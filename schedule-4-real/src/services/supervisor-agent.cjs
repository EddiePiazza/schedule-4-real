/**
 * Supervisor Agent Service
 * Evaluates automation flows and controls sockets based on sensor data
 *
 * Responsibilities:
 * - Subscribe to sensor data via MQTT
 * - Load enabled flows from database
 * - Evaluate conditions when sensor data arrives
 * - Check AI mode before acting on sockets
 * - Apply hysteresis to prevent rapid toggling
 * - Execute MQTT commands for ON/OFF
 * - Log executions to database
 */

const mqtt = require('mqtt');
const pg = require('pg');
const fs = require('fs');
const path = require('path');
const { gzipSync } = require('zlib');
const { execSync } = require('child_process');
const dotenv = require('dotenv');
const updateChecker = require('./update-checker.cjs');

dotenv.config();

// Configuration
const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const QUESTDB_HOST = process.env.QUESTDB_HOST || '127.0.0.1';
const QUESTDB_PORT = parseInt(process.env.QUESTDB_PG_PORT) || 8812;
const QUESTDB_USER = process.env.QUESTDB_USER || 'spider';
const QUESTDB_PASSWORD = process.env.QUESTDB_PASSWORD || 'spider123';
const QUESTDB_DATABASE = process.env.QUESTDB_DATABASE || 'qdb';

// ── MAC normalisation (CRITICAL, 2026-05-31) ──
// The device/proxy publishes the SAME device's MAC in mixed case across messages — e.g. both
// `80B54E8FFFF4` and `80b54e8ffff4`. Keying any map by the raw string splits ONE physical device
// into TWO phantom devices: the merged sensor value alternated between the two stores (the
// "humidity flap" 56↔63), and socket commands went to one casing while state was reported under
// the other (`getSocketState` missed → humidifier showed "was 0" forever and was re-commanded
// every cycle). Normalising every MAC key to lower-case collapses them back into one device.
function normMac(mac) { return (typeof mac === 'string') ? mac.toLowerCase() : mac; }

// Device registry (loaded from QuestDB)
// Maps MAC -> { type: 'ps5'|'cb'|'lc', uid: string, mac: string }
const deviceRegistry = new Map();
let defaultPrimaryMac = '';   // First primary device (PS5 or CB) detected
let defaultPrimaryType = 'ps5'; // Device type of the primary device

// Database pool
const pool = new pg.Pool({
  host: QUESTDB_HOST,
  port: QUESTDB_PORT,
  user: QUESTDB_USER,
  password: QUESTDB_PASSWORD,
  database: QUESTDB_DATABASE,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// State
let mqttClient = null;
let flows = [];
let socketAiModes = {};  // socket -> boolean (combines device+socket for multi-device)
let lastSensorValues = {};  // Legacy: merged sensor values from all devices
// Liveness watchdog timestamp: bumped ONLY when a message carried REAL sensor data (temp/humi/soil),
// NOT on the empty 10s schedule self-tick. The restart watchdog keys off this so a dead sensor feed
// actually trips it (the old lastSensorProcessedTime was bumped by the self-tick → never fired).
let lastRealSensorAt = Date.now();
let lastActionTimes = {}; // Track last action time per device:socket for hysteresis cooldown
let lastSocketStates = {}; // Legacy: socket states from default PS5
let lastModuleConfigs = {}; // Full config cache per module (blower, fan, etc.) — preserves speed/level on ON/OFF

// ── Safety Timeouts: prevent stuck devices ──
// Tracks when each device was last turned ON. If ON duration exceeds the configured max,
// the device is force-stopped regardless of trigger conditions.
let safetyTimeouts = {}; // deviceKey -> { maxOnMinutes, enabled }
const deviceOnSince = {}; // deviceKey -> timestamp (ms) when device turned ON, null if OFF
// Safety timeouts (max ON minutes). Set to 0 to disable a specific device's timeout.
// Heater: 240 min — small grow-tent heaters can legitimately run for hours to keep up
//   when ambient temp is well below idealMin (basement / winter). The previous 60 min
//   default forced the heater off mid-shift on rooms with naturally cold ambients.
const SAFETY_DEFAULTS = { heater: 240, humidifier: 30, dehumidifier: 60, blower: 120, fan: 0 };

async function loadSafetyTimeouts() {
  try {
    // Ensure table exists (production may not have run schema migration yet)
    await query(`CREATE TABLE IF NOT EXISTS safety_timeouts (timestamp TIMESTAMP, device_key SYMBOL, max_on_minutes INT, enabled INT, updated_by SYMBOL) TIMESTAMP(timestamp) PARTITION BY MONTH`).catch(() => {});
    const rows = await query(`
      SELECT device_key, max_on_minutes, enabled
      FROM safety_timeouts
      LATEST ON timestamp PARTITION BY device_key
    `);
    safetyTimeouts = {};
    for (const [key, minutes] of Object.entries(SAFETY_DEFAULTS)) {
      safetyTimeouts[key] = { maxOnMinutes: minutes, enabled: minutes > 0 };
    }
    for (const row of (rows || [])) {
      safetyTimeouts[row.device_key] = { maxOnMinutes: row.max_on_minutes, enabled: row.enabled === 1 };
    }
  } catch {
    // Table might not exist yet — use defaults
    safetyTimeouts = {};
    for (const [key, minutes] of Object.entries(SAFETY_DEFAULTS)) {
      safetyTimeouts[key] = { maxOnMinutes: minutes, enabled: minutes > 0 };
    }
  }
}

// Check and enforce safety timeouts — called after every action execution
function enforceSafetyTimeouts() {
  const now = Date.now();
  const forceOffActions = [];

  for (const [deviceKey, onSince] of Object.entries(deviceOnSince)) {
    if (!onSince) continue; // Device is OFF
    // If the device currently reports OFF, re-base its clock — the simple max-on timer must not
    // accumulate across on→off→on cycles (audit P2 #7). The blower especially: its speed/OFF
    // commands flow through sendBlowerCommand, which never cleared deviceOnSince, so the clock ran
    // forever and force-OFFed a healthy exhaust every ~120 min (398 log lines observed).
    if (lastSocketStates[deviceKey] === 0) { deviceOnSince[deviceKey] = null; continue; }
    // The AI-speed-controlled blower has its OWN governance (futility self-test, heartbeat,
    // mismatch-recovery, and a normal continuous idle 30 % exhaust). A blunt max-on force-OFF is
    // both unnecessary and harmful for it — exempt it. Other modules/outlets keep their timeout.
    if (deviceKey === 'blower' && socketAiModes['blower']) continue;
    const config = safetyTimeouts[deviceKey];
    if (!config || !config.enabled || config.maxOnMinutes <= 0) continue;

    const onDurationMs = now - onSince;
    const maxMs = config.maxOnMinutes * 60 * 1000;

    if (onDurationMs >= maxMs) {
      console.log(`[SAFETY] Timeout: ${deviceKey} has been ON for ${(onDurationMs / 60000).toFixed(0)} min (max ${config.maxOnMinutes} min) — FORCING OFF`);
      deviceOnSince[deviceKey] = null; // Mark as OFF

      // Determine if it's a module or socket
      const isModule = ['blower', 'fan', 'heater', 'humidifier', 'dehumidifier'].includes(deviceKey);
      forceOffActions.push({
        deviceMac: null,
        socket: deviceKey,
        action: 'off',
        reason: `SAFETY TIMEOUT: ${deviceKey} exceeded max ${config.maxOnMinutes} min ON duration`,
        mandatoryOff: true // Override everything
      });
    }
  }

  // Second check: detect AI-controlled outlets that are ON but NOT tracked in deviceOnSince.
  // This catches cases where the supervisor restarted and lost tracking state.
  // If an outlet is ON and AI-controlled but has no deviceOnSince entry, start tracking it NOW.
  // The next run (60s later) will have an accurate duration.
  const aiModules = ['blower', 'fan', 'heater', 'humidifier', 'dehumidifier'];
  for (const key of Object.keys(lastSocketStates)) {
    if (lastSocketStates[key] !== 1) continue; // Only care about ON devices
    if (!socketAiModes[key]) continue; // Only AI-controlled
    if (deviceOnSince[key]) continue; // Already tracked
    // This outlet is ON but we don't know since when — start tracking now
    deviceOnSince[key] = Date.now();
    console.log(`[SAFETY] Tracking untracked ON device: ${key} (started tracking now)`);
  }

  return forceOffActions;
}
const HYSTERESIS_COOLDOWN_MS = 5000; // Minimum 5 seconds between state changes
const SLOW_CLIMATE_DWELL_MS = 75 * 1000; // humidifier/dehumidifier: ≥75s between toggles (pump/compressor protection)
// Leaf temperature offset below air temperature, depends on lighting:
//   DAY:   1.0°C (moderate LED + airflow — leaves a hair cooler than air via transpiration)
//   NIGHT: 0.3°C (lights off — leaves equilibrate with air within ~30 min)
// 2026-05-25: lowered from 2.8/1.0. Eddie reported the system extracting when the air-VPD chart
// said it should humidify — the 2.8°C offset (DimLux assumption: dense canopy + peak LED) was
// flipping the phase decision for his sparser/lower-intensity setup. The VPD Control node can
// override these via leafOffsetDay / leafOffsetNight if a specific grow needs the old aggressive
// values back. The "air VPD" the user sees in the UI now matches the supervisor's view within
// ~0.05 kPa, so the control intent matches the user's reading of the VPD chart.
const LEAF_TEMP_OFFSET_DAY_DEFAULT = 0.5;
const LEAF_TEMP_OFFSET_NIGHT_DEFAULT = 0.2;
const LEAF_TEMP_OFFSET = LEAF_TEMP_OFFSET_DAY_DEFAULT; // Kept for backward-compat callers; see getLeafOffset()
function getLeafOffset() {
  // VPD Control node may override the defaults (leafOffsetDay / leafOffsetNight).
  const cfgDay = (vpdNodeConfig && typeof vpdNodeConfig.leafOffsetDay === 'number') ? vpdNodeConfig.leafOffsetDay : LEAF_TEMP_OFFSET_DAY_DEFAULT;
  const cfgNight = (vpdNodeConfig && typeof vpdNodeConfig.leafOffsetNight === 'number') ? vpdNodeConfig.leafOffsetNight : LEAF_TEMP_OFFSET_NIGHT_DEFAULT;
  try {
    return getCurrentPeriod() === 'day' ? cfgDay : cfgNight;
  } catch {
    return cfgDay;
  }
}

// ── Algorithm-owned temperature bands (2026-05-31, Eddie) ──
// Temperature is NOT a manual setpoint to chase — it is a safety/comfort band the algorithm OWNS.
// Inside the band the temperature floats freely and VPD is achieved entirely via HUMIDITY
// (humidifier / dehumidifier); the blower (cool) and heater only act when temp leaves the band.
// This is the fix for the chronic problem: a hand-set night max of 23 °C (below the room's real
// ~24 °C ambient) made the system fight an unreachable target, spiking the blower and crashing
// humidity (incidents 2026-05-30/31). Cannabis norms: absolute-safe 18-30 °C, ideal ~21-26 with a
// healthy day→night drop. The manual idealDayTemp / idealNightTemp from the VPD node are now
// IGNORED for control (kept in config only for display / backward-compat).
const TEMP_SAFE_MIN = 18;   // hard floor — force HEAT below this regardless of grace/phase
const TEMP_SAFE_MAX = 30;   // hard ceiling — force COOL above this regardless of futility
const TEMP_BAND_DAY = { min: 22, max: 25 };    // lights ON:  Eddie's goal = 24-25°C daytime → cool above 25
const TEMP_BAND_NIGHT = { min: 19, max: 24 };   // lights OFF: float 19-24, cool>24 / heat<19

// Activation hysteresis — dead band to prevent oscillation
// Devices activate when EXCEEDING target + hysteresis, deactivate at target (no hysteresis)
const TEMP_HIGH_HYSTERESIS = 0.5; // °C above idealTemp.max before cooling activates (blower ON at max+0.5)
const TEMP_LOW_HYSTERESIS = 0.5;  // °C below idealTemp.min before heating activates (heater ON at min-0.5)

// Smart blower speed optimizer — 3-phase state machine:
//   ESCALATING:    speed going up, looking for effective speed
//   DEESCALATING:  speed going down, finding minimum effective speed
//   HOLDING:       maintaining optimal speed, monitoring for changes
// Tuning rationale:
//   - 5 min check matches the user's "wait 5 min, then step" mental model and gives
//     room temperature/humidity sensors time to actually respond between steps.
//   - WORSEN_HUMI was 1.0 — too tolerant. A grow-tent picking up +1%/h of humi
//     because the blower de-escalated too aggressively never crossed the threshold
//     per cycle and the optimizer kept stepping down (incident 2026-05-19).
//     0.4% is well above the ±0.1% sensor noise but catches slow drift in time.
const ESCALATION_CHECK_MS = 90 * 1000;         // re-evaluate every 90 s — responsive without chasing noise
const ESCALATION_STEP = 10;                    // ±10% per step
// "Improving" = a power increase that moves the metric the desired way by at least this
// much counts as effective; anything smaller means we've hit the equipment's capacity.
const ESCALATION_IMPROVE_TEMP = 0.3;
const ESCALATION_IMPROVE_HUMI = 1.0;
// Periodic capacity re-test: every 30 min the optimizer forgets a previously-detected
// capacity limit so it re-probes upward — the grow's load changes through the day
// (sun/cloud/rain, watering, transpiration), so what "gave nothing" before may help now.
const EXPLORE_UP_INTERVAL_MS = 30 * 60 * 1000;
const COOLING_BELOW_MAX_TIMEOUT_MS = 5 * 60 * 1000; // 5 min below idealTemp.max → stop (best effort reached)
// Continuous baseline airflow for a VPD-controlled exhaust blower. It should never fully
// stop — stagnant air pools humidity unevenly and makes VPD swing between on/off cycles.
// The extraction/cooling logic still ramps far above this when needed; this is just the
// gentle floor that keeps air exchanging. Suppressed only during a cycle-transition stop.
// Idle baseline for the blower when it doubles as the extractor role and conditions are quiet
// (no extraction, no heating, no humidifying). 30 % is the minimum speed at which the blower
// produces measurable air movement; anything below is just current draw. Eddie 2026-05-26.
const VPD_BLOWER_IDLE_SPEED = 30;
// Blind/stale-data fail-safe extraction. When the sensor feed dies (>5 min) the supervisor can't
// measure the room, so it can't run VPD control — but a flowering room must NOT have the exhaust
// fully off for long (humidity builds → mould/botrytis). 40 % is a gentle, capped "keep venting"
// speed: sheds moisture + exchanges air without acting on a stale snapshot. Eddie 2026-06-03.
const STALE_SAFE_BLOWER_SPEED = 40;
/** Saturation vapor pressure (Tetens formula) */
function svp(t) { return 0.6108 * Math.exp((17.27 * t) / (t + 237.3)); }

// Per-device state tracking for multi-device support
const sensorValuesByDevice = new Map();  // mac -> { temp, humi, vpd, co2, ... }
const socketStatesByDevice = new Map();  // mac -> { O1: 0|1, O2: 0|1, ... }
let dayNightSchedule = { dayStart: '06:00', dayEnd: '00:00' };
// Flip-to-flower transitions (see server/utils/lightCycle.ts for the store format). When a
// light is in its dark transition we force the climate to NIGHT regardless of the schedule.
const LIGHT_CYCLE_STORE = path.resolve(__dirname, '../../data/light-cycle-transitions.json');
const DARK_REASSERT_MS = 10 * 60 * 1000; // re-push manual-off every 10 min while dark (survives device reboot / missed msg)
let darkTransitionActive = false;
// VPD Intelligent Control State
let vpdNodeConfig = null; // Parsed from flow vpd_control node
let vpdEscalationState = {
  roles: {}, // { roleName: { activatedAt, metricAtActivation, speedBoost, lastCheckTime, lastMetric, phase, noImproveCount } }
};
let activeGrowPhase = null; // Current grow phase from DB (9-stage key)
let vpdBlowerMinSpeed = 0; // VPD-driven blower speed floor (when too_low: boost extraction)
let vpdBlowerMaxSpeed = 100; // VPD-driven blower speed ceiling (when too_high: reduce extraction to conserve humidity)
let lastVpdLogKey = ''; // Throttle VPD log: only log when conditions change

// Thermal inertia tracking — devices have residual effect after deactivation
let lastHeaterOffTime = 0;   // When heater was last turned off (ms)
let lastHumidifierOffTime = 0; // When humidifier was last turned off (ms)

// Heater effectiveness tracking. The supervisor turns on the heater expecting
// temp to rise; if a few minutes pass with no rise, the heater is broken,
// unplugged, undersized for the room, or thermal mass is winning. Skip it for
// a cooldown so we don't sit waiting for nothing — switch lever to extraction.
let heaterEvalStartTime = 0;        // ms when heater turned on in current run
let heaterEvalStartTemp = 0;        // temp captured at heater-on
let heaterIneffectiveUntil = 0;     // ms timestamp; while now < this, treat heater as broken
const HEATER_EFFECT_CHECK_MS = 6 * 60 * 1000; // give heater 6 min to prove itself
const HEATER_EFFECT_MIN_RISE = 0.4;            // °C of rise expected in that window
const HEATER_INEFFECTIVE_COOLDOWN_MS = 30 * 60 * 1000; // skip heater for 30 min after a fail

// ── Humidifier "dry tank" self-test ──
// Mirrors the heater pattern: when humidifier is ON we expect humi to rise within
// HUMIDIFIER_EFFECT_CHECK_MS by at least HUMIDIFIER_EFFECT_MIN_RISE. If it doesn't, the tank
// is probably empty — keep humidifier OFF for a long cooldown to avoid wasting power, and
// let plant transpiration recover humi naturally (the operator must refill).
let humidifierEvalStartTime = 0;
let humidifierEvalStartHumi = 0;
let humidifierIneffectiveUntil = 0;
let humidifierIneffectiveStartHumi = null; // humi at the moment we marked ineffective

// ── Cooling "futility" self-test ──
// When the room can't actually be cooled (exhaust vents to an ambient that's as warm as the
// room — typical at night when the night target sits below ambient), slamming the blower does
// nothing for temperature and only desiccates the air. Mirror the heater/humidifier self-tests:
// if the blower runs high for COOLING_EFFECT_CHECK_MS without dropping temp by COOLING_EFFECT_MIN_DROP,
// declare cooling futile for a cooldown and hold the blower at idle (preserve humidity, let temp
// float above the unreachable target). Re-test after the cooldown — ambient load changes all day.
let coolingEvalStartTime = 0;
let coolingEvalStartTemp = 0;
let coolingIneffectiveUntil = 0;
let coolingFutileStartTemp = null; // temp at which futility was declared — for the rising-temp escape
const COOLING_EFFECT_CHECK_MS = 4 * 60 * 1000;       // 4 min of high blower to prove it can cool
const COOLING_EFFECT_MIN_DROP = 0.3;                 // °C drop expected in that window
const COOLING_INEFFECTIVE_COOLDOWN_MS = 30 * 60 * 1000; // hold idle 30 min, then re-test
const COOLING_UNREACHABLE_MS = 12 * 60 * 1000; // temp sustained above stop target this long (mildly) → cooling unreachable, suppress
// Escape hatches so a "futile" verdict can never trap a genuinely overheating tent (audit P0 #2):
const COOLING_FUTILE_ESCAPE_RISE = 0.8;  // °C above the futility baseline → re-allow cooling immediately

// ── EQUILIBRIUM-SEARCH COOLING (Eddie 2026-06-20) ──
// When the cooling target is UNREACHABLE (exhaust can't beat ambient — temp plateaus ABOVE the band),
// pure proportional control pins the blower near 100 % forever chasing a temp it can't reach, and a
// VPD wobble flipping cooling on/off slams it 100↔0. Instead, once temp has plateaued we hill-climb to
// the MINIMUM blower speed that just HOLDS that achievable floor: step the speed DOWN until temp starts
// to rise, then nudge it back UP — settling into a gentle limit cycle (Eddie's "potencia mínima de
// desaturación": let temp drift 26.6→26.8, that's the floor, +step to hold). Quieter, far less drying,
// the humidifier can keep up. Temperature stays the hard constraint (rising temp always raises speed).
const COOL_EQ_START_SPEED = 50;            // % seed at cooling engage
const COOL_LEVEL_MS = 60 * 1000;           // 1-min avg for the CURRENT temp level (logging)
const COOL_TREND_MS = 12 * 60 * 1000;      // LONG analysis window — catches the SLOW dawn→noon creep that a 5-min window missed (Eddie: it was imperceptible). Over 12 min even a 0.01°/min rise = +0.12°, well above noise.
const COOL_STEP_MS = 90 * 1000;            // pace power changes to the thermal lag (each step's effect partly lands before the next)
const COOL_RISE = 0.008;                   // °C/min (12-min) above this = RISING → add power. LOW so the slow curve is caught (noise averages out over 12 min).
const COOL_FALL = 0.008;                   // °C/min below −this = FALLING → ease power down
const COOL_UP_GAIN = 120;                  // up-step = clamp(rise_rate × this) — slow rise → small step, fast rise → bigger. Power tracks the curve PROPORTIONALLY, no emergency trigger.
const COOL_UP_MIN = 2;                     // % min/max up-step while rising
const COOL_UP_MAX = 10;
const COOL_DOWN_STEP = 3;                   // % down-step when FLAT or FALLING (minimum-seek / ease as cooling capacity recovers)
const COOL_MIN_OP = 40;                     // % operating FLOOR while cooling — Eddie's range 40-60, never ≤30% (humidifier, not blower, is the VPD bottleneck so diving lower is futile)
const COOL_ABS_MAX = 90;                    // % sanity ceiling for normal control (the separate 30°C TEMP_SAFE_MAX emergency can still force 100%)
const COOL_SAT_HIGH = 78;                   // % at/above this, a rise that ISN'T slowing despite more power = DESATURATION CAPACITY reached (intake/ambient-limited) → HOLD, don't climb futilely (more would only dry — Eddie 2026-06-22)
const COOL_TEMP_OVERRIDE_MARGIN = 1.0;     // temp this far above the band top = genuine heat → cool regardless of VPD
let coolEqSpeed = 0;         // current blower speed (0 = cooling not engaged this run)
let coolLastStep = 0;        // last paced power change
let coolLastDt = 0;          // temp trend at the previous step — to tell if more power is SLOWING the rise (capacity check)
let coolSatStreak = 0;       // consecutive high-power steps where the rise didn't slow → confirms capacity-limited (avoids a single-step false positive)
// Set true each evaluation when cooling is currently judged futile, so the blower-send path
// (separate function) knows NOT to force the blower to 100 % for a temperature emergency that
// cooling can't relieve anyway. Humidity emergencies (extraction works) are unaffected.
let vpdTempCoolingFutile = false;
const HUMIDIFIER_EFFECT_CHECK_MS = 10 * 60 * 1000; // 10 min — humidifiers are slower than heaters
const HUMIDIFIER_EFFECT_MIN_RISE = 1.0;             // % humi rise expected in that window
const HUMIDIFIER_INEFFECTIVE_COOLDOWN_MS = 45 * 60 * 1000; // 45 min, then re-test (gives time to refill)
// Early-clear threshold: if humi rises this much from the marked-ineffective value, the room is
// recovering on its own — clear the lockout so we don't keep the humidifier suppressed past need.
const HUMIDIFIER_INEFFECTIVE_RECOVERY_RISE = 3;

// (Removed 2026-05-31 audit P3 #12: manualOverrideUntil / lastRequestedSocketState /
// MANUAL_OVERRIDE_GRACE_MS were write-only dead state — the manual-override hold they fed was
// deleted long ago in favour of in-cycle intent resolution (resolveSocketIntents). A future
// manual-override detector should read per-device state via getSocketState, not a global mirror.)

// ── Periodic ventilation (rolling-window air-renewal guarantee) ──
// Even when retaining humidity (humi low, blower otherwise off), the room still needs a regular air
// refresh to keep CO2 / O2 / stale-air pockets healthy — at night the plants respire CO2 and the
// EXHAUST is the only device that swaps tent air (the circulator merely stirs it).
//
// Eddie's rule (2026-06-26): "the blower must NEVER be off more than 30 min — within any trailing
// 30-min window it must have run ≥5 min; if it hasn't, run it 5 min now." He explicitly warned NOT
// to use a naive "time since last active" timer: e.g. a 2-min blip 28 min ago must NOT be read as
// "ran recently" — what matters is the TRUE accumulated runtime inside the rolling window. So we keep
// an exact log of blower run-intervals (≥ AIR_REFRESH_MIN_SPEED), integrate the runtime inside the
// last 30 min, and pulse whenever that sum is below the 5-min minimum. The pulse counts toward the
// sum, so right after a 5-min pulse the window holds ≥5 min and it can't immediately re-fire — no loop.
let blowerRunIntervals = []; // [{start, end}] ms — exact log of blower run-intervals (≥ AIR_REFRESH_MIN_SPEED)
let airLastEvalNow = 0;      // timestamp of the previous evaluation, to attribute each elapsed segment
let ventilationPulseStart = 0;                       // > 0 while a pulse is active
const AIR_REFRESH_WINDOW_MS = 30 * 60 * 1000;        // 30 min rolling window
const AIR_REFRESH_MIN_MS = 5 * 60 * 1000;            // must accumulate ≥ 5 min of run inside the window
const VENTILATION_DURATION_MS = 5 * 60 * 1000;       // 5 min per pulse (tops the window back up to the 5-min minimum)
const VENTILATION_SPEED = 45;                        // % — a REAL air exchange (the old 30% token trickle barely moved air)
const AIR_REFRESH_MIN_SPEED = 40;                    // % — only a run at/above this counts as a genuine air refresh; weak ~31% cooling blips do NOT (they masked the staleness all night)

// Blower-off → heater grace. After extraction stops, the lamp + canopy / pot
// mass naturally warm the room over a few minutes; don't fire the heater
// immediately and waste a cycle.
let lastExtractionStopTime = 0;
const POST_EXTRACTION_HEATER_GRACE_MS = 5 * 60 * 1000;
const HEATER_GRACE_MS = 2 * 60 * 1000;     // 2 min: after heater off, suppress cooling (hysteresis handles the rest)
const HUMIDIFIER_GRACE_MS = 4 * 60 * 1000; // 4 min: after humidifier off, suppress extraction — residual moisture needs time to settle
const DEHUM_ESCALATION_MS = 2 * 60 * 1000; // 2 min: dehumidifier must run this long before blower escalation

// ── Socket-role re-issue throttle ──
// When a role wants the device ON but MQTT keeps reporting OFF (cooldown blocks command, or
// device truly didn't latch), the activateSocketRole() check fires every cycle — flooding logs
// and burning CPU. Throttle the re-issue, and after enough consecutive misses mark the role
// "unresponsive" and back off so the operator can investigate hardware (dry tank, broken plug,
// firmware reject). Reset on a successful state=1 observation.
const roleReissueState = {}; // { [roleName]: { lastAttemptAt, consecutiveMisses, unresponsiveUntil } }
const ROLE_REISSUE_THROTTLE_MS = 30 * 1000;             // never re-issue same role faster than this
const ROLE_UNRESPONSIVE_MISS_THRESHOLD = 6;             // ~3 min of misses at 30s throttle
const ROLE_UNRESPONSIVE_BACKOFF_MS = 10 * 60 * 1000;    // back off 10 min before next re-attempt

// ── Post-Cooling Intelligent Heater Suppression ──
// After blower/extractor finishes cooling, DON'T immediately fire heater.
// Monitor temp trend: if environment is self-correcting (rising), heater is unnecessary.
// Only allow heater if temp is stable AND still below min after sufficient observation.
const COOLING_GRACE_MIN_MS = 5 * 60 * 1000;        // Phase 1: 5 min unconditional suppress
const COOLING_GRACE_MAX_MS = 10 * 60 * 1000;       // 10 min max total grace period
const COOLING_GRACE_TREND_CHECK_MS = 2 * 60 * 1000; // Check trend every 2 min
const COOLING_GRACE_RISE_THRESHOLD = 0.1;            // °C over 2 min: if rising faster → self-correcting

let lastCoolingStopTime = 0;       // When blower/extractor finished cooling
let coolingGraceLastTemp = 0;      // Temp at last trend check
let coolingGraceLastCheck = 0;     // Timestamp of last trend check
let coolingGraceStableStart = 0;   // When temp first became stable (for 2-min timer)
let coolingBelowMaxSince = 0;     // When temp first dropped below idealTemp.max during active cooling

// ── Cycle Transition Grace Period ──
// When day↔night changes, the environment needs time to adjust naturally.
// Lights off → temp drops on its own. Lights on → temp rises on its own.
// We suppress aggressive climate actions during this period, monitoring every
// TREND_CHECK_INTERVAL to detect if the trend is favorable (moving toward target),
// stagnant (no change), or adverse (moving away from target).
const CYCLE_TRANSITION_GRACE_MS = 20 * 60 * 1000; // 20 min max grace period
const TREND_CHECK_INTERVAL_MS = 5 * 60 * 1000;    // Check trend every 5 min
const TREND_MIN_CHANGE = 0.5;                       // °C or % minimum change per 5 min to be "favorable"

let lastKnownPeriod = null;           // 'day' or 'night' — to detect transitions
let cycleTransitionTime = 0;          // When the last transition happened (ms)
let cycleTransitionTempAtStart = 0;   // Temp when transition occurred
let cycleTransitionHumiAtStart = 0;   // Humi when transition occurred
let cycleTransitionLastCheck = 0;     // Last trend check timestamp
let cycleTransitionLastTemp = 0;      // Temp at last trend check
let cycleTransitionLastHumi = 0;      // Humi at last trend check
let cycleTransitionGraceActive = false;
let cycleTransitionDirection = '';    // 'cooling' (day→night) or 'warming' (night→day)
let lastCycleTransitionAt = 0;        // Persisted across restarts — used for min-interval guard
// Minimum interval between consecutive cycle transitions. Without this, a flapping schedule loader
// (defaults reloaded then real values reloaded every 30 s) cascades 20+ transitions in minutes,
// each one killing all roles and resetting blower min/max to 0. Incident 2026-05-30.
const CYCLE_TRANSITION_MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 min
// Hard watchdog: even if eval never reaches the grace expiry path, force-clear after this much
// real time so a sensor outage during grace can't lock the system out forever.
const CYCLE_TRANSITION_GRACE_HARD_MAX_MS = CYCLE_TRANSITION_GRACE_MS + 5 * 60 * 1000;

// ── Boot grace — ignore the first schedule reload after startup ──
// The schedule defaults to { dayStart: '06:00', dayEnd: '00:00' } at boot, then loadDayNightSchedule
// replaces it with the real DB row a few ms later. The "change" between defaults and real values
// was being logged as a Day/Night schedule change AND interpreted as a cycle transition at certain
// times of day. Suppress this initial difference: any change within BOOT_SCHEDULE_GRACE_MS of
// process start is silently absorbed as the initial load, not a real change.
const BOOT_SCHEDULE_GRACE_MS = 60 * 1000; // 60 s
const SUPERVISOR_BOOT_AT = Date.now();
let scheduleInitialised = false;       // becomes true after first non-default load is absorbed

// ── Dual-authority resolution ──
// validateVpdVsTriggers detects sockets claimed BOTH by a VPD role AND by a user trigger action.
// Previously this was only a warning that flooded the error log hundreds of times a day. Now we
// AUTHORITATIVELY drop the user trigger's claim on those sockets during action merging — the VPD
// algorithm is the single source of truth. Without this the two controllers can fight every
// cycle (O3 had 326 events in one day on 2026-05-30).
let dualAuthorityVpdWins = new Set(); // socket IDs where the VPD role takes precedence
let lastDualAuthorityWarnAt = 0;       // throttle the warning log to once per 10 min

// ── Persisted supervisor state ──
// lastKnownPeriod + lastCycleTransitionAt + humidifier/heater lockouts survive PM2 restarts.
// Without this, every restart (24 in 31 h on 2026-05-30) wipes lastKnownPeriod, and the first
// evaluation after restart may flip period → cycle transition cascade.
const SUPERVISOR_STATE_PATH = path.resolve(__dirname, '../../data/appdata/supervisor-state.json');
function loadSupervisorState() {
  try {
    if (!fs.existsSync(SUPERVISOR_STATE_PATH)) return;
    const s = JSON.parse(fs.readFileSync(SUPERVISOR_STATE_PATH, 'utf8'));
    if (s && typeof s === 'object') {
      if (s.lastKnownPeriod === 'day' || s.lastKnownPeriod === 'night') {
        lastKnownPeriod = s.lastKnownPeriod;
      }
      if (typeof s.lastCycleTransitionAt === 'number' && s.lastCycleTransitionAt > 0) {
        lastCycleTransitionAt = s.lastCycleTransitionAt;
      }
      if (typeof s.humidifierIneffectiveUntil === 'number' && s.humidifierIneffectiveUntil > Date.now()) {
        humidifierIneffectiveUntil = s.humidifierIneffectiveUntil;
      }
      if (typeof s.heaterIneffectiveUntil === 'number' && s.heaterIneffectiveUntil > Date.now()) {
        heaterIneffectiveUntil = s.heaterIneffectiveUntil;
      }
      console.log(`[Supervisor] Loaded persisted state: period=${lastKnownPeriod}, lastTransition=${lastCycleTransitionAt ? new Date(lastCycleTransitionAt).toISOString() : 'never'}`);
    }
  } catch (err) {
    console.warn('[Supervisor] Failed to load supervisor state:', err.message);
  }
}
let _stateWriteScheduled = false;
function saveSupervisorState() {
  // Debounce writes so we don't hammer the disk every evaluation cycle.
  if (_stateWriteScheduled) return;
  _stateWriteScheduled = true;
  setTimeout(() => {
    _stateWriteScheduled = false;
    try {
      const dir = path.dirname(SUPERVISOR_STATE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SUPERVISOR_STATE_PATH, JSON.stringify({
        lastKnownPeriod,
        lastCycleTransitionAt,
        humidifierIneffectiveUntil,
        heaterIneffectiveUntil,
        savedAt: Date.now()
      }, null, 2));
    } catch (err) {
      console.warn('[Supervisor] Failed to save supervisor state:', err.message);
    }
  }, 2000);
}

// ── Anti-oscillation toggle guard ──
// On 2026-05-30 socket O3 had 326 state-change events in one day (≈1 every 4 min sustained,
// peaks every 6 s). Track recent toggles per socket and lock the state when toggling exceeds
// the safety threshold — gives whatever oscillation source time to settle.
const socketToggleHistory = {}; // socket -> [timestamps...]
const socketLockedUntil = {};   // socket -> timestamp ms
const TOGGLE_WINDOW_MS = 5 * 60 * 1000;
const TOGGLE_MAX_PER_WINDOW = 6;
const TOGGLE_LOCK_DURATION_MS = 5 * 60 * 1000;

// Blower Curve Control State
let blowerCurveConfig = null; // Parsed from flow blower_curve node
let blowerCurveEscalationState = {}; // { curveId: { lastValue, lastCheck, escalationBoost } }

// Persisted per-node condition state (survives across evaluation cycles).
// Used so that condition nodes can implement hysteresis: once active with hysteresis,
// the condition stays active until the sensor crosses the (target ± hysteresis) boundary,
// even across cycle boundaries. Without this, hysteresis is effectively disabled.
const persistedConditionState = new Map(); // nodeId -> boolean (was active last cycle)

// Rolling sensor-trend buffer: the last N (timestamp, temp, humi) samples.
// Used to anticipate emergencies — if temp is rising fast toward the ideal max, we can
// activate cooling a bit earlier to avoid triggering the strict emergency path.
// Pruned by TIME, not a fixed count, so a multi-minute trend window is ALWAYS fully populated.
// (Was a fixed 10 samples; at the per-sensor-message cadence that was only ~1-2 min, so computeTrend's
// 5-min default window — and the cooling controller's rise/fall detection — never had its full window of
// data. Eddie 2026-06-21: the analysis window must be ≥5 min to robustly tell if temp is rising or falling.)
const TREND_BUFFER_MS = 15 * 60 * 1000; // keep ~15 min of samples (covers the 5-min trend + headroom)
const TREND_BUFFER_CAP = 1000;          // hard safety cap on sample count (cadence-independent backstop)
const tempTrendBuffer = []; // [{ t, temp, humi }]
function pushTrendSample(temp, humi) {
  const now = Date.now();
  tempTrendBuffer.push({ t: now, temp, humi });
  while (tempTrendBuffer.length && (now - tempTrendBuffer[0].t > TREND_BUFFER_MS || tempTrendBuffer.length > TREND_BUFFER_CAP)) {
    tempTrendBuffer.shift();
  }
}
function computeTrend(field = 'temp', windowMs = 5 * 60 * 1000) {
  // Returns {delta, perMin} for the given field over up to `windowMs` of history.
  const now = Date.now();
  const windowSamples = tempTrendBuffer.filter(s => now - s.t <= windowMs);
  if (windowSamples.length < 2) return { delta: 0, perMin: 0, samples: windowSamples.length };
  const first = windowSamples[0];
  const last = windowSamples[windowSamples.length - 1];
  const delta = (last[field] ?? 0) - (first[field] ?? 0);
  const minutes = Math.max(1 / 60, (last.t - first.t) / 60000);
  return { delta, perMin: delta / minutes, samples: windowSamples.length };
}

// Timestamp of the last "blower crashed temp while extracting humidity" event.
// Used to suppress humidity extraction for a cooldown period after the crash so the
// environment can settle. Without this, the blower can oscillate: extract → crash →
// stop → humi rises → extract → crash again → infinite loop.
let lastHumiExtractionCrashTime = 0;
let lastHumiExtractionCrashHumi = null;
// 2 min cooldown: with the looser crashThreshold (heater-aware) and the bypass that
// re-fires the blower as soon as humidity climbs further, a short cooldown is enough
// to let the heater stabilise. The previous 5 min left rooms stuck above target.
const HUMI_EXTRACTION_CRASH_COOLDOWN_MS = 2 * 60 * 1000;
let lastBlowerSpeed = null; // Last commanded speed to avoid redundant commands
let lastBlowerSendAt = 0;   // ms of the last successful blower command send
let lastBlowerEmergency = false; // tracks whether last sent speed was the emergency-100 path
// Minimum on/off DWELL for the blower (Eddie 2026-06-06 flap fix). The blower send path bypasses
// executeActions, so neither the socket anti-oscillation lock nor the slow-climate dwell ever
// governed it — it flapped 31↔0 every ~15 s on the humidity boundary (~735 toggles/20 h). This
// caps an on/off CROSSING to one per BLOWER_MIN_DWELL_MS; emergencies/heartbeat/mismatch bypass it.
let blowerToggleLockUntil = 0;
const BLOWER_MIN_DWELL_MS = 90 * 1000;
// Heartbeat re-send interval. After this many ms without any send, the supervisor proactively
// re-publishes the current desired speed even if it hasn't changed. Protects against missed
// MQTT messages and helps the device confirm it's tracking the supervisor's intent. 3 min is
// well below the 5-min sensor watchdog and well above the per-cycle eval (~10 s) so we don't
// flood the device.
const BLOWER_HEARTBEAT_MS = 3 * 60 * 1000;

// ── Sequential climate phase state ──
// Running blower (humidity extraction) + heater simultaneously is wasteful: the heater
// pumps energy in, the blower immediately exhausts it. We sequence them instead:
//   - 'extracting' : blower ON, heater OFF — drop humidity
//   - 'heating'    : heater ON, blower OFF (or standby) — raise temperature
//   - 'idle'       : neither needed, room in target band
// When both humidity and temperature need correction, alternate phases with a minimum
// dwell time so each phase has time to actually move the metric before we switch.
let vpdPhase = 'idle';
let vpdPhaseStartedAt = 0;

// Calibration lock — when running, supervisor skips all trigger/blower evaluation
function isCalibrationLocked() {
  try {
    const lockPath = path.resolve(__dirname, '../../data/calibration-lock.json');
    return fs.existsSync(lockPath);
  } catch { return false; }
}

// Blower calibration data — measured capacity at each speed level
let calibrationData = null; // { day: { measurements, saturationTemp, ... }, night: { ... } }
function loadCalibrationData() {
  try {
    const calPath = path.resolve(__dirname, '../../data/ai-calibration.json');
    if (fs.existsSync(calPath)) {
      calibrationData = JSON.parse(fs.readFileSync(calPath, 'utf8'));
      const dayPts = calibrationData?.day?.measurements?.length || 0;
      const nightPts = calibrationData?.night?.measurements?.length || 0;
      if (dayPts || nightPts) {
        console.log(`[Supervisor] Calibration data loaded: day=${dayPts} pts, night=${nightPts} pts`);
      }
    }
  } catch (err) {
    console.error('[Supervisor] Failed to load calibration data:', err.message);
  }
}

/**
 * Calculate optimal blower speed from calibration data.
 * Uses inverse lookup: given how much we need to reduce temp/humi,
 * find the minimum speed whose measured capacity meets the need.
 *
 * @param {number} tempDelta - How much temp needs to drop (positive = need cooling)
 * @param {number} humiDelta - How much humi needs to drop (positive = need drying)
 * @param {string} period - 'day' or 'night'
 * @returns {number} Optimal speed (0 if no calibration or no reduction needed)
 */
function calcSpeedFromCalibration(tempDelta, humiDelta, period) {
  const cal = calibrationData?.[period];
  if (!cal || !cal.measurements?.length) return 0;

  const measurements = cal.measurements;
  let speedForTemp = 0;
  let speedForHumi = 0;

  // Find minimum speed that can achieve the needed temp reduction
  // deltaTemp must be NEGATIVE (actual cooling). Positive delta = blower warms the room → skip.
  if (tempDelta > 0) {
    for (const m of measurements) {
      if (m.deltaTemp < 0 && Math.abs(m.deltaTemp) >= tempDelta) {
        speedForTemp = m.speed;
        break;
      }
    }
    // No single speed achieves it — use the highest speed that actually cools
    if (speedForTemp === 0) {
      for (let i = measurements.length - 1; i >= 0; i--) {
        if (measurements[i].deltaTemp < 0) {
          speedForTemp = measurements[i].speed;
          break;
        }
      }
    }
  }

  // Find minimum speed that can achieve the needed humi reduction
  // deltaHumi must be NEGATIVE (actual drying). Positive delta = blower adds humidity → skip.
  if (humiDelta > 0) {
    for (const m of measurements) {
      if (m.deltaHumi < 0 && Math.abs(m.deltaHumi) >= humiDelta) {
        speedForHumi = m.speed;
        break;
      }
    }
    if (speedForHumi === 0) {
      for (let i = measurements.length - 1; i >= 0; i--) {
        if (measurements[i].deltaHumi < 0) {
          speedForHumi = measurements[i].speed;
          break;
        }
      }
    }
  }

  // Use the higher of the two (worst case drives the speed)
  return Math.max(speedForTemp, speedForHumi);
}

// Database query helper
async function query(text, params = []) {
  try {
    const result = await pool.query(text, params);
    return result.rows || [];
  } catch (err) {
    console.error('[Supervisor] DB query error:', err.message);
    throw err;
  }
}

/**
 * Load day/night schedule from database
 */
async function loadDayNightSchedule() {
  try {
    const prev = { ...dayNightSchedule };
    const rows = await query(`
      SELECT day_start, day_end
      FROM day_night_schedule
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    if (rows.length > 0) {
      dayNightSchedule = {
        dayStart: rows[0].day_start,
        dayEnd: rows[0].day_end
      };
    }
    const changed = prev.dayStart !== dayNightSchedule.dayStart || prev.dayEnd !== dayNightSchedule.dayEnd;
    const withinBootGrace = (Date.now() - SUPERVISOR_BOOT_AT) < BOOT_SCHEDULE_GRACE_MS;
    if (changed) {
      if (!scheduleInitialised || withinBootGrace) {
        // First non-default load (or anything within the boot grace) is just the initial DB row
        // replacing the in-process defaults — NOT a real user schedule change. Absorb silently
        // so we don't trigger a phantom cycle transition / blower reset.
        scheduleInitialised = true;
        if (changed && !withinBootGrace) {
          console.log('[Supervisor] Day/Night schedule loaded:', dayNightSchedule);
        }
      } else {
        // Genuine schedule change after the boot grace.
        console.log('[Supervisor] Day/Night schedule changed:', dayNightSchedule);
        lastBlowerSpeed = null; // Force blower re-evaluation with new period
      }
    } else if (!scheduleInitialised) {
      // No DB row OR DB row matches defaults — still mark as initialised so a later genuine
      // change is detected correctly.
      scheduleInitialised = true;
    }
  } catch (err) {
    if (!err.message.includes('does not exist')) {
      console.error('[Supervisor] Failed to load day/night schedule:', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// FLIP-TO-FLOWER EXECUTOR
// The flip endpoint persists pre-built device payloads + the times they should fire. Here we
// just compare `now` against those times and publish — no recomputation, so no drift. State
// machine per light: scheduled → dark → done. The dark payload is manual-OFF; the flower
// payload is a 12/12 TimeSlot. When flowering starts we also sync the climate day/night window.
// ─────────────────────────────────────────────────────────────────────
function readLightTransitions() {
  try {
    if (!fs.existsSync(LIGHT_CYCLE_STORE)) return { transitions: {} };
    const parsed = JSON.parse(fs.readFileSync(LIGHT_CYCLE_STORE, 'utf8'));
    return parsed && parsed.transitions ? parsed : { transitions: {} };
  } catch (err) {
    console.error('[LightCycle] read failed:', err.message);
    return { transitions: {} };
  }
}

function writeLightTransitions(store) {
  try {
    // Atomic write (temp + rename) so an interrupt can't truncate the store — same hardening as
    // versions.local.json. A half-written transitions file could strand a flip mid-dark-period.
    const tmp = LIGHT_CYCLE_STORE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, LIGHT_CYCLE_STORE);
  } catch (err) {
    console.error('[LightCycle] write failed:', err.message);
  }
}

function publishLightCycleConfig(t, config, label) {
  if (!mqttClient || !mqttClient.connected) return false;
  const dev = getDevice(t.deviceMac) || {};
  const type = (t.deviceType || dev.type || '').toLowerCase();
  const mac = t.deviceMac || dev.mac;
  if (!type || !mac) {
    console.error(`[LightCycle] No device for transition ${t.lightId} (${t.deviceMac})`);
    return false;
  }
  const command = {
    method: 'setConfigField',
    pid: mac,
    params: { keyPath: t.keyPath, [t.dataKey]: config },
    msgId: String(Date.now()),
    uid: String(t.uid || dev.uid || '')
  };
  mqttClient.publish(`ggs/${type}/${mac}/cmd`, JSON.stringify(command), { qos: 1 });
  console.log(`[LightCycle] ${label} — ${t.lightId} on ${type}/${mac}`);

  // Nudge the device to re-report its config a moment later, so the web app's config cache
  // (which only updates from device 'config' messages) reflects the change instead of showing
  // the stale schedule.
  setTimeout(() => {
    try {
      mqttClient.publish(`ggs/${type}/${mac}/cmd`, JSON.stringify({
        method: 'getConfigField',
        pid: mac,
        params: { keyPath: t.keyPath },
        msgId: String(Date.now()),
        uid: String(t.uid || dev.uid || '')
      }), { qos: 1 });
    } catch { /* best-effort cache refresh */ }
  }, 1500);
  return true;
}

// Sibling of publishLightCycleConfig for outlets on their own device-firmware TimeSlot schedule
// (IR/UV/Far-Red…) that the user chose to suppress during the dark period. Unlike the light, an
// outlet may live on a DIFFERENT device than the light (multi-device installs) — so this targets
// outlet.deviceMac/outlet.deviceType, not t.deviceMac/t.deviceType. `t` is only used for the
// transition id (logging) and as a uid fallback.
function publishOutletOverride(t, outlet, config, label) {
  if (!mqttClient || !mqttClient.connected) return false;
  const dev = getDevice(outlet.deviceMac) || {};
  const type = (outlet.deviceType || dev.type || '').toLowerCase();
  const mac = outlet.deviceMac || dev.mac;
  if (!type || !mac) {
    console.error(`[LightCycle] No device for outlet ${outlet.socket} (transition ${t.lightId}, mac ${outlet.deviceMac})`);
    return false;
  }
  const keyPath = ['outlet', outlet.socket];
  const command = {
    method: 'setConfigField',
    pid: mac,
    params: { keyPath, [outlet.socket]: config },
    msgId: String(Date.now()),
    uid: String(t.uid || dev.uid || '')
  };
  mqttClient.publish(`ggs/${type}/${mac}/cmd`, JSON.stringify(command), { qos: 1 });
  console.log(`[LightCycle] ${label} — outlet ${outlet.socket} on ${type}/${mac} (transition ${t.lightId})`);

  // Same cache-refresh nudge as publishLightCycleConfig, so the Sockets UI reflects the
  // forced-off/restored state promptly instead of waiting for the outlet's next periodic report.
  setTimeout(() => {
    try {
      mqttClient.publish(`ggs/${type}/${mac}/cmd`, JSON.stringify({
        method: 'getConfigField',
        pid: mac,
        params: { keyPath },
        msgId: String(Date.now()),
        uid: String(t.uid || dev.uid || '')
      }), { qos: 1 });
    } catch { /* best-effort cache refresh */ }
  }, 1500);
  return true;
}

// Defensive safety net: NEVER let the flip's outlet suppression touch a socket that is under
// active VPD or AI-trigger/manual control (humidifier/dehumidifier/extractor/circulator/blower
// roles, or any socket the user has put in AI mode). The wizard only ever offers plain TimeSlot
// (modeType 1) outlets, which are structurally exclusive with active VPD/AI control (those force
// the socket to modeType 0), so this should never actually trigger in practice — but if a role
// gets reassigned onto an outlet while a flip is already mid-dark-period, this stops the
// suppression/restore logic from fighting the climate controller.
function isClimateProtectedSocket(deviceMac, socket) {
  const mac = normMac(deviceMac);
  const aiModeKey = mac ? `${mac}:${socket}` : socket;
  if (socketAiModes[aiModeKey] || socketAiModes[socket]) return true;
  if (vpdNodeConfig && Array.isArray(vpdNodeConfig.roles)) {
    return vpdNodeConfig.roles.some(r => r.socket === socket && (!r.deviceMac || !mac || normMac(r.deviceMac) === mac));
  }
  return false;
}

// Force every selected outlet OFF (manual) so its own TimeSlot schedule can't fire during the
// dark period. Best-effort per outlet — a publish failure is logged and simply retried on the
// next dark re-assert (same DARK_REASSERT_MS cadence as the light), never blocks the light flip.
function suppressTransitionOutlets(t) {
  for (const outlet of (t.outlets || [])) {
    if (!outlet || !outlet.socket) continue;
    if (isClimateProtectedSocket(outlet.deviceMac, outlet.socket)) {
      console.warn(`[LightCycle] Skipping outlet ${outlet.socket} (${outlet.deviceMac || 'no-mac'}) — assigned to a VPD/AI climate role, leaving it untouched during dark suppression.`);
      continue;
    }
    const offConfig = { ...(outlet.originalConfig || {}), modeType: 0, mOnOff: 0 };
    if (!publishOutletOverride(t, outlet, offConfig, 'Dark: outlet forced OFF')) {
      console.warn(`[LightCycle] Outlet OFF publish failed for ${outlet.socket} (${outlet.deviceMac}) — will retry on next dark re-assert.`);
    }
  }
}

// Restore every selected outlet to its saved originalConfig (its real TimeSlot schedule) once
// flowering begins. One-shot, same as the light's own flowerConfig publish — mirrors the light's
// existing precedent of not re-asserting after 'done', so a failure here is logged but not
// auto-retried (matches how a failed flower publish for the light itself is handled today: it's
// never re-pushed once the transition already advanced past that point).
function restoreTransitionOutlets(t) {
  for (const outlet of (t.outlets || [])) {
    if (!outlet || !outlet.socket) continue;
    if (isClimateProtectedSocket(outlet.deviceMac, outlet.socket)) {
      console.warn(`[LightCycle] Skipping outlet ${outlet.socket} (${outlet.deviceMac || 'no-mac'}) — assigned to a VPD/AI climate role, leaving it untouched at flower restore.`);
      continue;
    }
    if (!publishOutletOverride(t, outlet, outlet.originalConfig || { modeType: 1 }, 'Flower: outlet schedule restored')) {
      console.warn(`[LightCycle] Outlet restore publish failed for ${outlet.socket} (${outlet.deviceMac}) — not auto-retried (one-shot, same as the light's flower publish).`);
    }
  }
}

// Tell the web API to flip the grow room's plants to early_flower + add a Journal entry.
// We call the authenticated Nitro endpoint (x-auth-token = APP_PASSWORD) rather than touching
// the lab tables here, so all the append-only stage bookkeeping stays in one place.
async function syncLabRoomToFlower(roomId) {
  try {
    const port = process.env.NITRO_PORT || process.env.PORT || 3000;
    const token = process.env.APP_PASSWORD || '';
    const res = await fetch(`http://127.0.0.1:${port}/api/lab/rooms/${roomId}/flip-to-flower`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
      body: JSON.stringify({ note: 'Switched to 12/12 flowering (Flip to Flower)' })
    });
    if (!res.ok) {
      console.error(`[LightCycle] Lab sync HTTP ${res.status}`);
      return false;
    }
    const data = await res.json().catch(() => ({}));
    console.log(`[LightCycle] Lab synced — ${data.affected || 0} plant(s) → early_flower in room ${roomId}`);
    return true;
  } catch (err) {
    console.error('[LightCycle] Lab sync failed:', err.message);
    return false;
  }
}

async function processLightCycleTransitions() {
  const store = readLightTransitions();
  const keys = Object.keys(store.transitions);
  if (keys.length === 0) {
    if (darkTransitionActive) { darkTransitionActive = false; lastBlowerSpeed = null; }
    return;
  }
  const now = Date.now();
  let changed = false;
  let anyDark = false;

  for (const key of keys) {
    const t = store.transitions[key];
    if (!t) continue;

    if (t.status === 'scheduled') {
      if (now >= t.darkStartAt) {
        anyDark = true; // the dark window is active regardless of publish success (climate → night)
        // Only advance to 'dark' once the OFF payload is actually published — otherwise a momentary
        // MQTT disconnect would silently mark the transition started while the light stays ON. Staying
        // 'scheduled' retries every tick (this grow has documented proxy/mosquitto restarts).
        if (publishLightCycleConfig(t, t.darkConfig, 'Dark period started (lights OFF)')) {
          t.status = 'dark';
          t.darkAppliedAt = now;
          t.lastDarkAssertAt = now;
          changed = true;
          if (t.outlets && t.outlets.length) suppressTransitionOutlets(t);
        } else {
          console.warn(`[LightCycle] Dark-start publish failed for ${t.lightId} — MQTT down? Staying 'scheduled', retrying next tick.`);
        }
      }
    } else if (t.status === 'dark') {
      if (now >= t.flowerStartAt) {
        // Terminal flip. Only advance to 'done' (and run the one-shot day/night + Lab sync) once the
        // flower payload is CONFIRMED published — otherwise the device never receives 12/12, the UI
        // unlocks, Lab flips, but the light stays stuck OFF forever. Staying 'dark' retries next tick.
        if (publishLightCycleConfig(t, t.flowerConfig, `Flower 12/12 started (ON ${t.flowerOn}–${t.flowerOff})`)) {
          t.status = 'done';
          t.flowerAppliedAt = now;
          changed = true;
          if (t.outlets && t.outlets.length) restoreTransitionOutlets(t);
          if (t.syncDayNight) {
            try {
              await query(
                `INSERT INTO day_night_schedule (timestamp, day_start, day_end, source) VALUES (now(), $1, $2, 'flip')`,
                [t.flowerOn, t.flowerOff]
              );
              await loadDayNightSchedule();
              console.log(`[LightCycle] Climate day/night synced to ${t.flowerOn}–${t.flowerOff}`);
            } catch (err) {
              console.error('[LightCycle] day/night sync failed:', err.message);
            }
          }
          // Sync the Lab: flip the grow room's plants to early_flower + add a Journal entry.
          // Done via the authenticated Nitro endpoint so we reuse the lab data-model logic.
          if (t.roomId) {
            const synced = await syncLabRoomToFlower(t.roomId);
            if (synced) { t.labSyncedAt = now; }
          }
        } else {
          anyDark = true; // still in the dark window until the flip is confirmed
          console.warn(`[LightCycle] Flower-start publish failed for ${t.lightId} — MQTT down? Staying 'dark', light stays OFF, retrying next tick.`);
        }
      } else {
        anyDark = true;
        // Re-assert the OFF payload periodically so a device reboot or a missed message can't
        // accidentally let the lights come back on mid-transition. Outlet suppression rides the
        // SAME cadence (fast retry every tick while failing, then every DARK_REASSERT_MS once
        // stable) rather than its own — matches the light's philosophy of not spamming MQTT once
        // things are confirmed OFF, and gives a failed outlet publish a bounded retry window.
        if (!t.lastDarkAssertAt || (now - t.lastDarkAssertAt) >= DARK_REASSERT_MS) {
          if (publishLightCycleConfig(t, t.darkConfig, 'Dark re-assert (lights OFF)')) {
            t.lastDarkAssertAt = now;
            changed = true;
          }
          // publish failed → leave lastDarkAssertAt unchanged so we retry on the next tick
          if (t.outlets && t.outlets.length) suppressTransitionOutlets(t);
        }
      }
    }
  }

  // Toggle climate night-mode when entering/leaving dark; force a blower re-eval on change.
  if (anyDark !== darkTransitionActive) {
    darkTransitionActive = anyDark;
    lastBlowerSpeed = null;
    console.log(`[LightCycle] Dark transition ${anyDark ? 'ACTIVE — climate forced to NIGHT' : 'cleared'}`);
  }
  if (changed) writeLightTransitions(store);
}

/**
 * Load VPD config from the flow's vpd_control node
 */
let _lastVpdConfigSummary = '';
function loadVpdFromFlow() {
  const prevConfig = vpdNodeConfig;
  vpdNodeConfig = null;
  for (const flow of flows) {
    for (const node of flow.flow.nodes) {
      if (node.type === 'vpd_control') {
        vpdNodeConfig = node.data.config;
        const _summary = `${vpdNodeConfig.mode}|${vpdNodeConfig.roles?.length || 0}|${vpdNodeConfig.escalationTimeoutSeconds || 0}`;
        if (_summary !== _lastVpdConfigSummary) {
          _lastVpdConfigSummary = _summary;
          console.log('[Supervisor] VPD Control node found:', {
            mode: vpdNodeConfig.mode,
            roles: vpdNodeConfig.roles?.length || 0,
            timeout: vpdNodeConfig.escalationTimeoutSeconds
          });
        }
        // Audit dual-authority: a socket assigned to a VPD role AND targeted by a user action.
        validateVpdVsTriggers(vpdNodeConfig, flow.flow);

        // Detect config changes → reset escalation state so rules re-evaluate cleanly
        // This ensures that when the user changes temp ranges, stage, roles, etc.,
        // the system immediately adjusts instead of holding stale state.
        if (prevConfig) {
          const changed =
            JSON.stringify(prevConfig.idealDayTemp) !== JSON.stringify(vpdNodeConfig.idealDayTemp) ||
            JSON.stringify(prevConfig.idealNightTemp) !== JSON.stringify(vpdNodeConfig.idealNightTemp) ||
            prevConfig.selectedStage !== vpdNodeConfig.selectedStage ||
            prevConfig.mode !== vpdNodeConfig.mode ||
            JSON.stringify(prevConfig.manualTarget) !== JSON.stringify(vpdNodeConfig.manualTarget) ||
            JSON.stringify(prevConfig.roles?.map(r => r.role + r.socket)) !== JSON.stringify(vpdNodeConfig.roles?.map(r => r.role + r.socket));
          if (changed) {
            console.log('[Supervisor] VPD config changed — resetting escalation state');
            // Clear all VPD roles except circulator
            for (const key of Object.keys(vpdEscalationState.roles)) {
              if (key !== 'circulator') delete vpdEscalationState.roles[key];
            }
            // Reset blower overrides so next evaluation starts fresh
            vpdBlowerMinSpeed = 0;
            vpdBlowerMaxSpeed = 100;
            lastVpdLogKey = ''; // Force log on next eval
            // Reset ALL grace periods and timers — config changed, old state is irrelevant
            lastCoolingStopTime = 0;
            coolingBelowMaxSince = 0;
            coolingGraceStableStart = 0;
            cycleTransitionGraceActive = false;
          }
        }
        return;
      }
    }
  }

  // VPD node removed — clean up all state
  if (prevConfig && !vpdNodeConfig) {
    console.log('[Supervisor] VPD Control node removed — clearing state');
    for (const key of Object.keys(vpdEscalationState.roles)) {
      delete vpdEscalationState.roles[key];
    }
    vpdBlowerMinSpeed = 0;
    vpdBlowerMaxSpeed = 100;
    lastCoolingStopTime = 0;
  }
}

/**
 * Determine if current time is during the day period
 */
function getCurrentPeriod() {
  // During a flip-to-flower dark transition the lights are forced OFF, so the climate must
  // treat it as night (night targets, night leaf offset) regardless of the stored schedule.
  if (darkTransitionActive) return 'night';
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const hhmm = `${hh}:${mm}`;
  const dayStart = dayNightSchedule.dayStart;
  const dayEnd = dayNightSchedule.dayEnd;
  if (dayEnd > dayStart) {
    return hhmm >= dayStart && hhmm < dayEnd ? 'day' : 'night';
  }
  // Overnight schedule (e.g., 06:00 - 00:00)
  return hhmm >= dayStart || hhmm < dayEnd ? 'day' : 'night';
}

/**
 * Load Blower Curve config from the flow's blower_curve node
 * Merges period-specific curves (day/night) with general curves
 */
function loadBlowerCurveFromFlow() {
  const prevConfig = blowerCurveConfig;
  blowerCurveConfig = null;
  for (const flow of flows) {
    if (!flow.enabled) continue;
    for (const node of flow.flow.nodes) {
      if (node.type === 'blower_curve') {
        blowerCurveConfig = node.data.config;

        // Select period-appropriate curves (day or night)
        const period = getCurrentPeriod();
        const periodCurves = period === 'day'
          ? (blowerCurveConfig.dayCurves || [])
          : (blowerCurveConfig.nightCurves || []);

        blowerCurveConfig._activeCurves = periodCurves;

        // Reset curve escalation if config changed
        if (prevConfig && JSON.stringify(prevConfig.dayCurves) !== JSON.stringify(blowerCurveConfig.dayCurves) ||
            prevConfig && JSON.stringify(prevConfig.nightCurves) !== JSON.stringify(blowerCurveConfig.nightCurves) ||
            prevConfig && prevConfig.standbySpeed !== blowerCurveConfig.standbySpeed) {
          console.log('[Supervisor] Blower Curve config changed — resetting curve escalation');
          blowerCurveEscalationState = {};
          lastBlowerSpeed = null; // Force speed re-evaluation
        }

        console.log('[Supervisor] Blower Curve node found:', {
          standbySpeed: blowerCurveConfig.standbySpeed,
          period,
          activeCurves: blowerCurveConfig._activeCurves.map(c => c.sensor).join(', ') || 'none'
        });
        return;
      }
    }
  }

  // Blower curve removed — reset
  if (prevConfig && !blowerCurveConfig) {
    blowerCurveEscalationState = {};
    lastBlowerSpeed = null;
  }
}

/**
 * Map Laboratory plant status to VPD phase
 * Lab statuses are more granular, VPD phases are simpler
 */
// Built-in VPD stage reference data (from docs/VPD/vpd_cannabis_data.json)
const VPD_STAGES = [
  { key: 'clones',           min: 0.40, max: 0.70 },
  { key: 'seedling',         min: 0.60, max: 0.90 },
  { key: 'vegetative_early', min: 0.80, max: 1.00 },
  { key: 'vegetative_late',  min: 0.85, max: 1.10 },
  { key: 'transition',       min: 0.95, max: 1.15 },
  { key: 'flower_early',     min: 1.00, max: 1.20 },
  { key: 'flower_mid',       min: 1.10, max: 1.35 },
  { key: 'flower_late',      min: 1.20, max: 1.50 },
  { key: 'ripening',         min: 1.30, max: 1.60 },
];

const LAB_STATUS_TO_VPD_STAGE = {
  'germinating':  'clones',
  'seedling':     'seedling',
  'early_veg':    'vegetative_early',
  'mid_veg':      'vegetative_early',
  'late_veg':     'vegetative_late',
  'pre_flower':   'transition',
  'early_flower': 'flower_early',
  'mid_flower':   'flower_mid',
  'late_flower':  'flower_late',
  'flush':        'ripening',
  'harvest':      'ripening',
};

function mapLabStatusToVpdStage(labStatus) {
  return LAB_STATUS_TO_VPD_STAGE[labStatus] || null;
}

/**
 * Load active plant stage from Laboratory plants
 * Uses the most advanced stage among active plants
 */
async function loadActiveGrowPhase() {
  try {
    // Query lab_plants for active plants (not culled, archived)
    const rows = await query(`
      SELECT status
      FROM lab_plants
      WHERE status NOT IN ('culled', 'archived')
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    if (rows.length > 0) {
      const labStatus = rows[0].status;
      activeGrowPhase = mapLabStatusToVpdStage(labStatus);
    } else {
      activeGrowPhase = null;
    }
  } catch (err) {
    if (!err.message.includes('does not exist')) {
      console.error('[Supervisor] Failed to load plant stage:', err.message);
    }
  }
}

/**
 * Get current VPD target range based on mode and plant stage
 */
function getVpdTargetRange() {
  if (!vpdNodeConfig) return null;

  if (vpdNodeConfig.mode === 'manual') {
    return vpdNodeConfig.manualTarget;
  }

  // fixed_stage: use selectedStage directly from built-in targets
  if (vpdNodeConfig.mode === 'fixed_stage') {
    const stageKey = vpdNodeConfig.selectedStage;
    const stage = stageKey && VPD_STAGES.find(s => s.key === stageKey);
    return stage ? { min: stage.min, max: stage.max } : null;
  }

  // auto_stage (+ legacy plant_stage/grow_phase): selectedStage override → lab auto-detect → legacy fallback
  if (vpdNodeConfig.selectedStage) {
    const stage = VPD_STAGES.find(s => s.key === vpdNodeConfig.selectedStage);
    if (stage) return { min: stage.min, max: stage.max };
  }

  if (activeGrowPhase) {
    const stage = VPD_STAGES.find(s => s.key === activeGrowPhase);
    if (stage) return { min: stage.min, max: stage.max };
  }

  // Legacy fallback: old phaseTargets from config
  if (vpdNodeConfig.phaseTargets && activeGrowPhase) {
    const t = vpdNodeConfig.phaseTargets[activeGrowPhase];
    if (t && t.min > 0 && t.max > 0) return t;
  }

  return null;
}

/**
 * Resolve period ('day'/'night'/'custom') to actual start/end times
 */
function resolvePeriodTimes(period, startTime, endTime) {
  if (!period || period === 'custom') {
    return { startTime, endTime };
  }
  if (period === 'day') {
    return { startTime: dayNightSchedule.dayStart, endTime: dayNightSchedule.dayEnd };
  }
  if (period === 'night') {
    return { startTime: dayNightSchedule.dayEnd, endTime: dayNightSchedule.dayStart };
  }
  return { startTime, endTime };
}

/**
 * Check if current time is within a time range (handles overnight ranges)
 */
function isWithinTimeRange(startTime, endTime) {
  const now = new Date();
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
}

/**
 * Load the global automation configuration from database
 */
async function loadFlows() {
  try {
    // Load only the global configuration
    const rows = await query(`
      SELECT id, name, description, enabled, flow_json
      FROM automation_flows
      WHERE id = 'global'
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    if (rows.length > 0 && rows[0].enabled === 1) {
      const row = rows[0];
      flows = [{
        id: row.id,
        name: row.name,
        description: row.description,
        enabled: row.enabled === 1,
        flow: JSON.parse(row.flow_json || '{"nodes":[],"connections":[]}')
      }];
      // Prune persisted condition state for nodes that no longer exist in the flow
      const activeNodeIds = new Set(flows[0].flow.nodes.map(n => n.id));
      for (const k of persistedConditionState.keys()) {
        if (!activeNodeIds.has(k)) persistedConditionState.delete(k);
      }
      // Validate the graph: detect cycles (DFS + colouring) and dead actions.
      validateFlowGraph(flows[0].flow);
      console.log(`[Supervisor] Global automation loaded: ${flows[0].flow.nodes.length} nodes`);
    } else {
      flows = [];
      persistedConditionState.clear();
      console.log('[Supervisor] Global automation disabled or not found');
    }
  } catch (err) {
    console.error('[Supervisor] Failed to load flows:', err.message);
    // Keep existing flows if load fails
  }
}

/**
 * Load socket AI modes from database
 */
async function loadSocketAiModes() {
  try {
    // Load outlet AI modes (O1-O10)
    const rows = await query(`
      SELECT socket, ai_mode
      FROM socket_ai_mode
      LATEST ON timestamp PARTITION BY socket
    `);

    socketAiModes = {};
    for (let i = 1; i <= 10; i++) {
      socketAiModes[`O${i}`] = false;
    }
    for (const row of rows) {
      socketAiModes[row.socket] = row.ai_mode === 1;
    }

    // Load blower AI mode
    try {
      const blowerRows = await query(`
        SELECT ai_mode FROM blower_ai_mode
        LATEST ON timestamp PARTITION BY device
      `);
      socketAiModes['blower'] = blowerRows.length > 0 && blowerRows[0].ai_mode === 1;
    } catch { socketAiModes['blower'] = false; }

    // Load fan AI mode
    try {
      const fanRows = await query(`
        SELECT ai_mode FROM fan_ai_mode
        LATEST ON timestamp PARTITION BY device
      `);
      socketAiModes['fan'] = fanRows.length > 0 && fanRows[0].ai_mode === 1;
    } catch { socketAiModes['fan'] = false; }

    // Climate modules (heater, humidifier, dehumidifier) use socket_ai_mode table
    // with the module name as the socket key (set by VPD control node)
    // Already loaded above if they exist in socket_ai_mode.
    // Initialize to false if not present so triggers can check them.
    for (const mod of ['heater', 'humidifier', 'dehumidifier']) {
      if (socketAiModes[mod] === undefined) socketAiModes[mod] = false;
    }

    // Only log AI modes on actual change — was flooding every 30 s with identical lines.
    const _aiSummary = JSON.stringify(socketAiModes);
    if (_aiSummary !== _lastAiModeSummary) {
      _lastAiModeSummary = _aiSummary;
      console.log('[Supervisor] AI modes:', socketAiModes);
    }
  } catch (err) {
    console.error('[Supervisor] Failed to load AI modes:', err.message);
  }
}
let _lastAiModeSummary = '';

/**
 * Compare a sensor value against a threshold with an operator
 */
function compareValue(currentValue, operator, threshold, value, hysteresis) {
  switch (operator) {
    case '>': return currentValue > threshold;
    case '<': return currentValue < threshold;
    case '>=': return currentValue >= threshold;
    case '<=': return currentValue <= threshold;
    case '==': return Math.abs(currentValue - value) <= (hysteresis || 0.1);
    case '!=': return Math.abs(currentValue - value) > (hysteresis || 0.1);
    default: return false;
  }
}

/**
 * Evaluate a condition node against current sensor values
 * Supports timeSlots: each slot has its own period, time range, weekmask, operator, value, hysteresis
 * Supports multi-device: deviceMac specifies which device's sensor to read
 */
function evaluateCondition(config, wasActive = false) {
  const { sensor, deviceMac } = config;

  // Get sensor value from specific device or legacy global
  const sensorValues = getSensorValues(deviceMac);
  const currentValue = sensorValues[sensor];

  if (currentValue === undefined || currentValue === null || typeof currentValue !== 'number' || isNaN(currentValue) || !isFinite(currentValue)) {
    if (currentValue !== undefined && currentValue !== null) {
      console.error(`[SAFETY] Sensor "${sensor}" returned invalid value: ${currentValue} (${typeof currentValue}) — condition BLOCKED, check sensor hardware`);
    }
    return false;
  }

  // Sensor staleness check: if sensor data hasn't updated in 5+ min, warn and fail-safe
  const sensorAge = sensorValues._lastUpdate ? (Date.now() - sensorValues._lastUpdate) : 0;
  if (sensorAge > 5 * 60 * 1000 && sensorValues._lastUpdate) {
    console.warn(`[SAFETY] Sensor data is ${(sensorAge / 60000).toFixed(0)} min stale — condition BLOCKED for "${sensor}"`);
    return false;
  }

  // If timeSlots array exists, evaluate per-slot
  if (config.timeSlots && config.timeSlots.length > 0) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const ourDay = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    for (const slot of config.timeSlots) {
      // Check weekmask
      if (!(slot.weekmask & (1 << ourDay))) continue;

      // Resolve period to actual times
      const resolved = resolvePeriodTimes(slot.period, slot.startTime, slot.endTime);

      // Check time range (00:00-00:00 means 24h, always active)
      if (resolved.startTime && resolved.endTime) {
        const isFullDay = resolved.startTime === '00:00' && resolved.endTime === '00:00';
        if (!isFullDay && !isWithinTimeRange(resolved.startTime, resolved.endTime)) continue;
      }

      // This slot is active - evaluate the condition with its operator/value/hysteresis
      const { operator, value, hysteresis = 0 } = slot;
      let threshold = value;
      if (wasActive && hysteresis > 0) {
        if (operator === '>' || operator === '>=') {
          threshold = value - hysteresis;
        } else if (operator === '<' || operator === '<=') {
          threshold = value + hysteresis;
        }
      }

      return compareValue(currentValue, operator, threshold, value, hysteresis);
    }

    // No slot matched current time/day
    return false;
  }

  // Legacy flat config (backward compatibility)
  const { operator, value, hysteresis = 0 } = config;
  let threshold = value;
  if (wasActive && hysteresis > 0) {
    if (operator === '>' || operator === '>=') {
      threshold = value - hysteresis;
    } else if (operator === '<' || operator === '<=') {
      threshold = value + hysteresis;
    }
  }

  return compareValue(currentValue, operator, threshold, value, hysteresis);
}

/**
 * Evaluate a schedule node
 */
function evaluateSchedule(config) {
  const { scheduleType, startTime, endTime, weekmask = 127, intervalMinutes, durationSeconds } = config;
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday

  // Check weekmask (bit 0 = Monday, bit 6 = Sunday in our system)
  // Convert JS dayOfWeek (0=Sun) to our system (0=Mon)
  const ourDay = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  if (!(weekmask & (1 << ourDay))) {
    return false;
  }

  if (scheduleType === 'time_range') {
    // Resolve period to actual times
    const resolved = resolvePeriodTimes(config.period, startTime, endTime);
    if (!resolved.startTime || !resolved.endTime) return false;

    return isWithinTimeRange(resolved.startTime, resolved.endTime);
  }

  if (scheduleType === 'interval') {
    if (!intervalMinutes || !durationSeconds) return false;

    // Resolve active period to actual times
    const activeResolved = resolvePeriodTimes(
      config.activePeriod,
      config.activeStartTime || '00:00',
      config.activeEndTime || '23:59'
    );

    // Check if current time is within active hours
    if (!isWithinTimeRange(activeResolved.startTime, activeResolved.endTime)) return false;

    // Calculate position in interval cycle
    const totalSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const intervalSeconds = intervalMinutes * 60;
    const positionInCycle = totalSeconds % intervalSeconds;

    return positionInCycle < durationSeconds;
  }

  return false;
}

/**
 * Evaluate a state check node
 * Supports timeRestricted: only active during specified period/time range
 * Supports multi-device: deviceMac specifies which device's socket to check
 */
function evaluateStateCheck(config) {
  const { socket, checkState, timeRestricted, deviceMac } = config;

  // Get socket state from specific device or legacy global
  const currentState = getSocketState(deviceMac, socket);

  if (currentState === undefined) return false;

  let stateMatches = false;
  if (checkState === 'on') stateMatches = currentState === 1;
  else if (checkState === 'off') stateMatches = currentState === 0;

  if (!stateMatches) return false;

  // Apply time restriction if configured
  if (timeRestricted) {
    const resolved = resolvePeriodTimes(config.period, config.startTime, config.endTime);
    if (resolved.startTime && resolved.endTime) {
      const isFullDay = resolved.startTime === '00:00' && resolved.endTime === '00:00';
      if (!isFullDay && !isWithinTimeRange(resolved.startTime, resolved.endTime)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Validate the flow graph: detect cycles and unreachable nodes.
 * Logs warnings but does not mutate the flow — the BFS evaluator handles cycles
 * defensively via visited-set, but users should know if their flow is malformed.
 */
function validateFlowGraph(flow) {
  const nodes = flow?.nodes || [];
  const connections = flow?.connections || [];
  if (nodes.length === 0) return;

  const adj = new Map();
  for (const c of connections) {
    if (!adj.has(c.source)) adj.set(c.source, []);
    adj.get(c.source).push(c.target);
  }

  // DFS with white/grey/black colouring for cycle detection
  const color = new Map(); // 0=white, 1=grey (on stack), 2=black
  const inCycle = new Set();
  function dfs(u, path) {
    const s = color.get(u) || 0;
    if (s === 1) {
      const idx = path.indexOf(u);
      const cycle = idx >= 0 ? path.slice(idx).concat(u) : [u];
      for (const n of cycle) inCycle.add(n);
      return;
    }
    if (s === 2) return;
    color.set(u, 1);
    path.push(u);
    for (const v of (adj.get(u) || [])) dfs(v, path);
    path.pop();
    color.set(u, 2);
  }
  for (const n of nodes) if (!color.has(n.id)) dfs(n.id, []);

  if (inCycle.size > 0) {
    console.warn(`[Supervisor] Flow validation: ${inCycle.size} node(s) in cycle — [${[...inCycle].slice(0, 5).join(', ')}${inCycle.size > 5 ? '...' : ''}]. Cycles are not evaluated; fix wiring.`);
  }

  // Dead action detection: action nodes that can never be reached from any entry point.
  const hasIncoming = new Set(connections.map(c => c.target));
  const entries = nodes.filter(n => !hasIncoming.has(n.id)).map(n => n.id);
  const reachable = new Set();
  const stack = [...entries];
  while (stack.length) {
    const u = stack.pop();
    if (reachable.has(u)) continue;
    reachable.add(u);
    for (const v of (adj.get(u) || [])) if (!reachable.has(v)) stack.push(v);
  }
  const orphanActions = nodes.filter(n => n.type === 'action' && !reachable.has(n.id));
  if (orphanActions.length > 0) {
    console.warn(`[Supervisor] Flow validation: ${orphanActions.length} orphan action node(s) — [${orphanActions.map(n => `${n.data?.config?.socket}→${n.data?.config?.action}`).join(', ')}]. These actions will never fire.`);
  }

  // Mandatory-flag direction mismatch: mandatoryOn only has meaning on an action that
  // fires ON; mandatoryOff only on one that fires OFF. A user who ticks "Mandatory ON"
  // on an OFF action gets no priority and no error — silently confusing. Warn so they
  // can fix the wiring.
  const mismatched = nodes.filter(n => {
    if (n.type !== 'action') return false;
    const c = n.data?.config || {};
    return (c.action === 'off' && c.mandatoryOn) || (c.action === 'on' && c.mandatoryOff);
  });
  if (mismatched.length > 0) {
    console.warn(`[Supervisor] Flow validation: ${mismatched.length} action(s) with a mandatory flag that doesn't match their direction — [${mismatched.map(n => `${n.data?.config?.socket}:${n.data?.config?.action} has ${n.data?.config?.mandatoryOn ? 'mandatoryOn' : 'mandatoryOff'}`).join(', ')}]. The flag is ignored; mandatoryOn applies to ON actions, mandatoryOff to OFF actions.`);
  }

  // Invalid wiring: a connection whose target is a condition/schedule/state node's input. Those
  // node types are sensor/timer evaluators — they have no input (their state comes from the
  // sensor/clock). The flow editor allows you to draw such an edge anyway, which silently does
  // nothing. Surface it so the user can fix it.
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const NO_INPUT_TYPES = new Set(['condition', 'schedule', 'state']);
  const badEdges = connections.filter(c => {
    const tgt = nodeById.get(c.target);
    return tgt && NO_INPUT_TYPES.has(tgt.type);
  });
  if (badEdges.length > 0) {
    console.warn(`[Supervisor] Flow validation: ${badEdges.length} invalid edge(s) pointing INTO a sensor/schedule/state node — [${badEdges.map(e => `${e.source}(${e.sourceHandle || 'out'})→${e.target}`).slice(0, 5).join(', ')}]. These edges do nothing; the target evaluates only from its own sensor / timer / socket state.`);
  }

  // Mandatory flags on non-action nodes are misleading. The flag is honoured via inheritance
  // (action inherits from upstream logic/condition that has it set), but visually it lives in
  // the wrong place. Recommend moving it to the action node.
  const misplacedMandatory = nodes.filter(n => {
    if (n.type === 'action') return false;
    const c = n.data?.config || {};
    return c.mandatoryOn === true || c.mandatoryOff === true;
  });
  if (misplacedMandatory.length > 0) {
    console.warn(`[Supervisor] Flow validation: mandatoryOn/Off set on ${misplacedMandatory.length} non-action node(s) — [${misplacedMandatory.map(n => `${n.type} ${n.id.slice(0, 10)}`).join(', ')}]. Honoured via inheritance, but it is clearer to set the flag on the action node it feeds.`);
  }

  // Multiple action nodes targeting the same socket — likely intentional (ON + OFF triggers)
  // but worth surfacing in case the user accidentally duplicated a trigger.
  const socketActionCounts = new Map(); // socket -> [{id, action}]
  for (const n of nodes) {
    if (n.type !== 'action') continue;
    const s = n.data?.config?.socket;
    if (!s) continue;
    if (!socketActionCounts.has(s)) socketActionCounts.set(s, []);
    socketActionCounts.get(s).push({ id: n.id.slice(0, 10), action: n.data?.config?.action || '?' });
  }
  for (const [sock, list] of socketActionCounts) {
    if (list.length > 2) {
      console.warn(`[Supervisor] Flow validation: socket ${sock} is targeted by ${list.length} action nodes — [${list.map(l => `${l.id}:${l.action}`).join(', ')}]. Conflicts are resolved by precedence (mOff > mOn > on > off) but ${list.length}-way duplication is usually a mistake.`);
    }
  }
}

/**
 * Cross-validate VPD role assignments against user trigger actions. If a socket is both a VPD
 * role (humidifier / dehumidifier / extractor / heater) AND the explicit target of a user
 * trigger action, the two controllers compete on every cycle. The intent resolver picks a winner
 * but the user almost certainly intended a single source of authority — surface it so they can
 * either remove the VPD role or remove the user trigger.
 */
function validateVpdVsTriggers(vpdCfg, flow) {
  // Reset the resolution set each time the flow is reloaded — the user may have fixed the
  // conflict in the editor.
  dualAuthorityVpdWins = new Set();
  if (!vpdCfg || !Array.isArray(vpdCfg.roles)) return;
  const roleSockets = new Set();
  for (const r of vpdCfg.roles) {
    if (r && r.socket) roleSockets.add(r.socket);
  }
  const userActionSockets = new Set();
  for (const n of (flow?.nodes || [])) {
    if (n.type !== 'action') continue;
    const s = n.data?.config?.socket;
    if (s) userActionSockets.add(s);
  }
  const both = [...roleSockets].filter(s => userActionSockets.has(s));
  if (both.length > 0) {
    // Authoritatively pick the VPD role as the winner for these sockets. The action merger in
    // processSensorData() drops any user trigger actions targeting them, so the VPD algorithm
    // is the single source of truth and the two controllers cannot fight cycle after cycle.
    for (const s of both) dualAuthorityVpdWins.add(s);
    // Throttle the audit warning so it doesn't flood the error log every 30 s on reload.
    const now = Date.now();
    if (now - lastDualAuthorityWarnAt > 10 * 60 * 1000) {
      lastDualAuthorityWarnAt = now;
      console.warn(`[Supervisor] Config audit: socket(s) ${both.join(', ')} are claimed BOTH by a VPD role and by user trigger action(s). RESOLVED automatically — VPD role wins, user trigger actions for these sockets are dropped this cycle. To fully fix, remove the socket from the VPD role assignment OR remove the user trigger so only one controller manages it.`);
    }
  }
}

/**
 * Evaluate a logic gate node (AND/OR/NOT).
 *
 * An unconnected logic gate returns false — safer default for a grow system
 * (no action happens) than the mathematical identity, which would cause AND
 * with nothing attached to fire things unexpectedly on an empty flow.
 *
 * The operator falls back to AND when unknown so a corrupted flow still produces
 * deterministic output instead of silently returning false everywhere.
 */
function evaluateLogicGate(config, inputResults) {
  if (!inputResults || inputResults.length === 0) return false;
  const operator = (config?.operator || 'and').toLowerCase();

  if (operator === 'and') return inputResults.every(r => r === true);
  if (operator === 'or')  return inputResults.some(r => r === true);
  if (operator === 'not') return !inputResults.some(r => r === true);

  console.warn(`[Supervisor] Unknown logic operator "${operator}" — falling back to AND`);
  return inputResults.every(r => r === true);
}

/**
 * Evaluate a flow and determine actions to take
 */
function evaluateFlow(flow) {
  const { nodes, connections } = flow.flow;
  const actions = [];

  // Build adjacency list for graph traversal
  const adjacencyList = new Map();
  for (const conn of connections) {
    if (!adjacencyList.has(conn.source)) {
      adjacencyList.set(conn.source, []);
    }
    adjacencyList.get(conn.source).push(conn.target);
  }

  // Find entry nodes (nodes with no incoming connections)
  const hasIncoming = new Set(connections.map(c => c.target));
  const entryNodes = nodes.filter(n => !hasIncoming.has(n.id));

  // Track evaluation results
  const nodeResults = new Map();

  // Topological evaluation order (Kahn's algorithm). Guarantees every node is
  // evaluated only AFTER all of its inputs are ready. The previous BFS dequeued
  // nodes in discovery order, so a logic gate fed by branches of different depth
  // could be evaluated before one of its inputs existed — that input was then
  // silently dropped (`.filter(r => r !== undefined)`) and the AND/OR produced the
  // wrong result. Topological order eliminates that whole class of bug.
  const inDegree = new Map();
  for (const n of nodes) inDegree.set(n.id, 0);
  for (const c of connections) {
    if (inDegree.has(c.target)) inDegree.set(c.target, inDegree.get(c.target) + 1);
  }
  const ready = [...entryNodes];          // in-degree 0 == no incoming edges
  const evalOrder = [];
  const queued = new Set(entryNodes.map(n => n.id));
  while (ready.length > 0) {
    const node = ready.shift();
    evalOrder.push(node);
    for (const targetId of (adjacencyList.get(node.id) || [])) {
      if (!inDegree.has(targetId)) continue;
      inDegree.set(targetId, inDegree.get(targetId) - 1);
      if (inDegree.get(targetId) <= 0 && !queued.has(targetId)) {
        const tn = nodes.find(n => n.id === targetId);
        if (tn) { ready.push(tn); queued.add(targetId); }
      }
    }
  }
  // Nodes left out of evalOrder are part of a cycle — validateFlowGraph already
  // warned about them; they are intentionally not evaluated.

  for (const node of evalOrder) {
    let result = false;

    switch (node.type) {
      case 'condition':
        // Hysteresis needs the condition's active state from the PREVIOUS evaluation cycle,
        // not from earlier in the same cycle. We store it in the module-level
        // `persistedConditionState` map so it survives across evaluations.
        const wasActive = !!persistedConditionState.get(node.id);
        result = evaluateCondition(node.data.config, wasActive);
        persistedConditionState.set(node.id, result);
        nodeResults.set(`${node.id}:active`, result);
        break;

      case 'schedule':
        result = evaluateSchedule(node.data.config);
        break;

      case 'state':
        result = evaluateStateCheck(node.data.config);
        break;

      case 'logic':
        // Get all input results for this logic gate
        // Honour the ELSE handle here too. The action fan-in below inverts an 'else' edge
        // (fires when the source is false), but this logic fan-in used to read the raw upstream
        // value, so an ELSE edge feeding another IF delivered the NON-inverted result — while the
        // canvas animated that edge as active. "IF NOT(x) AND y" chains silently misfired.
        const logicInputs = connections
          .filter(c => c.target === node.id)
          .map(c => {
            const r = nodeResults.get(c.source);
            if (r === undefined) return undefined;
            const isElseHandle = c.sourceHandle === 'else' || c.sourceHandle === 'else-top';
            return isElseHandle ? r === false : r;
          })
          .filter(r => r !== undefined);
        result = evaluateLogicGate(node.data.config, logicInputs);

        // Apply time restriction if configured
        if (result && node.data.config.timeRestricted) {
          const resolved = resolvePeriodTimes(
            node.data.config.period,
            node.data.config.startTime,
            node.data.config.endTime
          );
          if (resolved.startTime && resolved.endTime) {
            result = isWithinTimeRange(resolved.startTime, resolved.endTime);
          }
        }
        break;

      case 'action':
        // An action fires when any incoming edge is "active":
        //  - THEN handle (default): upstream source result === true
        //  - ELSE handle:           upstream source result === false
        //
        // Mandatory flags on the action / inherited from upstream logic/condition nodes
        // are PRIORITY SIGNALS, not "else semantics":
        //  - mandatoryOn:  when the action fires ON, it wins over non-safety controllers
        //  - mandatoryOff: when the action fires OFF, it's an absolute brake (wins over
        //                  everything including mandatoryOn) — wire it to an ELSE edge
        //                  (or a safety condition) to get "force OFF when X".
        const incomingConnections = connections.filter(c => c.target === node.id);
        if (incomingConnections.length === 0) break;

        // Aggregate ALL incoming edges (not just first match) so we can detect
        // contradictory wiring (e.g. THEN-fire + ELSE-fire arriving at the same action).
        // Multi-edge fan-in semantics is "OR" (any active edge fires the action).
        let anyInputTrue = false;
        let thenFired = false;
        let elseFired = false;
        for (const c of incomingConnections) {
          const sourceResult = nodeResults.get(c.source);
          if (sourceResult === undefined) continue;
          const handle = c.sourceHandle;
          const isElseHandle = handle === 'else' || handle === 'else-top';
          if (isElseHandle && sourceResult === false) {
            anyInputTrue = true; elseFired = true;
          } else if (!isElseHandle && sourceResult === true) {
            anyInputTrue = true; thenFired = true;
          }
        }
        if (!anyInputTrue) {
          // Auto-release: when an ON action's upstream is no longer firing, emit a low-priority
          // OFF intent so the socket releases. Otherwise a Schedule pulse that fires ON for 120 s
          // would never get a corresponding OFF — the socket sticks ON forever (Eddie 2026-05-26:
          // O4 stuck ON for >2 h after the schedule pulse ended). The intent resolver still lets
          // VPD or other ON triggers override; this OFF is just "I'm not the one keeping it on".
          // The previous "do not synthesise opposite actions" comment was a workaround for OFF
          // spam in logs — fixed properly now by the resolver + already-in-state filter.
          const acfg = node.data?.config || {};
          if (acfg.action === 'on' && acfg.socket) {
            actions.push({
              deviceMac: acfg.deviceMac,
              socket: acfg.socket,
              action: 'off',
              mandatoryOn: false,
              mandatoryOff: false,
              reason: `Auto-release: upstream stopped firing (${node.id.slice(0, 14)})`
            });
          }
          break;
        }

        if (thenFired && elseFired) {
          console.warn(`[Supervisor] Flow ${flow.name}: action ${node.id} has BOTH a THEN and ELSE edge firing simultaneously — check wiring.`);
        }

        const {
          deviceMac: actionDeviceMac,
          socket,
          action: configuredAction,
          moduleSpeedMode,
          moduleSpeed,
          mandatoryOn: actionMandatoryOn,
          mandatoryOff: actionMandatoryOff
        } = node.data.config;

        // Inherit mandatoryOn/mandatoryOff from upstream logic/condition nodes so users
        // can configure priority at the logic level.
        let inheritedMandatoryOn = false;
        let inheritedMandatoryOff = false;
        for (const c of incomingConnections) {
          const sourceNode = nodes.find(n => n.id === c.source);
          if (!sourceNode) continue;
          const scfg = sourceNode.data?.config || {};
          if (scfg.mandatoryOn) inheritedMandatoryOn = true;
          if (scfg.mandatoryOff) inheritedMandatoryOff = true;
        }
        // Apply flags relative to the effective action: mandatoryOn only has meaning
        // when firing an ON; mandatoryOff only when firing an OFF.
        const isFiringOn = configuredAction === 'on';
        const mandatoryOn = isFiringOn && !!(actionMandatoryOn || inheritedMandatoryOn);
        const mandatoryOff = !isFiringOn && !!(actionMandatoryOff || inheritedMandatoryOff);

        // Build reason from connected conditions
        const reasons = [];
        for (const conn of incomingConnections) {
          const sourceNode = nodes.find(n => n.id === conn.source);
          if (sourceNode?.type === 'condition') {
            const cfg = sourceNode.data.config;
            const sensorVals = getSensorValues(cfg.deviceMac);
            const val = sensorVals[cfg.sensor];
            const slot = Array.isArray(cfg.timeSlots) ? cfg.timeSlots[0] : null;
            const op = slot?.operator ?? cfg.operator ?? '?';
            const tgt = slot?.value ?? cfg.value ?? '?';
            reasons.push(`${cfg.sensor} ${op} ${tgt} (actual: ${val})`);
          }
        }
        const reasonText = reasons.join(', ') || 'Condition met';

        actions.push({
          deviceMac: actionDeviceMac,
          socket,
          action: configuredAction,
          moduleSpeedMode,
          moduleSpeed,
          mandatoryOn,
          mandatoryOff,
          reason: reasonText
        });
        // Reflect the fired state in nodeResults so the visualization marks the
        // action node active without relying solely on the edge-trace below.
        result = anyInputTrue;
        break;
    }

    nodeResults.set(node.id, result);
  }

  // Build active edges: trace which connections carry a "true" signal
  // For THEN handles: active when source result is true
  // For ELSE handles: active when source result is false
  const activeNodeIds = [];
  const activeEdgeIds = [];
  for (const [nodeId, result] of nodeResults) {
    if (result === true) activeNodeIds.push(nodeId);
  }
  for (const conn of connections) {
    const sourceResult = nodeResults.get(conn.source);
    const handle = conn.sourceHandle;
    const isElse = handle === 'else' || handle === 'else-top';
    const active = isElse ? sourceResult === false : sourceResult === true;
    if (active) {
      activeEdgeIds.push(conn.id);
      // Also mark the target action node as active if this edge fires it
      const targetNode = nodes.find(n => n.id === conn.target);
      if (targetNode?.type === 'action' && !activeNodeIds.includes(conn.target)) {
        activeNodeIds.push(conn.target);
      }
    }
  }

  // Emit evaluation state for real-time UI visualization
  if (mqttClient && mqttClient.connected) {
    try {
      mqttClient.publish('ggs/system/trigger-eval', JSON.stringify({
        activeNodes: activeNodeIds,
        activeEdges: activeEdgeIds,
        timestamp: Date.now()
      }), { qos: 0, retain: true });
    } catch { /* ignore */ }
  }

  return actions;
}

/**
 * Send MQTT command to control a socket or module on a specific device
 * @param {string} deviceMac - Target device MAC (or null for default PS5)
 * @param {string} socket - Socket ID (O1-O10) or module name (blower, fan, heater, humidifier, dehumidifier)
 * @param {string} action - 'on' or 'off'
 * @param {object} opts - Module options: { moduleSpeedMode: 'auto'|'fixed', moduleSpeed: number }
 */
async function sendSocketCommand(deviceMac, socket, action, opts = {}) {
  if (!mqttClient || !mqttClient.connected) {
    console.error('[Supervisor] MQTT not connected');
    return false;
  }

  // Get device: explicit MAC > find by socket type > fallback
  const device = deviceMac ? getDevice(deviceMac) : (findDeviceForSocket(socket) || getDevice());
  if (!device) {
    console.error(`[Supervisor] No device found for socket ${socket} (MAC: ${deviceMac || 'auto'})`);
    return false;
  }

  const topic = `ggs/${device.type}/${device.mac}/cmd`;

  // Modules use keyPath ['device', moduleName] per Spider Farmer protocol.
  // Each module type needs safe defaults to avoid corrupting the device config
  // (setConfigField REPLACES the entire section).
  // Outlets use keyPath ['outlet', socketId].
  const onOff = action === 'on' ? 1 : 0;

  // Module speed logic:
  //   'auto' mode: set ON at minimum (25%), Blower Curve takes over within seconds
  //   'fixed' mode: set ON at user-specified speed
  //   no mode (VPD/legacy): preserve last known speed from cached state
  const cached = lastModuleConfigs[socket] || {};
  const moduleDefaults = {
    blower:        { mLevel: 50, minSpeed: 0, maxSpeed: 0, closeCO2: 0 },
    fan:           { mLevel: 5, minSpeed: 0, maxSpeed: 0, shakeLevel: 0, natural: 0 },
    heater:        { mLevel: 0 },
    humidifier:    { mLevel: 0 },
    dehumidifier:  { mLevel: 0 },
  };

  const isModule = socket in moduleDefaults;
  let moduleConfig = null;
  if (isModule) {
    const defaults = moduleDefaults[socket];
    moduleConfig = { modeType: 0, mOnOff: onOff };

    // Preserve all non-speed fields from cached state
    for (const key of Object.keys(defaults)) {
      if (key !== 'mLevel') {
        moduleConfig[key] = cached[key] ?? defaults[key];
      }
    }

    // Determine speed/level
    if (!onOff) {
      moduleConfig.mLevel = 0;
    } else if (opts.moduleSpeedMode === 'fixed' && opts.moduleSpeed > 0) {
      // Fixed: user-specified speed
      moduleConfig.mLevel = opts.moduleSpeed;
    } else if (opts.moduleSpeedMode === 'auto') {
      // Auto: minimum speed — Blower Curve / VPD optimizer takes over within seconds.
      // Eddie 2026-05-26: blower minimum lifted to 30 % because below that the blower barely
      // moves air. Fan stays at 1 (proven adequate for circulation).
      moduleConfig.mLevel = socket === 'fan' ? 1 : 30;
    } else {
      // No mode (VPD/legacy): for the blower, ALWAYS use a moderate default (50 %) regardless
      // of cached speed. Preserving a cached 100 % from a previous emergency causes the next
      // user-trigger ON to slam the blower at 100 %, crashing humidity below target in seconds
      // — Eddie 2026-05-27. The supervisor's own speed controller (BlowerCurve / VPD optimizer)
      // will adjust the speed within seconds if it has authority; if the user trigger is the
      // sole controller, 50 % is a sensible mid-point that moves real air without slamming.
      moduleConfig.mLevel = (socket === 'blower')
        ? 50
        : (cached.mLevel || cached.level || defaults.mLevel);
    }
    // Hard floor for the blower module — anything below 30 % is wasted current with no air
    // movement. Applies to ON commands only; the OFF path above set mLevel=0 explicitly.
    if (onOff && socket === 'blower' && moduleConfig.mLevel > 0 && moduleConfig.mLevel < 30) {
      moduleConfig.mLevel = 30;
    }
  }
  const command = {
    method: 'setConfigField',
    params: isModule
      ? {
          keyPath: ['device', socket],
          [socket]: moduleConfig
        }
      : {
          keyPath: ['outlet', socket],
          [socket]: { modeType: 0, mOnOff: onOff }
        },
    pid: device.mac,
    msgId: `${Date.now()}`,
    uid: device.uid,
    UTC: Math.floor(Date.now() / 1000)
  };

  return new Promise((resolve) => {
    mqttClient.publish(topic, JSON.stringify(command), (err) => {
      if (err) {
        console.error(`[Supervisor] Failed to send command to ${device.mac}:${socket}:`, err.message);
        resolve(false);
      } else {
        console.log(`[Supervisor] Sent ${action.toUpperCase()} to ${device.mac}:${socket}`);
        resolve(true);
      }
    });
  });
}

/**
 * Send a socket command with verification: after sending, wait for the device
 * to confirm the state change via MQTT status. If not confirmed within timeout,
 * retry up to MAX_RETRIES times. Critical for safety-critical OFF commands
 * (cycle transitions, emergencies) where a missed OFF can leave devices ON indefinitely.
 */
const VERIFY_TIMEOUT_MS = 15000; // 15s per attempt
const VERIFY_MAX_RETRIES = 3;

async function sendSocketCommandVerified(deviceMac, socket, action, opts = {}) {
  const targetState = action === 'on' ? 1 : 0;

  for (let attempt = 1; attempt <= VERIFY_MAX_RETRIES; attempt++) {
    const sent = await sendSocketCommand(deviceMac, socket, action, opts);
    if (!sent) {
      console.error(`[SAFETY] Command send failed for ${socket}→${action} (attempt ${attempt}/${VERIFY_MAX_RETRIES})`);
      continue;
    }

    // Wait for device to confirm state change
    const confirmed = await waitForStateConfirmation(socket, targetState, VERIFY_TIMEOUT_MS);
    if (confirmed) {
      if (attempt > 1) console.log(`[SAFETY] ${socket}→${action} confirmed after ${attempt} attempts`);
      return true;
    }

    console.warn(`[SAFETY] ${socket}→${action} NOT confirmed by device within ${VERIFY_TIMEOUT_MS / 1000}s (attempt ${attempt}/${VERIFY_MAX_RETRIES})`);
  }

  console.error(`[SAFETY] CRITICAL: ${socket}→${action} FAILED after ${VERIFY_MAX_RETRIES} retries — device may be stuck in wrong state!`);
  return false;
}

function waitForStateConfirmation(socket, targetState, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      // Check if device confirmed the state change (updated by MQTT status handler)
      const currentState = lastSocketStates[socket];
      if (currentState === targetState) {
        clearInterval(check);
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve(false);
      }
    }, 2000); // Check every 2s
  });
}

/**
 * Log execution to database
 * @param {string} triggerReason - Why the action was triggered
 * @param {string} deviceMac - Target device MAC (for multi-device)
 * @param {string} socket - Socket ID (O1-O5)
 * @param {string} action - 'on' or 'off'
 * @param {string} result - 'success' or 'error'
 */
async function logExecution(triggerReason, deviceMac, socket, action, result) {
  try {
    await query(`
      INSERT INTO trigger_execution_log (timestamp, flow_id, flow_name, trigger_reason, device_mac, socket, action, result, sensor_values)
      VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      'global',
      'Global Automation',
      triggerReason,
      deviceMac || defaultPrimaryMac || '',
      socket,
      action,
      result,
      JSON.stringify(lastSensorValues)
    ]);
  } catch (err) {
    console.error('[Supervisor] Failed to log execution:', err.message);
  }
}

/**
 * Resolve conflicting intents per socket BEFORE executing them.
 *
 * Background: each cycle, the system collects intent from multiple sources — user trigger flow,
 * VPD algorithmic control, schedule pulses, cycle-transition logic — and pushes them all into
 * `actions[]`. Before this resolver, the executor processed each one sequentially and relied on a
 * `userMandatoryOnUntil` *hold map* (30 min, then 90 s) to "remember" that a mandatoryOn was set
 * earlier and suppress later OFFs. That created month-long pain: the hold was either too long
 * (sockets stuck ON 30 min after a 120 s schedule pulse) or too short (safety triggers turned off
 * instantly because the actionKey didn't match across cycles).
 *
 * New model — IN-CYCLE INTENT RESOLUTION. The trigger that's firing in *this* cycle is the
 * source of truth. If the user trigger fires ON this cycle, that's the intent. If next cycle the
 * trigger's upstream condition is false, no ON is fired → only the VPD/algorithm intent remains
 * → the system naturally relaxes. No cross-cycle hold needed. Conflicts within the same cycle are
 * resolved by precedence (mandatoryOff > mandatoryOn > regular ON > regular OFF).
 *
 * This makes the system "self-healing": there is no stale state in hold maps that can desync.
 * Editor mistakes (e.g. action with mandatoryOn on an OFF action) become impossible to chain into
 * weeks-long zombies — they only affect the cycle in which they fire.
 */
function resolveSocketIntents(actions) {
  const groups = new Map();
  for (const a of actions) {
    if (!a || !a.socket) continue;
    const key = (a.deviceMac || 'NOMAC') + ':' + a.socket;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const winners = [];
  for (const [key, intents] of groups) {
    if (intents.length === 1) {
      winners.push(intents[0]);
      continue;
    }

    // Precedence: mandatoryOff > mandatoryOn > regular ON > regular OFF.
    // Within each tier we pick the FIRST occurrence — flow processing order is stable.
    const mOff = intents.find(i => i.action === 'off' && i.mandatoryOff === true);
    const mOn  = intents.find(i => i.action === 'on'  && i.mandatoryOn  === true);
    const rOn  = intents.find(i => i.action === 'on');
    const rOff = intents.find(i => i.action === 'off');
    const winner = mOff || mOn || rOn || rOff;
    if (!winner) continue;

    // Log the conflict so dashboards / debugging surface the resolution choice.
    const summary = intents.map(i => `${i.action}${i.mandatoryOff ? '!!' : ''}${i.mandatoryOn ? '!' : ''}(${(i.reason || '?').slice(0, 40)})`).join(' vs ');
    const winnerTag = winner.mandatoryOff ? 'mOff' : (winner.mandatoryOn ? 'mOn' : winner.action);
    console.log(`[Supervisor] Intent conflict on ${key}: ${summary} → ${winnerTag} wins`);

    winners.push({
      ...winner,
      reason: `[${intents.length}-way resolution, ${winnerTag} wins] ${winner.reason || ''}`.trim()
    });
  }

  // ── Cross-device mutex: humidifier vs extractor never run together ──
  // Humidifier (adds moisture) and extractor/blower (removes moisture) are physically opposed.
  // Running both wastes water + power and produces no net change. The per-socket resolver
  // above can't see this — it works one socket at a time. Sweep the winners and, if we have
  // BOTH a humidifier-ON winner AND an extractor-ON winner this cycle, drop the lower-priority
  // one. mandatoryOn wins over regular; among equal priority, the extractor wins (humi reduction
  // is usually more time-critical than addition).
  // Sockets recognised as "humidifier" / "extractor" come from the VPD Control role assignment
  // — the user is expected to declare which physical socket plays which role there.
  if (vpdNodeConfig && Array.isArray(vpdNodeConfig.roles)) {
    const humSocks = new Set();
    const extSocks = new Set();
    for (const r of vpdNodeConfig.roles) {
      if (!r || !r.socket) continue;
      if (r.role === 'humidifier') humSocks.add(r.socket);
      // 'extractor' / 'dehumidifier' both REMOVE moisture from the perspective of humi target.
      if (r.role === 'extractor' || r.role === 'dehumidifier') extSocks.add(r.socket);
    }
    const humOn = winners.find(w => w.action === 'on' && humSocks.has(w.socket));
    const extOn = winners.find(w => w.action === 'on' && extSocks.has(w.socket));
    if (humOn && extOn) {
      const humPri = humOn.mandatoryOn ? 2 : 1;
      const extPri = extOn.mandatoryOn ? 2 : 1;
      // Tie-break favours extractor — humidity excess is a faster mold/VPD risk than dryness.
      const dropHum = extPri >= humPri;
      const dropped = dropHum ? humOn : extOn;
      const kept = dropHum ? extOn : humOn;
      console.log(`[Supervisor] Cross-device mutex: ${dropped.socket}=on AND ${kept.socket}=on cannot coexist — dropping ${dropped.socket}=on (${dropped.mandatoryOn ? 'mOn' : 'on'}) in favour of ${kept.socket}=on (${kept.mandatoryOn ? 'mOn' : 'on'}).`);
      // Replace the dropped intent with an OFF for the same socket so the device actually turns off.
      const idx = winners.indexOf(dropped);
      winners[idx] = {
        ...dropped,
        action: 'off',
        mandatoryOn: false,
        mandatoryOff: false,
        reason: `Cross-device mutex: yielded to ${kept.socket}=on`
      };
    }
  }

  return winners;
}

/**
 * Execute actions with cooldown (supports multi-device)
 */
async function executeActions(actions) {
  const now = Date.now();

  // Collapse multi-source conflicts BEFORE per-action processing. After this loop, each socket
  // has at most one intent per cycle, which is the only one we ever send to the device.
  const resolvedActions = resolveSocketIntents(actions);

  for (const action of resolvedActions) {
    const { socket, action: targetAction, reason, moduleSpeedMode, moduleSpeed } = action;
    // Normalise the action's MAC so cooldown keys, state writes and the defaultPrimaryMac
    // comparison all line up with the (lower-cased) registry + per-device stores.
    const deviceMac = normMac(action.deviceMac);

    // Use device-specific key for cooldown tracking
    const actionKey = deviceMac ? `${deviceMac}:${socket}` : socket;
    const lastTime = lastActionTimes[actionKey] || 0;

    // ── Anti-oscillation toggle guard ──
    // Track recent state-changes per socket. If a socket has toggled more than TOGGLE_MAX_PER_WINDOW
    // times within TOGGLE_WINDOW_MS, lock its current state for TOGGLE_LOCK_DURATION_MS. This breaks
    // pathological fast oscillation (O3 had 326 events in one day on 2026-05-30) and gives the
    // upstream cause time to settle (typically a controller fighting another controller). Safety/
    // emergency actions bypass the lock — we never block a forced OFF.
    const toggleKey = actionKey;
    const isSafetyOrEmergency = action.mandatoryOff === true
      || (reason && (reason.includes('SAFETY') || reason.includes('EMERGENCY') || reason.includes('cycle transition')));
    const lockedUntil = socketLockedUntil[toggleKey] || 0;
    if (!isSafetyOrEmergency && now < lockedUntil) {
      // Locked — skip this action; the previous logic-storm will resolve in the lock window
      continue;
    }

    // SAFETY check: only execute if we're authorized to control this socket.
    //  - VPD / SAFETY / cycle-transition actions: always execute (validated upstream).
    //  - HEATER / HUMIDIFIER / DEHUMIDIFIER modules: always execute when a trigger targets them —
    //    no user-facing manual firmware mode to protect, and they're driven by the VPD controller.
    //  - BLOWER / FAN: gated like outlets (2026-06-28). Unlike the three above, they DO have a user
    //    manual mode + their own blower_ai_mode / fan_ai_mode flag, so a forgotten/old trigger action
    //    must NOT override a manual dashboard command — require the flag, exactly like an outlet.
    //  - Outlets (O1-O10): require the socket to be in AI/trigger mode. Prevents a
    //    forgotten/old trigger from overriding an outlet the user put in Environment or
    //    TimeSlot mode manually.
    //  - mandatoryOff/mandatoryOn actions: always execute (explicit user intent).
    const isVpdOrSafety = reason && (reason.startsWith('VPD:') || reason.includes('SAFETY') || reason.includes('cycle transition'));
    const isModule = ['heater', 'humidifier', 'dehumidifier'].includes(socket);
    const aiModeKey = deviceMac ? `${deviceMac}:${socket}` : socket;
    const authorizedOutlet = socketAiModes[aiModeKey] || socketAiModes[socket];
    if (!isVpdOrSafety && !isModule && !action.mandatoryOff && !action.mandatoryOn && !authorizedOutlet) {
      continue; // Not authorized: outlet, or blower/fan not in AI/Trigger mode — don't touch manual config
    }

    // Get current state from device-specific storage or legacy
    const currentState = getSocketState(deviceMac, socket);
    const targetState = targetAction === 'on' ? 1 : 0;

    // Honour user intent holds before VPD/automation OFFs. SAFETY/cycle-transition/EMERGENCY OFFs
    // and explicit mandatoryOff still pass through — only "routine" VPD/automation OFFs are held.
    const isHardOff = action.mandatoryOff === true
      || (reason && (reason.includes('SAFETY') || reason.includes('cycle transition') || reason.includes('EMERGENCY')));
    // (The auto-detected manualOverride hold was removed long ago; device non-compliance is
    // handled by ROLE_UNRESPONSIVE_BACKOFF_MS in activate/deactivateSocketRole. True manual UI
    // toggles get re-OFF'd within seconds — switch the outlet to a non-AI firmware mode to retain
    // manual control. The dead mirror state that fed the old hold was deleted in the P3 #12 audit.)

    // Skip if already in desired state
    if (currentState === targetState) {
      // Log occasionally so we know triggers ARE evaluating even when state matches
      if (now % 60000 < 15000) { // Log once per minute
        console.log(`[Supervisor] ${socket} already ${targetAction} (state=${currentState}), skipping | ${reason || ''}`);
      }
      continue;
    }
    console.log(`[Supervisor] Executing: ${socket} → ${targetAction} (was ${currentState}) | ${reason || 'no reason'}`);

    // Check cooldown. Climate hardware (humidifier/dehumidifier — usually a pump or compressor)
    // must not be cycled every few seconds: inrush current and short-cycling damage the device.
    // The 5 s global floor is fine for solid-state outlets but far too short for these, so apply
    // a longer per-role dwell to the humidifier/dehumidifier role sockets (audit P1 #5). A genuine
    // mandatoryOff / safety brake still passes (it's handled before this point only for the lock,
    // but the dwell here is a routine guard — emergencies use the verified path regardless).
    const isSlowClimateSocket = vpdNodeConfig && Array.isArray(vpdNodeConfig.roles)
      && vpdNodeConfig.roles.some(r => (r.role === 'humidifier' || r.role === 'dehumidifier') && r.socket === socket);
    const dwellMs = (isSlowClimateSocket && !action.mandatoryOff) ? SLOW_CLIMATE_DWELL_MS : HYSTERESIS_COOLDOWN_MS;
    if (now - lastTime < dwellMs) {
      if (now % 60000 < 1000) console.log(`[Supervisor] Dwell active for ${actionKey} (${Math.round((dwellMs - (now - lastTime)) / 1000)}s left), skipping`);
      continue;
    }

    // Execute command. Use the verified (retry-until-confirmed) path for any action
    // that the system considers safety-critical, so a silently-dropped MQTT message
    // cannot leave a dangerous device in the wrong state:
    //  - OFF commands with VPD/cycle-transition/EMERGENCY/SAFETY reason (system safety)
    //  - any action with mandatoryOff (user-declared brake)
    //  - any action carrying mandatoryOn on an ON command (user-declared priority)
    //  - safety timeout forced OFFs (action.mandatoryOff is already set upstream)
    const reasonSafety = reason && (
      reason.includes('cycle transition')
      || reason.includes('EMERGENCY')
      || reason.includes('SAFETY')
      || reason.startsWith('VPD:')
    );
    const isSafetyCritical = (targetAction === 'off' && reasonSafety)
      || action.mandatoryOff === true
      || (action.mandatoryOn === true && targetAction === 'on');
    const success = isSafetyCritical
      ? await sendSocketCommandVerified(deviceMac, socket, targetAction, { moduleSpeedMode, moduleSpeed })
      : await sendSocketCommand(deviceMac, socket, targetAction, { moduleSpeedMode, moduleSpeed });

    if (success) {
      lastActionTimes[actionKey] = now;
      // ── Anti-oscillation: track this toggle and lock if storm detected ──
      // We're only tracking ACTUAL state changes here (we passed the "skip if already in
      // desired state" gate above). The toggleHistory keeps the last TOGGLE_WINDOW_MS of
      // change timestamps, and we engage a lock as soon as it overflows.
      const hist = socketToggleHistory[toggleKey] || [];
      while (hist.length && (now - hist[0]) > TOGGLE_WINDOW_MS) hist.shift();
      hist.push(now);
      socketToggleHistory[toggleKey] = hist;
      if (hist.length > TOGGLE_MAX_PER_WINDOW) {
        socketLockedUntil[toggleKey] = now + TOGGLE_LOCK_DURATION_MS;
        console.warn(`[Supervisor] Anti-oscillation: ${toggleKey} toggled ${hist.length} times in ${(TOGGLE_WINDOW_MS / 60000).toFixed(0)} min — LOCKING at "${targetAction}" for ${(TOGGLE_LOCK_DURATION_MS / 60000).toFixed(0)} min. Investigate the controllers fighting over this socket.`);
        // Clear history so we don't re-trigger immediately after the lock expires.
        socketToggleHistory[toggleKey] = [];
      }

      // Track ON/OFF time for safety timeouts
      if (targetState === 1) {
        if (!deviceOnSince[socket]) deviceOnSince[socket] = now;
      } else {
        deviceOnSince[socket] = null;
      }

      // Update both per-device and legacy state
      if (deviceMac) {
        if (!socketStatesByDevice.has(deviceMac)) {
          socketStatesByDevice.set(deviceMac, {});
        }
        socketStatesByDevice.get(deviceMac)[socket] = targetState;
      }
      if (!deviceMac || deviceMac === defaultPrimaryMac) {
        lastSocketStates[socket] = targetState;
      }

      const triggerReason = reason || `temp=${lastSensorValues.temp}, humi=${lastSensorValues.humi}`;
      await logExecution(triggerReason, deviceMac, socket, targetAction, 'success');
    } else {
      await logExecution('Command failed', deviceMac, socket, targetAction, 'error');
    }
  }
}

/**
 * Temperature-first, humidity-second VPD auto-calibration engine
 *
 * Priority: maintain ideal air temperature, then adapt humidity to achieve target VPD.
 *
 * Rules:
 * 1. Temp > idealMax (and no heater grace) → Blower ON. Stops at idealMax. Cooler if maxed.
 * 2. Humidity low → Humidifier ON, cap blower (unless temp needs it).
 * 3. Temp < idealMin → Heater ON.
 * 4. Humidity > idealMax (humidifier off) → Blower ON (force extraction).
 * 5. Blower ON + temp drops → Heater ON to compensate.
 * 6. Everything in range → all devices OFF, blower OFF. Let environment settle.
 */
function evaluateVpdIntelligent() {
  // Default to "cooling not futile" so any early return below leaves a genuine thermal emergency
  // free to drive the blower to 100 % in the send path. Only the full evaluation can set it true.
  vpdTempCoolingFutile = false;
  if (!vpdNodeConfig || !vpdNodeConfig.roles || vpdNodeConfig.roles.length === 0) return [];

  // Use the explicitly-configured sensor device if set; otherwise lock onto a STABLE primary
  // climate sensor (resolvePrimarySensorMac) instead of the merged last-writer blob, which
  // alternates between multiple devices' readings and destabilises the entire control loop.
  const sensorMac = vpdNodeConfig.sensorDeviceMac || resolvePrimarySensorMac();
  const sensorValues = getSensorValues(sensorMac);
  const temp = sensorValues.temp;
  const humi = sensorValues.humi;
  if (temp == null || humi == null) return [];

  // ── Sensor freshness guard ──
  // If sensor data is stale (>90 s old), the values may not reflect reality. Suppress any NEW
  // role activations — we don't want to escalate / activate based on a snapshot of conditions
  // that no longer exists. Existing roles continue to run (the device is already in a state;
  // abrupt deactivation on a missed reading is worse than over-shooting briefly). The sensor
  // watchdog at 5 min still triggers full restart if data is truly dead.
  const sensorAge = sensorValues._lastUpdate ? (Date.now() - sensorValues._lastUpdate) : 0;
  if (sensorAge > 120 * 1000) {
    if (sensorAge > 5 * 60 * 1000) {
      // Truly stale → clamp the blower to a MOULD-SAFE gentle extraction (not 0, not the last
      // value). Leaving it at the last value would let the heartbeat re-publish a stale speed
      // (e.g. a stale 100 % cooling) on conditions that no longer exist. But 0 % was WRONG for a
      // flowering room: a long sensor gap with the exhaust fully OFF lets humidity build → mould /
      // botrytis (Eddie 2026-06-03: a ~1.5 h MQTT dropout, 09:56-11:32, let humi climb 63→70 %
      // unmonitored with the blower off). A fixed, moderate, CAPPED extraction keeps air moving and
      // sheds moisture without acting on a stale snapshot — the safe blind default for a humid-
      // prone room is "gently vent", not "seal it up". The watchdog still restarts us to recover.
      vpdBlowerMinSpeed = STALE_SAFE_BLOWER_SPEED;
      vpdBlowerMaxSpeed = STALE_SAFE_BLOWER_SPEED;
      return [];
    }
    // Mild staleness: continue evaluating to keep existing roles ticking, but don't open new
    // activations. Implement by short-circuiting the activate* helpers further down — flag here.
    vpdEscalationState._suppressNewActivations = true;
  } else {
    vpdEscalationState._suppressNewActivations = false;
  }

  // Feed the trend buffer so anticipatory logic below has recent history.
  pushTrendSample(temp, humi);

  const currentVpd = calculateLeafVpd(temp, humi);
  if (currentVpd == null || currentVpd <= 0) return [];

  const target = getVpdTargetRange();
  if (!target) return [];

  const { min: targetMin, max: targetMax } = target;
  const actions = [];
  const now = Date.now();
  // Ideal temperature range (day/night). These are `let` because a suppressed cycle transition
  // (cooldown guard below) FREEZES the effective period to the previous one so control parameters
  // don't flap every cycle while a spurious schedule/clock oscillation settles.
  let currentPeriod = getCurrentPeriod();
  let isDaytime = currentPeriod === 'day';
  // Algorithm-owned band (NOT the manual config — see TEMP_BAND_* rationale). Float within it,
  // VPD via humidity; cool/heat only outside it; hard safety at TEMP_SAFE_MIN/MAX.
  let idealTemp = isDaytime ? TEMP_BAND_DAY : TEMP_BAND_NIGHT;

  // ── Cycle Transition Grace Period ──
  // When day↔night changes, STOP ALL active devices and let the environment adjust naturally.
  // Lights off → temp drops on its own. Lights on → temp rises on its own.
  // The old code only suppressed NEW actions but didn't stop RUNNING devices.
  // Now: on transition, we actively turn OFF everything, reset blower, and wait.
  if (lastKnownPeriod !== null && lastKnownPeriod !== currentPeriod) {
    // ── Cooldown guard ──
    // A flapping schedule loader (defaults vs DB row oscillating at boot or whenever the row
    // changes timestamp) used to cascade 20+ transitions in minutes. Reject any transition that
    // arrives less than CYCLE_TRANSITION_MIN_INTERVAL_MS after the previous one — that pattern
    // is impossible in real life (day/night flips at most twice per 24 h, separated by hours).
    const sinceLast = lastCycleTransitionAt > 0 ? (now - lastCycleTransitionAt) : Infinity;
    if (sinceLast < CYCLE_TRANSITION_MIN_INTERVAL_MS) {
      console.warn(`[VPD] Cycle transition ${lastKnownPeriod}→${currentPeriod} SUPPRESSED: only ${(sinceLast / 60000).toFixed(1)} min since last transition (min ${CYCLE_TRANSITION_MIN_INTERVAL_MS / 60000} min). Probable schedule/clock flapping. Freezing to previous period.`);
      // FREEZE: revert the effective period to the previous one for the REST of this evaluation,
      // so idealTemp / humidity targets / cooling thresholds stay consistent instead of flapping
      // every 30 s. Critically, we do NOT advance lastKnownPeriod — the fall-through guard below
      // sees currentPeriod === lastKnownPeriod and leaves it untouched. (Previous bug: the
      // fall-through advanced lastKnownPeriod anyway, silently defeating the freeze and letting
      // idealTemp swing day↔night every cycle.)
      currentPeriod = lastKnownPeriod;
      isDaytime = currentPeriod === 'day';
      idealTemp = isDaytime ? TEMP_BAND_DAY : TEMP_BAND_NIGHT;
    } else {
      // Transition just detected — STOP ALL devices immediately
      cycleTransitionTime = now;
      cycleTransitionTempAtStart = temp;
      cycleTransitionHumiAtStart = humi;
      cycleTransitionLastCheck = now;
      cycleTransitionLastTemp = temp;
      cycleTransitionLastHumi = humi;
      cycleTransitionGraceActive = true;
      cycleTransitionDirection = (currentPeriod === 'night') ? 'cooling' : 'warming';
      lastCycleTransitionAt = now;
      console.log(`[VPD] Cycle transition ${lastKnownPeriod}→${currentPeriod}: STOPPING all devices, grace period started (${cycleTransitionDirection}, ${temp.toFixed(1)}°C → ${idealTemp.min}-${idealTemp.max}°C)`);

      // Kill all active roles — devices must stop to let environment settle
      for (const key of Object.keys(vpdEscalationState.roles)) {
        delete vpdEscalationState.roles[key];
      }
      // Reset blower to OFF
      vpdBlowerMinSpeed = 0;
      vpdBlowerMaxSpeed = 0; // Ceiling 0 = blower OFF
      // Set thermal inertia timestamps so grace periods work correctly after transition
      lastHeaterOffTime = now;
      lastHumidifierOffTime = now;
      // Reset all grace/timeout state from previous period
      lastCoolingStopTime = 0;
      coolingBelowMaxSince = 0;
      coolingGraceStableStart = 0;
      lastVpdLogKey = '';

      // Build OFF actions for all assigned roles
      const transitionOffActions = [];
      for (const role of (vpdNodeConfig.roles || [])) {
        if (role.socket && role.socket !== 'blower') {
          const aiModeKey = role.deviceMac ? `${role.deviceMac}:${role.socket}` : role.socket;
          if (socketAiModes[aiModeKey] || socketAiModes[role.socket]) {
            transitionOffActions.push({ deviceMac: role.deviceMac, socket: role.socket, action: 'off', reason: 'VPD: cycle transition — letting environment settle' });
            console.log(`[VPD] Cycle transition: → ${role.role} OFF (${role.socket})`);
          }
        }
      }
      lastKnownPeriod = currentPeriod;
      saveSupervisorState();
      return transitionOffActions; // Send OFF commands, then suppress until grace ends
    }
  }
  if (lastKnownPeriod !== currentPeriod) {
    lastKnownPeriod = currentPeriod;
    saveSupervisorState();
  }

  // Evaluate grace period if active
  if (cycleTransitionGraceActive) {
    // ── Hard watchdog ──
    // If grace was somehow set without a fresh cycleTransitionTime (e.g. state corruption,
    // bug elsewhere), or if grace lasts longer than the hard ceiling for any reason, force
    // it clear. Otherwise a stuck grace locks the blower at 0 indefinitely while the room
    // overheats — Eddie 2026-05-30, blower OFF for 3 h after a cycle transition cascade.
    const graceAge = cycleTransitionTime > 0 ? (now - cycleTransitionTime) : Infinity;
    if (graceAge > CYCLE_TRANSITION_GRACE_HARD_MAX_MS || cycleTransitionTime === 0) {
      cycleTransitionGraceActive = false;
      vpdBlowerMaxSpeed = 100;
      console.warn(`[VPD] Cycle transition grace watchdog: force-cleared after ${(graceAge / 60000).toFixed(1)} min (hard max ${CYCLE_TRANSITION_GRACE_HARD_MAX_MS / 60000} min). Resuming normal control.`);
    }
  }
  if (cycleTransitionGraceActive) {
    // Keep blower OFF during grace
    vpdBlowerMinSpeed = 0;
    vpdBlowerMaxSpeed = 0;

    const elapsed = now - cycleTransitionTime;
    const sinceLastCheck = now - cycleTransitionLastCheck;

    // ── Emergency override: if temp or humi drift into danger during grace,
    // bail out of grace immediately and resume normal control. Grace is a
    // convenience for smooth transitions, not a safety lock.
    const earlyTempEmerg = temp >= TEMP_SAFE_MAX || temp <= TEMP_SAFE_MIN;
    const earlyHumiEmerg = humi > 85;
    if (earlyTempEmerg || earlyHumiEmerg) {
      cycleTransitionGraceActive = false;
      console.log(`[VPD] Cycle transition: EMERGENCY override (temp=${temp.toFixed(1)}°C, humi=${humi.toFixed(0)}%) — grace aborted, resuming control`);
      vpdBlowerMaxSpeed = 100;
    }
    // Past a band EDGE → cooling/heating is needed NOW; grace must not keep the blower off. A lights-ON
    // transition sends the foco's heat straight up THROUGH the band top, and the grace's trend check treats
    // a rising temp "favorable" (drifting toward the warm band) so it waited the full ~20 min while the room
    // baked 25→26.6°C (Eddie 2026-06-21). Aborting on the band edge resumes cooling within one cycle (~30s).
    if (cycleTransitionGraceActive && (temp > idealTemp.max || temp < idealTemp.min)) {
      cycleTransitionGraceActive = false;
      vpdBlowerMaxSpeed = 100;
      console.log(`[VPD] Cycle transition: temp ${temp.toFixed(1)}°C past band [${idealTemp.min}-${idealTemp.max}] — grace aborted, resuming control now.`);
    }

    if (elapsed >= CYCLE_TRANSITION_GRACE_MS) {
      cycleTransitionGraceActive = false;
      console.log(`[VPD] Cycle transition grace ended (${(elapsed / 60000).toFixed(0)}min elapsed) — resuming control with ${currentPeriod} parameters`);
    } else if (sinceLastCheck >= TREND_CHECK_INTERVAL_MS) {
      const tempDelta = temp - cycleTransitionLastTemp;
      cycleTransitionLastCheck = now;
      cycleTransitionLastTemp = temp;
      cycleTransitionLastHumi = humi;

      const wantCooling = cycleTransitionDirection === 'cooling';
      const tempMovingRight = wantCooling ? (tempDelta < -TREND_MIN_CHANGE * 0.3) : (tempDelta > TREND_MIN_CHANGE * 0.3);
      const tempMovingWrong = wantCooling ? (tempDelta > TREND_MIN_CHANGE * 0.5) : (tempDelta < -TREND_MIN_CHANGE * 0.5);
      const tempStagnant = !tempMovingRight && !tempMovingWrong;
      const tempAlreadyInRange = temp >= idealTemp.min && temp <= idealTemp.max;

      if (tempAlreadyInRange) {
        cycleTransitionGraceActive = false;
        console.log(`[VPD] Cycle transition: temp ${temp.toFixed(1)}°C in range [${idealTemp.min}-${idealTemp.max}], grace ended early`);
      } else if (tempMovingWrong) {
        cycleTransitionGraceActive = false;
        console.log(`[VPD] Cycle transition: ADVERSE trend (temp Δ${tempDelta > 0 ? '+' : ''}${tempDelta.toFixed(1)}°C in 5min, want ${wantCooling ? 'cooling' : 'warming'}), grace ended — resuming control`);
      } else if (tempStagnant) {
        cycleTransitionGraceActive = false;
        console.log(`[VPD] Cycle transition: STAGNANT (temp Δ${tempDelta > 0 ? '+' : ''}${tempDelta.toFixed(1)}°C in 5min), grace ended — resuming control`);
      } else {
        console.log(`[VPD] Cycle transition: favorable trend (temp ${temp.toFixed(1)}°C, Δ${tempDelta > 0 ? '+' : ''}${tempDelta.toFixed(1)}°C, ${((CYCLE_TRANSITION_GRACE_MS - elapsed) / 60000).toFixed(0)}min remaining)`);
      }
    }

    if (cycleTransitionGraceActive) {
      return []; // Suppress all actions while grace is active
    }
    // Grace just ended — blower ceiling restored, normal evaluation continues below
    vpdBlowerMaxSpeed = 100;
  }

  // Calculate ideal humidity from VPD target at CURRENT temperature
  // Leaf VPD = SVP(T_leaf) - SVP(T_air) × (RH/100)
  // → RH = (SVP(T_leaf) - VPD) / SVP(T_air) × 100
  const leafTemp = temp - getLeafOffset();
  const svpLeaf = svp(leafTemp);
  const svpAir = svp(temp);
  // Mold-safety cap (80 %, was 90 %): now that temperature floats within a wider band, hitting a
  // low-VPD stage target at the warm end could otherwise demand 80 %+ RH — mold/bud-rot territory.
  // 80 % is a safe universal ceiling: clones/seedlings (which want the highest RH) tolerate it, and
  // flower stages stay well below it via their own higher VPD targets. If VPD can't be reached
  // without exceeding 80 %, we accept a slightly higher (drier) VPD rather than a dangerous humidity.
  const HUMI_MOLD_CAP = 80;
  const idealHumiMax = Math.min(HUMI_MOLD_CAP, (svpLeaf - targetMin) / svpAir * 100); // low VPD → high humi limit
  const idealHumiMin = Math.max(30, (svpLeaf - targetMax) / svpAir * 100); // high VPD → low humi limit
  // Target humidity = midpoint VPD → this is WHERE we want humidity to converge
  const vpdTarget = (targetMin + targetMax) / 2;
  const idealHumiTarget = Math.max(idealHumiMin, Math.min(idealHumiMax, (svpLeaf - vpdTarget) / svpAir * 100));

  // Grace periods — after device off, let residual effects settle naturally
  // Heater grace: ONLY while temp is still below idealTemp.max.
  // If temp crosses max during grace, abort immediately — cooling is needed, not grace.
  const heaterRecentlyOff = (now - lastHeaterOffTime) < HEATER_GRACE_MS && temp < idealTemp.max;
  const humidifierRecentlyOff = (now - lastHumidifierOffTime) < HUMIDIFIER_GRACE_MS;

  // ── ACTIVATION thresholds (with hysteresis dead band) ──
  // Devices activate when exceeding target + hysteresis margin.
  // Prevents oscillation with 2min heater grace: heater off → grace suppresses cooling → temp settles.
  const tempHighThreshold = idealTemp.max; // Cooling starts immediately when temp exceeds max (no hysteresis — continuation logic prevents oscillation)
  const tempLowThreshold = idealTemp.min - TEMP_LOW_HYSTERESIS;  // e.g., 24-0.5=23.5°C

  // Humidity thresholds — humidifier ON at humiLowThreshold, OFF at idealHumiMin+1 (see RULE 2).
  // ON edge = idealHumiMin (the band FLOOR / VPD band max). This humidifier is powerful + laggy:
  // one ~75 s pulse keeps raising humidity for minutes after it's commanded off, overshooting ~+7 %
  // (Eddie 2026-06-02: ON at 61 → peaked 69 %). So we deliberately re-arm at the LOW edge of the
  // band — the inevitable overshoot then lands near the HIGH edge (idealHumiMax) instead of sailing
  // past it into too-humid/VPD-below-band. Net swing ≈ idealHumiMin→idealHumiMax = VPD inside the
  // band on both ends. (re-arm at idealHumiMin−2 overshot to 69 % / VPD 0.92; idealHumiMin−4 dried
  // to 59 % / VPD 1.24. idealHumiMin threads it.)
  // The value band is intentionally narrow (~1 %) for that lag-compensation, so noise immunity is
  // TIME-based instead: the humidifier is a slow-climate socket, so SLOW_CLIMATE_DWELL_MS bounds how
  // often the relay can toggle (a wider value band would re-break the overshoot landing point).
  const humiLowThreshold = idealHumiMin;
  const humiHighThreshold = idealHumiMax + 4; // 4% above ideal max (absorbs post-humidifier overshoot)

  // Emergency humidity flag — critically above max, overrides safety margins
  // In emergencies: skip humidifier grace period, skip tempSafeForBlower, skip dehumidifier wait
  const humiEmergency = humi > idealHumiMax + 15 || humi > 85;

  // Emergency temperature flag — temp at the HARD safety ceiling (30 °C). At this point cooling is
  // forced regardless of futility/grace/VPD-gate (heat danger outranks every optimisation). The
  // soft cooling zone (above the band but below this) is normal, futility-suppressible cooling.
  const tempEmergency = temp >= TEMP_SAFE_MAX;

  // ── LEAF VPD GUARDS ──
  // Critical (mold risk territory): VPD is far below targetMin → force aggressive
  //   action even when discrete temp/humi flags don't trip.
  // BelowTarget (sub-optimal): VPD is below targetMin but not yet critical. Keep
  //   extraction running rather than stopping at the first sign of temp dip — the
  //   goal is to land in the [targetMin, targetMax] band, not just escape "red".
  const leafVpdCritical = currentVpd > 0 && currentVpd < (targetMin - 0.15);
  const leafVpdBelowTarget = currentVpd > 0 && currentVpd < targetMin;

  // ── Anticipatory cooling ──
  // Detect fast-rising temperatures so we can start cooling BEFORE reaching the limit.
  // Rationale: mechanical response is not instant; if temp is climbing at ≥ 0.3°C/min
  // and we're within 0.5°C of idealMax, start cooling now. This avoids the emergency
  // path and reduces big on/off oscillations.
  const tempTrend = computeTrend('temp', 5 * 60 * 1000); // Δ per minute over last 5 min
  const tempRisingFast = tempTrend.samples >= 3
    && tempTrend.perMin >= 0.3
    && temp >= idealTemp.max - 0.5;

  // Activation conditions (first trigger — require exceeding hysteresis threshold)
  // tempEmergency bypasses heater grace — safety takes priority over preventing oscillation
  // tempRisingFast pre-activates cooling before crossing the hard threshold.
  const tempHigh = (temp > tempHighThreshold || tempRisingFast)
    && (!heaterRecentlyOff || tempEmergency); // Suppress cooling during heater grace (unless emergency)
  // tempLow with continuation hysteresis: once heater is active, keep it active until
  // temp reaches idealMin (already handled separately). The flap we're avoiding here is
  // the state-flag itself (TL ↔ T_) bouncing at exactly the threshold every cycle from
  // 0.1 °C sensor noise. Add a 0.3 °C upward dead band so once we drop below threshold,
  // we need to recover to threshold + 0.3 to clear the flag.
  const tempLow = temp < tempLowThreshold || (vpdEscalationState.tempLowSticky && temp < tempLowThreshold + 0.3);
  vpdEscalationState.tempLowSticky = tempLow;
  const humiLow = humi < humiLowThreshold;
  // Leaf VPD critical → escalate humidity as if it were high (even inside the +4% hysteresis).
  const humiHigh = humi > humiHighThreshold || (leafVpdCritical && humi > idealHumiMax);

  // Continuation flags — already-active devices keep running until reaching target (no hysteresis on deactivation)
  const coolingActive = !!vpdEscalationState.roles['extractor_temp'];
  const humiExtractionActive = !!vpdEscalationState.roles['extractor_humi'];

  // ── DEACTIVATION thresholds (at target, instant, no hysteresis) ──
  const tempInRange = temp >= idealTemp.min && temp <= idealTemp.max;
  // humiOk = humi is genuinely at the sweet spot. Only inside [target-1, target+1] does
  // RULE 6 conclude "nobody needs to do anything". Eddie 2026-05-29: a wider `min..target`
  // window flagged humi at min as "OK" and RULE 6 deactivated the humidifier that had just
  // turned on to reach target — humi never converged, just bounced between min and target.
  // Now both controllers (humidifier driving humi UP, extractor driving humi DOWN) keep
  // running until humi is genuinely at the sweet spot.
  const humiOk = humi >= idealHumiTarget - 1 && humi <= idealHumiTarget + 1;

  // ── SEQUENTIAL CLIMATE PHASE ──
  // Pick exactly one of {extracting, heating, idle} for the heater/extractor pair.
  // Energy-efficient ALTERNATION when both metrics are mildly off.
  // BUT: when humidity is critically high (mold risk / leaf VPD red zone) we lock to
  // extracting and let Rule 5 (below) bring the heater along as a co-pilot — the
  // user has explicitly authorised heater→O5 and would rather pay extra power than
  // let leaf VPD sit at 0.4 for hours (incident 2026-05-19).
  // Heater effectiveness self-test (must be computed BEFORE phase logic, which
  // gates `needsHeating` on it). When the heater is ON, we expect temp to rise
  // within HEATER_EFFECT_CHECK_MS by at least HEATER_EFFECT_MIN_RISE. If it
  // doesn't, the heater is plugged out / undersized / fighting thermal mass —
  // declare it ineffective for a cooldown and switch lever (drop humi).
  const heaterRoleActive = !!vpdEscalationState.roles['heater'];
  if (heaterRoleActive && heaterEvalStartTime === 0) {
    heaterEvalStartTime = now;
    heaterEvalStartTemp = temp;
  } else if (!heaterRoleActive && heaterEvalStartTime !== 0) {
    heaterEvalStartTime = 0;
  }
  if (heaterRoleActive && heaterEvalStartTime > 0
      && (now - heaterEvalStartTime) >= HEATER_EFFECT_CHECK_MS) {
    const rise = temp - heaterEvalStartTemp;
    if (rise < HEATER_EFFECT_MIN_RISE) {
      heaterIneffectiveUntil = now + HEATER_INEFFECTIVE_COOLDOWN_MS;
      console.log(`[VPD] Heater INEFFECTIVE: +${rise.toFixed(2)}°C in ${(HEATER_EFFECT_CHECK_MS / 60000).toFixed(0)} min (expected ≥ ${HEATER_EFFECT_MIN_RISE}°C). Skipping heater for ${(HEATER_INEFFECTIVE_COOLDOWN_MS / 60000).toFixed(0)} min — switching strategy to humidity extraction.`);
      heaterEvalStartTime = 0;
    } else {
      heaterEvalStartTime = now;
      heaterEvalStartTemp = temp;
    }
  }
  const heaterIneffective = now < heaterIneffectiveUntil;

  // Humidifier "dry tank" self-test (mirror of the heater pattern). If humi doesn't rise while
  // the humidifier is ON, assume an empty tank → suspend humidifier for a cooldown, and let the
  // plants' transpiration + reduced blower extraction recover humi naturally. Re-test after the
  // cooldown so a refilled tank gets picked up automatically.
  //
  // CRITICAL HARDENING (Eddie 2026-05-30 incident): the previous code reset the eval window
  // when extractor became active, which caught contemporaneous extraction but NOT a window
  // where extractor activated and deactivated within the 10-min interval (leaving stale data
  // for the rise check). Now we track an explicit "contaminated" flag that survives until the
  // window is rebuilt from scratch with extractor confirmed off the entire time.
  const humidifierRoleActive = !!vpdEscalationState.roles['humidifier'];
  // Treat extraction-flavoured roles as contaminating the DRY test — they pull humidity out and
  // would mask the humidifier's rise, producing a false "DRY tank" verdict (Eddie 2026-05-30:
  // humi 41% post-cooling). extractor_humi / extractor (socket) always contaminate. extractor_temp
  // (proportional cooling) ONLY contaminates when the blower was ACTUALLY running high — during a
  // humidity-yield hold the cooling role lingers nominally but the blower sits at idle 30 %, which
  // is gentle enough that a working humidifier still raises humi, so the DRY test should run (so an
  // empty tank during a yield is still caught and releases the yield).
  const extractorRoleActiveNow = !!vpdEscalationState.roles['extractor_humi']
    || !!vpdEscalationState.roles['extractor']
    || (!!vpdEscalationState.roles['extractor_temp'] && (lastBlowerSpeed ?? 0) > VPD_BLOWER_IDLE_SPEED + 5);
  if (humidifierRoleActive && humidifierEvalStartTime === 0) {
    // Only start a fresh eval window if extraction is OFF right now — otherwise wait until it's off.
    if (!extractorRoleActiveNow) {
      humidifierEvalStartTime = now;
      humidifierEvalStartHumi = humi;
      vpdEscalationState.humidifierEvalContaminated = false;
    }
  } else if (!humidifierRoleActive && humidifierEvalStartTime !== 0) {
    humidifierEvalStartTime = 0;
    vpdEscalationState.humidifierEvalContaminated = false;
  }
  // Mark the window as contaminated if ANY exhaust is moving air — even the idle baseline (~30%)
  // vents the humidifier's vapour about as fast as it accumulates (verified 2026-05-31), so a
  // "no rise" verdict while the blower runs is meaningless. The old guard only counted the
  // extractor ROLE at >idle+5, so a baseline blower silently masked the rise and the test cried
  // "tank empty" on a FULL tank (2026-06-02 — Eddie confirmed water present; humidity WAS rising
  // from the humidifier, the exhaust just hid it). Only judge the pump when the exhaust is off.
  const exhaustMaskingNow = extractorRoleActiveNow || (lastBlowerSpeed ?? 0) >= VPD_BLOWER_IDLE_SPEED;
  if (humidifierEvalStartTime > 0 && exhaustMaskingNow) {
    if (!vpdEscalationState.humidifierEvalContaminated) {
      console.log('[VPD] Humidifier DRY self-test: window contaminated by concurrent extraction — will restart fresh once extraction clears');
    }
    vpdEscalationState.humidifierEvalContaminated = true;
    // Push the start forward so we don't accidentally end the window while extraction is running
    humidifierEvalStartTime = now;
    humidifierEvalStartHumi = humi;
  }
  if (humidifierRoleActive && humidifierEvalStartTime > 0
      && (now - humidifierEvalStartTime) >= HUMIDIFIER_EFFECT_CHECK_MS) {
    if (vpdEscalationState.humidifierEvalContaminated) {
      // Window was contaminated by extraction — restart it fresh now (extractor is currently off
      // since extractorRoleActiveNow check above would have pushed start forward otherwise).
      humidifierEvalStartTime = now;
      humidifierEvalStartHumi = humi;
      vpdEscalationState.humidifierEvalContaminated = false;
      console.log('[VPD] Humidifier DRY self-test: previous window discarded (contaminated). New window starting fresh.');
    } else {
      const rise = humi - humidifierEvalStartHumi;
      // A real empty tank makes humidity FALL while the pump runs (exhaust already excluded by the
      // contamination guard above). A WORKING pump that's merely slow, or one already at its ceiling
      // in dry ambient, holds or rises only a little — that is NOT "empty". The old test ("rise <
      // 1%") false-flagged both cases (humidifier takes minutes to show, doubled if the blower ran —
      // Eddie 2026-06-02 confirmed a full tank flagged empty). So only declare it empty on a clear
      // DECLINE; otherwise keep trusting it.
      if (rise < -HUMIDIFIER_EFFECT_MIN_RISE) {
        humidifierIneffectiveUntil = now + HUMIDIFIER_INEFFECTIVE_COOLDOWN_MS;
        humidifierIneffectiveStartHumi = humi;
        saveSupervisorState();
        console.log(`[VPD] Humidifier INEFFECTIVE: humi FELL ${rise.toFixed(2)}% in ${(HUMIDIFIER_EFFECT_CHECK_MS / 60000).toFixed(0)} min with exhaust off — tank likely empty. Resting it ${(HUMIDIFIER_INEFFECTIVE_COOLDOWN_MS / 60000).toFixed(0)} min (it still runs whenever humi is below target; refill to restore full effect).`);
        humidifierEvalStartTime = 0;
      } else {
        humidifierEvalStartTime = now;
        humidifierEvalStartHumi = humi;
      }
    }
  }
  // Early-clear: if humi has recovered substantially from the marked-ineffective value, the
  // lockout is no longer warranted — clear it so the humidifier can resume work if needed.
  // This also covers the case where the user refilled the tank during the cooldown.
  if (now < humidifierIneffectiveUntil
      && humidifierIneffectiveStartHumi != null
      && humi >= humidifierIneffectiveStartHumi + HUMIDIFIER_INEFFECTIVE_RECOVERY_RISE) {
    console.log(`[VPD] Humidifier lockout CLEARED early: humi recovered ${humi.toFixed(0)}% from ${humidifierIneffectiveStartHumi.toFixed(0)}% — re-test allowed.`);
    humidifierIneffectiveUntil = 0;
    humidifierIneffectiveStartHumi = null;
    saveSupervisorState();
  }
  const humidifierIneffective = now < humidifierIneffectiveUntil;

  const humiExcess = Math.max(0, humi - idealHumiMax);
  const tempDeficit = Math.max(0, idealTemp.min - temp);
  // Hysteresis around leafVpd's targetMin — without it, currentVpd oscillating across the
  // boundary (e.g. 0.94 ↔ 0.95) flipped phase every 10s and cycled dehumidifier + blower curve
  // constantly. Enter "extracting" only when CLEARLY below; exit only when CLEARLY above.
  const VPD_PHASE_HYST = 0.05;
  const leafVpdBelowTargetHyst = vpdPhase === 'extracting'
    ? currentVpd > 0 && currentVpd < targetMin + VPD_PHASE_HYST  // stay extracting until clearly above
    : currentVpd > 0 && currentVpd < targetMin - VPD_PHASE_HYST; // start extracting only when clearly below
  // Mirror: extraction would lower humi, which RAISES VPD. If leafVPD is already ABOVE the
  // upper band (too dry), extracting would push us further from target. (Eddie 2026-05-25:
  // "no hay heater, debería estar humidificando para bajar el VPD" — algorithm was extracting
  // because humi > absolute max, ignoring that the action would worsen the VPD it's meant to fix.)
  // Hysteresis around targetMax using a dedicated flag — vpdPhase ('extracting' / 'heating' /
  // 'idle') is a poor proxy for "currently humidifying for VPD reasons", which made the veto
  // engage at 1.10 instead of waiting for 1.20+ (Eddie 2026-05-25: humidifier kicked at 1.12).
  if (vpdEscalationState.humidifyMode === undefined) vpdEscalationState.humidifyMode = false;
  const _inHumidifyMode = vpdEscalationState.humidifyMode;
  const leafVpdAboveTargetHyst = _inHumidifyMode
    ? currentVpd > targetMax - VPD_PHASE_HYST  // already humidifying — stay until clearly back in band (≤1.10)
    : currentVpd > targetMax + VPD_PHASE_HYST; // not humidifying — enter only when clearly above (>1.20)
  vpdEscalationState.humidifyMode = leafVpdAboveTargetHyst;
  // VETO extraction when VPD is too high — humidification (below) is the right lever instead.
  // Eddie 2026-05-28: enter the extracting phase as soon as humi drifts above target (with a
  // small deadband to avoid jitter), not just when it exceeds the absolute ceiling. Otherwise
  // the optimizer never gets a chance to start escalating speed until humi is already in trouble.
  // humiAboveTarget keeps the phase machine in 'extracting' through a WIDE deadband — the
  // role deactivation at line ~3146 uses `humi <= target-3`, so the phase machine has to
  // agree with that or line 3166's `!phaseExtracting && humiExtractionActive` will wipe the
  // role first. Setting humiAboveTarget at target-2 (= 59 for target=61) gives both gates a
  // common range — phase stays extracting between target-2 and infinity, role persists.
  const humiAboveTarget = humi > idealHumiTarget - 2;
  const needsExtraction = !leafVpdAboveTargetHyst && (humiExcess > 2 || leafVpdBelowTargetHyst || humiAboveTarget);
  const needsHeating = tempDeficit > 0.3 && !heaterIneffective;
  let nextPhase = vpdPhase;
  if (!needsExtraction && !needsHeating) {
    nextPhase = 'idle';
  } else if (needsExtraction && !needsHeating) {
    nextPhase = 'extracting';
  } else if (!needsExtraction && needsHeating) {
    nextPhase = 'heating';
  } else {
    // BOTH levers would help. We do NOT blindly alternate on a timer — that reset the
    // blower speed optimizer every 12 min and stalled the de-escalation hunt (the
    // blower "got stuck" at a mid speed; incident 2026-05-20).
    //
    // Policy: EXTRACTION IS PRIMARY while humidity is above its target. Lowering humi
    // directly raises VPD and removes mold risk, and lets the blower optimizer run
    // continuously toward its minimum effective speed. Heating is the SECONDARY lever,
    // used only once humidity is satisfied but temperature still drags VPD down.
    // (Energy note: the heater never runs alongside the blower, so there's no waste —
    // we simply prioritise the lever that's actively needed.)
    if (needsExtraction) nextPhase = 'extracting';
    else nextPhase = 'heating';
  }
  if (nextPhase !== vpdPhase) {
    console.log(`[VPD] Phase: ${vpdPhase} → ${nextPhase} (humi excess ${humiExcess.toFixed(1)}%, temp deficit ${tempDeficit.toFixed(1)}°C${humiEmergency ? ', HUMI_EMERG' : ''})`);
    vpdPhase = nextPhase;
    vpdPhaseStartedAt = now;
  }
  const phaseExtracting = vpdPhase === 'extracting';
  const phaseHeating = vpdPhase === 'heating';

  // Track when extraction stops so we can grace the heater immediately after
  // (residual lamp heat carries temp up without spending power on a heater).
  if (!phaseExtracting && vpdEscalationState.wasExtracting) {
    lastExtractionStopTime = now;
  }
  vpdEscalationState.wasExtracting = phaseExtracting;
  const inPostExtractionGrace = lastExtractionStopTime > 0
    && (now - lastExtractionStopTime) < POST_EXTRACTION_HEATER_GRACE_MS;

  // Heater authorisation lifted to function scope so phase / co-pilot logic and
  // the substitution rule below share one definition.
  const _hasHeaterRole = (() => { const a = vpdNodeConfig.roles.find(r => r.role === 'heater'); return !!(a && a.socket); })();
  const heaterAuthorised = (() => {
    if (!_hasHeaterRole) return false;
    const a = vpdNodeConfig.roles.find(r => r.role === 'heater');
    const k = a.deviceMac ? `${a.deviceMac}:${a.socket}` : a.socket;
    return !!(socketAiModes[k] || socketAiModes[a.socket]);
  })();

  // Throttled log — only print when conditions change
  const graceFlags = `${heaterRecentlyOff ? 'Hgrace' : ''}${humidifierRecentlyOff ? 'Ugrace' : ''}`;
  const curState = `${tempHigh ? 'TH' : tempLow ? 'TL' : (coolingActive && temp > idealTemp.max) ? 'Tc' : 'T_'}|${humiLow ? 'HL' : humiHigh ? 'HH' : (humiExtractionActive && humi > idealHumiMax) ? 'Hc' : 'H_'}`;
  const logKey = `${curState}|${graceFlags}|${humiEmergency ? 'hE' : ''}${tempEmergency ? 'tE' : ''}|${currentVpd.toFixed(1)}|${temp.toFixed(0)}|${Math.round(humi/2)}`;
  if (logKey !== lastVpdLogKey) {
    lastVpdLogKey = logKey;
    const anticFlag = tempRisingFast ? ` TREND+${tempTrend.perMin.toFixed(2)}/min` : '';
    // Compute air VPD alongside leaf VPD so the operator can verify both numbers — the UI shows air
    // VPD but the controller acts on leaf VPD. Printing them side-by-side avoids the "VPD high in
    // UI but supervisor doing the opposite" confusion (Eddie 2026-05-25).
    const _airVpd = svpAir - svpAir * (humi / 100);
    console.log(`[VPD] leaf ${currentVpd.toFixed(2)} kPa (air ${_airVpd.toFixed(2)}, Δ${(_airVpd - currentVpd).toFixed(2)} via leaf-offset ${getLeafOffset().toFixed(1)}°C) (${targetMin.toFixed(2)}-${targetMax.toFixed(2)}, target ${vpdTarget.toFixed(2)}) | T:${temp.toFixed(1)}°C (${idealTemp.min}-${idealTemp.max}, cool@${tempHighThreshold}, heat@${tempLowThreshold.toFixed(1)}) H:${humi.toFixed(0)}% (${idealHumiMin.toFixed(0)}-[${idealHumiTarget.toFixed(0)}]-${idealHumiMax.toFixed(0)}%) | ${curState}${graceFlags ? ' ' + graceFlags : ''}${tempEmergency ? ' TEMP_EMERG' : ''}${humiEmergency ? ' HUMI_EMERG' : ''}${coolingActive ? ' COOLING' : ''}${humiExtractionActive ? ' HEXT' : ''}${anticFlag}`);
  }

  // Track condition changes for escalation reset
  const prevState = vpdEscalationState.conditions || '';
  if (curState !== prevState) {
    console.log(`[VPD] Conditions changed: ${prevState || 'none'} → ${curState}`);
    vpdEscalationState.conditions = curState;
  }

  // --- Helpers ---

  function getRoleAssignment(roleName) {
    const assignment = vpdNodeConfig.roles.find(r => r.role === roleName);
    return assignment ? { socket: assignment.socket, deviceMac: assignment.deviceMac } : null;
  }

  const extAssignment = getRoleAssignment('extractor');
  const extIsBlower = extAssignment && extAssignment.socket === 'blower';

  // ── Target-anchored, capacity-aware speed controller ──
  // The control objective is ABSOLUTE: keep the metric (humidity / temperature) at or
  // just under its target ceiling (idealHumiMax / idealTemp.max). Comparing against the
  // target — not against recent history — is what makes it immune to slow drift: if the
  // metric creeps up 0.5 %/20 min the relative delta per check is invisible, but the
  // distance-from-target keeps growing, so the controller still reacts. It can never
  // "accept" 60 % as fine when the target is 53 %.
  //
  // Behaviour:
  //   • metric > target + DEAD  → push harder (escalate), unless we've proven the
  //                               equipment is at its desaturation capacity here.
  //   • metric < target − EASE  → headroom to spare → ease power off to save energy.
  //   • within the deadband     → sweet spot, hold steady.
  // Capacity: if a power increase doesn't move the metric, we mark the cap and hold the
  // best achievable instead of flooring the blower against an unwinnable load. The cap is
  // re-tested every EXPLORE_UP_INTERVAL because a living grow's load changes all day.
  // EMA pre-filters sensor jitter so neither the deadband nor the capacity test chase noise.
  function evaluateEscalation(roleName, metricNow, target, wantLower, improveThreshold) {
    const state = vpdEscalationState.roles[roleName];
    if (!state) return { boost: 0 };
    if (state.speedBoost === undefined) state.speedBoost = 0;
    if (state.holdCycles === undefined) state.holdCycles = 0;
    if (state.lastAction === undefined) state.lastAction = 'init';

    if (state.metricEma === undefined) state.metricEma = metricNow;
    else state.metricEma = state.metricEma * 0.8 + metricNow * 0.2;

    const lastCheck = state.lastCheckTime || state.activatedAt;
    if (now - lastCheck < ESCALATION_CHECK_MS) {
      return { boost: state.speedBoost };
    }
    state.lastCheckTime = now;

    const ema = state.metricEma;
    // over > 0 ⇒ metric is on the WRONG side of the target (above the ceiling for
    // wantLower). This is an ABSOLUTE distance, so slow drift is always caught.
    const over = wantLower ? (ema - target) : (target - ema);
    const DEAD = 1.0;   // tolerated overshoot above target before adding power
    const EASE = 2.0;   // how far below target before easing power off to save energy

    // Adaptive step: when we're FAR from target, take big bites; when close, be gentle. Without
    // this the controller crawled 10% per 90s while humi was 8% over target — way too slow.
    // Eddie 2026-05-25: full daytime period at 25-35% blower while humi pinned at 65-70%.
    const STEP = (over > 5) ? 25
               : (over > 3) ? 15
               : (over > 1.5) ? 10
                              : ESCALATION_STEP; // ≤1.5 over → small step
    // We refuse to declare "capacity" at trivial speeds — at boost 0-20% a measurement < threshold
    // is almost certainly noise, not the real desaturation limit. Only freeze the cap once we're
    // running at substantial power AND have seen the failure twice in a row.
    const CAPACITY_MIN_BOOST = 30;
    const CAPACITY_MISSES_REQUIRED = 2;
    if (state.capacityMisses === undefined) state.capacityMisses = 0;

    // Periodic capacity re-test — the grow's moisture/heat load changes through the day
    // (sun/cloud/rain, watering, transpiration), so a speed that "gave nothing" before may
    // help now. Forget the cap so the logic below re-probes upward while still over target.
    if (state.capacityClearedAt === undefined) state.capacityClearedAt = now;
    if (now - state.capacityClearedAt >= EXPLORE_UP_INTERVAL_MS) {
      state.capacitySpeed = undefined;
      state.capacityClearedAt = now;
      state.capacityMisses = 0;
    }

    // Judge the previous upward step: did the extra power actually move the metric?
    if (state.lastAction === 'up') {
      const moved = wantLower ? (state.emaBeforeUp - ema) : (ema - state.emaBeforeUp);
      if (moved >= improveThreshold) {
        state.capacitySpeed = undefined; // it responds → allow climbing further if still over
        state.capacityMisses = 0;
        state.lastAction = 'hold'; state.holdCycles = 1;
        console.log(`[VPD] ${roleName}: +power effective (${moved.toFixed(2)} better, ema ${ema.toFixed(1)}/target ${target.toFixed(1)}) → keep boost ${state.speedBoost}%`);
      } else if (state.speedBoost < CAPACITY_MIN_BOOST) {
        // Not enough power to credibly call this "capacity" — keep escalating regardless.
        state.lastAction = 'hold'; state.holdCycles = 0;
        console.log(`[VPD] ${roleName}: +power gave Δ${moved.toFixed(2)} at boost ${state.speedBoost}% — too noisy to call capacity yet (need ≥${CAPACITY_MIN_BOOST}%), continuing to escalate`);
      } else {
        state.capacityMisses++;
        if (state.capacityMisses >= CAPACITY_MISSES_REQUIRED) {
          state.capacitySpeed = state.speedBoost;
          state.speedBoost -= STEP;
          state.lastAction = 'hold'; state.holdCycles = 2;
          console.log(`[VPD] ${roleName}: +power gave nothing (Δ${moved.toFixed(2)}, miss ${state.capacityMisses}/${CAPACITY_MISSES_REQUIRED}) → CAPACITY (ema ${ema.toFixed(1)}/target ${target.toFixed(1)}) — back to boost ${state.speedBoost}%, best achievable`);
        } else {
          // First weak step at high power — could be a noisy measurement. Try once more.
          state.lastAction = 'hold'; state.holdCycles = 0;
          console.log(`[VPD] ${roleName}: +power weak (Δ${moved.toFixed(2)}, miss ${state.capacityMisses}/${CAPACITY_MISSES_REQUIRED}) at boost ${state.speedBoost}% — re-testing before calling capacity`);
        }
      }
      return { boost: state.speedBoost };
    }

    if (over > DEAD) {
      // Above the target ceiling → must reduce the metric.
      // "At capacity" if the NEXT step up would hit the recorded ceiling — otherwise the prior
      // revert (speedBoost -= STEP after a capacity hit) leaves us one step below, and we re-test
      // forever (incident observed 2026-05-25 around 04:50 — boost ping-ponged 10↔20 every cycle).
      // EXPLORE_UP_INTERVAL_MS still re-tests the cap periodically once the load may have changed.
      const atCapacity = state.capacitySpeed !== undefined && (state.speedBoost + STEP >= state.capacitySpeed);
      if (atCapacity) {
        state.lastAction = 'hold';
        console.log(`[VPD] ${roleName}: ${over.toFixed(1)} over target but at capacity (boost ${state.speedBoost}%, ema ${ema.toFixed(1)}) — holding best achievable`);
      } else {
        state.emaBeforeUp = ema;
        state.speedBoost = Math.min(100, state.speedBoost + STEP);
        state.lastAction = 'up';
        console.log(`[VPD] ${roleName}: ${over.toFixed(1)} over target → +${STEP}% (boost ${state.speedBoost}%, ema ${ema.toFixed(1)} → ${target.toFixed(1)})`);
      }
    } else if (over < -EASE) {
      // Comfortably under target → spare capacity, ease off to save energy/noise.
      if (state.holdCycles > 0) {
        state.holdCycles--;
      } else {
        state.speedBoost -= STEP;
        state.lastAction = 'down';
        console.log(`[VPD] ${roleName}: ${(-over).toFixed(1)} under target → −${STEP}% (boost ${state.speedBoost}%, ema ${ema.toFixed(1)}) easing`);
      }
    } else {
      // Within the deadband around target — the sweet spot. Hold.
      state.lastAction = 'hold';
      console.log(`[VPD] ${roleName}: at target (ema ${ema.toFixed(1)} ≈ ${target.toFixed(1)}, boost ${state.speedBoost}%) — holding`);
    }

    return { boost: state.speedBoost };
  }

  // Activate a socket-based role (ON)
  // Pushes a command when role transitions off→on, OR when supervisor thinks role is
  // on but the device reports off (e.g. a SAFETY timeout force-OFF de-synced state).
  // Without the desync re-push, the heater can be force-OFFed by safety and never
  // come back on, even though tempLow keeps activating the role.
  function activateSocketRole(roleName, reason) {
    const assignment = getRoleAssignment(roleName);
    if (!assignment || !assignment.socket || assignment.socket === 'blower') return;
    const { socket, deviceMac } = assignment;
    const aiModeKey = deviceMac ? `${deviceMac}:${socket}` : socket;
    if (!socketAiModes[aiModeKey] && !socketAiModes[socket]) {
      if (curState !== prevState) console.log(`[VPD] ${roleName} (${socket}) NOT in AI mode, skip`);
      return;
    }
    const deviceState = getSocketState(deviceMac, socket);
    const roleWasActive = !!vpdEscalationState.roles[roleName];
    // Sensor-staleness suppression: don't OPEN a new activation while sensors are stale —
    // we may be acting on a snapshot that no longer reflects reality. Existing role continues.
    if (!roleWasActive && vpdEscalationState._suppressNewActivations) {
      if (curState !== prevState) console.log(`[VPD] ${roleName} activation suppressed — sensor data stale`);
      return;
    }
    const deviceIsOff = deviceState === 0;
    // Reset re-issue tracking on a successful ON observation — the device is alive.
    if (deviceState === 1 && roleReissueState[roleName]) {
      roleReissueState[roleName].consecutiveMisses = 0;
      roleReissueState[roleName].unresponsiveUntil = 0;
    }
    // Trigger a push when the role is newly active OR when device is actually off.
    // The second case catches safety-timeout-induced desync.
    if (!roleWasActive || deviceIsOff) {
      if (!roleWasActive) {
        vpdEscalationState.roles[roleName] = { activatedAt: now, metricAtActivation: 0 };
        console.log(`[VPD] → ${roleName} ON (${socket}): ${reason}`);
        actions.push({ deviceMac, socket, action: 'on', reason: `VPD: ${reason}` });
      } else if (deviceIsOff) {
        // Throttled re-issue with unresponsive-backoff. Without this we re-pushed every cycle
        // (observed 2026-05-25: dehumidifier on O4 logged 20+ "re-issue / cooldown skipping"
        // lines per second because the device persistently reported OFF).
        const rs = roleReissueState[roleName] || { lastAttemptAt: 0, consecutiveMisses: 0, unresponsiveUntil: 0 };
        if (rs.unresponsiveUntil > now) return;
        if (now - rs.lastAttemptAt < ROLE_REISSUE_THROTTLE_MS) return;
        rs.lastAttemptAt = now;
        rs.consecutiveMisses++;
        if (rs.consecutiveMisses >= ROLE_UNRESPONSIVE_MISS_THRESHOLD) {
          rs.unresponsiveUntil = now + ROLE_UNRESPONSIVE_BACKOFF_MS;
          console.warn(`[VPD] ⚠ ${roleName} (${socket}) unresponsive after ${rs.consecutiveMisses} attempts — backing off ${ROLE_UNRESPONSIVE_BACKOFF_MS / 60000} min. Check hardware (dry tank? unplugged? firmware reject?).`);
        } else {
          console.log(`[VPD] ↺ ${roleName} ON (${socket}) re-issue #${rs.consecutiveMisses} — device shows OFF: ${reason}`);
        }
        roleReissueState[roleName] = rs;
        actions.push({ deviceMac, socket, action: 'on', reason: `VPD: ${reason}` });
      }
    }
  }

  // Deactivate a socket-based role (OFF)
  // Same desync re-push logic: clear stale role state, and re-issue OFF if device
  // is still ON despite supervisor thinking it's off.
  function deactivateSocketRole(roleName, reason) {
    const assignment = getRoleAssignment(roleName);
    if (!assignment || !assignment.socket || assignment.socket === 'blower') return;
    const { socket, deviceMac } = assignment;
    const aiModeKey = deviceMac ? `${deviceMac}:${socket}` : socket;
    if (!socketAiModes[aiModeKey] && !socketAiModes[socket]) return;
    const deviceState = getSocketState(deviceMac, socket);
    const roleWasActive = !!vpdEscalationState.roles[roleName];
    const deviceIsOn = deviceState === 1;
    // Reset re-issue tracking on a successful OFF observation.
    if (deviceState === 0 && roleReissueState[roleName]) {
      roleReissueState[roleName].consecutiveMisses = 0;
      roleReissueState[roleName].unresponsiveUntil = 0;
    }
    if (roleWasActive || deviceIsOn) {
      if (roleWasActive) {
        console.log(`[VPD] → ${roleName} OFF (${socket}): ${reason}`);
        delete vpdEscalationState.roles[roleName];
        if (roleName === 'heater') lastHeaterOffTime = now;
        if (roleName === 'humidifier') lastHumidifierOffTime = now;
        actions.push({ deviceMac, socket, action: 'off', reason: `VPD: ${reason}` });
      } else if (deviceIsOn) {
        // Same throttled re-issue pattern as activateSocketRole (see comment there).
        const rs = roleReissueState[roleName] || { lastAttemptAt: 0, consecutiveMisses: 0, unresponsiveUntil: 0 };
        if (rs.unresponsiveUntil > now) return;
        if (now - rs.lastAttemptAt < ROLE_REISSUE_THROTTLE_MS) return;
        rs.lastAttemptAt = now;
        rs.consecutiveMisses++;
        if (rs.consecutiveMisses >= ROLE_UNRESPONSIVE_MISS_THRESHOLD) {
          rs.unresponsiveUntil = now + ROLE_UNRESPONSIVE_BACKOFF_MS;
          console.warn(`[VPD] ⚠ ${roleName} (${socket}) won't turn OFF after ${rs.consecutiveMisses} attempts — backing off ${ROLE_UNRESPONSIVE_BACKOFF_MS / 60000} min.`);
        } else {
          console.log(`[VPD] ↺ ${roleName} OFF (${socket}) re-issue #${rs.consecutiveMisses} — device shows ON: ${reason}`);
        }
        roleReissueState[roleName] = rs;
        actions.push({ deviceMac, socket, action: 'off', reason: `VPD: ${reason}` });
      }
    }
  }

  function isRoleActive(roleName) {
    return !!vpdEscalationState.roles[roleName];
  }

  // --- Blower floor/ceiling ---
  // PRINCIPLE: blower is OFF by default. It only runs when something NEEDS extraction:
  //   - Rule 1 lifts ceiling when temp > idealTemp.max (needs cooling)
  //   - Rule 4 lifts ceiling when humi > idealHumiMax (needs dehumidifying)
  // When cooling, blower stops at idealTemp.max (not min) to avoid triggering heater.
  // After heater off, 5-min grace period before allowing blower (thermal inertia).
  let newBlowerFloor = 0;
  let newBlowerCeiling = 0; // OFF by default — only Rules 1 and 4 can lift this

  // ═══════════════════════════════════════════════════════
  // RULE 1: Temperature too high → Blower ON (override ceiling)
  // Activation: temp > idealMax + hysteresis (e.g., 27.5°C when max=27)
  // Goal: cool toward idealTemp.min (uses full range)
  // Continues while temp > idealTemp.min (target is bottom of range)
  // Safety timeout: if below idealTemp.max for 5+ min without reaching min → stop
  //   (blower did its best, environment saturated, no point running indefinitely)
  // Speed: 3-phase optimizer (escalate → de-escalate → hold at minimum effective speed)
  // ═══════════════════════════════════════════════════════


  // Cooling engages only ABOVE the band top (idealTemp.max), NOT inside it — temperature is
  // allowed to float anywhere within the band with no active cooling (VPD is held via humidity).
  // (Previously the stop target was max−0.5, which pulled cooling INTO the band and, with a
  // too-tight hand-set max, caused the futile-cooling spikes of 2026-05-31.) Once engaged, the
  // proportional speed tapers to the idle baseline exactly at the band top, so there's no
  // bang-bang. Suppressors: heater grace, VPD gate, futility/unreachability; only the hard ceiling
  // (TEMP_SAFE_MAX) forces it unconditionally.
  const coolingStopTarget = idealTemp.max;
  // VPD-aware cooling gate (2026-05-31). Cooling lowers air temperature, which lowers VPD.
  //   • When VPD is ABOVE target (room too dry / VPD high): cooling moves VPD toward target → good.
  //   • When VPD is AT/BELOW target (room humid / VPD low): cooling moves VPD further BELOW target
  //     → counterproductive. The right lever there is drying (extraction), not cooling.
  // Without this gate, after the humidifier raised humi to target the blower would slam into
  // temperature-cooling (e.g. 82 %) the instant humidity-yield released at the band top, crashing
  // humidity and VPD and oscillating humi 57↔69 / blower 0↔82 (observed 2026-05-31). A true
  // thermal emergency (temp > max + 1.5) overrides — heat danger outranks the VPD nicety.
  // Small VPD dead band (+0.08): cooling may only ENGAGE when VPD is meaningfully above target,
  // not the instant it grazes it. Without this, at humi≈target / VPD≈target the cooling re-armed
  // every time the humidifier turned off, fired the blower, dried the air, and the cycle repeated
  // (2026-05-31 evening: 4 cycles, blower 0↔86 %, humi 62↔41). Emergency bypasses.
  // Temperature is the HARD constraint (Eddie): when temp is genuinely above the band — not merely
  // grazing the top — cool REGARDLESS of VPD; the humidifier compensates the drying so blower+humidifier
  // run together. The VPD gate (don't cool while VPD is already in-band, which over-dries) is the right
  // call only for MILD overshoot near the band top. Without this override a VPD dip below target+0.08
  // flipped cooling OFF at 26.9 °C and the blower slammed 100↔0 (Eddie 2026-06-20: "100% bajando a 95%
  // luego parándose y volviendo al instante al 100%"). Preserves the night mild-overshoot fix: at
  // 24.5 °C on a 19-24 band tempClearlyHigh is false → still VPD-gated; 25.5 °C+ cools. [[reference_vpd_softcool_night_regression]]
  const tempClearlyHigh = temp > coolingStopTarget + COOL_TEMP_OVERRIDE_MARGIN;
  const vpdAllowsCooling = currentVpd > vpdTarget + 0.08 || tempEmergency || tempClearlyHigh;

  // ── TIME-BASED COOLING-UNREACHABILITY (2026-05-31 evening incident) ──
  // The 4-min blower-measurement futility self-test is DEFEATED by the blower↔humidifier mutex:
  // the mutex clamps the blower to 0 the moment the humidifier engages (humi<target), so the
  // blower never sustains a high speed for the full measurement window and futility never latches.
  // Result on a night where ambient (~23.7°C) sits just above the night cooling target (23°C):
  // cooling fires futilely whenever the humidifier is off, spiking the blower and drying the air,
  // forever. This detector is BLOWER-STATE-INDEPENDENT: if temp has stayed above the cooling stop
  // target for a sustained period but only MILDLY (not an emergency), the room floor is above the
  // target (exhaust can't beat ambient) → cooling is unreachable → suppress it and let temp float
  // while humidity holds VPD. Resets the instant temp drops to the stop target (cooled into range)
  // or escalates into a real emergency (then cooling is forced regardless).
  if (temp > coolingStopTarget) {
    if (vpdEscalationState.tempAboveCoolTargetSince == null || vpdEscalationState.tempAboveCoolTargetSince === 0) {
      vpdEscalationState.tempAboveCoolTargetSince = now;
    }
  } else {
    vpdEscalationState.tempAboveCoolTargetSince = 0;
  }
  const coolingUnreachable = vpdEscalationState.tempAboveCoolTargetSince > 0
    && (now - vpdEscalationState.tempAboveCoolTargetSince) > COOLING_UNREACHABLE_MS
    && !isDaytime;  // (Eddie 2026-06-17) Futile-cooling suppression is a NIGHT-only concept: a cool ambient
    // sitting just above the tight night band means cooling can't win, so we suppress it to avoid venting/drying
    // the night. In the DAY we must NEVER suppress — it once parked the blower OFF for >1h as the day heated past
    // the band, a self-reinforcing trap (off → temp stays high → stays latched → off) that let temp climb toward
    // the 30°C ceiling. By day the exhaust ALWAYS runs when above the band: even if it can't reach target it HOLDS
    // temperature instead of giving up. (Was `temp < TEMP_SAFE_MAX`, which only forced cooling at the 30°C ceiling.)

  // ENGAGE HYSTERESIS (the missing deadband — root cause of the 2026-06-02 disaster). The cooling
  // stop target is the band top, but to START cooling temp must exceed it by TEMP_HIGH_HYSTERESIS
  // (0.5°C); once cooling (coolingActive latch), it continues until temp falls back to the stop
  // target. The previous "cooling starts immediately at the band top, continuation logic prevents
  // oscillation" was FALSE when ambient sits right at the band top (warm night ≈ 24°C = night max):
  // temp micro-crossed 24.0 every cycle, so needsCooling flipped on/off 8642× in one day, each
  // blower burst venting moisture the night humidifier couldn't replace → humidity spiralled
  // 62→42 %, VPD ran away to 1.7+. The 0.5°C deadband makes temp hovering at the band top a no-op.
  // NOTE (Eddie 2026-06-17): REVERTED an earlier "soft cooling zone" experiment (engage 2°C below
  // the band max, and cool on temperature alone with the vpdAllowsCooling gate dropped). With the
  // tighter NIGHT band (19-24, max 24) that made cool-engage 22.5°C, so on a perfectly normal night
  // at 24.5°C / VPD 1.22 (dead-centre in band) the blower slammed to ~50%, vented humidity 60→53%
  // and pushed VPD out of band, forcing the humidifier — a self-inflicted night oscillation. Restored
  // the band-max engage + the vpdAllowsCooling gate: cooling fires only when temp exceeds the band
  // AND VPD is genuinely high, so a good-VPD night is left alone. (To cool earlier in the DAY, lower
  // the day temp-band max in settings — that's the per-stage knob, not a global offset.)
  // ENGAGE hysteresis. DAY: standard thermostat — engage AT the band ceiling, release TEMP_HIGH_HYSTERESIS below
  // it, so the exhaust is ON whenever temp is at/over your configured day ceiling (Eddie 2026-06-17: the old
  // "engage at ceiling+0.5" left the blower OFF at 27.5 above a 27°C band). NIGHT: keep engage at ceiling+0.5 /
  // release at ceiling — at night the tight band + cool ambient means engaging AT the ceiling would vent/dry the
  // room every time it grazes the band top; the +0.5 deadband + the night-only futility suppression keep it calm.
  const coolEngageTemp = isDaytime
    ? (coolingActive ? (coolingStopTarget - TEMP_HIGH_HYSTERESIS) : coolingStopTarget)
    : (coolingActive ? coolingStopTarget : (coolingStopTarget + TEMP_HIGH_HYSTERESIS));
  const needsCooling = temp > coolEngageTemp
    && (!heaterRecentlyOff || tempEmergency)
    && vpdAllowsCooling
    && (!coolingUnreachable || tempEmergency);

  if (needsCooling) {
    // Cooling needed — lift ceiling
    newBlowerCeiling = 100;

    // If extractor is a socket (not blower), turn it ON
    if (!extIsBlower) {
      activateSocketRole('extractor', `Temp ${temp.toFixed(1)}°C > ${tempHighThreshold.toFixed(1)}°C`);
      if (!vpdEscalationState.roles['extractor']) {
        vpdEscalationState.roles['extractor'] = { activatedAt: now, metricAtActivation: temp };
      }
    } else {
      // TREND-FOLLOWING COOLING (Eddie 2026-06-21, v7). POWER TRACKS TEMPERATURE DIRECTION — the cardinal
      // rule Eddie kept stating: "qué demonios hace bajando la potencia si la temperatura va subiendo". v6
      // made trimming the DEFAULT and only raised power on a detected rebound, so during the foco warm-up it
      // trimmed power WHILE temp climbed (hour-long 1° waves, never stabilising). v7 keys purely off the 5-min
      // trend and NEVER reduces power while temp is rising:
      //   • trend RISING (> RISE_THRESH) → power UP, step ∝ the rise rate (track the demand); ramps a smooth
      //     increasing curve until temp stabilises — exactly Eddie's "ondulaciones suaves crecientes".
      //   • trend slightly rising (0 < trend ≤ RISE_THRESH) → HOLD (don't trim into a developing rise, don't
      //     over-react to a wiggle — wait to see if it develops).
      //   • trend FLAT or FALLING (≤ 0) → −DOWN_STEP: minimise power / follow the cooling down. This is the
      //     ONLY time power drops, and only when temp is NOT rising. → finds the min power that holds a stable
      //     temp (probe down; if temp then rises, the rising branch adds it back → gentle limit cycle).
      //   • paced one step per COOL_STEP_MS (thermal lag); SAFETY push every cycle if temp ≥ band+PUSH_MARGIN.
      const _lvl = tempTrendBuffer.filter(s => now - s.t <= COOL_LEVEL_MS);
      const levelTemp = _lvl.length ? _lvl.reduce((a, s) => a + s.temp, 0) / _lvl.length : temp;
      const dT = computeTrend('temp', COOL_TREND_MS).perMin; // 12-min slope — catches even the SLOW dawn→noon creep
      // v9 (Eddie 2026-06-22): blower power CONTINUOUSLY tracks the temperature curve and the desaturation
      // CAPACITY — no fixed cap, no emergency trigger. The day's slow sun-driven rise was imperceptible to the
      // old 5-min/0.03 detector, so the blower sat at 40% until temp crossed an emergency threshold and slammed.
      // Now (12-min window, 0.008 threshold) even a slow creep is seen and power rises PROPORTIONALLY to meet it;
      // when the exhaust hits its capacity (the rise won't slow despite more power = intake/ambient-limited) it
      // HOLDS instead of climbing futilely (more would only dry); flat/falling → trims to the minimum that holds.
      let coolingSpeed;
      if (coolEqSpeed === 0) {
        coolEqSpeed = Math.max(COOL_MIN_OP, Math.min(COOL_ABS_MAX, COOL_EQ_START_SPEED + Math.round(Math.max(0, levelTemp - coolingStopTarget) * 12)));
        coolLastStep = now; coolLastDt = dT; coolSatStreak = 0;
        console.log(`[VPD] Cooling engaged at ${coolEqSpeed}% — temp ${temp.toFixed(1)}°C > ${coolingStopTarget.toFixed(1)}°C; tracking the curve.`);
      } else if (now - coolLastStep >= COOL_STEP_MS) {
        if (dT > COOL_RISE) {
          // RISING (even slowly) → add power ∝ the rise rate, tracking the curve. BUT check CAPACITY: at high
          // power, if the rise is NOT slowing (more airflow isn't helping), the exhaust can't beat the intake
          // air → HOLD (more would only dry). Needs 2 confirmations (coolSatStreak) to ignore a noise blip.
          const riseSlowing = dT < coolLastDt - 0.003;
          if (coolEqSpeed >= COOL_SAT_HIGH && !riseSlowing) coolSatStreak++; else coolSatStreak = 0;
          if (coolSatStreak >= 2) {
            console.log(`[VPD] Cooling ⚠ ${coolEqSpeed}% @ ${levelTemp.toFixed(2)}° (rising +${dT.toFixed(3)}/min, NOT slowing at ${coolEqSpeed}%) — DESATURATION CAPACITY reached / intake-limited: holding, more power would only dry. Needs cooler intake / AC.`);
          } else {
            const up = Math.max(COOL_UP_MIN, Math.min(COOL_UP_MAX, Math.round(dT * COOL_UP_GAIN)));
            coolEqSpeed = Math.min(COOL_ABS_MAX, coolEqSpeed + up);
            console.log(`[VPD] Cooling ↑ ${coolEqSpeed}% @ ${levelTemp.toFixed(2)}° (rising +${dT.toFixed(3)}/min over 12min) — +${up}% tracking the curve.`);
          }
        } else if (dT > 0) {
          // Barely rising (below the act threshold) → HOLD. NEVER trim into a developing rise.
          coolSatStreak = 0;
          console.log(`[VPD] Cooling = ${coolEqSpeed}% @ ${levelTemp.toFixed(2)}° (+${dT.toFixed(3)}/min, barely rising) — holding.`);
        } else {
          // Flat or falling → minimise: trim toward the efficient power (floor COOL_MIN_OP). Only when NOT rising.
          coolSatStreak = 0;
          coolEqSpeed = Math.max(COOL_MIN_OP, coolEqSpeed - COOL_DOWN_STEP);
          console.log(`[VPD] Cooling ↓ ${coolEqSpeed}% @ ${levelTemp.toFixed(2)}° (${dT >= 0 ? '+' : ''}${dT.toFixed(3)}/min, not rising) — trim −${COOL_DOWN_STEP}% toward minimum (floor ${COOL_MIN_OP}%).`);
        }
        coolLastDt = dT;
        coolLastStep = now;
      }
      coolingSpeed = coolEqSpeed;

      if (!vpdEscalationState.roles['extractor_temp']) {
        vpdEscalationState.roles['extractor_temp'] = { activatedAt: now, metricAtActivation: temp };
      }
      newBlowerFloor = Math.max(newBlowerFloor, coolingSpeed);
    }

    // Temp too high → no heater needed
    deactivateSocketRole('heater', 'Temp too high');

  } else {
    // Not cooling this cycle — either temp is back in range (≤ idealMax − 0.5) OR cooling was
    // VPD-gated off (temp still high but VPD ≤ target, so drying not cooling is the right lever).
    // Either way, release the cooling role so it can't linger; the baseline / humidity logic
    // governs the blower from here.
    if (coolingActive) {
      const reason = temp <= coolingStopTarget
        ? `back in range at ${temp.toFixed(1)}°C (≤ ${coolingStopTarget.toFixed(1)}°C)`
        : `cooling yielded — VPD ${currentVpd.toFixed(2)} ≤ target ${vpdTarget.toFixed(2)} (drying, not cooling, raises VPD)`;
      console.log(`[VPD] Cooling done: ${reason} — starting post-cooling grace`);
      lastCoolingStopTime = now;
      coolingGraceLastTemp = temp;
      coolingGraceLastCheck = now;
      coolingGraceStableStart = 0;
    }
    coolingBelowMaxSince = 0;
    coolEqSpeed = 0; coolLastStep = 0; // temp re-entered band → reset adaptive cooling (re-seeds next engage)
    delete vpdEscalationState.roles['extractor_temp'];
    deactivateSocketRole('cooler', 'Temp OK');
    if (!extIsBlower) deactivateSocketRole('extractor', 'Temp OK');
  }

  // ═══════════════════════════════════════════════════════
  // RULE 2: Humidity management
  // When temp needs cooling AND humidity is low, there's a conflict:
  //   - Blower cools the room (good) but extracts humidity (bad)
  //   - Old approach: cap blower at 35% → temp never reaches target
  // New approach: TEMPERATURE COOLING HAS PRIORITY.
  //   - Let blower run at whatever speed Rule 1 / escalation needs
  //   - Activate humidifier to compensate the moisture loss from extraction
  //   - Only cap blower when temp is already in range (no cooling needed)
  // ═══════════════════════════════════════════════════════
  if (humi < idealHumiMin && !needsCooling) {
    // Humidity low and no cooling needed — cap blower to conserve moisture
    newBlowerCeiling = Math.min(newBlowerCeiling, 35);
  }
  // When needsCooling + humiLow: blower ceiling stays at 100 (from Rule 1).
  // Humidifier compensates below.

  // (Earlier we had a "gentle extraction cap" that limited the blower to 25-61% whenever humi
  // was only marginally above target. That logic was designed for the old calibrated blower
  // curve which would over-extract at low humi excess. Now that vpd_control disables the curve
  // entirely and the in-supervisor optimizer is the controller, the gentle cap was actively
  // sabotaging the optimizer — capping the ceiling at 25% while the optimizer wanted 70% — so
  // humidity ran away to 70% (Eddie 2026-05-25, full daytime period at 25% blower). Removed.)

  // The dry-tank self-test ("ineffective") may only REST the pump while humidity is still adequate
  // (≥ band floor) — it must NEVER starve the room during a real humidity crash. Below the band
  // floor (VPD out of band on the dry side) the humidifier runs regardless of the flag: if the tank
  // truly is empty it does no harm, and if it isn't — the usual FALSE POSITIVE, where a running
  // blower vented the vapour so the self-test saw "no rise" and wrongly cried empty — it rescues the
  // plant. Eddie 2026-06-02: the flag suspended the pump for 45 min while humi crashed to 46 % /
  // VPD 1.62 with the blower simply masking a perfectly full tank. A running blower must never keep
  // the humidifier off when humidity is low.
  // The dry-tank suspension may ONLY rest the pump once humidity is at/above TARGET (genuinely
  // fine) — never below it. A humidifier takes minutes to register a rise and the exhaust roughly
  // doubles that lag (Eddie 2026-06-02), so the self-test false-flags easily; gating the block at
  // target means even a false flag can't starve the room — the humidifier keeps running until humi
  // actually reaches target. (Was idealHumiMin, which capped recovery at the band floor ~60 %.)
  const humidifierBlocked = humidifierIneffective && humi >= idealHumiTarget;
  if (humidifierBlocked && humidifierRoleActive) {
    deactivateSocketRole('humidifier', `Humidifier appears DRY (no humi rise during last self-test) — suspended for ${Math.round((humidifierIneffectiveUntil - now) / 60000)} min; refill tank`);
    delete vpdEscalationState.roles['humidifier'];
    lastHumidifierOffTime = now;
  } else if (leafVpdAboveTargetHyst && !humidifierBlocked) {
    // VPD-driven humidification: leaf VPD is ABOVE the upper band → room is too dry. The only
    // two levers to lower VPD are heat (which is gated by temperature ceiling and may be
    // unauthorised — Eddie disconnected his heater) or humidity. Activate the humidifier even
    // if absolute humi is "within" the stage range — the goal at this point is VPD, not humi.
    activateSocketRole('humidifier', `Leaf VPD ${currentVpd.toFixed(2)} above band ${targetMin.toFixed(2)}-${targetMax.toFixed(2)} (air ${(svpAir - svpAir * humi / 100).toFixed(2)}, humi ${humi.toFixed(0)}% → target ${idealHumiTarget.toFixed(0)}%) — raising humi toward VPD-chart target`);
    if (!vpdEscalationState.roles['humidifier']) {
      vpdEscalationState.roles['humidifier'] = { activatedAt: now, metricAtActivation: humi };
    }
    deactivateSocketRole('dehumidifier', 'VPD too high — pulling moisture out would worsen it');
    // extractor_humi is a virtual blower role (no socket) — deactivateSocketRole early-returns on
    // it, so clear it directly (audit P1 #4 dead-no-op fix). And drop the blower floor so the
    // exhaust isn't fighting the humidifier we just turned on.
    if (vpdEscalationState.roles['extractor_humi']) {
      delete vpdEscalationState.roles['extractor_humi'];
      if (!needsCooling) { newBlowerFloor = 0; newBlowerCeiling = 0; }
    }
  } else if (humiLow && !humidifierBlocked) {
    activateSocketRole('humidifier', `Humi ${humi.toFixed(0)}% < ${humiLowThreshold.toFixed(0)}% (target ${idealHumiTarget.toFixed(0)}%)`);
    if (!vpdEscalationState.roles['humidifier']) {
      vpdEscalationState.roles['humidifier'] = { activatedAt: now, metricAtActivation: humi };
    }
    deactivateSocketRole('dehumidifier', 'Humi too low');
  } else if (humi < idealHumiMin && !humidifierBlocked) {
    // Humidity below ideal minimum — activate humidifier regardless of cooling state
    activateSocketRole('humidifier', `Humi ${humi.toFixed(0)}% < ${idealHumiMin.toFixed(0)}%`);
    if (!vpdEscalationState.roles['humidifier']) {
      vpdEscalationState.roles['humidifier'] = { activatedAt: now, metricAtActivation: humi };
    }
  } else if (humi >= idealHumiMin + 1 && !leafVpdAboveTargetHyst) {
    // LAG-COMPENSATED OFF (Eddie 2026-06-02). This humidifier keeps raising humidity for minutes
    // after it's switched off (mist already airborne) — observed ≈ +5-6 % post-off. If we wait for
    // target+1 to switch off, that tail sails humidity to ~69-71 % / VPD 0.92 (out of band, humid).
    // So switch off as soon as humidity clears the band FLOOR (idealHumiMin+1); the post-off tail
    // then lands near the band CEILING (idealHumiMax) instead of past it. Re-arms at idealHumiMin,
    // giving a gentle idealHumiMin↔idealHumiMax swing that stays inside the VPD band both ways.
    // (Don't shut off while VPD is still ABOVE the upper band — that branch is dragging VPD down.)
    deactivateSocketRole('humidifier', `Humi ${humi.toFixed(0)}% ≥ band floor+1 (${(idealHumiMin + 1).toFixed(0)}%) — off early to let the lag tail settle at target (VPD ${currentVpd.toFixed(2)})`);
    delete vpdEscalationState.roles['humidifier'];
  }
  // Between humiLow and idealHumiTarget: humidifier stays in whatever state it's in (keeps pushing)

  // ═══════════════════════════════════════════════════════
  // POST-COOLING GRACE: Intelligent heater suppression after blower cooling
  // Prevents heater-blower oscillation by monitoring temp trend after cooling.
  //   Phase 1 (0-5 min): unconditional suppress — thermal inertia still settling
  //   Phase 2 (5-10 min): trend analysis every 2 min
  //     - Rising → suppress (environment self-correcting, heater unnecessary)
  //     - Falling → suppress (still settling, wait)
  //     - Stable 2+ min AND below min → allow heater (environment truly can't recover)
  //   After 10 min: grace expires, normal heater rules apply
  // ═══════════════════════════════════════════════════════
  let heaterSuppressedByCoolingGrace = false;
  const coolingGraceElapsed = lastCoolingStopTime > 0 ? (now - lastCoolingStopTime) : Infinity;

  if (coolingGraceElapsed < COOLING_GRACE_MAX_MS) {
    if (coolingGraceElapsed < COOLING_GRACE_MIN_MS) {
      // Phase 1: unconditional suppress
      heaterSuppressedByCoolingGrace = true;
    } else {
      // Phase 2: trend analysis every 2 min
      const sinceLastCheck = now - coolingGraceLastCheck;

      if (sinceLastCheck >= COOLING_GRACE_TREND_CHECK_MS) {
        const tempDelta = temp - coolingGraceLastTemp;
        coolingGraceLastTemp = temp;
        coolingGraceLastCheck = now;

        if (tempDelta > COOLING_GRACE_RISE_THRESHOLD) {
          // Rising → environment self-correcting, heater not needed
          coolingGraceStableStart = 0; // Reset stable timer
          console.log(`[VPD] Cooling grace: temp RISING (Δ+${tempDelta.toFixed(2)}°C/2min) — heater suppressed, environment self-correcting`);
        } else if (tempDelta < -COOLING_GRACE_RISE_THRESHOLD) {
          // Falling → still settling, wait
          coolingGraceStableStart = 0;
          console.log(`[VPD] Cooling grace: temp FALLING (Δ${tempDelta.toFixed(2)}°C/2min) — heater suppressed, still settling`);
        } else {
          // Stable
          if (coolingGraceStableStart === 0) {
            coolingGraceStableStart = now;
            console.log(`[VPD] Cooling grace: temp STABLE at ${temp.toFixed(1)}°C — starting 2-min observation`);
          }
        }
      }

      // Check if stable long enough to allow heater
      const stableDuration = coolingGraceStableStart > 0 ? (now - coolingGraceStableStart) : 0;
      if (stableDuration >= COOLING_GRACE_TREND_CHECK_MS && temp < idealTemp.min) {
        // Stable for 2+ min AND still below min → environment can't recover, allow heater
        console.log(`[VPD] Cooling grace: temp stable at ${temp.toFixed(1)}°C for ${(stableDuration / 60000).toFixed(0)}min, below ${idealTemp.min}°C — allowing heater`);
        lastCoolingStopTime = 0; // End grace
        heaterSuppressedByCoolingGrace = false;
      } else {
        heaterSuppressedByCoolingGrace = true;
      }
    }

    // If temp returned to range during grace, cancel it early
    if (temp >= idealTemp.min && temp <= idealTemp.max) {
      lastCoolingStopTime = 0;
      heaterSuppressedByCoolingGrace = false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // RULE 3: Temperature too low → Heater ON
  // Activation: temp < idealMin - hysteresis (e.g., 23.5°C)
  // Deactivation: temp >= idealMin (heater heats TO the bottom of range, NOT through it)
  //   This prevents thermal inertia from pushing temp far above range.
  //   Overshoot: heater off at 24°C → inertia to ~24.5°C = safe, still in range.
  // If temp is IN range (>= min): heater must NEVER be on.
  // ═══════════════════════════════════════════════════════
  const tempReachedMin = temp >= idealTemp.min; // Heater target: bottom of range

  // Heater only fires in the 'heating' phase, never alongside extraction (wastes
  // energy) and never during the post-extraction grace (residual lamp + canopy
  // heat is doing the work). Also skipped while we've declared the heater
  // ineffective — the system switches lever and extracts more instead.
  const heaterAllowed = phaseHeating
    && !heaterSuppressedByCoolingGrace
    && !inPostExtractionGrace
    && !heaterIneffective;
  if (phaseHeating && tempLow && heaterSuppressedByCoolingGrace) {
    if (curState !== prevState) {
      console.log(`[VPD] Heater suppressed by cooling grace (${(coolingGraceElapsed / 60000).toFixed(0)}min/${(COOLING_GRACE_MAX_MS / 60000)}min) — temp ${temp.toFixed(1)}°C < ${tempLowThreshold.toFixed(1)}°C but monitoring trend`);
    }
  } else if (phaseHeating && tempLow && inPostExtractionGrace) {
    if (curState !== prevState) {
      const remaining = Math.ceil((POST_EXTRACTION_HEATER_GRACE_MS - (now - lastExtractionStopTime)) / 60000);
      console.log(`[VPD] Heater suppressed: post-extraction grace ${remaining} min — letting lamp + canopy mass warm naturally`);
    }
  } else if (heaterAllowed && tempLow) {
    activateSocketRole('heater', `Temp ${temp.toFixed(1)}°C < ${tempLowThreshold.toFixed(1)}°C`);
    deactivateSocketRole('cooler', 'Temp too low');
  } else if (heaterAllowed && leafVpdCritical && temp < idealTemp.min) {
    activateSocketRole('heater', `Leaf VPD ${currentVpd.toFixed(2)} critical (<${(targetMin - 0.15).toFixed(2)}) — raise temp ${temp.toFixed(1)}°C toward ${idealTemp.min}°C`);
    deactivateSocketRole('cooler', 'Temp too low');
  } else if (tempReachedMin && isRoleActive('heater')) {
    deactivateSocketRole('heater', `Temp ${temp.toFixed(1)}°C reached ideal min ${idealTemp.min}°C — stopping to prevent overshoot`);
  } else if ((!phaseHeating || inPostExtractionGrace || heaterIneffective) && isRoleActive('heater')) {
    const why = heaterIneffective ? 'heater ineffective — switching to extraction'
      : inPostExtractionGrace ? 'post-extraction grace — letting room recover naturally'
      : `phase=${vpdPhase}`;
    deactivateSocketRole('heater', why);
  }

  // ═══════════════════════════════════════════════════════
  // RULE 4: Humidity too high → Dehumidifier first, blower LAST RESORT
  //   + SMART SUBSTITUTION: if blower is crashing temp, switch to dehumidifier
  // Step 1: Dehumidifier (if available, no temp impact)
  // Step 2: Only if dehumidifier exhausted → blower (with temp safety monitoring)
  // Step 3: If blower is dropping temp dangerously → STOP blower, rely on dehumidifier
  // ═══════════════════════════════════════════════════════
  // Humidity extraction only fires when the phase machine assigns us to 'extracting'.
  // During 'heating' or 'idle' the blower stays off (or runs only for Rule 1 cooling)
  // so the heater isn't blowing its work out a vent. Emergency overrides the gate.
  //
  // Goal-oriented extension: if the heater has been declared ineffective (e.g. user
  // unplugged it) and leaf VPD is still below target, we must drive humi DOWN to
  // reach the band even if it's already within the "normal" tolerance — extraction
  // is the only lever left. We loosen the gate so the blower runs proactively in
  // that scenario.
  // Activate extraction when humi crosses the TARGET (sweet spot) — not just the absolute
  // ceiling. Eddie 2026-05-28: at humi 64 with band 58-65 (target 61), the blower sat at 30 %
  // idle because two gates conspired against it:
  //   1) old gate: `humi > idealHumiMax` (65) — humi=64 didn't qualify
  //   2) old gate: `(humiHigh || humiExtractionActive || ...)` where humiHigh = humi > humiMax+4
  //      (69) — also didn't qualify for first activation; the system was waiting for humi to
  //      get worse before doing anything.
  // The user wants the optimizer to start its smart escalation as soon as humi drifts above
  // target so it can find the desaturation sweetspot well before the ceiling is hit. The
  // dropped `humiHigh || ...` gate was a conservative noise filter, but with the in-cycle
  // intent resolver + the humidifier-active guard below, it isn't needed.
  // The humidifier-recently-off grace (4 min) exists so a brief overshoot doesn't immediately
  // get extracted away. But when humi is CLEARLY above target (≥ 2 % over), it's not a transient
  // overshoot — it's a real load and waiting just lets it climb. Bypass the grace in that case.
  // Eddie 2026-05-28: blower sat at 30 % idle with humi=64 (target 61) for the whole grace
  // window because the grace blocked extraction unconditionally.
  // Eddie 2026-05-28: dropped the humidifierRecentlyOff guard from this gate. The 4-min grace
  // was preventing extraction whenever the humidifier had just been off — even at humi=62 well
  // above target. That created the on/off oscillation he kept seeing. The cross-device mutex
  // already blocks simultaneous humidifier+blower, so the grace is redundant here.
  // ── UNCONDITIONAL extractor_humi teardown (audit P1 #4) ──
  // The role activates at humi>target but its normal release lives in the `else` of
  // `if (needsHumiAction)`, which is gated by `!isRoleActive('humidifier')`. So once the
  // humidifier re-engages in the same band, the release path is unreachable and the latched role
  // keeps the blower extracting WHILE the humidifier adds moisture — they fight. Tear it down
  // here, unconditionally, the moment the humidifier is driving OR humi is back at/below target.
  // Release when humidity is 2 % back inside the band (≤ idealHumiMax−2). The job is to undo the
  // overshoot that pushed VPD below the band — overshooting down to target over-extracted and crashed
  // humidity to ~58 % / VPD 1.28 (Eddie 2026-06-02), so we stay well above target. Paired with the
  // arm-at-ceiling below, this gives a clean 2 % hysteresis (arm at idealHumiMax, release 2 % under)
  // with real OFF-time between pulses — instead of the 1 %-overlap that toggled the blower 0↔30 %
  // continuously while the room rested at the ceiling (Eddie 2026-06-17).
  if (extIsBlower && vpdEscalationState.roles['extractor_humi']
      && (isRoleActive('humidifier') || humi <= idealHumiMax - 2)) {
    delete vpdEscalationState.roles['extractor_humi'];
    if (!needsCooling) { newBlowerFloor = 0; newBlowerCeiling = 0; }
  }

  // Arm extraction only when humi exceeds the band CEILING (idealHumiMax — the VPD-band low edge);
  // once armed keep running until the teardown above clears it at humi ≤ idealHumiMax−2 → a clean
  // 2 % hysteresis. Eddie 2026-06-17: arming at idealHumiTarget+2 sat BELOW where the room rests
  // (62-63 %), so extraction was permanently armed and toggled 0↔30 % every cycle against the 62 %
  // release (the misleading "15 % average"). Arming at the ceiling fires the exhaust only when VPD
  // genuinely leaves the band, and the 2 % band gives real off-time between pulses. Emergencies bypass.
  const needsHumiAction = (phaseExtracting || humiEmergency)
    && (humi > idealHumiMax || humiEmergency || isRoleActive('extractor_humi'))
    && !isRoleActive('humidifier');

  if (needsHumiAction) {
    deactivateSocketRole('humidifier', 'Humi too high');

    const dehumRole = getRoleAssignment('dehumidifier');
    const hasDehumRole = dehumRole && dehumRole.socket;
    // If the dehumidifier socket isn't authorised (AI mode off, or socket missing),
    // activateSocketRole below silently no-ops and the system would otherwise wait
    // forever for it to "exhaust" before escalating to blower extraction.
    // Treat the unauthorised dehumidifier as already-exhausted so extraction proceeds.
    const dehumAiKey = hasDehumRole && dehumRole.deviceMac
      ? `${dehumRole.deviceMac}:${dehumRole.socket}`
      : (hasDehumRole ? dehumRole.socket : null);
    const dehumAuthorised = !!hasDehumRole && (
      socketAiModes[dehumAiKey] || (dehumRole && socketAiModes[dehumRole.socket])
    );

    // Step 1: Try dehumidifier first (only if it's actually authorised — otherwise
    // we skip straight to blower since the dehumidifier can never do real work).
    if (hasDehumRole && dehumAuthorised) {
      activateSocketRole('dehumidifier', `Humi ${humi.toFixed(0)}% > ${idealHumiMax.toFixed(0)}% — dehumidifier first`);
      if (!vpdEscalationState.roles['dehumidifier']) {
        vpdEscalationState.roles['dehumidifier'] = {
          activatedAt: now, metricAtActivation: humi
        };
      }
    } else if (hasDehumRole && !dehumAuthorised && curState !== prevState) {
      console.log(`[VPD] Dehumidifier (${dehumRole.socket}) assigned but not in AI mode — skipping to blower extraction`);
    }

    // Step 2: Escalate to blower if dehumidifier exhausted, missing, OR unauthorised
    const dehumState = vpdEscalationState.roles['dehumidifier'];
    const dehumExhausted = (hasDehumRole && dehumAuthorised && !humiEmergency)
      ? (dehumState && now - dehumState.activatedAt > DEHUM_ESCALATION_MS && humi >= dehumState.metricAtActivation - 1)
      : true; // No dehumidifier, unauthorised dehumidifier, or emergency → skip straight to blower

    // ── SMART SUBSTITUTION: blower crashing temp → switch to dehumidifier-only ──
    // If blower is extracting humidity but temp has dropped to near idealTemp.min,
    // the blower is causing more harm than good. Stop it, let dehumidifier handle it.
    // Without dehumidifier, we sacrifice humidity control to protect temperature.
    //
    // BUT — if a heater role is assigned and authorised, the heater can COMPENSATE the
    // temperature drop while the blower keeps extracting. Only abort the blower when
    // temp drops far enough below idealMin that the heater clearly can't keep up.
    // Without this, a setup with tight idealMin (e.g. 21°C) and ambient near min sits
    // in a substitution loop every cycle and humidity never gets extracted.
    const hasHeaterRole = _hasHeaterRole; // already computed at top — reuse
    // Threshold for substitution. With heater authorised the system can compensate the
    // blower's cooling effect, so the threshold drops well below idealMin. When leaf VPD
    // is critical (mold risk) the threshold drops further still — mold damage is harder
    // to recover from than a few °C of low temp.
    // The goal is to land VPD inside [targetMin, targetMax], not just above 0.80, so we
    // also never substitute while VPD is still below targetMin if the heater can compensate.
    const crashThreshold = heaterAuthorised
      ? idealTemp.min - (leafVpdCritical ? 3.0 : 1.5)
      : idealTemp.min + (leafVpdCritical ? -0.5 : 0.5);
    const blowerCrashingTemp = humiExtractionActive
      && temp < crashThreshold
      && !humiEmergency
      && !(leafVpdBelowTarget && heaterAuthorised) // never abort while VPD < target if heater can compensate
      // If the heater is ineffective (unplugged / undersized), there is no temperature
      // lever at all — stopping the blower would just let humidity climb with no upside.
      // Keep extracting down to an absolute cold floor (idealMin - 5 °C) to protect VPD;
      // only a genuinely dangerous temp aborts.
      && !(heaterIneffective && temp > idealTemp.min - 5);

    if (blowerCrashingTemp) {
      console.log(`[VPD] SUBSTITUTION: blower crashing temp (${temp.toFixed(1)}°C < ${crashThreshold.toFixed(1)}°C${heaterAuthorised ? ', heater can not keep up' : ''}) — switching to dehumidifier-only for humidity`);
      lastHumiExtractionCrashTime = now;
      lastHumiExtractionCrashHumi = humi;
      // NOTE: do NOT start cooling grace here. Cooling grace exists to dampen heater
      // oscillation after Rule 1 *temperature* cooling. A humidity-extraction crash is
      // a different problem — we want the heater to fire IMMEDIATELY to bring temp
      // back up. Starting cooling grace here used to deadlock the system: blower off
      // (substitution), heater off (cooling grace), humidity never came down.
      delete vpdEscalationState.roles['extractor_humi'];
      if (!extIsBlower) {
        if (!needsCooling) deactivateSocketRole('extractor', 'Temp crash — dehumidifier takes over');
      } else {
        if (!needsCooling) {
          newBlowerCeiling = 0;
          newBlowerFloor = 0;
        }
      }
    }

    // Temperature safety: blower for humidity extraction would COOL the room.
    // With heater role authorised, Rule 5 compensates → safe down to 1.5°C below min.
    // Without heater, we need temp above idealMin + 0.5 to start extraction.
    // Continuation bias: once extraction is running, keep the gate open through small
    // temp dips — the SUBSTITUTION/crash logic above is the authority on when to stop,
    // not this activation gate. Without this, temp oscillating ±0.3 °C around the
    // (idealMin − 1.5) threshold toggled the blower 0↔45 % every cycle (incident
    // 2026-05-20). And when the heater is ineffective, extraction is the only lever,
    // so stay safe down to an absolute cold floor.
    const tempSafeForBlower = temp > idealTemp.min + 0.5
      || humiEmergency
      || leafVpdCritical
      || (heaterAuthorised && temp > idealTemp.min - 1.5)
      || (humiExtractionActive && temp > idealTemp.min - 2.0)
      || (heaterIneffective && temp > idealTemp.min - 5);

    // Anti-oscillation cooldown: after a substitution, suppress reactivation briefly so
    // the heater / dehumidifier can do work. But if humidity keeps RISING during the
    // cooldown the substitution failed to help — short-circuit and let the blower retry.
    const crashCooldownActive = (() => {
      if (lastHumiExtractionCrashTime <= 0) return false;
      const elapsed = now - lastHumiExtractionCrashTime;
      if (elapsed >= HUMI_EXTRACTION_CRASH_COOLDOWN_MS) return false;
      if (humiEmergency) return false;
      // Cooldown bypass: humidity continued climbing past the substitution threshold.
      // No reason to keep waiting — the alternative (dehum / settle) isn't working.
      if (lastHumiExtractionCrashHumi != null && humi > lastHumiExtractionCrashHumi + 2) {
        if (curState !== prevState) {
          console.log(`[VPD] Humi extraction cooldown bypassed: humi rose ${humi.toFixed(0)}% > ${(lastHumiExtractionCrashHumi + 2).toFixed(0)}% since substitution — retry blower`);
        }
        return false;
      }
      return true;
    })();
    if (crashCooldownActive && curState !== prevState) {
      console.log(`[VPD] Humi extraction cooldown active (${Math.round((HUMI_EXTRACTION_CRASH_COOLDOWN_MS - (now - lastHumiExtractionCrashTime)) / 60000)}min remaining) — skipping reactivation`);
    }

    // Activation gate. Trigger on `humi > idealHumiMax` — i.e. only once humidity pushes VPD BELOW
    // the band (genuinely too humid). The 2026-05-28 trigger `humi > idealHumiTarget` was far too
    // eager: it dried the air the instant humidity drifted above target CENTRE while VPD was still
    // perfectly in band, so it fought every overshoot of this powerful/laggy humidifier and produced
    // the 60↔69 % / VPD 0.92↔1.22 saw-tooth (Eddie 2026-06-02). Above-target-but-in-band humidity is
    // FINE — leave it alone and let it drift; only extract when it actually leaves the band.
    if (!crashCooldownActive && dehumExhausted && !blowerCrashingTemp
        && (humiHigh || humiExtractionActive || humi > idealHumiMax)
        && tempSafeForBlower) {
      if (extIsBlower) {
        newBlowerCeiling = 100;

        // ── PROPORTIONAL CONTROL ──
        // Eddie 2026-05-28: the user wants the blower to stay running steadily and reach +
        // hold target VPD, not to slam to a fixed speed and then toggle on/off. The previous
        // step-based optimizer (±10 % bites every 90 s) overshot at the chosen speed, humi
        // crashed below target, role deactivated, then humi rose back and the cycle restarted.
        //
        // The new behaviour: the blower runs CONTINUOUSLY while extraction is wanted, and the
        // speed varies smoothly with how far humi is from target. Bigger error → faster
        // extraction. Small error around target → low steady speed (just enough to fight the
        // moisture input the plants put back into the air). This naturally converges to a
        // stable equilibrium speed instead of bouncing between 40 % and 0 %.
        //
        //   speed = MIN_SPEED + GAIN * max(0, humi - target)
        //
        // GAIN tunes how aggressive the response is. 6 %/percent means humi=target+1 → 36 %,
        // target+3 → 48 %, target+5 → 60 %, target+8 → 78 %. The MIN_SPEED (30) is the lowest
        // setting the blower actually moves air at.
        const PROP_MIN_SPEED = 30;
        const PROP_GAIN = 6;
        // Ramp from the band CEILING, not target: extraction only runs once humidity is over
        // idealHumiMax, so the speed should be gentle right at the edge (a small overshoot needs a
        // nudge, not a 48 % blast) and only grow for genuine excess. Basing it on humi−target made
        // the very first extraction cycle slam ~48 % at humi=target+3 and crash humidity (2026-06-02).
        const errOverMax = Math.max(0, humi - idealHumiMax);
        const propSpeed = Math.min(100, PROP_MIN_SPEED + Math.round(errOverMax * PROP_GAIN));

        if (!humiExtractionActive) {
          // Initial activation — capture state for the role record. baseSpeed stores the
          // proportional speed for future cycles to fall back to if the activation branch is
          // skipped.
          vpdEscalationState.roles['extractor_humi'] = {
            activatedAt: now, metricAtActivation: humi,
            baseSpeed: propSpeed, speedBoost: 0, lastCheckTime: now,
            metricEma: humi, lastAction: 'init', capacityClearedAt: now,
            committedFloor: propSpeed
          };
          console.log(`[VPD] Blower extraction ON @ ${propSpeed}% — humi ${humi.toFixed(0)}% (${errOverMax.toFixed(1)} over band ceiling ${idealHumiMax.toFixed(0)}%, VPD below band)`);
        }

        // Keep the role's committedFloor live so the fallback at line ~3235 picks up the
        // current proportional speed even on cycles where this block doesn't enter.
        const role = vpdEscalationState.roles['extractor_humi'];
        if (role) {
          role.committedFloor = propSpeed;
          role.baseSpeed = propSpeed;
        }
        newBlowerFloor = Math.max(newBlowerFloor, propSpeed);
      } else {
        activateSocketRole('extractor', `Humi ${humi.toFixed(0)}% > ${humiHighThreshold.toFixed(0)}% (${hasDehumRole ? 'dehumidifier exhausted' : 'no dehumidifier'})`);
      }
    }

  } else if (humi <= idealHumiTarget - 6 || (humi < idealHumiMin && !humiEmergency)) {
    // Deactivate when humi is FAR below target (≥6 % under) OR has crashed below the stage's
    // ideal minimum. The second condition is the 2026-05-30 safety: extraction shouldn't keep
    // a role "active" once humi has fallen below the stage min — humidity is no longer the
    // problem, plant transpiration is.
    if (humiExtractionActive) {
      const reason = humi < idealHumiMin
        ? `humi crashed to ${humi.toFixed(0)}% < idealMin ${idealHumiMin.toFixed(0)}% (extraction stops, plants need moisture)`
        : `${humi.toFixed(0)}% far below target ${idealHumiTarget.toFixed(0)}%`;
      console.log(`[VPD] Humidity extraction done: ${reason}`);
      delete vpdEscalationState.roles['extractor_humi'];
      if (!needsCooling) {
        if (!extIsBlower) deactivateSocketRole('extractor', 'Humi OK');
      }
    }
    if (vpdEscalationState.roles['dehumidifier']) {
      delete vpdEscalationState.roles['dehumidifier'];
    }
    deactivateSocketRole('dehumidifier', 'Humi OK');
  }
  // Between idealHumiMax and humiHighThreshold: if nothing was activated, stays off (hysteresis)
  // During humidifierRecentlyOff: everything suppressed, residual moisture settles naturally

  // RULE 5 removed: heater compensation while blower extracts was wasteful — the
  // blower exhausted whatever heat the heater added. The sequential phase machine
  // above replaces it: the system extracts first, then heats. Never simultaneously.

  // When the phase switches to HEATING mid-extraction, stop the extractor — the heater
  // can't compete with active extraction. Eddie 2026-05-28: previously this fired on ANY
  // non-extracting phase including 'idle', so a single noisy 58.5 % humi reading kicked
  // phase→idle and wiped the role mid-test. The 'idle' case is now handled exclusively
  // by the asymmetric deactivation gate at line ~3145 (humi <= target - 3).
  if (phaseHeating && humiExtractionActive) {
    delete vpdEscalationState.roles['extractor_humi'];
    if (!needsCooling) {
      newBlowerCeiling = 0;
      newBlowerFloor = 0;
      if (extIsBlower) {
        // No-op; the floor/ceiling above will be applied via vpdBlowerMaxSpeed
      } else {
        deactivateSocketRole('extractor', `Phase=${vpdPhase} — extraction yielding`);
      }
    }
  }

  // RULE 5 (co-pilot heater) intentionally removed: heater MUST NOT run while the
  // blower is extracting. Burning watts to warm air the blower immediately exhausts
  // is wasted energy. The system relies on residual heat from the lamp + canopy
  // mass to recover temp once extraction stops, gated by a grace period below.

  // ═══════════════════════════════════════════════════════
  // RULE 6: Everything in range → deactivate all, blower OFF
  // ═══════════════════════════════════════════════════════
  if (tempInRange && humiOk) {
    // Full comfort — no devices needed, let the environment settle
    // Blower stays OFF (ceiling=0): no extraction when everything is fine
    newBlowerFloor = 0;
    newBlowerCeiling = 0;
    deactivateSocketRole('humidifier', 'All in range');
    deactivateSocketRole('dehumidifier', 'All in range');
    deactivateSocketRole('heater', 'All in range');
    deactivateSocketRole('cooler', 'All in range');
    if (!extIsBlower) deactivateSocketRole('extractor', 'All in range');
    // Start cooling grace if cooling was active (for when temp re-enters range from above)
    if (coolingActive && !lastCoolingStopTime) {
      lastCoolingStopTime = now;
      coolingGraceLastTemp = temp;
      coolingGraceLastCheck = now;
      coolingGraceStableStart = 0;
    }
    // Also cancel cooling grace if we're solidly in range
    if (temp > idealTemp.min + 0.5) {
      lastCoolingStopTime = 0; // Well above min, no risk of heater-blower fight
    }
    // Full comfort (temp in range AND humi at target±1) → clear ALL roles except the circulator.
    // We used to preserve extractor_humi here to protect a mid-extraction optimizer test, but the
    // optimizer was replaced by proportional control and the unconditional teardown above now owns
    // extractor_humi's lifecycle (it's gone by the time humi reaches target). Preserving it let the
    // blower keep extracting during "everything's fine" (audit P1 #4). Clear it.
    for (const key of Object.keys(vpdEscalationState.roles)) {
      if (key !== 'circulator') delete vpdEscalationState.roles[key];
    }
  }

  // ═══════════════════════════════════════════════════════
  // HARD SAFETY: Prevent devices from making things WORSE.
  // - Heater off if temp > idealMin + 0.5 (well into range, no longer needed)
  //   Allows Rule 5 compensation to work in [idealMin, idealMin+0.5] zone.
  // - Cooler off if temp <= idealMin
  // These run LAST and override ALL rules + flow triggers.
  // ═══════════════════════════════════════════════════════
  if (temp > idealTemp.min + 0.5 && isRoleActive('heater')) {
    deactivateSocketRole('heater', `SAFETY: temp ${temp.toFixed(1)}°C > ${(idealTemp.min + 0.5).toFixed(1)}°C — heater not needed`);
  }
  if (temp <= idealTemp.min && isRoleActive('cooler')) {
    deactivateSocketRole('cooler', `SAFETY: temp ${temp.toFixed(1)}°C <= min ${idealTemp.min}°C`);
  }

  // Fallback: if humidity extraction is still the active role (blower extractor) but
  // no rule lifted the ceiling this cycle — e.g. crash-cooldown window, a momentary
  // temp dip below a gate, or the "humi just touched idealHumiMax" edge — keep driving
  // the previously committed extraction speed instead of dropping to 0. Extraction is
  // only truly ended when the role is deleted (humi reached target, or substitution).
  if (extIsBlower
      && vpdEscalationState.roles['extractor_humi']
      && newBlowerCeiling === 0
      && !needsCooling) {
    const committed = vpdEscalationState.roles['extractor_humi'].committedFloor || 40;
    newBlowerCeiling = 100;
    newBlowerFloor = Math.max(newBlowerFloor, committed);
  }

  // Continuous baseline airflow: keep the exhaust gently moving instead of fully
  // stopping, for even humidity and stable VPD. BUT never while the room is being
  // heated (temp low / heater on) — a baseline exhaust would pull out the very warmth
  // the heater is adding, wasting energy. Also skipped during a cycle-transition stop.
  //
  // Skipped during heating (heater + extractor fight each other heat-wise) and during a
  // genuine humidity emergency (VPD critical, humi very low — even a 30 % baseline pulls
  // moisture out faster than a small humidifier can restore). At MILD humidification (humi
  // just under target, humidifier on for a top-up), keep the baseline running — Eddie
  // 2026-05-29: at humi=58 with VPD=1.12, the blower turning fully off let humi rise
  // unevenly and the humidifier overshot. 30 % baseline distributes humidity through the
  // room while the humidifier adds it, smoother and faster convergence to target.
  const heatingNow = tempLow || isRoleActive('heater') || temp < idealTemp.min;
  const humiCritical = humiLow || leafVpdCritical || (currentVpd > targetMax + 0.10);
  if (extIsBlower && !cycleTransitionGraceActive && !heatingNow && !humiCritical) {
    if (newBlowerCeiling < VPD_BLOWER_IDLE_SPEED) newBlowerCeiling = VPD_BLOWER_IDLE_SPEED;
    if (newBlowerFloor < VPD_BLOWER_IDLE_SPEED) newBlowerFloor = VPD_BLOWER_IDLE_SPEED;
  }

  // ── Rolling-window air-renewal guarantee (Eddie 2026-06-26) ──
  // Attribute the segment that just elapsed [airLastEvalNow, now] to "ran"/"off" by the blower speed
  // that was actually in force over it, keep an EXACT interval log, integrate the TRUE runtime inside
  // the trailing 30 min, and force a 5-min pulse whenever that runtime is below the 5-min minimum.
  // We measure accumulated runtime IN THE WINDOW — not "time since last active" — so a 2-min blip 28
  // min ago can't be mistaken for a fresh swap (Eddie's explicit warning). A finished 5-min pulse adds
  // exactly 5 min to the window, so it can never immediately re-fire: no execution loop.
  const ventilationPulseActive = ventilationPulseStart > 0
    && (now - ventilationPulseStart) < VENTILATION_DURATION_MS;
  // 1) Record the elapsed segment by the speed that was in force over it (lastBlowerSpeed reflects the
  //    previous cycle's command, which includes any pulse that was running).
  if (airLastEvalNow > 0 && now > airLastEvalNow) {
    const segActive = ((lastBlowerSpeed ?? 0) >= AIR_REFRESH_MIN_SPEED) || ventilationPulseActive;
    if (segActive) {
      const last = blowerRunIntervals[blowerRunIntervals.length - 1];
      if (last && last.end >= airLastEvalNow - 1500) last.end = now;      // contiguous → extend the run
      else blowerRunIntervals.push({ start: airLastEvalNow, end: now });  // a fresh run starts
    }
  }
  airLastEvalNow = now;
  // 2) Drop intervals fully outside the window; integrate runtime inside [windowStart, now].
  const airWindowStart = now - AIR_REFRESH_WINDOW_MS;
  blowerRunIntervals = blowerRunIntervals.filter(iv => iv.end >= airWindowStart);
  if (blowerRunIntervals.length > 400) blowerRunIntervals = blowerRunIntervals.slice(-400); // safety cap
  let airRunMsInWindow = 0;
  for (const iv of blowerRunIntervals) {
    const s = Math.max(iv.start, airWindowStart);
    const e = Math.min(iv.end, now);
    if (e > s) airRunMsInWindow += e - s;
  }
  // 3) Pulse whenever the window holds LESS than the 5-min minimum (and we're not already pulsing,
  //    nor in cycle-transition grace where everything is deliberately stopped). This single HARD rule
  //    overrides humidity retention and cooling-futility: a tent that holds humidity but suffocates
  //    its plants in CO2 is a failure. The pulse doubles as a cooling-effectiveness probe.
  const airUndersupplied = airRunMsInWindow < AIR_REFRESH_MIN_MS;
  const needsVentilationPulse = !cycleTransitionGraceActive
    && !ventilationPulseActive
    && airUndersupplied;
  if (needsVentilationPulse) {
    ventilationPulseStart = now;
    console.log(`[VPD] Air-renewal pulse: blower → ${VENTILATION_SPEED}% for ${(VENTILATION_DURATION_MS / 60000).toFixed(0)} min (only ${(airRunMsInWindow / 60000).toFixed(1)} min run in the last ${(AIR_REFRESH_WINDOW_MS / 60000).toFixed(0)} min — air renewal beats humidity).`);
  }
  const inVentilationPulse = ventilationPulseStart > 0
    && (now - ventilationPulseStart) < VENTILATION_DURATION_MS;
  if (inVentilationPulse) {
    // Inside the pulse: enforce the airflow floor (and lift the ceiling so it's actually allowed to
    // run). The pulse is a SAFETY refresh — don't let humi-conserving rules block it.
    if (newBlowerCeiling < VENTILATION_SPEED) newBlowerCeiling = VENTILATION_SPEED;
    if (newBlowerFloor < VENTILATION_SPEED) newBlowerFloor = VENTILATION_SPEED;
  } else if (ventilationPulseStart > 0) {
    // Pulse just ended — clear it so the next one can fire when the window next runs short.
    ventilationPulseStart = 0;
  }

  // ═══════════════════════════════════════════════════════
  // HUMIDITY-PROTECTION & COOLING-FUTILITY SAFETY (2026-05-30 redesign)
  //
  // Root cause of the 2026-05-30 catastrophe: when the night target (e.g. ≤23 °C) sits BELOW
  // the ambient the exhaust vents into (~24 °C), the blower can never reach the target. Cooling
  // is futile — it just desiccates the air. The proportional cooling rule kept slamming the
  // blower to 90-100 %, crashing humidity to 40 % and spiking leaf VPD to 1.8 for hours.
  //
  // A naive "stop the blower when humidifier is active" patch only moves the problem: it
  // creates a NEW oscillation at the engage/disengage threshold (blower 0↔94 %, humi 61↔64).
  //
  // The robust fix is TWO mechanisms with WIDE hysteresis, applied as the final blower authority:
  //
  //   A. COOLING FUTILITY self-test — if the blower runs high for COOLING_EFFECT_CHECK_MS and
  //      temp doesn't drop COOLING_EFFECT_MIN_DROP, the room can't be cooled at this ambient.
  //      Mark cooling futile for a cooldown → hold idle, stop wasting the blower on temperature.
  //      Only evaluated while the blower is cooling for TEMPERATURE (humi below target); when
  //      humi is high the blower's job is humidity removal, which succeeds regardless of temp.
  //
  //   B. STICKY HUMIDITY-YIELD — when cooling is wanted but humi is below target and the
  //      humidifier can do the job, the exhaust yields: holds a steady gentle idle while the
  //      humidifier raises humi, temp floats above the unreachable target. Engages at humi <
  //      target, releases only at humi >= idealHumiMax (genuine natural excess) — wide hysteresis
  //      so the blower never oscillates at a threshold. A relievable heat emergency breaks it; a
  //      futile one does not (slamming wouldn't cool → preserve humidity, let temp float).
  //
  // Net effect on the incident ambient: the system learns "can't cool to 23 °C", holds the
  // blower at a steady 30 %, lets the humidifier hold humi at target, and temp floats at ~24 °C
  // (perfectly safe). Stable equilibrium, no oscillation, no humidity crash.
  // ═══════════════════════════════════════════════════════
  const ABSOLUTE_HUMI_FLOOR_PCT = 42;
  const truthTempEmergency = temp >= TEMP_SAFE_MAX;
  const truthHumiEmergency = humi > idealHumiMax + 15 || humi > 85;

  // ── A. Cooling futility self-test ──
  // "Trying to cool for temperature" = cooling is wanted, humidity is at/below target (so the
  // blower isn't doing useful humidity-EXTRACTION work — at/under target the proportional
  // extractor speed is just idle), and the blower actually ran high last cycle. Using <= target
  // (not < target) lets the test run during a thermal emergency that holds humi right at target.
  const coolingTryingForTemp = needsCooling && humi <= idealHumiTarget && !truthHumiEmergency;
  if (coolingTryingForTemp && (lastBlowerSpeed ?? 0) > VPD_BLOWER_IDLE_SPEED + 10) {
    if (coolingEvalStartTime === 0) {
      coolingEvalStartTime = now;
      coolingEvalStartTemp = temp;
    } else if (now - coolingEvalStartTime >= COOLING_EFFECT_CHECK_MS) {
      const drop = coolingEvalStartTemp - temp;
      if (drop < COOLING_EFFECT_MIN_DROP) {
        coolingIneffectiveUntil = now + COOLING_INEFFECTIVE_COOLDOWN_MS;
        coolingFutileStartTemp = temp; // baseline for the rising-temp escape
        console.log(`[VPD] Cooling FUTILE: only −${drop.toFixed(2)}°C in ${(COOLING_EFFECT_CHECK_MS / 60000).toFixed(0)} min at high blower — ambient too warm to reach ${idealTemp.max}°C. Holding idle ${(COOLING_INEFFECTIVE_COOLDOWN_MS / 60000).toFixed(0)} min, preserving humidity; temp will float above target.`);
        coolingEvalStartTime = 0;
      } else {
        // still dropping — keep measuring from the new baseline (cooling is working)
        coolingEvalStartTime = now;
        coolingEvalStartTemp = temp;
      }
    }
  } else {
    coolingEvalStartTime = 0;
  }
  // ── Rising-temp / hard-ceiling escape (audit P0 #2) ──
  // A futile verdict must NEVER trap a tent that then overheats. If temp climbs past the futility
  // baseline by COOLING_FUTILE_ESCAPE_RISE, OR exceeds an absolute danger ceiling (idealMax+2.5),
  // drop the lockout immediately and force a fresh re-test — cooling, even if marginal, beats
  // letting temp run away. Mirrors the humidifier/heater ineffective self-tests' early-clear.
  const coolingFutileHardCeiling = TEMP_SAFE_MAX;
  if (now < coolingIneffectiveUntil
      && (
        (coolingFutileStartTemp != null && temp >= coolingFutileStartTemp + COOLING_FUTILE_ESCAPE_RISE)
        || temp >= coolingFutileHardCeiling
      )) {
    console.log(`[VPD] Cooling-futility lockout CLEARED early: temp ${temp.toFixed(1)}°C rose from baseline ${coolingFutileStartTemp != null ? coolingFutileStartTemp.toFixed(1) : '?'}°C (or ≥ hard ceiling ${coolingFutileHardCeiling.toFixed(1)}°C) — re-allowing cooling.`);
    coolingIneffectiveUntil = 0;
    coolingFutileStartTemp = null;
    coolingEvalStartTime = 0; // force a fresh measurement
  }
  // coolingFutile = the 4-min blower-measured verdict OR the time-based unreachability detector.
  // The latter is what catches the night ambient-bound case the mutex hides from the former.
  const coolingFutile = (now < coolingIneffectiveUntil) || coolingUnreachable;
  vpdTempCoolingFutile = coolingFutile; // export to the blower-send emergency logic
  // A genuine, RELIEVABLE heat emergency breaks the futility hold. AND an unambiguous overheat
  // (temp ≥ idealMax+2.5) always cools even if a prior verdict called it futile — heat danger
  // outranks the "don't waste the blower" optimisation.
  const emergencyCanCool = truthTempEmergency && (!coolingFutile || temp >= coolingFutileHardCeiling);

  // ── B. Sticky humidity-yield (the primary stabiliser) ──
  // The night conflict: cooling is wanted (temp above stop target) but humidity is below target.
  // Exhaust cooling would dry the air, fighting the humidifier, and at this ambient barely cools
  // anyway. Per Eddie's directive ("la temperatura no puede bajar más → subir humedad según la
  // tabla VPD"), the exhaust YIELDS to the humidifier: it holds a steady gentle idle (mixing +
  // mild cooling) while the humidifier raises humi, and temp is allowed to float above the
  // unreachable target. The humidifier is the humidity authority.
  //
  // WIDE hysteresis is the whole point — this is why the earlier naive guards oscillated:
  //   • ENGAGE when humi < idealHumiTarget (cooling wanted, humidifier can help).
  //   • RELEASE only when humi >= idealHumiMax (humidity reached genuine EXCESS on its own — now
  //     extraction is actually warranted), OR temp fell back into range, OR a relievable heat
  //     emergency, OR the humidifier can't help (then cooling is the only VPD lever — let it run).
  // Engage target−2, release at target (2 % hysteresis). While engaged the exhaust is 0 so the
  // humidifier can win; on release the gentle baseline resumes and trims any overshoot, so humi
  // settles around target with at most a mild 0↔baseline ripple — never the violent swing.
  const _humRoleAssign = vpdNodeConfig.roles.find(r => r.role === 'humidifier');
  const humidifierAuthorised = !!(_humRoleAssign && _humRoleAssign.socket && (
    socketAiModes[_humRoleAssign.deviceMac ? `${_humRoleAssign.deviceMac}:${_humRoleAssign.socket}` : _humRoleAssign.socket]
    || socketAiModes[_humRoleAssign.socket]
  ));
  // "Can help" = the humidifier will actually run (so the blower should yield to it). Mirror the
  // activation gate (humidifierBlocked): when humidity is below target the humidifier runs even if
  // the dry-test flagged it, so the exhaust must yield then too — otherwise it keeps venting and the
  // humidity rise the humidifier IS producing never becomes perceptible (Eddie 2026-06-02).
  const humidifierCanHelp = humidifierAuthorised && !humidifierBlocked;
  const coolingWantedNow = temp > coolingStopTarget;
  if (vpdEscalationState.humidityYield === undefined) vpdEscalationState.humidityYield = false;
  if (!vpdEscalationState.humidityYield) {
    // Engage a couple % BELOW target so there's a real hysteresis band (engage target−2,
    // release target). Engaging exactly at target and releasing at idealHumiMax (the earlier
    // design) let the humidifier overshoot to idealHumiMax+ with the exhaust held at 0 — humi
    // climbed to ~69 % then extraction yanked it back, oscillating humi 61↔69 (2026-05-31).
    if (coolingWantedNow && humi < idealHumiTarget - 2 && humidifierCanHelp && !emergencyCanCool) {
      vpdEscalationState.humidityYield = true;
    }
  } else {
    // Release once humidity REACHES target: at that point the exhaust should resume (gentle
    // baseline) so it removes the humidifier's overshoot instead of letting humi keep climbing
    // with zero exhaust. Cooling can't slam here because the VPD-aware cooling gate suppresses
    // temperature-cooling while VPD ≤ target.
    if (humi >= idealHumiTarget || !coolingWantedNow || emergencyCanCool || !humidifierCanHelp) {
      vpdEscalationState.humidityYield = false;
    }
  }
  const humidityYield = vpdEscalationState.humidityYield;

  // Hold idle when (a) we're yielding to the humidifier, or (b) cooling has been proven futile
  // and there's no humidity excess to extract (covers the no-/dead-humidifier case where yield
  // can't engage but slamming the blower is still pointless).
  // Temperature priority (Eddie 2026-06-06): NEVER hold the exhaust idle while cooling is needed.
  // The blower must run for temperature even while the humidifier raises humidity — they run together.
  const holdIdle = !needsCooling && (humidityYield || (coolingFutile && humi < idealHumiMax && !truthHumiEmergency));

  // ── Apply final blower authority (priority order) ──
  if (truthHumiEmergency) {
    // Humidity dangerously high → extraction is correct AND effective; never cap it here.
  } else if (emergencyCanCool) {
    // Genuine, relievable heat emergency → let cooling run hard (do not cap).
  } else if (holdIdle) {
    // Hold speed:
    //   • humidity-yield (actively raising humi): exhaust FULLY OFF. Verified 2026-05-31 that
    //     even a 30 % exhaust out-paced the humidifier in this dry ambient (humi fell 60→48 %),
    //     whereas at 0 % the humidifier raised humi 43→64 %. So while we're trying to RAISE
    //     humidity, the exhaust must not fight it at all. Internal air movement is the
    //     circulator's job, not the exhaust's.
    //   • cooling futile WITH a humidifier present and humidity not in excess: fully OFF. Even a
    //     30 % exhaust out-paces this humidifier (humi fell 60→48 % at 30 %, rose 43→64 % at 0 %),
    //     so a "gentle air-exchange" baseline silently vents the vapour and drags humidity down,
    //     re-arming the yield → the slow 59↔64 % / VPD 1.12↔1.23 ripple seen 2026-06-02. Air
    //     movement is the circulator's job, not the exhaust's. Only run the 30 % baseline when there
    //     is NO humidifier to out-pace (and humidity isn't in genuine excess, which has its own path).
    //   • active heating: fully OFF (don't vent the heat).
    const holdSpeed = (heatingNow || humidityYield || (humidifierCanHelp && humi < idealHumiMax)) ? 0 : VPD_BLOWER_IDLE_SPEED;
    const why = humidityYield
      ? `humidity-yield (humi ${humi.toFixed(0)}% < target ${idealHumiTarget.toFixed(0)}%, temp ${temp.toFixed(1)}°C floating — humidifier raising humi per VPD chart, exhaust off so it isn't fought)`
      : (humidifierCanHelp && humi < idealHumiMax)
        ? `cooling futile + humidifier maintaining humi ${humi.toFixed(0)}% — exhaust fully off so it doesn't out-pace it`
        : `cooling futile (ambient ${temp.toFixed(1)}°C can't reach ${idealTemp.max}°C) — gentle air exchange`;
    const oldF = newBlowerFloor, oldC = newBlowerCeiling;
    newBlowerFloor = holdSpeed;
    newBlowerCeiling = holdSpeed;
    if ((oldF !== newBlowerFloor || oldC !== newBlowerCeiling) && curState !== prevState) {
      console.log(`[VPD] BLOWER HOLD @ ${holdSpeed}% — ${why} (was ${oldF}-${oldC}%)`);
    }
  } else if (humi < ABSOLUTE_HUMI_FLOOR_PCT) {
    // Defensive backstop (rarely reached given the yield above): never slam a desiccated room.
    newBlowerFloor = Math.min(newBlowerFloor, VPD_BLOWER_IDLE_SPEED);
    newBlowerCeiling = Math.min(newBlowerCeiling, 50);
  }

  // ── BLOWER-AWARE HUMIDIFIER MUTEX (audit P1 #3) ──
  // The cross-device mutex in resolveSocketIntents() only inspects socket on/off winners, but when
  // the extractor role IS the blower it is driven by vpdBlowerMin/MaxSpeed and NEVER appears as an
  // action — so that mutex is blind to it and the humidifier could pump water while the blower
  // exhausts above idle (drives humi DOWN / VPD UP — the opposite of intent). humidityYield catches
  // the humi<target−2 case, but a humidifier left ON by its own hysteresis in the [target−2, target+1]
  // band while cooling wants the blower high slips through. Reconcile explicitly, here, after the
  // final floor is known:
  // TEMPERATURE PRIORITY (Eddie 2026-06-06): when cooling is needed the blower and humidifier run
  // SIMULTANEOUSLY — the mutex no longer clamps the exhaust just because the humidifier is on. The
  // humidifier keeps raising humidity while the exhaust cools; we never trade temperature for humidity.
  // The clamp below now only applies when we are NOT cooling (the resting/in-band case).
  if (extIsBlower && isRoleActive('humidifier') && newBlowerFloor > VPD_BLOWER_IDLE_SPEED && !truthHumiEmergency && !needsCooling) {
    if (emergencyCanCool) {
      // Genuine relievable heat emergency → cooling wins; a high exhaust nullifies humidification
      // anyway, so stop wasting water and stop fighting.
      deactivateSocketRole('humidifier', 'High exhaust nullifies humidification — emergency cooling wins');
      delete vpdEscalationState.roles['humidifier'];
      lastHumidifierOffTime = now;
    } else {
      // Non-emergency → humidifier wins; clamp the blower so it isn't fighting it. 0 while actively
      // raising humi (humi<target), gentle idle otherwise.
      const clamp = (heatingNow || humi < idealHumiTarget) ? 0 : VPD_BLOWER_IDLE_SPEED;
      if (curState !== prevState) {
        console.log(`[VPD] BLOWER↔HUMIDIFIER mutex: humidifier active + blower floor ${newBlowerFloor}% — clamping blower to ${clamp}% (humidifier wins, non-emergency).`);
      }
      newBlowerFloor = clamp;
      newBlowerCeiling = clamp;
    }
  }

  // ── EXHAUST OFF WHEN NOT COOLING AND HUMIDITY ISN'T IN EXCESS (Eddie 2026-06-02) ──
  // The exhaust's only legitimate jobs are to COOL or to dump genuine humidity EXCESS. Any standing
  // "baseline air-exchange" speed steadily vents moisture this room's marginal, lagging humidifier
  // can't replace at night — it drags humidity below target and ping-pongs the humidifier (the slow
  // 59↔64 % / VPD 1.12↔1.23 ripple). The earlier guards each had a hole: the blower↔humidifier mutex
  // only fires above idle (the 30 % baseline slipped through), and the futile-cooling hold needs
  // coolingUnreachable which takes 12 min to re-latch after a restart. This final clamp closes them
  // all: unless we genuinely need cooling (or temp/humidity is an emergency), the exhaust is OFF for
  // the whole in-band humidity range. Air circulation is the circulator's job, not the exhaust's.
  // Exhaust OFF across the whole IN-BAND humidity range (humi ≤ idealHumiMax → VPD ≥ band min). The
  // exhaust's only jobs are to cool or to dump genuine excess; a baseline "air-exchange" speed just
  // vents moisture this marginal/laggy humidifier can't replace and ping-pongs it. Aligned with the
  // extraction gate (which now fires only ABOVE idealHumiMax), so: in band → exhaust 0; above band →
  // the gentle proportional extraction takes over. Air circulation is the circulator's job.
  if (!needsCooling && !tempEmergency && !truthHumiEmergency && humi <= idealHumiMax) {
    newBlowerFloor = 0;
    newBlowerCeiling = 0;
  }

  // ── AIR-RENEWAL PULSE = HARD OVERRIDE (final word) ──
  // Every humidity / futility / mutex authority above can pin the exhaust at 0 to preserve humidity.
  // The air-renewal pulse must survive ALL of them, so re-assert it here — after the final clamps —
  // so a dry room can never suppress the periodic fresh-air swap. Air renewal outranks humidity
  // retention: a tent that holds humidity but suffocates its plants in CO2 is a failure (Eddie 2026-06-26).
  if (inVentilationPulse) {
    if (newBlowerCeiling < VENTILATION_SPEED) newBlowerCeiling = VENTILATION_SPEED;
    if (newBlowerFloor < VENTILATION_SPEED) newBlowerFloor = VENTILATION_SPEED;
  }

  // Apply blower overrides
  vpdBlowerMinSpeed = newBlowerFloor;
  vpdBlowerMaxSpeed = newBlowerCeiling;

  // Circulator always ON when VPD control is active
  const circAssignment = getRoleAssignment('circulator');
  if (circAssignment && circAssignment.socket) {
    const { socket: circSocket, deviceMac: circDeviceMac } = circAssignment;
    const aiModeKey = circDeviceMac ? `${circDeviceMac}:${circSocket}` : circSocket;
    if (socketAiModes[aiModeKey] || socketAiModes[circSocket]) {
      actions.push({ deviceMac: circDeviceMac, socket: circSocket, action: 'on', reason: 'VPD: circulation' });
    }
  }

  // Dedupe per socket — when multiple rules target the same socket within a single
  // evaluation (e.g. Rule 3 "heater off, temp reached min" then Rule 5 "heater on,
  // compensate blower extraction") the LATER decision wins because it ran with more
  // context (subsequent rules see the state the earlier ones set). Without this,
  // the first-in-wins merge later collapses the contradiction the wrong way and
  // the heater stays off while the blower keeps extracting humidity and cooling
  // the room.
  const dedupedBySocket = new Map();
  for (const a of actions) {
    const key = a.deviceMac ? `${a.deviceMac}:${a.socket}` : a.socket;
    dedupedBySocket.set(key, a);
  }
  return Array.from(dedupedBySocket.values());
}

/**
 * Interpolate speed from curve points
 * @param {Array} points - Curve points [{value, speed}, ...]
 * @param {number} sensorValue - Current sensor value
 * @returns {number} - Interpolated speed (0 if below first point)
 */
function interpolateCurve(points, sensorValue) {
  if (!points || points.length < 2) return 0;

  const sorted = [...points].sort((a, b) => a.value - b.value);

  // Below first point = curve inactive
  if (sensorValue < sorted[0].value) return 0;

  // Above last point = max speed from curve
  if (sensorValue >= sorted[sorted.length - 1].value) {
    return sorted[sorted.length - 1].speed;
  }

  // Find segment and interpolate linearly
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sensorValue >= sorted[i].value && sensorValue < sorted[i + 1].value) {
      const ratio = (sensorValue - sorted[i].value) / (sorted[i + 1].value - sorted[i].value);
      return Math.round(sorted[i].speed + ratio * (sorted[i + 1].speed - sorted[i].speed));
    }
  }

  return 0;
}

/**
 * Evaluate Blower Curve control
 * - Calculates optimal blower speed based on sensor curves
 * - Multiple curves: highest demanded speed wins
 * - Supports escalation if sensor doesn't improve
 * @returns {number|null} - Desired blower speed (25-100) or null if no change needed
 */
function evaluateBlowerCurve() {
  const activeCurves = blowerCurveConfig?._activeCurves;
  if (!blowerCurveConfig || !activeCurves || activeCurves.length === 0) {
    return null;
  }

  // When VPD+calibration is active, skip temp/humi curves — calibration is more accurate.
  // Only keep curves for other sensors (CO2, etc.) that VPD doesn't control.
  const vpdActive = !!vpdNodeConfig && vpdNodeConfig.roles?.length > 0;
  const hasCalibration = !!calibrationData;

  const { standbySpeed } = blowerCurveConfig;
  const curves = activeCurves;
  let maxSpeed = 0;
  const now = Date.now();

  for (const curve of curves) {
    // Skip temp/humi curves when VPD+calibration handles them scientifically
    if (vpdActive && hasCalibration && (curve.sensor === 'temp' || curve.sensor === 'humi')) {
      continue;
    }

    const sensorValue = lastSensorValues[curve.sensor];
    if (sensorValue === undefined || sensorValue === null) continue;

    // Calculate base speed from curve
    let speed = interpolateCurve(curve.points, sensorValue);

    // Apply escalation if enabled and curve is active
    if (speed > 0 && curve.escalation?.enabled) {
      const key = curve.id;

      if (!blowerCurveEscalationState[key]) {
        blowerCurveEscalationState[key] = {
          lastValue: sensorValue,
          lastCheck: now,
          escalationBoost: 0
        };
      } else {
        const state = blowerCurveEscalationState[key];
        const elapsedSeconds = (now - state.lastCheck) / 1000;

        if (elapsedSeconds >= (curve.escalation.intervalSeconds || 30)) {
          const improvement = state.lastValue - sensorValue;
          // Also check cumulative: compare against the value at the start of de-escalation
          // to catch gradual drift that individual steps miss
          const cumulativeImprovement = (state.valueAtBoostPeak ?? state.lastValue) - sensorValue;

          if (improvement < (curve.escalation.expectedImprovement || 0.5)) {
            // Not improving enough, escalate
            state.escalationBoost = Math.min(
              state.escalationBoost + (curve.escalation.speedIncrement || 10),
              100 - speed  // Don't exceed 100%
            );
            state.valueAtBoostPeak = sensorValue; // Track peak for cumulative detection
            console.log(`[BlowerCurve] ${curve.sensor}: No improvement (${improvement.toFixed(2)}), escalating +${curve.escalation.speedIncrement}% to ${speed + state.escalationBoost}%`);
          } else if (state.escalationBoost > 0 && cumulativeImprovement < 0) {
            // Cumulative worsening: sensor value is HIGHER than when we started de-escalating.
            // Stop reducing — the reduced speed is making things worse overall.
            console.log(`[BlowerCurve] ${curve.sensor}: Cumulative worsening detected (now ${sensorValue.toFixed(1)} vs peak ${(state.valueAtBoostPeak ?? state.lastValue).toFixed(1)}), HOLDING boost at ${state.escalationBoost}%`);
          } else {
            // Improving, reduce escalation
            state.escalationBoost = Math.max(0, state.escalationBoost - (curve.escalation.speedIncrement || 10));
          }

          state.lastValue = sensorValue;
          state.lastCheck = now;
        }

        speed = Math.min(100, speed + state.escalationBoost);
      }
    }

    maxSpeed = Math.max(maxSpeed, speed);
  }

  // If no curve demanded a speed, return null so the caller defers to the VPD
  // floor/ceiling instead of clobbering it with a literal 0 (which produced
  // spurious "speed=0%" blips between VPD-driven speeds — incident 2026-05-20).
  // Only emit the explicit standby speed when one is configured (> 0).
  if (maxSpeed > 0) return maxSpeed;
  if (standbySpeed && standbySpeed > 0) return standbySpeed;
  return null;
}

/**
 * Send blower speed command via MQTT
 * @param {number} speed - Speed percentage (0-100)
 * @param {boolean} on - Whether blower should be on
 */
async function sendBlowerCommand(speed, on = true) {
  const device = findDeviceForSocket('blower');
  if (!device) {
    console.error('[BlowerCurve] No device found for blower');
    return false;
  }

  const topic = `ggs/${device.type}/${device.mac}/cmd`;
  const command = {
    method: 'setConfigField',
    pid: device.mac,
    params: {
      keyPath: ['device', 'blower'],
      blower: {
        modeType: 0,  // Manual mode (required for trigger control)
        mOnOff: on ? 1 : 0,
        mLevel: speed,
        minSpeed: 0,
        maxSpeed: 0,
        closeCO2: 0
      }
    },
    msgId: String(Date.now()),
    uid: String(device.uid || '')
  };

  console.log(`[BlowerCurve] Sending command: speed=${speed}%, on=${on}`);

  return new Promise((resolve) => {
    mqttClient.publish(topic, JSON.stringify(command), { qos: 1 }, (err) => {
      if (err) {
        console.error('[BlowerCurve] MQTT publish error:', err.message);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

/**
 * Process sensor data (with multi-device support)
 * @param {object} sensorData - Sensor values
 * @param {string} deviceMac - Source device MAC
 */
async function processSensorData(sensorData, deviceMac) {
  // Single canonical timestamp for this evaluation cycle. Used by the blower heartbeat,
  // mismatch recovery, and any later guard that needs to compare wall-clock progress
  // against state set earlier in the same function.
  const now = Date.now();

  // Initialize device sensor storage
  if (deviceMac && !sensorValuesByDevice.has(deviceMac)) {
    sensorValuesByDevice.set(deviceMac, {});
  }

  // Update per-device sensor values
  if (deviceMac) {
    const deviceSensors = sensorValuesByDevice.get(deviceMac);
    if (sensorData.temp !== undefined) deviceSensors.temp = sensorData.temp;
    if (sensorData.humi !== undefined) deviceSensors.humi = sensorData.humi;
    if (sensorData.vpd !== undefined) deviceSensors.vpd = sensorData.vpd;
    if (sensorData.co2 !== undefined) deviceSensors.co2 = sensorData.co2;
    if (sensorData.tempSoil !== undefined) deviceSensors.temp_soil = sensorData.tempSoil;
    if (sensorData.humiSoil !== undefined) deviceSensors.humi_soil = sensorData.humiSoil;
    if (sensorData.ECSoil !== undefined) deviceSensors.ec_soil = sensorData.ECSoil;
  }

  // Also update legacy global sensor values (merge from all devices)
  if (sensorData.temp !== undefined) lastSensorValues.temp = sensorData.temp;
  if (sensorData.humi !== undefined) lastSensorValues.humi = sensorData.humi;
  if (sensorData.vpd !== undefined) lastSensorValues.vpd = sensorData.vpd;
  if (sensorData.co2 !== undefined) lastSensorValues.co2 = sensorData.co2;
  if (sensorData.tempSoil !== undefined) lastSensorValues.temp_soil = sensorData.tempSoil;
  if (sensorData.humiSoil !== undefined) lastSensorValues.humi_soil = sensorData.humiSoil;
  if (sensorData.ECSoil !== undefined) lastSensorValues.ec_soil = sensorData.ECSoil;

  // Track when sensor data was last updated (for staleness detection)
  const hasRealData = sensorData.temp !== undefined || sensorData.humi !== undefined || sensorData.tempSoil !== undefined;
  if (hasRealData) {
    lastSensorValues._lastUpdate = Date.now();
    lastRealSensorAt = Date.now(); // liveness watchdog keys off THIS, not every processSensorData call
    if (deviceMac && sensorValuesByDevice.has(deviceMac)) {
      sensorValuesByDevice.get(deviceMac)._lastUpdate = Date.now();
    }
  }

  // Skip all trigger/blower evaluation while calibration is running
  if (isCalibrationLocked()) {
    return;
  }

  // Evaluate all enabled flows
  const allActions = [];
  for (const flow of flows) {
    try {
      const actions = evaluateFlow(flow);
      allActions.push(...actions);
    } catch (err) {
      console.error(`[Supervisor] Flow evaluation error (${flow.name}):`, err.message);
    }
  }

  // Merge flow actions with explicit conflict detection.
  // If two user flows produce OPPOSITE actions (ON vs OFF) on the same socket, mandatoryOff
  // wins; otherwise mandatoryOn wins; otherwise OFF wins (safer default for contradictions).
  // Pure duplicates (same action) are collapsed silently. Contradictions are logged.
  const actionMap = new Map();
  for (const action of allActions) {
    // Dual-authority resolution (2026-05-31, re-confirmed): the user wired humidity triggers on
    // O3 ("humi<55 → on", "humi>70 → off") AND assigned O3 as the VPD humidifier role. Both
    // resolve to the SAME physical outlet (PS5:O3 — confirmed via socket_events). They fight: the
    // user trigger's auto-release emits O3 OFF whenever humi is between 55 and the VPD target, and
    // the merge's "user trigger wins" rule then OVERRIDES the VPD's ON — capping humidity at ~55 %
    // and blocking the VPD from reaching its chart target (~66 %). Resolution: the VPD is the
    // intelligent controller the user asked to drive humidity per the VPD chart, so it gets sole
    // authority — drop the routine user O3 actions (including the synthesised auto-release OFF).
    // An explicit mandatoryOff (a user safety brake) still survives. The VPD role targets the
    // same device, so dropping the user action does NOT strand the humidifier.
    if (action && action.socket && dualAuthorityVpdWins.has(action.socket) && !action.mandatoryOff) {
      continue;
    }
    const key = action.deviceMac ? `${action.deviceMac}:${action.socket}` : action.socket;
    const existing = actionMap.get(key);
    if (!existing) { actionMap.set(key, action); continue; }
    if (existing.action === action.action) {
      // Same direction → keep the first intent, but MERGE the priority flags. Dropping them silently
      // (the old behaviour) meant a user's explicit "Mandatory OFF" brake was lost whenever a
      // same-direction non-mandatory OFF happened to be pushed earlier in the cycle — and the
      // synthesised auto-release OFF almost always is. The surviving non-mandatory OFF is then
      // blocked by the anti-oscillation lock and sent unverified, so the socket could stay ON for
      // minutes while the user's brake was firing every cycle. Merging cannot switch anything ON:
      // direction is identical, only the priority/verification of that same command improves.
      if (action.mandatoryOff) existing.mandatoryOff = true;
      if (action.mandatoryOn) existing.mandatoryOn = true;
      continue;
    }
    // Contradiction — choose winner by priority
    const chooseMandatoryOff = existing.mandatoryOff && !action.mandatoryOff ? existing
      : (!existing.mandatoryOff && action.mandatoryOff ? action : null);
    const chooseMandatoryOn = existing.mandatoryOn && !action.mandatoryOn ? existing
      : (!existing.mandatoryOn && action.mandatoryOn ? action : null);
    let winner;
    let tieBreak;
    if (chooseMandatoryOff) { winner = chooseMandatoryOff; tieBreak = 'mandatoryOff'; }
    else if (chooseMandatoryOn) { winner = chooseMandatoryOn; tieBreak = 'mandatoryOn'; }
    else if (existing.action === 'off') { winner = existing; tieBreak = 'OFF safer default'; }
    else if (action.action === 'off')   { winner = action;   tieBreak = 'OFF safer default'; }
    else                                 { winner = existing; tieBreak = 'first-wins'; }
    console.warn(`[Supervisor] Contradictory flow actions for ${key}: "${existing.action}" (${existing.reason}) vs "${action.action}" (${action.reason}) — winner: "${winner.action}" [${tieBreak}]`);
    actionMap.set(key, winner);
  }

  // Evaluate VPD intelligent auto-calibration
  // VPD only overrides sockets that are assigned as VPD roles.
  // User-created trigger actions on OTHER sockets are never touched by VPD.
  // EXCEPTION: safety-critical VPD actions (TEMP_EMERG, HUMI_EMERG, leafVpdCritical) ALWAYS
  // win over user triggers — an incorrectly configured user trigger (e.g. AND logic that
  // never activates) must never be able to block a safety shutdown/activation.
  const vpdActions = evaluateVpdIntelligent();
  const vpdRoleSockets = new Set((vpdNodeConfig?.roles || []).map(r => r.socket));
  // Use the SAME stable sensor the VPD controller acted on (not the merged blob), so the
  // emergency override decision is consistent with the control decision.
  const _emergSensor = vpdNodeConfig
    ? getSensorValues(vpdNodeConfig.sensorDeviceMac || resolvePrimarySensorMac())
    : lastSensorValues;
  const tempNow = _emergSensor.temp;
  const humiNow = _emergSensor.humi;
  // Temperature emergency = the HARD safety ceiling (algorithm-owned, NOT the manual config).
  // The soft cooling zone (band top → 30 °C) is handled inside evaluateVpdIntelligent and is
  // futility-suppressible; only at/above TEMP_SAFE_MAX does the send path force the blower to 100 %.
  const emergTempHigh = tempNow != null && tempNow >= TEMP_SAFE_MAX;
  const emergHumiHigh = humiNow != null && humiNow > 85;

  for (const action of vpdActions) {
    const key = action.deviceMac ? `${action.deviceMac}:${action.socket}` : action.socket;
    const existing = actionMap.get(key);
    const isVpdSafety = action.reason && (
      action.reason.includes('cycle transition')
      || action.reason.includes('SAFETY')
      || emergTempHigh
      || emergHumiHigh
    );

    // Mandatory user triggers win for routine VPD actions, but NOT for safety.
    if (existing && !isVpdSafety && (existing.mandatoryOff || existing.mandatoryOn || existing.reason?.includes('Mandatory'))) {
      continue;
    }
    if (existing && isVpdSafety) {
      console.log(`[Supervisor] VPD SAFETY override: ${action.socket}→${action.action} (temp=${tempNow}, humi=${humiNow}) — user trigger ${existing.action} IGNORED`);
      actionMap.set(key, action);
      continue;
    }
    if (existing) {
      console.log(`[Supervisor] VPD wants ${action.socket}→${action.action} but user trigger wants ${existing.action} — user trigger wins`);
      continue;
    }
    actionMap.set(key, action);
  }

  // When VPD is capping the blower, reset curve escalation BEFORE evaluation
  // to prevent pointless accumulation that would spike when ceiling lifts
  if (vpdBlowerMaxSpeed < 100) {
    for (const key in blowerCurveEscalationState) {
      if (blowerCurveEscalationState[key]) {
        blowerCurveEscalationState[key].escalationBoost = 0;
        blowerCurveEscalationState[key].lastCheck = Date.now();
      }
    }
  }

  // Evaluate Blower Curve control (proportional speed based on sensor curves)
  // VPD floor/ceiling override the curve when needed.
  // BUT: if a user trigger has an active blower action (not VPD, not safety), skip VPD
  // ceiling/floor to let the user's trigger control the blower directly.
  // EXCEPTION: temp/humi emergencies (leaf VPD, over-temperature) always win — an
  // incorrect user trigger must never be able to prevent a safety response.
  const userBlowerAction = actionMap.get('blower');
  const userBlowerIsVpdOrSafety = userBlowerAction && (
    userBlowerAction.reason?.startsWith('VPD:')
    || userBlowerAction.reason?.includes('SAFETY')
    || userBlowerAction.reason?.includes('cycle transition')
  );
  const blowerControlledByUserTrigger = userBlowerAction && !userBlowerIsVpdOrSafety
    && !emergTempHigh && !emergHumiHigh;
  // When the VPD Controller node is configured, IT is the sole authority over blower speed.
  // The Blower Curve is open-loop per-sensor calibration that doesn't know the current stage's
  // target — after a stage change (e.g. veg → flowering shifts humi target up) the calibrated
  // curve over-extracts based on stale absolute humi values, fighting the VPD algorithm and
  // crashing humidity. The VPD optimizer's min/max already drive the blower; skip the curve.
  // ALSO skip the curve when the blower is NOT in Trigger/AI mode (blower_ai_mode off). The curve +
  // 3-min heartbeat is an automation authority; in Manual/TimeSlot/Cycle/Environment mode the device
  // firmware or the user's dashboard toggle owns the blower, and the heartbeat must NOT re-assert a
  // saved curve/standby speed over a manual command (JoeGhost 2026-06-28: manual "off" → dashboard
  // "on" was reverted within 3 min). Mirrors how outlets require their AI-mode flag.
  const blowerAiEnabled = !!socketAiModes['blower'];
  const curveSpeed = (vpdNodeConfig || !blowerAiEnabled) ? null : evaluateBlowerCurve();
  // Manual hold: neither VPD (vpdNodeConfig) nor Trigger/AI mode is driving the blower → the user owns
  // it completely; send nothing so the manual command stands indefinitely. VPD/AI installs are
  // unaffected (blowerManualHold is false for them), so their existing emergency-100% override still
  // applies exactly as before; a pure-manual user gets no override, which is the current behaviour too.
  const blowerManualHold = !vpdNodeConfig && !blowerAiEnabled;

  // Enter the speed-send block whenever VPD has any opinion. The old guard skipped the block
  // entirely when both floor=0 and ceiling=100 (no demand), which left the blower stuck at its
  // last commanded value — Eddie 2026-05-27 saw blower stuck at 85 % long after humi had crashed
  // to 48 % and extraction was no longer wanted. With vpdNodeConfig present, the supervisor IS
  // the authority over the blower; if no extraction is needed, that means OFF, not "leave as is".
  if (!blowerControlledByUserTrigger && !blowerManualHold && (curveSpeed !== null || vpdBlowerMinSpeed > 0 || vpdBlowerMaxSpeed < 100 || vpdNodeConfig)) {
    // Resolve the target speed.
    //  - When a curve demands a speed, the VPD floor can only RAISE it (and the
    //    ceiling caps it).
    //  - When there's no curve (VPD is the sole controller), the VPD floor IS the
    //    target — and it must be free to go DOWN. The old code did
    //    `max(lastBlowerSpeed, floor)`, which pinned the speed to its previous value
    //    and stopped the optimizer ever reducing it (blower stuck at 50 % while the
    //    optimizer had already chosen 20 % — incident 2026-05-20).
    let effectiveSpeed = (curveSpeed !== null)
      ? Math.max(curveSpeed, vpdBlowerMinSpeed)
      : vpdBlowerMinSpeed;
    effectiveSpeed = Math.min(effectiveSpeed, vpdBlowerMaxSpeed);
    // Floor: any non-zero blower speed must be ≥ 30 % — below that the blower barely moves air
    // (Eddie 2026-05-26 calibration). 0 % stays 0 % (off). Belt-and-suspenders against curve
    // points calibrated at 25 % and other historical sources of sub-30 % values.
    if (effectiveSpeed > 0 && effectiveSpeed < 30) effectiveSpeed = 30;
    // Emergency blower override — but distinguish the two emergency types:
    //   • Humidity emergency (humi > 85 / far over max): extraction REMOVES the excess and is
    //     always effective → force 100 %.
    //   • Temperature emergency = temp ≥ TEMP_SAFE_MAX (30 °C, the hard ceiling): ALWAYS force
    //     100 %. The futility-suppression that keeps the blower idle on a warm-but-safe night all
    //     happens inside evaluateVpdIntelligent for temp < 30; by the time the send path sees
    //     emergTempHigh we're at the danger limit, where marginal airflow beats letting temp climb.
    if (emergHumiHigh || emergTempHigh) {
      effectiveSpeed = 100;
    }
    // Debounce: only re-issue a command when the speed actually changes by a
    // meaningful step (≥ 5 %), or when crossing the on/off boundary. The base
    // floor wobbles ±5 % cycle-to-cycle as humi micro-fluctuates ±1 %; without
    // this guard the device was spammed with a new command every 2 s.
    const lastSpeed = lastBlowerSpeed ?? -1;
    const crossedOnOff = (effectiveSpeed > 0) !== (lastSpeed > 0);
    // ≥8 % step to re-issue (was 5 %). The proportional extractor moves in ~6 %/1%-humi steps, so a
    // 5 % threshold let single-percent humi noise transmit a 30↔36 limit cycle to the device
    // (audit P1 #6). 8 % filters that quantisation step while still tracking real load changes.
    const changedEnough = Math.abs(effectiveSpeed - lastSpeed) >= 8;
    // Emergency rising edge — always re-send so the operator/device can't miss it.
    const emergencyNow = !!(emergTempHigh || emergHumiHigh);
    const emergencyRisingEdge = emergencyNow && !lastBlowerEmergency;
    // Heartbeat — if we haven't sent a command in BLOWER_HEARTBEAT_MS, re-publish the current
    // desired speed even if nothing changed. Closes the gap where a single missed MQTT message
    // could leave the device stuck at a stale speed indefinitely.
    const heartbeatDue = (now - lastBlowerSendAt) > BLOWER_HEARTBEAT_MS;
    // Mismatch recovery — if the supervisor's lastBlowerSpeed > 0 but device state reports
    // module off, the device probably missed a previous command. Force a re-send.
    const deviceModuleState = lastSocketStates['blower'];
    const mismatchedOnOff = (effectiveSpeed > 0)
      && (deviceModuleState === 0)
      && (now - lastBlowerSendAt) > 30 * 1000; // cooldown so we don't spam during normal startup
    // Min on/off DWELL: suppress an on/off CROSSING within BLOWER_MIN_DWELL_MS of the last accepted
    // crossing (the 31↔0 flap fix). Never suppress an emergency, device-mismatch recovery, or
    // heartbeat — and never block a same-direction speed change (changedEnough without a crossing).
    const dwellBlocksCrossing = crossedOnOff
      && now < blowerToggleLockUntil
      && !emergencyNow && !mismatchedOnOff && !heartbeatDue;
    if (!dwellBlocksCrossing && (crossedOnOff || changedEnough || emergencyRisingEdge || heartbeatDue || mismatchedOnOff)) {
      if (crossedOnOff) blowerToggleLockUntil = now + BLOWER_MIN_DWELL_MS;
      const tags = [];
      if (emergencyNow) tags.push('EMERGENCY');
      if (emergencyRisingEdge) tags.push('emergency-edge');
      if (heartbeatDue) tags.push('heartbeat');
      if (mismatchedOnOff) tags.push('device-mismatch-recovery');
      const tagStr = tags.length ? ` [${tags.join(',')}]` : '';
      console.log(`[BlowerCurve] Speed: ${effectiveSpeed}% (curve=${curveSpeed ?? 'n/a'}, floor=${vpdBlowerMinSpeed}%, ceil=${vpdBlowerMaxSpeed}%)${tagStr}`);
      lastBlowerSpeed = effectiveSpeed;
      lastBlowerSendAt = now;
      lastBlowerEmergency = emergencyNow;
      await sendBlowerCommand(effectiveSpeed, effectiveSpeed > 0);
    }
  }

  // Enforce safety timeouts — force OFF any device that has been ON too long
  const safetyActions = enforceSafetyTimeouts();
  for (const sa of safetyActions) {
    const key = sa.deviceMac ? `${sa.deviceMac}:${sa.socket}` : sa.socket;
    actionMap.set(key, sa); // Safety overrides everything (mandatoryOff = true)
  }

  // Execute deduplicated actions
  await executeActions(Array.from(actionMap.values()));
}

/**
 * Process outlet state updates (with multi-device support)
 * @param {object} outletData - Outlet state data
 * @param {string} deviceMac - Source device MAC
 */
function processOutletState(outletData, deviceMac) {
  // Initialize device socket state storage
  if (deviceMac && !socketStatesByDevice.has(deviceMac)) {
    socketStatesByDevice.set(deviceMac, {});
  }

  for (const [key, value] of Object.entries(outletData)) {
    if (key.startsWith('O') && typeof value === 'object') {
      const isOn = value.on ?? value.mOnOff ?? 0;

      // Store in per-device map
      if (deviceMac) {
        socketStatesByDevice.get(deviceMac)[key] = isOn;
      }

      // Also update legacy global if this is the default PS5
      if (!deviceMac || deviceMac === defaultPrimaryMac) {
        lastSocketStates[key] = isOn;
      }
    }
  }
}

/**
 * Handle MQTT messages (with multi-device support)
 */
function handleMessage(topic, payload) {
  try {
    // Flow update notification — reload and evaluate immediately
    if (topic === 'ggs/system/flow-updated') {
      console.log('[Supervisor] Flow updated notification — reloading and evaluating NOW');
      refreshData().then(() => {
        if (flows.length > 0 && Object.keys(lastSensorValues).length > 0) {
          processSensorData({});
        }
      }).catch(() => {});
      return;
    }

    const message = JSON.parse(payload.toString());
    const parts = topic.split('/');
    // Topic format: ggs/{deviceType}/{mac}/{messageType}
    const deviceType = parts[1];  // ps5, lc
    const deviceMac = normMac(parts[2]);   // MAC address — normalised to lower-case (see normMac)
    const messageType = parts[3]; // status, sensors, etc.

    if (messageType === 'status') {
      const data = message.data || message;

      // Update socket states from outlet data (PS5 devices)
      if (data.outlet) {
        processOutletState(data.outlet, deviceMac);
      }

      // Update module states (blower, fan, heater, humidifier, dehumidifier)
      // These are ON/OFF controllable modules, stored alongside outlet states
      // so trigger conditions and actions can reference them by module name.
      const moduleKeys = ['blower', 'fan', 'heater', 'humidifier', 'dehumidifier'];
      for (const mk of moduleKeys) {
        if (data[mk] && typeof data[mk] === 'object') {
          const mod = data[mk];
          const isOn = mod.on !== undefined ? (mod.on ? 1 : 0) : (mod.mOnOff ?? 0);
          if (deviceMac) {
            if (!socketStatesByDevice.has(deviceMac)) socketStatesByDevice.set(deviceMac, {});
            socketStatesByDevice.get(deviceMac)[mk] = isOn;
          }
          // Gate the merged-store write to the primary device, mirroring the outlet path (audit
          // P2 #8). Unconditional writes let two module-capable strips overwrite each other's
          // blower/module state every ~0.4 s in the merged store → spurious mismatch re-sends.
          // Per-device reads (getSocketState(mac,...)) remain authoritative for the actual owner.
          if (!deviceMac || deviceMac === defaultPrimaryMac) lastSocketStates[mk] = isOn;
          // Cache full config so triggers can preserve speed/level when toggling ON/OFF
          lastModuleConfigs[mk] = { ...mod };
        }
      }

      // Process sensor data (LC devices)
      if (data.sensor) {
        processSensorData(data.sensor, deviceMac);
      }

      // Process soil sensor data (array of sensors, use average)
      if (Array.isArray(data.sensors)) {
        const soilSensors = data.sensors.filter(s => s.id !== 'avg');
        if (soilSensors.length > 0) {
          const avg = {
            tempSoil: soilSensors.reduce((sum, s) => sum + (s.tempSoil || 0), 0) / soilSensors.length,
            humiSoil: soilSensors.reduce((sum, s) => sum + (s.humiSoil || 0), 0) / soilSensors.length,
            ECSoil: soilSensors.reduce((sum, s) => sum + (s.ECSoil || 0), 0) / soilSensors.length
          };
          processSensorData(avg, deviceMac);
        }
      }
    }

    if (messageType === 'sensors') {
      processSensorData(message, deviceMac);
    }
  } catch (err) {
    // Genuine JSON parse errors on malformed packets are expected and noisy, but a
    // programming error inside processSensorData / evaluateFlow would otherwise vanish
    // here forever. Log non-parse errors, throttled, so real bugs surface.
    const isParseError = err instanceof SyntaxError;
    if (!isParseError) {
      const nowMs = Date.now();
      if (nowMs - lastHandleMessageErrorLog > 30000) {
        lastHandleMessageErrorLog = nowMs;
        console.error(`[Supervisor] handleMessage error on ${topic}:`, err && err.stack ? err.stack : err);
      }
    }
  }
}
let lastHandleMessageErrorLog = 0;

/**
 * Connect to MQTT broker
 */
function connectMqtt() {
  const url = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
  console.log(`[Supervisor] Connecting to MQTT ${url}...`);

  mqttClient = mqtt.connect(url, {
    clientId: `supervisor-agent-${Date.now()}`,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000
  });

  let mqttConnected = false;

  mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log('[Supervisor] MQTT connected');

    // Subscribe to sensor data topics
    mqttClient.subscribe('ggs/+/+/status', { qos: 0 });
    mqttClient.subscribe('ggs/+/+/sensors', { qos: 0 });
    // Subscribe to system notifications (flow updates, etc.)
    mqttClient.subscribe('ggs/system/flow-updated', { qos: 0 });
  });

  mqttClient.on('message', handleMessage);

  mqttClient.on('error', (err) => {
    console.error('[Supervisor] MQTT error:', err.message);
    // If we never connected successfully and mqtt.js stops retrying,
    // force a manual reconnect after delay
    if (!mqttConnected) {
      setTimeout(() => {
        if (!mqttConnected && mqttClient) {
          console.log('[Supervisor] MQTT initial connection failed — forcing reconnect in 10s...');
          try { mqttClient.end(true); } catch {}
          mqttClient = null;
          setTimeout(connectMqtt, 10000);
        }
      }, 5000);
    }
  });

  mqttClient.on('close', () => {
    console.log('[Supervisor] MQTT disconnected');
  });

  mqttClient.on('reconnect', () => {
    console.log('[Supervisor] MQTT reconnecting...');
  });
}

/**
 * Periodic refresh of flows and AI modes
 */
async function refreshData() {
  await loadFlows();
  await loadSocketAiModes();
  await loadDayNightSchedule();
  await processLightCycleTransitions(); // resume any in-flight flip + set night-mode flag before first eval
  await loadSafetyTimeouts();
  loadCalibrationData();
  loadVpdFromFlow();
  loadBlowerCurveFromFlow();
  if (vpdNodeConfig && (vpdNodeConfig.mode === 'grow_phase' || vpdNodeConfig.mode === 'plant_stage')) {
    await loadActiveGrowPhase();
  }
}

/**
 * Load device info (MAC, UID) from QuestDB into device registry
 */
let _lastDeviceLoadSummary = '';
async function loadDeviceInfo() {
  try {
    const result = await pool.query(`
      SELECT device_type, mac, user_id
      FROM devices
      LATEST ON timestamp PARTITION BY mac
    `);

    if (result.rows) {
      for (const row of result.rows) {
        const type = (row.device_type || '').toLowerCase();
        const mac = normMac(row.mac); // normalise so registry keys match the normalised topic MACs

        if (!mac) continue;

        deviceRegistry.set(mac, {
          type,
          uid: row.user_id || '',
          mac
        });

        // Set default primary device — prefer PS5 (has outlets), CB as fallback
        if (type === 'ps5') {
          defaultPrimaryMac = mac;
          defaultPrimaryType = type;
        } else if (type === 'cb' && !defaultPrimaryMac) {
          defaultPrimaryMac = mac;
          defaultPrimaryType = type;
        }
      }
    }

    const summary = `${deviceRegistry.size}|${defaultPrimaryType}|${defaultPrimaryMac || 'none'}`;
    if (summary !== _lastDeviceLoadSummary) {
      _lastDeviceLoadSummary = summary;
      console.log(`[Supervisor] Loaded ${deviceRegistry.size} devices, primary: ${defaultPrimaryType}/${defaultPrimaryMac || 'none'}`);
    }
  } catch (err) {
    if (!err.message.includes('does not exist')) {
      console.error('[Supervisor] Error loading device info:', err.message);
    }
  }
}

/**
 * Get device info by MAC, with fallback to primary device
 */
function getDevice(mac) {
  mac = normMac(mac);
  if (mac && deviceRegistry.has(mac)) {
    return deviceRegistry.get(mac);
  }
  // Fallback to default primary for backward compatibility
  if (defaultPrimaryMac && deviceRegistry.has(defaultPrimaryMac)) {
    return deviceRegistry.get(defaultPrimaryMac);
  }
  return null;
}

/**
 * Find the correct device for a socket/module.
 * For modules (blower, fan, heater, etc.): find the device that actually HAS that module
 * by checking which device reports state for it.
 * For outlets: find PS5/PS10/CB that has outlets.
 */
function findDeviceForSocket(socketId) {
  const isModule = ['blower', 'fan', 'heater', 'humidifier', 'dehumidifier'].includes(socketId);

  if (isModule) {
    // Find the device that actually has this module (reported via MQTT status)
    for (const [mac, states] of socketStatesByDevice) {
      if (states[socketId] !== undefined) {
        const dev = deviceRegistry.get(mac);
        if (dev) return dev;
      }
    }
    // Fallback: check lastModuleConfigs for devices that reported this module
    if (lastModuleConfigs[socketId]) {
      // Module data exists — find any power strip device
      for (const [mac, dev] of deviceRegistry) {
        if (dev.type === 'ps5' || dev.type === 'ps10' || dev.type === 'cb') return dev;
      }
    }
  }

  // For outlets or fallback: find any power strip device
  for (const [mac, dev] of deviceRegistry) {
    if (dev.type === 'ps10') return dev; // PS10 has more outlets, prefer it
  }
  for (const [mac, dev] of deviceRegistry) {
    if (dev.type === 'ps5') return dev;
  }
  for (const [mac, dev] of deviceRegistry) {
    if (dev.type === 'cb') return dev;
  }
  return null;
}

/**
 * Get sensor values for a specific device (or merged values if no device specified)
 */
function getSensorValues(deviceMac) {
  deviceMac = normMac(deviceMac);
  if (deviceMac && sensorValuesByDevice.has(deviceMac)) {
    return sensorValuesByDevice.get(deviceMac);
  }
  // Fallback to legacy merged values
  return lastSensorValues;
}

/**
 * Resolve the STABLE primary climate-sensor device MAC for VPD control.
 *
 * Root-cause fix (2026-05-31): when the VPD node has no explicit sensorDeviceMac, the controller
 * was reading `lastSensorValues` — the MERGED, last-writer-wins sensor blob. With more than one
 * device reporting temp/humi (here a CB and an LC with differently-calibrated/placed probes,
 * ~56 % vs ~63 % RH), every incoming message overwrote the blob, so the controller saw humidity
 * ALTERNATING 56↔63 % every few seconds. That fed the whole loop (VPD, humidifier, phase machine,
 * blower) garbage and was a major driver of the erratic behaviour.
 *
 * Fix: lock onto ONE device's per-device store and keep using it (stability) unless it goes stale.
 * Preference order matches the web dashboard's primary (CB first — "full sensor suite") so the
 * supervisor controls on the SAME reading the user sees. The user can still override per VPD node
 * via sensorDeviceMac.
 */
let _lockedSensorMac = '';
function resolvePrimarySensorMac() {
  const FRESH_MS = 3 * 60 * 1000;
  const hasFresh = (mac) => {
    const s = sensorValuesByDevice.get(mac);
    return !!(s && typeof s.temp === 'number' && typeof s.humi === 'number'
      && s._lastUpdate && (Date.now() - s._lastUpdate) < FRESH_MS);
  };
  // Stability first: keep the current lock while it's still delivering fresh data.
  if (_lockedSensorMac && hasFresh(_lockedSensorMac)) return _lockedSensorMac;
  // Re-select by type priority (CB matches the web's primary), then power strips, then LC.
  for (const wantType of ['cb', 'ps10', 'ps5', 'lc']) {
    for (const [mac, dev] of deviceRegistry) {
      if ((dev.type || '').toLowerCase() === wantType && hasFresh(mac)) {
        if (_lockedSensorMac !== mac) {
          console.log(`[VPD] Primary climate sensor → ${wantType.toUpperCase()} ${mac} (stable single source; set the VPD node's sensorDeviceMac to override). Was reading the merged multi-device blob, which alternates between sensors.`);
          _lockedSensorMac = mac;
        }
        return mac;
      }
    }
  }
  // Nothing fresh per-device — return '' so getSensorValues() falls back to the merged blob
  // (legacy behaviour; never returns undefined).
  return '';
}

/**
 * Calculate Leaf VPD from air temp and humidity.
 * Formula: SVP(T_leaf) - SVP(T_air) × (RH/100)
 * where T_leaf = T_air - offset. Offset is day/night aware so nighttime
 * (lights off) doesn't get penalised by the high-LED day offset.
 */
function calculateLeafVpd(airTemp, humi) {
  if (airTemp == null || humi == null) return null;
  const svp = (t) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
  const leafTemp = airTemp - getLeafOffset();
  return svp(leafTemp) - svp(airTemp) * (humi / 100);
}

/**
 * Get socket state for a specific device:socket
 */
function getSocketState(deviceMac, socket) {
  deviceMac = normMac(deviceMac);
  if (deviceMac && socketStatesByDevice.has(deviceMac)) {
    const deviceStates = socketStatesByDevice.get(deviceMac);
    if (deviceStates[socket] !== undefined) {
      return deviceStates[socket];
    }
  }
  // Fallback to legacy states (default PS5)
  return lastSocketStates[socket];
}

/**
 * Daily auto-backup: creates a database backup at 00:00, keeps only 2 (today + yesterday)
 */
async function performAutoBackup() {
  const questdbHost = process.env.QUESTDB_HOST || '127.0.0.1';
  const questdbPort = process.env.QUESTDB_HTTP_PORT || '9000';
  const baseUrl = `http://${questdbHost}:${questdbPort}`;
  const PROJECT_ROOT = path.resolve(__dirname, '../..');
  const backupDir = path.join(PROJECT_ROOT, 'database/backups');

  console.log('[Supervisor] Starting daily auto-backup...');

  try {
    // Get list of tables
    const tablesRes = await fetch(`${baseUrl}/exec?query=${encodeURIComponent('SHOW TABLES')}`);
    if (!tablesRes.ok) throw new Error('Failed to query tables');
    const tablesData = await tablesRes.json();

    const systemPrefixes = ['sys.', 'telemetry', '_query_trace'];
    const tableNames = tablesData.dataset
      .map(row => row[0])
      .filter(name => !systemPrefixes.some(p => name.startsWith(p)));

    // Export each table
    const tables = [];
    for (const tableName of tableNames) {
      try {
        const colRes = await fetch(`${baseUrl}/exec?query=${encodeURIComponent(`SHOW COLUMNS FROM '${tableName}'`)}`);
        if (!colRes.ok) continue;
        const colData = await colRes.json();
        const schema = colData.dataset.map(row => ({ name: row[0], type: row[1] }));

        const dataRes = await fetch(`${baseUrl}/exec?query=${encodeURIComponent(`SELECT * FROM '${tableName}' LIMIT 1000000`)}&limit=0,1000000`);
        if (!dataRes.ok) continue;
        const dataResult = await dataRes.json();

        tables.push({
          name: tableName,
          schema,
          rowCount: dataResult.count || 0,
          data: dataResult.dataset || []
        });
      } catch (err) {
        console.error(`[Supervisor] Auto-backup: error exporting ${tableName}:`, err.message);
      }
    }

    // Assemble and compress
    const backup = { version: 1, created: new Date().toISOString(), tables };
    const jsonBuffer = Buffer.from(JSON.stringify(backup));
    const compressed = gzipSync(jsonBuffer, { level: 6 });

    // Save with "autobackup" prefix and date
    fs.mkdirSync(backupDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `autobackup-${dateStr}.json.gz`;
    const filePath = path.join(backupDir, filename);
    fs.writeFileSync(filePath, compressed);

    const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0);
    console.log(`[Supervisor] Auto-backup saved: ${filename} (${tables.length} tables, ${totalRows} rows, ${(compressed.length / 1024).toFixed(0)} KB)`);

    // Cleanup: keep only 2 most recent auto-backups
    const allFiles = fs.readdirSync(backupDir);
    const autoBackups = allFiles
      .filter(f => f.startsWith('autobackup-') && f.endsWith('.json.gz'))
      .sort()
      .reverse();

    for (let i = 2; i < autoBackups.length; i++) {
      const oldPath = path.join(backupDir, autoBackups[i]);
      fs.unlinkSync(oldPath);
      console.log(`[Supervisor] Removed old auto-backup: ${autoBackups[i]}`);
    }
  } catch (err) {
    console.error('[Supervisor] Auto-backup failed:', err.message);
  }
}

let lastAutoBackupDay = null;

function checkAutoBackupSchedule() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = now.getHours();
  const minute = now.getMinutes();

  // Trigger at 00:00 (within the first minute of the day)
  if (hour === 0 && minute === 0 && lastAutoBackupDay !== today) {
    lastAutoBackupDay = today;
    performAutoBackup().catch(err => {
      console.error('[Supervisor] Auto-backup schedule error:', err.message);
    });
  }
}

/**
 * Initialize and start the supervisor agent
 */
async function start() {
  console.log('[Supervisor] Starting supervisor agent...');

  // Load persisted supervisor state (lastKnownPeriod, lastCycleTransitionAt, ineffective lockouts).
  // Done BEFORE the first refreshData so the cycle-transition guard has the previous period to
  // compare against — otherwise the first eval after restart would treat any period as a fresh
  // transition cascade (the 2026-05-30 incident pattern: 24 restarts × cascade per restart).
  loadSupervisorState();

  // Load device MACs from database
  await loadDeviceInfo();

  // Initial data load
  await refreshData();

  // Connect to MQTT
  connectMqtt();

  // One-time: cap the QuestDB container log if it isn't already (uncapped json-file logs grew
  // to 12 GB on a user's disk — incident 2026-05-21). Deferred so it never delays startup;
  // idempotent and a no-op once the container has rotation. Guarded for older updater builds.
  setTimeout(() => {
    try {
      if (typeof updateChecker.ensureQuestdbLogRotation === 'function') {
        updateChecker.ensureQuestdbLogRotation();
      }
    } catch (err) {
      console.warn('[Supervisor] QuestDB log rotation check failed:', err.message);
    }
    // Cap ALL PM2 service logs (install + configure pm2-logrotate) so no service —
    // the verbose TLS proxy especially — can balloon a user's disk. Idempotent.
    try {
      if (typeof updateChecker.ensurePm2Logrotate === 'function') {
        updateChecker.ensurePm2Logrotate();
      }
    } catch (err) {
      console.warn('[Supervisor] pm2-logrotate check failed:', err.message);
    }
    // One-time: repair the s4r-app.service systemd unit (Type=forking → oneshot) so the
    // whole stack auto-recovers after a reboot. Idempotent no-op once migrated. This is the
    // ONLY reliable trigger on a supervisor-only release — the updater's self-update path
    // restarts the supervisor before runPostUpdateMigrations() runs. Guarded for older builds.
    try {
      if (typeof updateChecker.ensureBootResilience === 'function') {
        updateChecker.ensureBootResilience();
      }
    } catch (err) {
      console.warn('[Supervisor] Boot resilience check failed:', err.message);
    }
  }, 8000);

  // ── Safe Startup Sequence ──
  // After connecting MQTT, wait briefly then send ALL OFF to every registered device.
  // This prevents devices from staying in an unknown ON state after supervisor restart.
  // Especially important for heaters (fire risk) and humidifiers (flood risk).
  setTimeout(async () => {
    const allDevices = Array.from(deviceRegistry.values());
    if (allDevices.length === 0) return;

    console.log(`[SAFETY] Safe startup: sending ALL OFF to ${allDevices.length} devices...`);
    const moduleKeys = ['blower', 'fan', 'heater', 'humidifier', 'dehumidifier'];

    for (const device of allDevices) {
      if (!device.mac || device.type === 'lc') continue; // Skip sensor-only devices

      // Turn off all outlets
      for (let i = 1; i <= 10; i++) {
        const socket = `O${i}`;
        // Only send OFF if socket is in AI mode (don't interfere with manual control)
        if (socketAiModes[socket]) {
          await sendSocketCommand(device.mac, socket, 'off');
        }
      }

      // Turn off all modules in AI mode
      for (const mod of moduleKeys) {
        if (socketAiModes[mod]) {
          await sendSocketCommand(device.mac, mod, 'off');
        }
      }
    }

    // Reset blower. CRITICAL: also reset lastBlowerSpeed so the next VPD evaluation
    // detects the change from "off" to "wanted speed" and re-sends the command.
    // Without this, the VPD thinks the blower is still at whatever speed it last set
    // and never re-issues the command after the Safe Startup forced it OFF.
    if (socketAiModes['blower']) {
      vpdBlowerMinSpeed = 0;
      vpdBlowerMaxSpeed = 0;
      await sendBlowerCommand(0, false);
      lastBlowerSpeed = 0;
    }

    console.log('[SAFETY] Safe startup complete — all AI-controlled devices OFF');

    // ── Recover deviceOnSince from database ──
    // If the supervisor crashed while a device was ON, we need to know HOW LONG
    // it's been ON so the safety timeout can fire. Query the last ON event per socket.
    try {
      const onEvents = await query(`
        SELECT socket, timestamp
        FROM socket_events
        WHERE is_on = 1
        ORDER BY timestamp DESC
        LIMIT 50
      `);
      const latestOnPerSocket = {};
      for (const row of (onEvents || [])) {
        if (!latestOnPerSocket[row.socket]) {
          latestOnPerSocket[row.socket] = row.timestamp;
        }
      }
      // For each socket currently reported as ON, start tracking from NOW.
      // Previously we used the DB timestamp of the last ON event, but DB events can
      // be stale (off events not logged, or the supervisor missed cycles) and a
      // 2h-old timestamp would immediately trip the safety force-OFF on restart,
      // even though the device may have been freshly turned on. Tracking from NOW
      // keeps the user's heater alive after a supervisor restart.
      for (const [socket, ts] of Object.entries(latestOnPerSocket)) {
        const currentState = lastSocketStates[socket];
        if (currentState === 1 && socketAiModes[socket]) {
          deviceOnSince[socket] = Date.now();
          const ageMin = Math.round((Date.now() - new Date(typeof ts === 'string' && !ts.endsWith('Z') ? ts.replace(' ', 'T') + 'Z' : ts).getTime()) / 60000);
          console.log(`[SAFETY] Tracking ${socket} (currently ON; last DB ON event ${ageMin} min ago — restarting clock)`);
        }
      }
    } catch (err) {
      console.error('[SAFETY] Failed to recover deviceOnSince:', err.message);
    }
  }, 5000); // Wait 5 sec for MQTT connection to establish

  // Refresh data and device info every 30 seconds
  setInterval(async () => {
    await loadDeviceInfo();
    await refreshData();
  }, 30000);

  // Also evaluate schedule-based triggers periodically (every 10 seconds)
  setInterval(async () => {
    if (flows.length > 0 && Object.keys(lastSensorValues).length > 0) {
      // Trigger evaluation with current sensor values
      await processSensorData({});
    }
  }, 10000);

  // Flip-to-flower transitions (dark → 12/12) are driven inside refreshData() — startup, every 30 s,
  // and on flow-update — so darkTransitionActive is set before each sensor eval in the same cycle.
  // A separate 30 s setInterval here used to ALSO call processLightCycleTransitions(), double-ticking
  // the transition and risking a double day/night INSERT + double Lab sync at the flip boundary
  // (removed 2026-06-28). The dark/flower instants are absolute times, so a tick adds ≤30 s of slack.

  // Check for software updates every 10 minutes
  setInterval(() => {
    updateChecker.checkForUpdates({ autoApply: true }).catch(err => {
      console.error('[Supervisor] Update check error:', err.message);
    });
  }, 10 * 60 * 1000);

  // Self-heal errored PM2 services every 5 minutes — covers the
  // "Mosquitto stuck in errored after reboot" scenario from cobra5118 / Joerg.
  setInterval(() => {
    if (typeof updateChecker.recoverErroredServices === 'function') {
      updateChecker.recoverErroredServices().catch(err => {
        console.error('[Supervisor] Service recovery error:', err.message);
      });
    }
  }, 5 * 60 * 1000);
  // Also run once on startup, after a short delay so PM2 has settled
  setTimeout(() => {
    if (typeof updateChecker.recoverErroredServices === 'function') {
      updateChecker.recoverErroredServices().catch(() => {});
    }
  }, 15000);

  // Sync appdata assets every 10 minutes (lightweight: just compares cached index)
  setInterval(() => {
    updateChecker.syncAppData().catch(err => {
      console.error('[Supervisor] AppData sync error:', err.message);
    });
  }, 10 * 60 * 1000);

  // Sync appdata immediately on startup (5s delay for services to settle)
  setTimeout(() => {
    updateChecker.syncAppData().catch(err => {
      console.error('[Supervisor] Initial AppData sync error:', err.message);
    });
  }, 5000);

  // Check for software updates 30s after startup
  setTimeout(() => {
    updateChecker.checkForUpdates({ autoApply: true }).catch(err => {
      console.error('[Supervisor] Initial update check error:', err.message);
    });
  }, 30000);

  // Daily auto-backup check every 60 seconds
  setInterval(checkAutoBackupSchedule, 60000);
  // Also check immediately on startup (in case we started at midnight)
  checkAutoBackupSchedule();

  // ═══════════════════════════════════════════════════════
  // DEVICE WATCHDOG: Detect outlets stuck ON beyond safety limits.
  // Runs every 60s. Reads actual device state (lastSocketStates)
  // and enforces safety timeouts even if deviceOnSince was lost.
  // This is the LAST line of defense against stuck devices.
  // ═══════════════════════════════════════════════════════
  setInterval(() => {
    if (isShuttingDown) return;
    const forceOff = enforceSafetyTimeouts();
    if (forceOff && forceOff.length > 0) {
      executeActions(forceOff).catch(err => {
        console.error('[SAFETY] Failed to execute safety timeout actions:', err.message);
      });
    }
  }, 60000);

  // ═══════════════════════════════════════════════════════
  // WATCHDOG: Self-monitoring — if no REAL sensor data arrives for 5 minutes, the feed is dead
  // (device offline, proxy/MQTT hung). Force-exit so PM2 restarts us and re-subscribes.
  // CRITICAL: this keys off lastRealSensorAt (bumped only on genuine temp/humi/soil messages),
  // NOT a per-call timestamp — the old version was bumped by the empty 10s schedule self-tick, so
  // it NEVER fired even during a real 27-min sensor outage (2026-05-21). The blower would otherwise
  // sit frozen at its last speed indefinitely while emergencies read a stale value.
  // ═══════════════════════════════════════════════════════
  const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes without REAL sensor data = dead feed
  let lastPipelineKickAt = 0;
  const PIPELINE_KICK_COOLDOWN_MS = 4 * 60 * 1000; // don't restart the proxy more than ~once per 4 min
  setInterval(() => {
    const silenceMs = Date.now() - lastRealSensorAt;
    if (silenceMs > WATCHDOG_TIMEOUT_MS) {
      // The data SOURCE is the proxy (device→proxy→local broker). When the proxy's local-publish
      // client gets stuck disconnected, it silently drops every reading while staying PM2-"online",
      // so restarting only the supervisor never recovered it (Eddie 2026-06-20: a ~1.5h sensor gap
      // that only a full machine reboot fixed; the proxy/broker/ingest had NOT restarted during it).
      // Kick the proxy (and let it re-establish its local-broker link) BEFORE we exit, so the feed
      // actually resumes instead of the supervisor bouncing in place against a dead source.
      const now = Date.now();
      if (now - lastPipelineKickAt > PIPELINE_KICK_COOLDOWN_MS) {
        lastPipelineKickAt = now;
        console.error(`[Supervisor] WATCHDOG: No REAL sensor data in ${Math.round(silenceMs / 1000)}s — restarting the proxy (data source) before self-restart`);
        try {
          execSync('pm2 restart s4r-proxy', { stdio: 'pipe', timeout: 20000 });
          console.error('[Supervisor] WATCHDOG: proxy restart issued');
        } catch (e) {
          console.error('[Supervisor] WATCHDOG: proxy restart failed:', e && e.message);
        }
      } else {
        console.error(`[Supervisor] WATCHDOG: No REAL sensor data in ${Math.round(silenceMs / 1000)}s — proxy kicked recently, forcing self-restart only`);
      }
      process.exit(1); // PM2 will restart us; we re-subscribe to the now-fresh pipeline
    }
  }, 60000);

  // ═══════════════════════════════════════════════════════
  // HEARTBEAT: Publish health status to MQTT every 30s
  // External monitors (web UI, other services) can subscribe
  // to detect if the supervisor is alive and evaluating.
  // ═══════════════════════════════════════════════════════
  setInterval(() => {
    if (mqttClient && mqttClient.connected) {
      mqttClient.publish('s4r/supervisor/health', JSON.stringify({
        status: 'alive',
        uptime: Math.round(process.uptime()),
        lastSensorAge: Math.round((Date.now() - lastRealSensorAt) / 1000),
        mem: Math.round(process.memoryUsage().rss / 1024 / 1024),
        devices: deviceRegistry.size,
        flows: flows.length,
        ts: Date.now()
      }), { qos: 0, retain: true });
    }
  }, 30000);

  console.log('[Supervisor] Supervisor agent started (watchdog + heartbeat active)');
}

/**
 * Graceful shutdown — SAFETY: turn OFF all AI-controlled devices before dying.
 * Prevents devices from being stuck ON indefinitely when the supervisor restarts.
 * Critical for heaters (fire risk), humidifiers (flood/mold risk), and blowers.
 */
let isShuttingDown = false;
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[SAFETY] Graceful shutdown: turning OFF all AI-controlled devices...');

  if (mqttClient && mqttClient.connected) {
    const moduleKeys = ['blower', 'fan', 'heater', 'humidifier', 'dehumidifier'];
    const allDevices = Array.from(deviceRegistry.values());

    for (const device of allDevices) {
      if (!device.mac || device.type === 'lc') continue;
      // Turn off AI-controlled outlets
      for (let i = 1; i <= 10; i++) {
        const socket = `O${i}`;
        if (socketAiModes[socket] && lastSocketStates[socket] === 1) {
          try { await sendSocketCommand(device.mac, socket, 'off'); } catch {}
        }
      }
      // Turn off AI-controlled modules
      for (const mod of moduleKeys) {
        if (socketAiModes[mod] && lastSocketStates[mod] === 1) {
          try { await sendSocketCommand(device.mac, mod, 'off'); } catch {}
        }
      }
    }
    // Blower to 0
    if (socketAiModes['blower']) {
      try { await sendBlowerCommand(0, false); } catch {}
    }

    console.log('[SAFETY] Shutdown complete — all AI devices OFF');
    mqttClient.publish('s4r/supervisor/health', JSON.stringify({
      status: 'offline', ts: Date.now()
    }), { qos: 0, retain: true });
    mqttClient.end(true);
  }
  pool.end();
  // Give MQTT a moment to flush
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the service
start().catch((err) => {
  console.error('[Supervisor] Failed to start:', err);
  process.exit(1);
});
