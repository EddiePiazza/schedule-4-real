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
const HYSTERESIS_COOLDOWN_MS = 5000; // Minimum 5 seconds between state changes

// Per-device state tracking for multi-device support
const sensorValuesByDevice = new Map();  // mac -> { temp, humi, vpd, co2, ... }
const socketStatesByDevice = new Map();  // mac -> { O1: 0|1, O2: 0|1, ... }
let dayNightSchedule = { dayStart: '06:00', dayEnd: '00:00' };
// VPD Intelligent Control State
let vpdNodeConfig = null; // Parsed from flow vpd_control node
let vpdEscalationState = {
  roles: {}, // { roleName: { activatedAt, vpdAtActivation, maxedOut } }
  currentDirection: 'in_range', // 'too_high' | 'too_low' | 'in_range'
};
let activeGrowPhase = null; // Current grow phase from DB

// Blower Curve Control State
let blowerCurveConfig = null; // Parsed from flow blower_curve node
let blowerCurveEscalationState = {}; // { curveId: { lastValue, lastCheck, escalationBoost } }
let lastBlowerSpeed = null; // Last commanded speed to avoid redundant commands

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
    console.log('[Supervisor] Day/Night schedule:', dayNightSchedule);
  } catch (err) {
    // Table might not exist yet, use defaults
    if (!err.message.includes('does not exist')) {
      console.error('[Supervisor] Failed to load day/night schedule:', err.message);
    }
  }
}

/**
 * Load VPD config from the flow's vpd_control node
 */
function loadVpdFromFlow() {
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
        return;
      }
    }
  }
}

/**
 * Load Blower Curve config from the flow's blower_curve node
 */
function loadBlowerCurveFromFlow() {
  blowerCurveConfig = null;
  for (const flow of flows) {
    if (!flow.enabled) continue;
    for (const node of flow.flow.nodes) {
      if (node.type === 'blower_curve') {
        blowerCurveConfig = node.data.config;
        const enabledCurves = blowerCurveConfig.curves?.filter(c => c.enabled) || [];
        console.log('[Supervisor] Blower Curve node found:', {
          standbySpeed: blowerCurveConfig.standbySpeed,
          curves: enabledCurves.map(c => c.sensor).join(', ') || 'none'
        });
        return;
      }
    }
  }
}

/**
 * Map Laboratory plant status to VPD phase
 * Lab statuses are more granular, VPD phases are simpler
 */
function mapLabStatusToVpdPhase(labStatus) {
  const mapping = {
    'germinating': 'germination',
    'seedling': 'seedling',
    'early_veg': 'vegetative',
    'mid_veg': 'vegetative',
    'late_veg': 'vegetative',
    'pre_flower': 'flower',
    'early_flower': 'flower',
    'mid_flower': 'flower',
    'late_flower': 'flower',
    'flush': 'flush',
    'harvest': 'flush', // harvest uses same VPD as flush
    'drying': 'drying',
    'curing': 'curing'
  };
  return mapping[labStatus] || null;
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
      activeGrowPhase = mapLabStatusToVpdPhase(labStatus);
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

  // Support both 'grow_phase' (legacy) and 'plant_stage' (new)
  if ((vpdNodeConfig.mode === 'grow_phase' || vpdNodeConfig.mode === 'plant_stage') && activeGrowPhase) {
    const target = vpdNodeConfig.phaseTargets?.[activeGrowPhase];
    if (target && target.min > 0 && target.max > 0) {
      return target;
    }
    // Phase disabled (sentinel -1)
    return null;
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
    const rows = await query(`
      SELECT socket, ai_mode
      FROM socket_ai_mode
      WHERE timestamp = (
        SELECT max(timestamp) FROM socket_ai_mode s2
        WHERE s2.socket = socket_ai_mode.socket
      )
    `);

    socketAiModes = {};
    for (let i = 1; i <= 5; i++) {
      socketAiModes[`O${i}`] = false;
    }
    for (const row of rows) {
      socketAiModes[row.socket] = row.ai_mode === 1;
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
          const { deviceMac: actionDeviceMac, socket, action } = node.data.config;

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

          actions.push({ deviceMac: actionDeviceMac, socket, action, reason: reasons.join(', ') || 'Condition met' });
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
 * Send MQTT command to control socket on a specific device
 * @param {string} deviceMac - Target device MAC (or null for default PS5)
 * @param {string} socket - Socket ID (O1-O5)
 * @param {string} action - 'on' or 'off'
 */
async function sendSocketCommand(deviceMac, socket, action) {
  if (!mqttClient || !mqttClient.connected) {
    console.error('[Supervisor] MQTT not connected');
    return false;
  }

  // Get device info (with fallback to default PS5)
  const device = getDevice(deviceMac);
  if (!device) {
    console.error(`[Supervisor] No device found for MAC: ${deviceMac || 'default'}`);
    return false;
  }

  const topic = `ggs/${device.type}/${device.mac}/cmd`;
  const command = {
    method: 'setConfigField',
    params: {
      keyPath: ['outlet', socket],
      [socket]: {
        modeType: 0,  // Manual mode
        mOnOff: action === 'on' ? 1 : 0
      }
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
    const { deviceMac, socket, action: targetAction, reason } = action;

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

    // Check cooldown
    if (now - lastTime < HYSTERESIS_COOLDOWN_MS) {
      console.log(`[Supervisor] Cooldown active for ${actionKey}, skipping`);
      continue;
    }

    // Execute command (deviceMac can be null for backward compatibility)
    const success = await sendSocketCommand(deviceMac, socket, targetAction);

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
 * Intelligent VPD auto-calibration engine
 * - Tracks device effectiveness over time
 * - Escalates to secondary devices when primary ones max out
 * - Uses hysteresis to prevent oscillation
 * - Supports multi-device: sensorDeviceMac for VPD reading, deviceMac per role for actions
 */
function evaluateVpdIntelligent() {
  if (!vpdNodeConfig || !vpdNodeConfig.roles || vpdNodeConfig.roles.length === 0) return [];

  // Get VPD from specified sensor device or legacy global
  const sensorValues = getSensorValues(vpdNodeConfig.sensorDeviceMac);
  const currentVpd = sensorValues.vpd;
  if (!currentVpd || currentVpd <= 0) return [];

  const target = getVpdTargetRange();
  if (!target) return []; // Phase disabled or no target

  const { min: targetMin, max: targetMax } = target;
  const actions = [];
  const now = Date.now();
  const timeoutMs = (vpdNodeConfig.escalationTimeoutSeconds || 180) * 1000;

  // Calculate hysteresis comfort zone (inner X% of range)
  const rangeWidth = targetMax - targetMin;
  const hystPercent = (vpdNodeConfig.hysteresisPercent || 60) / 100;
  const hystMargin = rangeWidth * (1 - hystPercent) / 2;
  const comfortMin = targetMin + hystMargin;
  const comfortMax = targetMax - hystMargin;

  // Determine direction
  let direction = 'in_range';
  if (currentVpd > targetMax) direction = 'too_high';
  else if (currentVpd < targetMin) direction = 'too_low';

  // If direction changed, reset escalation state
  if (direction !== vpdEscalationState.currentDirection) {
    vpdEscalationState.roles = {};
    vpdEscalationState.currentDirection = direction;
  }

  // Helper: get socket and deviceMac for a role
  function getRoleAssignment(roleName) {
    const assignment = vpdNodeConfig.roles.find(r => r.role === roleName);
    return assignment ? { socket: assignment.socket, deviceMac: assignment.deviceMac } : null;
  }

  // Helper: check if a role's device has maxed out (not improving VPD)
  function isMaxedOut(roleName) {
    const state = vpdEscalationState.roles[roleName];
    if (!state) return false;
    if (state.maxedOut) return true;

    // Check if enough time has passed since activation
    if (now - state.activatedAt >= timeoutMs) {
      const movingRight = (direction === 'too_high' && currentVpd < state.vpdAtActivation) ||
                          (direction === 'too_low' && currentVpd > state.vpdAtActivation);
      const improvement = Math.abs(state.vpdAtActivation - currentVpd);

      if (!movingRight || improvement < 0.02) {
        // Device not helping - mark as maxed out
        state.maxedOut = true;
        console.log(`[VPD] Role "${roleName}" maxed out. VPD at activation: ${state.vpdAtActivation.toFixed(2)}, now: ${currentVpd.toFixed(2)}`);
        return true;
      }
      // Device is working but hasn't reached target yet - reset timer
      state.activatedAt = now;
      state.vpdAtActivation = currentVpd;
    }
    return false;
  }

  // Helper: activate a role (with multi-device support)
  function activateRole(roleName, reason) {
    const assignment = getRoleAssignment(roleName);
    if (!assignment || !assignment.socket) return;

    const { socket, deviceMac } = assignment;
    const aiModeKey = deviceMac ? `${deviceMac}:${socket}` : socket;

    // Check AI mode (try device-specific key first, then legacy)
    if (!socketAiModes[aiModeKey] && !socketAiModes[socket]) return;

    if (!vpdEscalationState.roles[roleName]) {
      vpdEscalationState.roles[roleName] = {
        activatedAt: now,
        vpdAtActivation: currentVpd,
        maxedOut: false
      };
    }
    actions.push({ deviceMac, socket, action: 'on', reason: `VPD: ${reason}` });
  }

  // Helper: deactivate a role (with multi-device support)
  function deactivateRole(roleName, reason) {
    const assignment = getRoleAssignment(roleName);
    if (!assignment || !assignment.socket) return;

    const { socket, deviceMac } = assignment;
    const aiModeKey = deviceMac ? `${deviceMac}:${socket}` : socket;

    // Check AI mode (try device-specific key first, then legacy)
    if (!socketAiModes[aiModeKey] && !socketAiModes[socket]) return;

    delete vpdEscalationState.roles[roleName];
    actions.push({ deviceMac, socket, action: 'off', reason: `VPD: ${reason}` });
  }

  if (direction === 'too_high') {
    // VPD too high -> need to lower: humidifier first, then cooler
    activateRole('humidifier', `VPD ${currentVpd.toFixed(2)} > ${targetMax}`);

    if (isMaxedOut('humidifier')) {
      activateRole('cooler', `Humidifier maxed, VPD ${currentVpd.toFixed(2)} > ${targetMax}`);
    }

    // Deactivate opposing roles
    deactivateRole('extractor', 'VPD too high');
    deactivateRole('heater', 'VPD too high');

  } else if (direction === 'too_low') {
    // VPD too low -> need to raise: extractor first, then heater
    activateRole('extractor', `VPD ${currentVpd.toFixed(2)} < ${targetMin}`);

    if (isMaxedOut('extractor')) {
      activateRole('heater', `Extractor maxed, VPD ${currentVpd.toFixed(2)} < ${targetMin}`);
    }

    // Deactivate opposing roles
    deactivateRole('humidifier', 'VPD too low');
    deactivateRole('cooler', 'VPD too low');

  } else {
    // In range - check if in comfort zone before deactivating (hysteresis)
    if (currentVpd >= comfortMin && currentVpd <= comfortMax) {
      // Well within range - deactivate in reverse priority order
      deactivateRole('cooler', 'VPD in comfort zone');
      deactivateRole('heater', 'VPD in comfort zone');
      deactivateRole('humidifier', 'VPD in comfort zone');
      deactivateRole('extractor', 'VPD in comfort zone');
    }
    // If in range but not in comfort zone, keep current state (hysteresis)
  }

  // Circulator always ON when VPD control is active (with multi-device support)
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
  if (!blowerCurveConfig || !blowerCurveConfig.curves || blowerCurveConfig.curves.length === 0) {
    return null;
  }

  const { standbySpeed, curves } = blowerCurveConfig;
  let maxSpeed = 0;
  const now = Date.now();

  for (const curve of curves) {
    if (!curve.enabled) continue;

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

  // Return null if speed hasn't changed (avoid redundant commands)
  if (lastBlowerSpeed === finalSpeed) {
    return null;
  }

  lastBlowerSpeed = finalSpeed;
  return finalSpeed;
}

/**
 * Send blower speed command via MQTT
 * @param {number} speed - Speed percentage (0-100)
 * @param {boolean} on - Whether blower should be on
 */
async function sendBlowerCommand(speed, on = true) {
  if (!defaultPrimaryMac) {
    console.error('[BlowerCurve] No primary device MAC available');
    return false;
  }

  const topic = `ggs/${defaultPrimaryType}/${defaultPrimaryMac}/cmd`;
  const command = {
    method: 'setConfigField',
    pid: defaultPrimaryMac,
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
    uid: String(deviceUid)
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

  // Evaluate Blower Curve control (proportional speed based on sensor curves)
  const blowerSpeed = evaluateBlowerCurve();
  if (blowerSpeed !== null) {
    const isOn = blowerSpeed > 0;
    await sendBlowerCommand(blowerSpeed, isOn);
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

  mqttClient.on('connect', () => {
    console.log('[Supervisor] MQTT connected');

    // Subscribe to sensor data topics
    mqttClient.subscribe('ggs/+/+/status', { qos: 0 });
    mqttClient.subscribe('ggs/+/+/sensors', { qos: 0 });
  });

  mqttClient.on('message', handleMessage);

  mqttClient.on('error', (err) => {
    console.error('[Supervisor] MQTT error:', err.message);
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

        // Set default primary device (first PS5 or CB detected)
        if ((type === 'ps5' || type === 'cb') && !defaultPrimaryMac) {
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
  // Fallback to default PS5 for backward compatibility
  if (defaultPrimaryMac && deviceRegistry.has(defaultPrimaryMac)) {
    return deviceRegistry.get(defaultPrimaryMac);
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

  console.log('[Supervisor] Supervisor agent started');
}

/**
 * Graceful shutdown
 */
function shutdown() {
  console.log('[Supervisor] Shutting down...');
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
