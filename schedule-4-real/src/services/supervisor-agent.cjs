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
// Leaf temperature offset below air temperature, depends on lighting:
//   DAY:   2.8°C (LED high power — hot leaves via radiation, DimLux standard)
//   NIGHT: 1.0°C (lights off — leaves barely cooler than air, mostly transpiration)
// Night VPD rises fast if we keep using the day offset → system triggers false extraction.
const LEAF_TEMP_OFFSET_DAY = 2.8;
const LEAF_TEMP_OFFSET_NIGHT = 1.0;
const LEAF_TEMP_OFFSET = LEAF_TEMP_OFFSET_DAY; // Kept for backward-compat callers; see getLeafOffset()
function getLeafOffset() {
  try {
    return getCurrentPeriod() === 'day' ? LEAF_TEMP_OFFSET_DAY : LEAF_TEMP_OFFSET_NIGHT;
  } catch {
    return LEAF_TEMP_OFFSET_DAY;
  }
}

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
const VPD_BLOWER_IDLE_SPEED = 20;
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

// Blower-off → heater grace. After extraction stops, the lamp + canopy / pot
// mass naturally warm the room over a few minutes; don't fire the heater
// immediately and waste a cycle.
let lastExtractionStopTime = 0;
const POST_EXTRACTION_HEATER_GRACE_MS = 5 * 60 * 1000;
const HEATER_GRACE_MS = 2 * 60 * 1000;     // 2 min: after heater off, suppress cooling (hysteresis handles the rest)
const HUMIDIFIER_GRACE_MS = 4 * 60 * 1000; // 4 min: after humidifier off, suppress extraction — residual moisture needs time to settle
const DEHUM_ESCALATION_MS = 2 * 60 * 1000; // 2 min: dehumidifier must run this long before blower escalation

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
const TREND_BUFFER_SIZE = 10;
const tempTrendBuffer = []; // [{ t, temp, humi }]
function pushTrendSample(temp, humi) {
  const now = Date.now();
  tempTrendBuffer.push({ t: now, temp, humi });
  while (tempTrendBuffer.length > TREND_BUFFER_SIZE) tempTrendBuffer.shift();
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
    // If schedule changed, force period re-evaluation (blower curves depend on period)
    if (prev.dayStart !== dayNightSchedule.dayStart || prev.dayEnd !== dayNightSchedule.dayEnd) {
      console.log('[Supervisor] Day/Night schedule changed:', dayNightSchedule);
      lastBlowerSpeed = null; // Force blower re-evaluation with new period
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
    fs.writeFileSync(LIGHT_CYCLE_STORE, JSON.stringify(store, null, 2));
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
        publishLightCycleConfig(t, t.darkConfig, 'Dark period started (lights OFF)');
        t.status = 'dark';
        t.darkAppliedAt = now;
        t.lastDarkAssertAt = now;
        anyDark = true;
        changed = true;
      }
    } else if (t.status === 'dark') {
      if (now >= t.flowerStartAt) {
        publishLightCycleConfig(t, t.flowerConfig, `Flower 12/12 started (ON ${t.flowerOn}–${t.flowerOff})`);
        t.status = 'done';
        t.flowerAppliedAt = now;
        changed = true;
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
        anyDark = true;
        // Re-assert the OFF payload periodically so a device reboot or a missed message can't
        // accidentally let the lights come back on mid-transition.
        if (!t.lastDarkAssertAt || (now - t.lastDarkAssertAt) >= DARK_REASSERT_MS) {
          publishLightCycleConfig(t, t.darkConfig, 'Dark re-assert (lights OFF)');
          t.lastDarkAssertAt = now;
          changed = true;
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
function loadVpdFromFlow() {
  const prevConfig = vpdNodeConfig;
  vpdNodeConfig = null;
  for (const flow of flows) {
    for (const node of flow.flow.nodes) {
      if (node.type === 'vpd_control') {
        vpdNodeConfig = node.data.config;
        console.log('[Supervisor] VPD Control node found:', {
          mode: vpdNodeConfig.mode,
          roles: vpdNodeConfig.roles?.length || 0,
          timeout: vpdNodeConfig.escalationTimeoutSeconds
        });

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

    console.log('[Supervisor] AI modes:', socketAiModes);
  } catch (err) {
    console.error('[Supervisor] Failed to load AI modes:', err.message);
  }
}

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
        const logicInputs = connections
          .filter(c => c.target === node.id)
          .map(c => nodeResults.get(c.source))
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
        // We do NOT synthesise opposite actions from these flags — that's the user's job
        // via ELSE edges. Doing so caused constant OFF spam when AND gates were false.
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
        if (!anyInputTrue) break;

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
      // Auto: minimum speed — Blower Curve takes over within seconds
      moduleConfig.mLevel = socket === 'fan' ? 1 : 25;
    } else {
      // No mode (VPD/legacy): preserve last known speed
      moduleConfig.mLevel = cached.mLevel || cached.level || defaults.mLevel;
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
 * Execute actions with cooldown (supports multi-device)
 */
async function executeActions(actions) {
  const now = Date.now();

  for (const action of actions) {
    const { deviceMac, socket, action: targetAction, reason, moduleSpeedMode, moduleSpeed } = action;

    // Use device-specific key for cooldown tracking
    const actionKey = deviceMac ? `${deviceMac}:${socket}` : socket;
    const lastTime = lastActionTimes[actionKey] || 0;

    // SAFETY check: only execute if we're authorized to control this socket.
    //  - VPD / SAFETY / cycle-transition actions: always execute (validated upstream).
    //  - Climate modules (blower, fan, heater, humidifier, dehumidifier): always execute
    //    when the user explicitly targeted them in a trigger action. There's no user-set
    //    firmware mode to protect for modules — the user wouldn't have added them to a
    //    trigger unless they wanted the trigger to control them.
    //  - Outlets (O1-O10): require the socket to be in AI/trigger mode. Prevents a
    //    forgotten/old trigger from overriding an outlet the user put in Environment or
    //    TimeSlot mode manually.
    //  - mandatoryOff/mandatoryOn actions: always execute (explicit user intent).
    const isVpdOrSafety = reason && (reason.startsWith('VPD:') || reason.includes('SAFETY') || reason.includes('cycle transition'));
    const isModule = ['blower', 'fan', 'heater', 'humidifier', 'dehumidifier'].includes(socket);
    const aiModeKey = deviceMac ? `${deviceMac}:${socket}` : socket;
    const authorizedOutlet = socketAiModes[aiModeKey] || socketAiModes[socket];
    if (!isVpdOrSafety && !isModule && !action.mandatoryOff && !action.mandatoryOn && !authorizedOutlet) {
      continue; // Outlet not in AI mode — don't touch the user's manual config
    }

    // Get current state from device-specific storage or legacy
    const currentState = getSocketState(deviceMac, socket);
    const targetState = targetAction === 'on' ? 1 : 0;

    // Skip if already in desired state
    if (currentState === targetState) {
      // Log occasionally so we know triggers ARE evaluating even when state matches
      if (now % 60000 < 15000) { // Log once per minute
        console.log(`[Supervisor] ${socket} already ${targetAction} (state=${currentState}), skipping | ${reason || ''}`);
      }
      continue;
    }
    console.log(`[Supervisor] Executing: ${socket} → ${targetAction} (was ${currentState}) | ${reason || 'no reason'}`);

    // Check cooldown
    if (now - lastTime < HYSTERESIS_COOLDOWN_MS) {
      console.log(`[Supervisor] Cooldown active for ${actionKey}, skipping`);
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
  if (!vpdNodeConfig || !vpdNodeConfig.roles || vpdNodeConfig.roles.length === 0) return [];

  const sensorValues = getSensorValues(vpdNodeConfig.sensorDeviceMac);
  const temp = sensorValues.temp;
  const humi = sensorValues.humi;
  if (temp == null || humi == null) return [];

  // Feed the trend buffer so anticipatory logic below has recent history.
  pushTrendSample(temp, humi);

  const currentVpd = calculateLeafVpd(temp, humi);
  if (currentVpd == null || currentVpd <= 0) return [];

  const target = getVpdTargetRange();
  if (!target) return [];

  const { min: targetMin, max: targetMax } = target;
  const actions = [];
  const now = Date.now();
  // Ideal temperature range (day/night)
  const isDaytime = getCurrentPeriod() === 'day';
  const currentPeriod = isDaytime ? 'day' : 'night';
  const idealTemp = isDaytime
    ? (vpdNodeConfig.idealDayTemp || { min: 24, max: 25 })
    : (vpdNodeConfig.idealNightTemp || { min: 20, max: 22 });

  // ── Cycle Transition Grace Period ──
  // When day↔night changes, STOP ALL active devices and let the environment adjust naturally.
  // Lights off → temp drops on its own. Lights on → temp rises on its own.
  // The old code only suppressed NEW actions but didn't stop RUNNING devices.
  // Now: on transition, we actively turn OFF everything, reset blower, and wait.
  if (lastKnownPeriod !== null && lastKnownPeriod !== currentPeriod) {
    // Transition just detected — STOP ALL devices immediately
    cycleTransitionTime = now;
    cycleTransitionTempAtStart = temp;
    cycleTransitionHumiAtStart = humi;
    cycleTransitionLastCheck = now;
    cycleTransitionLastTemp = temp;
    cycleTransitionLastHumi = humi;
    cycleTransitionGraceActive = true;
    cycleTransitionDirection = (currentPeriod === 'night') ? 'cooling' : 'warming';
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
    return transitionOffActions; // Send OFF commands, then suppress until grace ends
  }
  lastKnownPeriod = currentPeriod;

  // Evaluate grace period if active
  if (cycleTransitionGraceActive) {
    // Keep blower OFF during grace
    vpdBlowerMinSpeed = 0;
    vpdBlowerMaxSpeed = 0;

    const elapsed = now - cycleTransitionTime;
    const sinceLastCheck = now - cycleTransitionLastCheck;

    // ── Emergency override: if temp or humi drift into danger during grace,
    // bail out of grace immediately and resume normal control. Grace is a
    // convenience for smooth transitions, not a safety lock.
    const earlyTempEmerg = temp > (vpdNodeConfig.idealDayTemp?.max || 26) + 1.5
      || temp > (vpdNodeConfig.idealNightTemp?.max || 23) + 1.5;
    const earlyHumiEmerg = humi > 85;
    if (earlyTempEmerg || earlyHumiEmerg) {
      cycleTransitionGraceActive = false;
      console.log(`[VPD] Cycle transition: EMERGENCY override (temp=${temp.toFixed(1)}°C, humi=${humi.toFixed(0)}%) — grace aborted, resuming control`);
      vpdBlowerMaxSpeed = 100;
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
  const idealHumiMax = Math.min(90, (svpLeaf - targetMin) / svpAir * 100); // low VPD → high humi limit
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

  // Humidity thresholds
  const humiLowThreshold = humidifierRecentlyOff
    ? idealHumiTarget - 3  // After humidifier off: wider tolerance, moisture still settling
    : idealHumiTarget - 1; // Normal: 1% below target
  const humiHighThreshold = idealHumiMax + 4; // 4% above ideal max (absorbs post-humidifier overshoot)

  // Emergency humidity flag — critically above max, overrides safety margins
  // In emergencies: skip humidifier grace period, skip tempSafeForBlower, skip dehumidifier wait
  const humiEmergency = humi > idealHumiMax + 15 || humi > 85;

  // Emergency temperature flag — temp dangerously above max, overrides heater grace
  // Without this, heater thermal inertia could push temp 2-3°C above max with no cooling response
  const tempEmergency = temp > idealTemp.max + 1.5;

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
  const humiOk = humi >= idealHumiTarget && humi <= idealHumiMax;

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

  const humiExcess = Math.max(0, humi - idealHumiMax);
  const tempDeficit = Math.max(0, idealTemp.min - temp);
  const needsExtraction = humiExcess > 2 || leafVpdBelowTarget;
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
    console.log(`[VPD] ${currentVpd.toFixed(2)} kPa (${targetMin.toFixed(2)}-${targetMax.toFixed(2)}, target ${vpdTarget.toFixed(2)}) | T:${temp.toFixed(1)}°C (${idealTemp.min}-${idealTemp.max}, cool@${tempHighThreshold}, heat@${tempLowThreshold.toFixed(1)}) H:${humi.toFixed(0)}% (${idealHumiMin.toFixed(0)}-[${idealHumiTarget.toFixed(0)}]-${idealHumiMax.toFixed(0)}%) | ${curState}${graceFlags ? ' ' + graceFlags : ''}${tempEmergency ? ' TEMP_EMERG' : ''}${humiEmergency ? ' HUMI_EMERG' : ''}${coolingActive ? ' COOLING' : ''}${humiExtractionActive ? ' HEXT' : ''}${anticFlag}`);
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

    const STEP = ESCALATION_STEP;
    const ema = state.metricEma;
    // over > 0 ⇒ metric is on the WRONG side of the target (above the ceiling for
    // wantLower). This is an ABSOLUTE distance, so slow drift is always caught.
    const over = wantLower ? (ema - target) : (target - ema);
    const DEAD = 1.0;   // tolerated overshoot above target before adding power
    const EASE = 2.0;   // how far below target before easing power off to save energy

    // Periodic capacity re-test — the grow's moisture/heat load changes through the day
    // (sun/cloud/rain, watering, transpiration), so a speed that "gave nothing" before may
    // help now. Forget the cap so the logic below re-probes upward while still over target.
    if (state.capacityClearedAt === undefined) state.capacityClearedAt = now;
    if (now - state.capacityClearedAt >= EXPLORE_UP_INTERVAL_MS) {
      state.capacitySpeed = undefined;
      state.capacityClearedAt = now;
    }

    // Judge the previous upward step: did the extra power actually move the metric?
    if (state.lastAction === 'up') {
      const moved = wantLower ? (state.emaBeforeUp - ema) : (ema - state.emaBeforeUp);
      if (moved >= improveThreshold) {
        state.capacitySpeed = undefined; // it responds → allow climbing further if still over
        state.lastAction = 'hold'; state.holdCycles = 1;
        console.log(`[VPD] ${roleName}: +power effective (${moved.toFixed(2)} better, ema ${ema.toFixed(1)}/target ${target.toFixed(1)}) → keep boost ${state.speedBoost}%`);
      } else {
        state.capacitySpeed = state.speedBoost; // beyond this, more power does nothing
        state.speedBoost -= STEP;
        state.lastAction = 'hold'; state.holdCycles = 2;
        console.log(`[VPD] ${roleName}: +power gave nothing (Δ${moved.toFixed(2)}) → CAPACITY (ema ${ema.toFixed(1)}/target ${target.toFixed(1)}) — back to boost ${state.speedBoost}%, best achievable`);
      }
      return { boost: state.speedBoost };
    }

    if (over > DEAD) {
      // Above the target ceiling → must reduce the metric.
      const atCapacity = state.capacitySpeed !== undefined && state.speedBoost >= state.capacitySpeed;
      if (atCapacity) {
        state.lastAction = 'hold';
        console.log(`[VPD] ${roleName}: ${over.toFixed(1)} over target but at capacity (boost ${state.speedBoost}%, ema ${ema.toFixed(1)}) — holding best achievable`);
      } else {
        state.emaBeforeUp = ema;
        state.speedBoost += STEP;
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
    const deviceIsOff = deviceState === 0;
    // Trigger a push when the role is newly active OR when device is actually off.
    // The second case catches safety-timeout-induced desync.
    if (!roleWasActive || deviceIsOff) {
      if (!roleWasActive) {
        vpdEscalationState.roles[roleName] = { activatedAt: now, metricAtActivation: 0 };
        console.log(`[VPD] → ${roleName} ON (${socket}): ${reason}`);
      } else if (deviceIsOff) {
        console.log(`[VPD] ↺ ${roleName} ON (${socket}) re-issue — device shows OFF: ${reason}`);
      }
      actions.push({ deviceMac, socket, action: 'on', reason: `VPD: ${reason}` });
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
    if (roleWasActive || deviceIsOn) {
      if (roleWasActive) {
        console.log(`[VPD] → ${roleName} OFF (${socket}): ${reason}`);
        delete vpdEscalationState.roles[roleName];
        if (roleName === 'heater') lastHeaterOffTime = now;
        if (roleName === 'humidifier') lastHumidifierOffTime = now;
      } else if (deviceIsOn) {
        console.log(`[VPD] ↺ ${roleName} OFF (${socket}) re-issue — device shows ON: ${reason}`);
      }
      actions.push({ deviceMac, socket, action: 'off', reason: `VPD: ${reason}` });
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


  // Cool only to just INSIDE the range (idealMax − 0.5), not all the way down to idealMin.
  // Driving temp to the bottom of the range over-cools, fights an often-unreachable target,
  // and oscillated the blower 85↔0 % every few minutes (incident 2026-05-20). Stopping just
  // inside range keeps temp stable near the top of the band (which also keeps VPD higher).
  // Cooling is now CONTINUOUS + PROPORTIONAL: it engages whenever temp is above the stop
  // target and the speed (computed below) tapers to the baseline exactly at the target, so
  // there is no on/off bang-bang and no need for the tempHigh trigger or the saturation
  // timeout (both caused cycling). The only suppressor is the heater grace / emergency.
  const coolingStopTarget = idealTemp.max - 0.5;
  const needsCooling = temp > coolingStopTarget
    && (!heaterRecentlyOff || tempEmergency);

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
      // Blower extractor: PROPORTIONAL cooling. Speed rises smoothly with how far temp
      // exceeds the cooling stop target — gentle near the target (no 100 % slam to shave
      // 0.1 °C), strong when genuinely hot. Recomputed each cycle, so it tracks the load
      // continuously instead of bang-banging 100↔0/20 % (incident 2026-05-20). It blends
      // seamlessly into the baseline at the stop target (need 0 → baseline speed).
      const coolingNeed = Math.max(0, temp - coolingStopTarget);
      const COOLING_GAIN = 40; // % blower per °C above the stop target
      const coolingSpeed = Math.min(100, VPD_BLOWER_IDLE_SPEED + Math.round(coolingNeed * COOLING_GAIN));
      if (!vpdEscalationState.roles['extractor_temp']) {
        vpdEscalationState.roles['extractor_temp'] = { activatedAt: now, metricAtActivation: temp };
        console.log(`[VPD] Cooling engaged — temp ${temp.toFixed(1)}°C > ${tempHighThreshold.toFixed(1)}°C, proportional speed ${coolingSpeed}% (toward ≤ ${coolingStopTarget.toFixed(1)}°C)`);
      }
      newBlowerFloor = Math.max(newBlowerFloor, coolingSpeed);
    }

    // Temp too high → no heater needed
    deactivateSocketRole('heater', 'Temp too high');

  } else if (temp <= coolingStopTarget) {
    // Cooled back into range (≤ idealMax − 0.5) — release cooling; baseline keeps air moving.
    if (coolingActive) {
      const reason = `back in range at ${temp.toFixed(1)}°C (≤ ${coolingStopTarget.toFixed(1)}°C)`;
      console.log(`[VPD] Cooling done: ${reason} — starting post-cooling grace`);
      lastCoolingStopTime = now;
      coolingGraceLastTemp = temp;
      coolingGraceLastCheck = now;
      coolingGraceStableStart = 0;
    }
    coolingBelowMaxSince = 0;
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

  // Activate humidifier when humidity is low
  if (humiLow) {
    activateSocketRole('humidifier', `Humi ${humi.toFixed(0)}% < ${humiLowThreshold.toFixed(0)}% (target ${idealHumiTarget.toFixed(0)}%)`);
    if (!vpdEscalationState.roles['humidifier']) {
      vpdEscalationState.roles['humidifier'] = { activatedAt: now, metricAtActivation: humi };
    }
    deactivateSocketRole('dehumidifier', 'Humi too low');
  } else if (humi < idealHumiMin) {
    // Humidity below ideal minimum — activate humidifier regardless of cooling state
    activateSocketRole('humidifier', `Humi ${humi.toFixed(0)}% < ${idealHumiMin.toFixed(0)}%`);
    if (!vpdEscalationState.roles['humidifier']) {
      vpdEscalationState.roles['humidifier'] = { activatedAt: now, metricAtActivation: humi };
    }
  } else if (humi >= idealHumiTarget) {
    // Humidity reached TARGET (VPD midpoint) — turn off humidifier
    deactivateSocketRole('humidifier', `Humi ${humi.toFixed(0)}% reached target ${idealHumiTarget.toFixed(0)}%`);
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
  const needsHumiAction = (phaseExtracting || humiEmergency)
    && humi > idealHumiMax
    && (humiHigh || humiExtractionActive || isRoleActive('dehumidifier') || (heaterIneffective && leafVpdBelowTarget))
    && !isRoleActive('humidifier')
    && (!humidifierRecentlyOff || humiEmergency);

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

    if (!crashCooldownActive && dehumExhausted && !blowerCrashingTemp && (humiHigh || humiExtractionActive) && tempSafeForBlower) {
      if (extIsBlower) {
        newBlowerCeiling = 100;

        if (!humiExtractionActive) {
          // Compute the starting speed from calibration ONCE, at activation, and
          // freeze it as baseSpeed. We deliberately do NOT recompute it from the
          // instantaneous humi each cycle — that made the floor wobble 40↔50 % as
          // the sensor jittered ±1 % (incident 2026-05-20). From here the optimizer
          // owns the speed via ±10 % steps every 5 min.
          // Start from a MODERATE speed, never a jump to 100 %. The calibration estimate
          // is only a hint and clamped to 60 % on activation; the capacity-aware optimizer
          // then climbs only as far as actually helps. The sole exception is a genuine
          // flood (humi > 85 %) where we start at full power immediately.
          // (Previously a huge humiExcess against an unreachable day target made the
          // calibration return 100 %, so every (re)activation slammed the blower to
          // 100 % out of nowhere — incident 2026-05-20.)
          const humiExcess = humi - idealHumiMax;
          const period = isDaytime ? 'day' : 'night';
          const calSpeed = calcSpeedFromCalibration(0, humiExcess, period);
          const baseSpeed = humi > 85 ? 100 : Math.min(calSpeed > 0 ? calSpeed : 40, 60);
          vpdEscalationState.roles['extractor_humi'] = {
            activatedAt: now, metricAtActivation: humi,
            baseSpeed, speedBoost: 0, lastCheckTime: now,
            metricEma: humi, lastAction: 'init', capacityClearedAt: now
          };
          newBlowerFloor = Math.max(newBlowerFloor, baseSpeed);
          console.log(`[VPD] Blower floor ${newBlowerFloor}% — humidity extraction (${humi.toFixed(0)}% > ${humiHighThreshold.toFixed(0)}%, ${hasDehumRole ? 'dehumidifier exhausted' : 'no dehumidifier'})`);
        } else {
          // Target-anchored optimizer: drive humidity down toward idealHumiMax (the band
          // ceiling). Absolute anchoring means a slow daytime creep is always caught; the
          // capacity logic prevents flooring the blower against an unreachable target.
          evaluateEscalation('extractor_humi', humi, idealHumiMax, true, ESCALATION_IMPROVE_HUMI);
        }
        const role = vpdEscalationState.roles['extractor_humi'];
        const baseSpeed = role?.baseSpeed ?? 40;
        let boost = role?.speedBoost || 0;
        // Effective extraction speed clamped to [20, 100] while the role is active.
        // Anti-windup: pin the stored boost back to whatever the clamp allows so it
        // can't drift to a huge negative number that would take many cycles to climb
        // back from when humidity finally rises.
        let effFloor = baseSpeed + boost;
        if (effFloor < 20) { effFloor = 20; boost = 20 - baseSpeed; }
        if (effFloor > 100) { effFloor = 100; boost = 100 - baseSpeed; }
        if (role) role.speedBoost = boost;
        newBlowerFloor = Math.max(newBlowerFloor, effFloor);
        // Commit the chosen speed onto the role so cycles that don't re-traverse
        // this exact block (cooldown windows, momentary temp dips) keep driving the
        // blower instead of letting newBlowerCeiling reset to 0 → spurious 0 % blips.
        if (vpdEscalationState.roles['extractor_humi']) {
          vpdEscalationState.roles['extractor_humi'].committedFloor = newBlowerFloor;
        }
      } else {
        activateSocketRole('extractor', `Humi ${humi.toFixed(0)}% > ${humiHighThreshold.toFixed(0)}% (${hasDehumRole ? 'dehumidifier exhausted' : 'no dehumidifier'})`);
      }
    }

  } else if (humi <= idealHumiMax) {
    // Humidity reached target — stop ALL humidity extraction
    if (humiExtractionActive) {
      console.log(`[VPD] Humidity extraction done: ${humi.toFixed(0)}% reached target ${idealHumiMax.toFixed(0)}%`);
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

  // When the phase is NOT 'extracting', make sure humidity-extraction blower state is
  // cleared so Rule 1 (cooling) controls the blower cleanly. This also prevents the
  // blower from staying at the humi-extraction floor after phase switches to 'heating'.
  if (!phaseExtracting && humiExtractionActive) {
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
    // Clean escalation state
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
  const heatingNow = tempLow || isRoleActive('heater') || temp < idealTemp.min;
  if (extIsBlower && !cycleTransitionGraceActive && !heatingNow) {
    if (newBlowerCeiling < VPD_BLOWER_IDLE_SPEED) newBlowerCeiling = VPD_BLOWER_IDLE_SPEED;
    if (newBlowerFloor < VPD_BLOWER_IDLE_SPEED) newBlowerFloor = VPD_BLOWER_IDLE_SPEED;
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
    const key = action.deviceMac ? `${action.deviceMac}:${action.socket}` : action.socket;
    const existing = actionMap.get(key);
    if (!existing) { actionMap.set(key, action); continue; }
    if (existing.action === action.action) { continue; /* duplicate, keep first */ }
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
  const tempNow = lastSensorValues.temp;
  const humiNow = lastSensorValues.humi;
  const idealT = vpdNodeConfig && (getCurrentPeriod() === 'day'
    ? (vpdNodeConfig.idealDayTemp || { max: 26 })
    : (vpdNodeConfig.idealNightTemp || { max: 23 }));
  const emergTempHigh = tempNow != null && idealT && tempNow > idealT.max + 1.5;
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
  const curveSpeed = evaluateBlowerCurve();

  if (!blowerControlledByUserTrigger && (curveSpeed !== null || vpdBlowerMinSpeed > 0 || vpdBlowerMaxSpeed < 100)) {
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
    // In emergency, force the blower ON at 100% even if curve/floor say otherwise
    if (emergTempHigh || emergHumiHigh) {
      effectiveSpeed = 100;
    }
    // Debounce: only re-issue a command when the speed actually changes by a
    // meaningful step (≥ 5 %), or when crossing the on/off boundary. The base
    // floor wobbles ±5 % cycle-to-cycle as humi micro-fluctuates ±1 %; without
    // this guard the device was spammed with a new command every 2 s.
    const lastSpeed = lastBlowerSpeed ?? -1;
    const crossedOnOff = (effectiveSpeed > 0) !== (lastSpeed > 0);
    const changedEnough = Math.abs(effectiveSpeed - lastSpeed) >= 5;
    if (crossedOnOff || changedEnough) {
      console.log(`[BlowerCurve] Speed: ${effectiveSpeed}% (curve=${curveSpeed ?? 'n/a'}, floor=${vpdBlowerMinSpeed}%, ceil=${vpdBlowerMaxSpeed}%)${(emergTempHigh || emergHumiHigh) ? ' EMERGENCY' : ''}`);
      lastBlowerSpeed = effectiveSpeed;
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
    const deviceMac = parts[2];   // MAC address
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
          lastSocketStates[mk] = isOn;
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
        const mac = row.mac;

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

    console.log(`[Supervisor] Loaded ${deviceRegistry.size} devices, primary: ${defaultPrimaryType}/${defaultPrimaryMac || 'none'}`);
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
  if (deviceMac && sensorValuesByDevice.has(deviceMac)) {
    return sensorValuesByDevice.get(deviceMac);
  }
  // Fallback to legacy merged values
  return lastSensorValues;
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

  // Load device MACs from database
  await loadDeviceInfo();

  // Initial data load
  await refreshData();

  // Connect to MQTT
  connectMqtt();

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

  // Drive flip-to-flower transitions (dark → 12/12). Runs every 30 s — plenty for multi-hour
  // schedules, and the dark/flower instants are stored as absolute times so a tick boundary
  // only adds at most 30 s of slack.
  setInterval(() => {
    processLightCycleTransitions().catch(err => {
      console.error('[LightCycle] tick error:', err.message);
    });
  }, 30000);

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
  // WATCHDOG: Self-monitoring — if no sensor data is processed
  // for 5 minutes, the supervisor is effectively dead (hung MQTT,
  // frozen event loop, etc.). Force-exit so PM2 restarts us.
  // ═══════════════════════════════════════════════════════
  let lastSensorProcessedTime = Date.now();

  // Patch processSensorData to track liveness
  const _originalProcessSensorData = processSensorData;
  processSensorData = async function (...args) {
    lastSensorProcessedTime = Date.now();
    return _originalProcessSensorData.apply(this, args);
  };

  const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes without sensor data = dead
  setInterval(() => {
    const silenceMs = Date.now() - lastSensorProcessedTime;
    if (silenceMs > WATCHDOG_TIMEOUT_MS) {
      console.error(`[Supervisor] WATCHDOG: No sensor data processed in ${Math.round(silenceMs / 1000)}s — forcing restart`);
      process.exit(1); // PM2 will restart us
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
        lastSensorAge: Math.round((Date.now() - lastSensorProcessedTime) / 1000),
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
