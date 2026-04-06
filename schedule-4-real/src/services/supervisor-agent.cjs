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
const HYSTERESIS_COOLDOWN_MS = 5000; // Minimum 5 seconds between state changes
const LEAF_TEMP_OFFSET = 2.8; // Leaf temp ~2.8°C below air temp (LED high power, DimLux standard)

// Activation hysteresis — dead band to prevent oscillation
// Devices activate when EXCEEDING target + hysteresis, deactivate at target (no hysteresis)
const TEMP_HIGH_HYSTERESIS = 0.5; // °C above idealTemp.max before cooling activates (blower ON at max+0.5)
const TEMP_LOW_HYSTERESIS = 0.5;  // °C below idealTemp.min before heating activates (heater ON at min-0.5)

// Smart blower speed optimizer — 3-phase state machine:
//   ESCALATING:    speed going up, looking for effective speed
//   DEESCALATING:  speed going down, finding minimum effective speed
//   HOLDING:       maintaining optimal speed, monitoring for changes
const ESCALATION_CHECK_MS = 2 * 60 * 1000;   // Evaluate every 2 min
const ESCALATION_STEP = 5;                     // ±5% per adjustment step
const ESCALATION_IMPROVE_TEMP = 0.2;           // °C drop needed to count as "improving"
const ESCALATION_IMPROVE_HUMI = 0.5;           // % drop needed to count as "improving"
const ESCALATION_WORSEN_TEMP = 0.5;            // °C rise = "worsening" (speed too low)
const ESCALATION_WORSEN_HUMI = 1.0;            // % rise = "worsening" (wider: sensor noise ±0.5%)
const COOLING_BELOW_MAX_TIMEOUT_MS = 5 * 60 * 1000; // 5 min below idealTemp.max → stop (best effort reached)
/** Saturation vapor pressure (Tetens formula) */
function svp(t) { return 0.6108 * Math.exp((17.27 * t) / (t + 237.3)); }

// Per-device state tracking for multi-device support
const sensorValuesByDevice = new Map();  // mac -> { temp, humi, vpd, co2, ... }
const socketStatesByDevice = new Map();  // mac -> { O1: 0|1, O2: 0|1, ... }
let dayNightSchedule = { dayStart: '06:00', dayEnd: '00:00' };
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
let lastBlowerSpeed = null; // Last commanded speed to avoid redundant commands

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
      console.log(`[Supervisor] Global automation loaded: ${flows[0].flow.nodes.length} nodes`);
    } else {
      flows = [];
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

  if (currentValue === undefined || currentValue === null) {
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
 * Evaluate a logic gate node (AND/OR)
 */
function evaluateLogicGate(config, inputResults) {
  const { operator } = config;

  if (!inputResults || inputResults.length === 0) return false;

  if (operator === 'and') {
    return inputResults.every(r => r === true);
  } else if (operator === 'or') {
    return inputResults.some(r => r === true);
  }

  return false;
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
  const mandatoryConditions = new Map(); // socket -> [condition results]

  // BFS evaluation
  const queue = [...entryNodes];
  const visited = new Set();

  while (queue.length > 0) {
    const node = queue.shift();
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    let result = false;

    switch (node.type) {
      case 'condition':
        const wasActive = nodeResults.get(`${node.id}:active`) || false;
        result = evaluateCondition(node.data.config, wasActive);
        nodeResults.set(`${node.id}:active`, result); // Track for next evaluation

        // Track mandatory status
        if (node.data.config.mandatory) {
          // Find connected action nodes
          const connected = adjacencyList.get(node.id) || [];
          for (const targetId of connected) {
            const targetNode = nodes.find(n => n.id === targetId);
            if (targetNode?.type === 'action') {
              const socket = targetNode.data.config.socket;
              if (!mandatoryConditions.has(socket)) {
                mandatoryConditions.set(socket, []);
              }
              mandatoryConditions.get(socket).push(result);
            }
          }
        }
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
        // Check if any incoming connection has true result
        const incomingConnections = connections.filter(c => c.target === node.id);
        const anyInputTrue = incomingConnections.some(c => nodeResults.get(c.source) === true);

        if (anyInputTrue) {
          const { deviceMac: actionDeviceMac, socket, action, moduleSpeedMode, moduleSpeed } = node.data.config;

          // Use device-specific AI mode key or legacy socket key
          const aiModeKey = actionDeviceMac ? `${actionDeviceMac}:${socket}` : socket;

          // Check if socket is in AI mode (fallback to legacy key for backward compat)
          if (!socketAiModes[aiModeKey] && !socketAiModes[socket]) {
            console.log(`[Supervisor] Socket ${aiModeKey} not in AI mode, skipping`);
            break;
          }

          // Check mandatory conditions (keyed by device:socket for multi-device)
          const mandatoryKey = actionDeviceMac ? `${actionDeviceMac}:${socket}` : socket;
          const mandatories = mandatoryConditions.get(mandatoryKey) || mandatoryConditions.get(socket);
          if (mandatories && mandatories.length > 0) {
            const allMandatoriesMet = mandatories.every(m => m === true);
            if (!allMandatoriesMet) {
              console.log(`[Supervisor] Mandatory conditions not met for ${mandatoryKey}, forcing OFF`);
              actions.push({ deviceMac: actionDeviceMac, socket, action: 'off', reason: 'Mandatory condition not met' });
              break;
            }
          }

          // Build reason from connected conditions
          const reasons = [];
          for (const conn of incomingConnections) {
            const sourceNode = nodes.find(n => n.id === conn.source);
            if (sourceNode?.type === 'condition') {
              const cfg = sourceNode.data.config;
              // Use device-specific sensor values if condition has deviceMac
              const sensorVals = getSensorValues(cfg.deviceMac);
              const val = sensorVals[cfg.sensor];
              reasons.push(`${cfg.sensor} ${cfg.operator} ${cfg.value} (actual: ${val})`);
            }
          }

          actions.push({ deviceMac: actionDeviceMac, socket, action, moduleSpeedMode, moduleSpeed, reason: reasons.join(', ') || 'Condition met' });
        }
        break;
    }

    nodeResults.set(node.id, result);

    // Add connected nodes to queue
    const connected = adjacencyList.get(node.id) || [];
    for (const targetId of connected) {
      const targetNode = nodes.find(n => n.id === targetId);
      if (targetNode) {
        queue.push(targetNode);
      }
    }
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

    // Get current state from device-specific storage or legacy
    const currentState = getSocketState(deviceMac, socket);
    const targetState = targetAction === 'on' ? 1 : 0;

    // Skip if already in desired state
    if (currentState === targetState) {
      continue;
    }
    console.log(`[Supervisor] Executing: ${socket} → ${targetAction} (was ${currentState}) | ${reason || 'no reason'}`);

    // Check cooldown
    if (now - lastTime < HYSTERESIS_COOLDOWN_MS) {
      console.log(`[Supervisor] Cooldown active for ${actionKey}, skipping`);
      continue;
    }

    // Execute command (deviceMac can be null for backward compatibility)
    const success = await sendSocketCommand(deviceMac, socket, targetAction, { moduleSpeedMode, moduleSpeed });

    if (success) {
      lastActionTimes[actionKey] = now;

      // Update both per-device and legacy state
      if (deviceMac) {
        if (!socketStatesByDevice.has(deviceMac)) {
          socketStatesByDevice.set(deviceMac, {});
        }
        socketStatesByDevice.get(deviceMac)[socket] = targetState;
      }
      // Also update legacy if this is the default PS5 (or no device specified)
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
  const leafTemp = temp - LEAF_TEMP_OFFSET;
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

  // Activation conditions (first trigger — require exceeding hysteresis threshold)
  // tempEmergency bypasses heater grace — safety takes priority over preventing oscillation
  const tempHigh = temp > tempHighThreshold && (!heaterRecentlyOff || tempEmergency); // Suppress cooling during heater grace (unless emergency)
  const tempLow = temp < tempLowThreshold;
  const humiLow = humi < humiLowThreshold;
  const humiHigh = humi > humiHighThreshold;

  // Continuation flags — already-active devices keep running until reaching target (no hysteresis on deactivation)
  const coolingActive = !!vpdEscalationState.roles['extractor_temp'];
  const humiExtractionActive = !!vpdEscalationState.roles['extractor_humi'];

  // ── DEACTIVATION thresholds (at target, instant, no hysteresis) ──
  const tempInRange = temp >= idealTemp.min && temp <= idealTemp.max;
  const humiOk = humi >= idealHumiTarget && humi <= idealHumiMax;

  // Throttled log — only print when conditions change
  const graceFlags = `${heaterRecentlyOff ? 'Hgrace' : ''}${humidifierRecentlyOff ? 'Ugrace' : ''}`;
  const curState = `${tempHigh ? 'TH' : tempLow ? 'TL' : (coolingActive && temp > idealTemp.max) ? 'Tc' : 'T_'}|${humiLow ? 'HL' : humiHigh ? 'HH' : (humiExtractionActive && humi > idealHumiMax) ? 'Hc' : 'H_'}`;
  const logKey = `${curState}|${graceFlags}|${humiEmergency ? 'hE' : ''}${tempEmergency ? 'tE' : ''}|${currentVpd.toFixed(1)}|${temp.toFixed(0)}|${Math.round(humi/2)}`;
  if (logKey !== lastVpdLogKey) {
    lastVpdLogKey = logKey;
    console.log(`[VPD] ${currentVpd.toFixed(2)} kPa (${targetMin.toFixed(2)}-${targetMax.toFixed(2)}, target ${vpdTarget.toFixed(2)}) | T:${temp.toFixed(1)}°C (${idealTemp.min}-${idealTemp.max}, cool@${tempHighThreshold}, heat@${tempLowThreshold.toFixed(1)}) H:${humi.toFixed(0)}% (${idealHumiMin.toFixed(0)}-[${idealHumiTarget.toFixed(0)}]-${idealHumiMax.toFixed(0)}%) | ${curState}${graceFlags ? ' ' + graceFlags : ''}${tempEmergency ? ' TEMP_EMERG' : ''}${humiEmergency ? ' HUMI_EMERG' : ''}${coolingActive ? ' COOLING' : ''}${humiExtractionActive ? ' HEXT' : ''}`);
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

  // ── 3-Phase Blower Speed Optimizer ──
  // ESCALATING:    trying higher speed. If 2 consecutive steps don't help → revert, DEESCALATE.
  // DEESCALATING:  lowering speed. If metric worsens → bump up one step, HOLD.
  // HOLDING:       optimal speed found. If metric worsens → ESCALATE. If improves → DEESCALATE.
  //
  // This finds the MINIMUM effective speed: escalate to find a speed that works,
  // then de-escalate to find the lowest speed that still holds the metric.
  // @param {number} improveThreshold - metric must drop by this to count as "improving"
  // @param {number} worsenThreshold  - metric must rise by this to count as "worsening" (0.5°C / 1.0%)
  // Returns { boost: number, phase: string }
  function evaluateEscalation(roleName, metricNow, wantLower, improveThreshold, worsenThreshold) {
    const state = vpdEscalationState.roles[roleName];
    if (!state) return { boost: 0, phase: 'none' };

    // Initialize optimizer state if missing
    if (!state.phase) state.phase = 'escalating';
    if (state.speedBoost === undefined) state.speedBoost = 0;
    if (state.noImproveCount === undefined) state.noImproveCount = 0;

    const lastCheck = state.lastCheckTime || state.activatedAt;
    if (now - lastCheck < ESCALATION_CHECK_MS) {
      return { boost: state.speedBoost, phase: state.phase };
    }

    // Compare metric against last check
    const baseline = state.lastMetric ?? state.metricAtActivation;
    const delta = wantLower ? (metricNow - baseline) : (baseline - metricNow);
    // delta > 0 means WORSE (metric rose when we want it lower, or dropped when we want it higher)
    // delta < 0 means BETTER
    const improved = delta < -improveThreshold;
    const worsened = delta > worsenThreshold;

    state.lastCheckTime = now;
    state.lastMetric = metricNow;

    switch (state.phase) {
      case 'escalating':
        if (improved) {
          // This speed works → hold here, try de-escalating later
          state.phase = 'holding';
          state.noImproveCount = 0;
          console.log(`[VPD] ${roleName}: speed effective at boost ${state.speedBoost}% — HOLDING (metric ${metricNow.toFixed(1)})`);
        } else {
          state.noImproveCount++;
          if (state.noImproveCount >= 2) {
            // 2 consecutive no-improve → higher speed is useless
            // Revert last step and start de-escalating to find minimum
            state.speedBoost -= ESCALATION_STEP;
            state.phase = 'deescalating';
            state.noImproveCount = 0;
            console.log(`[VPD] ${roleName}: escalation ineffective — reverting to boost ${state.speedBoost}%, DEESCALATING`);
          } else {
            // First no-improve: try one more step up
            state.speedBoost += ESCALATION_STEP;
            console.log(`[VPD] ${roleName}: ESCALATING to boost ${state.speedBoost}% (metric ${metricNow.toFixed(1)}, attempt ${state.noImproveCount}/2)`);
          }
        }
        break;

      case 'deescalating':
        if (worsened) {
          // Speed too low → bump back up and hold
          state.speedBoost += ESCALATION_STEP;
          state.phase = 'holding';
          console.log(`[VPD] ${roleName}: too low at boost ${state.speedBoost - ESCALATION_STEP}% (metric worsened) — back to ${state.speedBoost}%, HOLDING`);
        } else {
          // Not worse → keep reducing to find minimum (clamp at -100)
          state.speedBoost = Math.max(-100, state.speedBoost - ESCALATION_STEP);
          console.log(`[VPD] ${roleName}: DEESCALATING to boost ${state.speedBoost}% (metric ${metricNow.toFixed(1)}, stable)`);
        }
        break;

      case 'holding':
        if (worsened) {
          // Conditions changed, need more power
          state.phase = 'escalating';
          state.noImproveCount = 0;
          console.log(`[VPD] ${roleName}: metric worsening at boost ${state.speedBoost}% — ESCALATING (metric ${metricNow.toFixed(1)})`);
        } else if (improved) {
          // Maybe can reduce further
          state.phase = 'deescalating';
          console.log(`[VPD] ${roleName}: metric still improving at boost ${state.speedBoost}% — DEESCALATING (metric ${metricNow.toFixed(1)})`);
        }
        // Stable → stay at current speed
        break;
    }

    return { boost: state.speedBoost, phase: state.phase };
  }

  // Activate a socket-based role (ON)
  function activateSocketRole(roleName, reason) {
    const assignment = getRoleAssignment(roleName);
    if (!assignment || !assignment.socket || assignment.socket === 'blower') return;
    const { socket, deviceMac } = assignment;
    const aiModeKey = deviceMac ? `${deviceMac}:${socket}` : socket;
    if (!socketAiModes[aiModeKey] && !socketAiModes[socket]) {
      if (curState !== prevState) console.log(`[VPD] ${roleName} (${socket}) NOT in AI mode, skip`);
      return;
    }
    if (!vpdEscalationState.roles[roleName]) {
      vpdEscalationState.roles[roleName] = { activatedAt: now, metricAtActivation: 0 };
      console.log(`[VPD] → ${roleName} ON (${socket}): ${reason}`);
    }
    actions.push({ deviceMac, socket, action: 'on', reason: `VPD: ${reason}` });
  }

  // Deactivate a socket-based role (OFF)
  function deactivateSocketRole(roleName, reason) {
    const assignment = getRoleAssignment(roleName);
    if (!assignment || !assignment.socket || assignment.socket === 'blower') return;
    const { socket, deviceMac } = assignment;
    const aiModeKey = deviceMac ? `${deviceMac}:${socket}` : socket;
    if (!socketAiModes[aiModeKey] && !socketAiModes[socket]) return;
    if (vpdEscalationState.roles[roleName]) {
      console.log(`[VPD] → ${roleName} OFF (${socket}): ${reason}`);
      delete vpdEscalationState.roles[roleName];
      // Track deactivation time for thermal inertia grace periods
      if (roleName === 'heater') lastHeaterOffTime = now;
      if (roleName === 'humidifier') lastHumidifierOffTime = now;
    }
    actions.push({ deviceMac, socket, action: 'off', reason: `VPD: ${reason}` });
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

  // Track time below idealTemp.max during cooling — safety timeout
  if (coolingActive && temp <= idealTemp.max) {
    if (!coolingBelowMaxSince) coolingBelowMaxSince = now;
  } else {
    coolingBelowMaxSince = 0;
  }
  const belowMaxSaturated = coolingBelowMaxSince > 0 && (now - coolingBelowMaxSince) >= COOLING_BELOW_MAX_TIMEOUT_MS;

  const needsCooling = temp > idealTemp.min
    && (tempHigh || coolingActive)
    && (!heaterRecentlyOff || tempEmergency)
    && !belowMaxSaturated;

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
      // Blower extractor: calculate initial speed from calibration or formula
      const tempExcess = temp - idealTemp.min;
      const period = isDaytime ? 'day' : 'night';
      const calSpeed = calcSpeedFromCalibration(tempExcess, 0, period);
      const baseFloor = calSpeed > 0
        ? calSpeed
        : Math.min(80, Math.round(25 + tempExcess * 15));

      if (!coolingActive) {
        // First activation — create optimizer state
        vpdEscalationState.roles['extractor_temp'] = {
          activatedAt: now, metricAtActivation: temp,
          speedBoost: 0, lastCheckTime: now, lastMetric: temp,
          phase: 'escalating', noImproveCount: 0
        };
        console.log(`[VPD] Blower floor ${baseFloor}% (${calSpeed > 0 ? 'calibrated' : 'estimated'}) — temp ${temp.toFixed(1)}°C > ${tempHighThreshold.toFixed(1)}°C (cooling to ${idealTemp.min}°C)`);
      } else {
        // 3-phase speed optimizer
        evaluateEscalation('extractor_temp', temp, true, ESCALATION_IMPROVE_TEMP, ESCALATION_WORSEN_TEMP);
      }
      // Apply optimizer boost (can be negative during de-escalation)
      const boost = vpdEscalationState.roles['extractor_temp']?.speedBoost || 0;
      newBlowerFloor = Math.max(0, baseFloor + boost);
      newBlowerFloor = Math.min(100, newBlowerFloor);
    }

    // Temp too high → no heater needed
    deactivateSocketRole('heater', 'Temp too high');

  } else if (temp <= idealTemp.min || belowMaxSaturated) {
    // Either reached idealTemp.min OR below max for 5+ min (best effort)
    if (coolingActive) {
      const reason = belowMaxSaturated
        ? `below ${idealTemp.max}°C for 5 min, best effort ${temp.toFixed(1)}°C`
        : `reached target ${idealTemp.min}°C`;
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

  if (tempLow && heaterSuppressedByCoolingGrace) {
    if (curState !== prevState) {
      console.log(`[VPD] Heater suppressed by cooling grace (${(coolingGraceElapsed / 60000).toFixed(0)}min/${(COOLING_GRACE_MAX_MS / 60000)}min) — temp ${temp.toFixed(1)}°C < ${tempLowThreshold.toFixed(1)}°C but monitoring trend`);
    }
  } else if (tempLow && !heaterSuppressedByCoolingGrace) {
    activateSocketRole('heater', `Temp ${temp.toFixed(1)}°C < ${tempLowThreshold.toFixed(1)}°C`);
    deactivateSocketRole('cooler', 'Temp too low');
  } else if (tempReachedMin && isRoleActive('heater')) {
    // Heater heated room to bottom of range — turn off BEFORE entering range
    deactivateSocketRole('heater', `Temp ${temp.toFixed(1)}°C reached ideal min ${idealTemp.min}°C — stopping to prevent overshoot`);
  }

  // ═══════════════════════════════════════════════════════
  // RULE 4: Humidity too high → Dehumidifier first, blower LAST RESORT
  //   + SMART SUBSTITUTION: if blower is crashing temp, switch to dehumidifier
  // Step 1: Dehumidifier (if available, no temp impact)
  // Step 2: Only if dehumidifier exhausted → blower (with temp safety monitoring)
  // Step 3: If blower is dropping temp dangerously → STOP blower, rely on dehumidifier
  // ═══════════════════════════════════════════════════════
  const needsHumiAction = humi > idealHumiMax
    && (humiHigh || humiExtractionActive || isRoleActive('dehumidifier'))
    && !isRoleActive('humidifier')
    && (!humidifierRecentlyOff || humiEmergency);

  if (needsHumiAction) {
    deactivateSocketRole('humidifier', 'Humi too high');

    const dehumRole = getRoleAssignment('dehumidifier');
    const hasDehumRole = dehumRole && dehumRole.socket;

    // Step 1: Try dehumidifier first (if role exists)
    if (hasDehumRole) {
      activateSocketRole('dehumidifier', `Humi ${humi.toFixed(0)}% > ${idealHumiMax.toFixed(0)}% — dehumidifier first`);
      if (!vpdEscalationState.roles['dehumidifier']) {
        vpdEscalationState.roles['dehumidifier'] = {
          activatedAt: now, metricAtActivation: humi
        };
      }
    }

    // Step 2: Escalate to blower ONLY if dehumidifier exhausted (or doesn't exist)
    const dehumState = vpdEscalationState.roles['dehumidifier'];
    const dehumExhausted = (hasDehumRole && !humiEmergency)
      ? (dehumState && now - dehumState.activatedAt > DEHUM_ESCALATION_MS && humi >= dehumState.metricAtActivation - 1)
      : true; // No dehumidifier or emergency → skip straight to blower

    // ── SMART SUBSTITUTION: blower crashing temp → switch to dehumidifier-only ──
    // If blower is extracting humidity but temp has dropped to near idealTemp.min,
    // the blower is causing more harm than good. Stop it, let dehumidifier handle it.
    // Blower crashing temp: stop extraction regardless of whether dehumidifier exists.
    // Without dehumidifier, we sacrifice humidity control to protect temperature.
    const blowerCrashingTemp = humiExtractionActive
      && temp < idealTemp.min + 0.5
      && !humiEmergency;

    if (blowerCrashingTemp) {
      console.log(`[VPD] SUBSTITUTION: blower crashing temp (${temp.toFixed(1)}°C < ${(idealTemp.min + 0.5).toFixed(1)}°C) — switching to dehumidifier-only for humidity`);
      // Start cooling grace: blower was extracting and dropped temp, same logic applies
      if (!lastCoolingStopTime) {
        lastCoolingStopTime = now;
        coolingGraceLastTemp = temp;
        coolingGraceLastCheck = now;
        coolingGraceStableStart = 0;
      }
      delete vpdEscalationState.roles['extractor_humi'];
      if (!extIsBlower) {
        if (!needsCooling) deactivateSocketRole('extractor', 'Temp crash — dehumidifier takes over');
      } else {
        // Blower: actively remove humidity extraction ceiling/floor.
        // Rule 1 cooling (needsCooling) can still control the blower independently.
        if (!needsCooling) {
          newBlowerCeiling = 0;
          newBlowerFloor = 0;
        }
        // If needsCooling is true, ceiling stays at 100 from Rule 1 — that's correct,
        // the blower runs for TEMP not humidity. Humi extraction stops.
      }
      // Dehumidifier stays active (activated above in Step 1)
    }

    // Temperature safety: blower for humidity extraction would COOL the room.
    // Don't fire it if temp is already near/below idealTemp.min — that would trigger the heater.
    // Exception: humiEmergency overrides safety (critically high humidity).
    const tempSafeForBlower = temp > idealTemp.min + 0.5 || humiEmergency;

    if (dehumExhausted && !blowerCrashingTemp && (humiHigh || humiExtractionActive) && tempSafeForBlower) {
      if (extIsBlower) {
        newBlowerCeiling = 100;
        const humiExcess = humi - idealHumiMax;
        const period = isDaytime ? 'day' : 'night';
        const calSpeed = calcSpeedFromCalibration(0, humiExcess, period);
        const baseFloor = calSpeed > 0 ? calSpeed : 40;

        if (!humiExtractionActive) {
          vpdEscalationState.roles['extractor_humi'] = {
            activatedAt: now, metricAtActivation: humi,
            speedBoost: 0, lastCheckTime: now, lastMetric: humi,
            phase: 'escalating', noImproveCount: 0
          };
          newBlowerFloor = Math.max(newBlowerFloor, baseFloor);
          console.log(`[VPD] Blower floor ${newBlowerFloor}% — humidity extraction (${humi.toFixed(0)}% > ${humiHighThreshold.toFixed(0)}%, ${hasDehumRole ? 'dehumidifier exhausted' : 'no dehumidifier'})`);
        } else {
          // 3-phase speed optimizer for humidity extraction
          evaluateEscalation('extractor_humi', humi, true, ESCALATION_IMPROVE_HUMI, ESCALATION_WORSEN_HUMI);
        }
        const boost = vpdEscalationState.roles['extractor_humi']?.speedBoost || 0;
        newBlowerFloor = Math.max(0, Math.max(newBlowerFloor, baseFloor) + boost);
        newBlowerFloor = Math.min(100, newBlowerFloor);
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

  // ═══════════════════════════════════════════════════════
  // RULE 5: Blower ON for HUMIDITY + temp dropping → Heater compensates
  // Only applies when blower runs for humidity extraction (side-effect: temp drops).
  // Does NOT apply when blower is intentionally cooling for temperature (Rule 1) —
  // that's the blower's JOB, don't fight it with the heater.
  // Also respects post-cooling grace to avoid immediate heater after any blower stop.
  // ═══════════════════════════════════════════════════════
  const blowerRunningForHumiOnly = humiExtractionActive && newBlowerFloor > 0 && !needsCooling;
  if (blowerRunningForHumiOnly && temp < idealTemp.min + 0.3 && !heaterSuppressedByCoolingGrace) {
    activateSocketRole('heater', `Compensate humi-extraction blower: temp ${temp.toFixed(1)}°C dropping below ${idealTemp.min}°C`);
  }

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

  return actions;
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

          if (improvement < (curve.escalation.expectedImprovement || 0.5)) {
            // Not improving enough, escalate
            state.escalationBoost = Math.min(
              state.escalationBoost + (curve.escalation.speedIncrement || 10),
              100 - speed  // Don't exceed 100%
            );
            console.log(`[BlowerCurve] ${curve.sensor}: No improvement (${improvement.toFixed(2)}), escalating +${curve.escalation.speedIncrement}% to ${speed + state.escalationBoost}%`);
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

  // If no curve is demanding, use standby speed
  const finalSpeed = maxSpeed > 0 ? maxSpeed : (standbySpeed || 0);

  return finalSpeed;
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

  // Deduplicate flow actions (key is device:socket for multi-device)
  const actionMap = new Map();
  for (const action of allActions) {
    const key = action.deviceMac ? `${action.deviceMac}:${action.socket}` : action.socket;
    actionMap.set(key, action);
  }

  // Evaluate VPD intelligent auto-calibration (overrides flow actions for climate sockets)
  const vpdActions = evaluateVpdIntelligent();
  for (const action of vpdActions) {
    const key = action.deviceMac ? `${action.deviceMac}:${action.socket}` : action.socket;
    // VPD overrides normal flow actions, but mandatory flags take priority
    const existing = actionMap.get(key);
    if (existing && (existing.mandatoryOff || existing.mandatoryOn || existing.reason?.includes('Mandatory'))) {
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
  // VPD floor/ceiling override the curve when needed
  const curveSpeed = evaluateBlowerCurve();

  if (curveSpeed !== null || vpdBlowerMinSpeed > 0 || vpdBlowerMaxSpeed < 100) {
    let effectiveSpeed = Math.max(curveSpeed ?? lastBlowerSpeed ?? 0, vpdBlowerMinSpeed);
    effectiveSpeed = Math.min(effectiveSpeed, vpdBlowerMaxSpeed);
    // When VPD is capping the blower (ceiling < 100), respect it fully — don't force a minimum
    if (vpdBlowerMaxSpeed >= 100 && effectiveSpeed > 0) {
      effectiveSpeed = Math.max(effectiveSpeed, 25); // Minimum when actively running
    }
    if (effectiveSpeed !== lastBlowerSpeed) {
      console.log(`[BlowerCurve] Speed: ${effectiveSpeed}% (curve=${curveSpeed ?? 'n/a'}, floor=${vpdBlowerMinSpeed}%, ceil=${vpdBlowerMaxSpeed}%)`);
      lastBlowerSpeed = effectiveSpeed;
      await sendBlowerCommand(effectiveSpeed, effectiveSpeed > 0);
    }
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
    // Ignore parse errors
  }
}

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
  loadCalibrationData();
  loadVpdFromFlow();
  loadBlowerCurveFromFlow();
  // Load plant stage for phase-based VPD mode (supports both legacy 'grow_phase' and new 'plant_stage')
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
 * Find the correct device for a socket type.
 * Outlets (O1-O5) and blower live on PS5 (or CB). No guessing — find by device type.
 */
function findDeviceForSocket(socketId) {
  // If explicit MAC provided in role, that's used before calling this
  // This handles the fallback: find PS5 first (has outlets + blower), then CB
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
 * Calculate Leaf VPD from air temp and humidity
 * Formula: SVP(T_leaf) - SVP(T_air) × (RH/100)
 * where T_leaf = T_air - LEAF_TEMP_OFFSET
 */
function calculateLeafVpd(airTemp, humi) {
  if (airTemp == null || humi == null) return null;
  const svp = (t) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
  const leafTemp = airTemp - LEAF_TEMP_OFFSET;
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

  // Check for software updates every 10 minutes
  setInterval(() => {
    updateChecker.checkForUpdates({ autoApply: true }).catch(err => {
      console.error('[Supervisor] Update check error:', err.message);
    });
  }, 10 * 60 * 1000);

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
 * Graceful shutdown
 */
function shutdown() {
  console.log('[Supervisor] Shutting down...');
  if (mqttClient && mqttClient.connected) {
    // Publish offline status before dying
    mqttClient.publish('s4r/supervisor/health', JSON.stringify({
      status: 'offline', ts: Date.now()
    }), { qos: 0, retain: true });
  }
  if (mqttClient) {
    mqttClient.end(true);
  }
  pool.end();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the service
start().catch((err) => {
  console.error('[Supervisor] Failed to start:', err);
  process.exit(1);
});
