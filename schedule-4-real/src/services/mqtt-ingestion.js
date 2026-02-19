/**
 * MQTT Ingestion Service
 * Connects to local Mosquitto broker and stores sensor data in QuestDB
 */

import mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';
import { query } from '../db/connection.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
const MQTT_PORT = process.env.MQTT_PORT || 1883;

// Topics to subscribe (from hybrid proxy)
// Format: ggs/{device_type}/{mac}/{data_type}
const TOPICS = [
  'ggs/+/+/status',   // Device status with sensor data (getDevSta)
  'ggs/+/+/sensors',  // Extracted sensor data
  'ggs/+/+/system',   // System info (getSysSta)
  'ggs/+/+/events',   // Events/logs
  'ggs/+/+/config',   // Device config (getConfigField responses)
  'ggs/+/+/down'      // Server->Device commands (phone app, cloud)
];

let client = null;
let isConnected = false;
let messageCount = 0;
let lastMessageTime = null;

// Track last known socket states to detect changes
const lastSocketStates = new Map();

// ── Device Source Filter ──────────────────────────────────
// Reads the same filter config as mqtt.ts (data/mqtt-device-filter.json)
const FILTER_CONFIG_PATH = path.resolve(process.cwd(), 'data', 'mqtt-device-filter.json');
let deviceFilterMode = 'allow-all';
let allowedUids = new Set();

function loadDeviceFilter() {
  try {
    if (fs.existsSync(FILTER_CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(FILTER_CONFIG_PATH, 'utf-8'));
      deviceFilterMode = data.mode === 'whitelist' ? 'whitelist' : 'allow-all';
      allowedUids = new Set(data.allowedUids || []);
    }
  } catch { /* ignore */ }
}

// Track MAC→UID associations (learned from messages that include uid)
const macToUid = new Map();

function isMessageAllowed(uid, mac) {
  if (deviceFilterMode === 'allow-all') return true;

  // Learn MAC→UID association from messages that have a UID
  if (uid && mac) {
    macToUid.set(mac, uid);
  }

  // If we have a UID (from message or learned), check whitelist
  const resolvedUid = uid || macToUid.get(mac) || '';
  if (resolvedUid) {
    return allowedUids.has(resolvedUid);
  }

  // Unknown MAC with no UID ever seen — block when whitelist is active
  return false;
}

// Reload filter periodically (picks up changes from the web UI)
setInterval(loadDeviceFilter, 5000);
loadDeviceFilter();

// ── Remote Forwarding ──────────────────────────────────
let remoteClient = null;
let remoteConfig = { remoteEnabled: false, remoteHost: '', remotePort: 1884 };
const CONFIG_PATH = path.resolve(process.cwd(), 'proxy', 'proxy-config.json');

function loadRemoteConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('[Forward] Config read error:', err.message);
  }
  return { remoteEnabled: false, remoteHost: '', remotePort: 1884 };
}

function syncRemoteClient() {
  const config = loadRemoteConfig();

  // Disconnect if config changed or disabled
  if (remoteClient) {
    const changed = !config.remoteEnabled ||
      config.remoteHost !== remoteConfig.remoteHost ||
      config.remotePort !== remoteConfig.remotePort;
    if (changed) {
      console.log('[Forward] Config changed, disconnecting remote');
      stopHeartbeat();
      remoteClient.end(true);
      remoteClient = null;
    }
  }

  remoteConfig = config;
  if (!config.remoteEnabled || !config.remoteHost) return;
  if (remoteClient) return; // Already connected

  // Determine connection mode: raw MQTT (IP) vs MQTT-over-WebSocket (domain with protocol)
  const rawHost = config.remoteHost.trim();
  let url;

  if (/^wss?:\/\//i.test(rawHost)) {
    // Explicit WebSocket URL — use as-is
    url = rawHost;
  } else if (/^https:\/\//i.test(rawHost)) {
    // HTTPS domain → connect via WSS (MQTT over secure WebSocket through Nginx)
    const host = rawHost.replace(/^https:\/\//i, '').replace(/\/+$/, '');
    url = `wss://${host}/mqtt`;
  } else if (/^http:\/\//i.test(rawHost)) {
    // HTTP domain → connect via WS
    const host = rawHost.replace(/^http:\/\//i, '').replace(/\/+$/, '');
    url = `ws://${host}/mqtt`;
  } else {
    // Raw IP or hostname — use plain MQTT with port
    const port = config.remotePort || 1884;
    url = `mqtt://${rawHost}:${port}`;
  }
  console.log(`[Forward] Connecting to remote: ${url}`);

  remoteClient = mqtt.connect(url, {
    clientId: `s4r-forward-${Date.now()}`,
    clean: true,
    reconnectPeriod: 10000,
    connectTimeout: 10000
  });

  remoteClient.on('connect', () => {
    console.log(`[Forward] Connected to ${url}`);
    versionSyncTriggered = false; // Reset on reconnect
    startHeartbeat();
    // Subscribe to relay commands from the remote server (bidirectional control)
    remoteClient.subscribe('ggs/_relay/cmd/#', { qos: 1 }, (err) => {
      if (!err) console.log('[Forward] Subscribed to relay commands from remote');
      else console.error('[Forward] Failed to subscribe to relay commands:', err.message);
    });
    // Subscribe to version info from the remote server (version sync)
    remoteClient.subscribe('ggs/_source/versions', { qos: 0 }, (err) => {
      if (!err) console.log('[Forward] Subscribed to remote version info');
    });
  });
  remoteClient.on('message', (topic, payload) => {
    // Handle version sync response from remote server
    if (topic === 'ggs/_source/versions') {
      handleRemoteVersions(payload);
      return;
    }

    // Handle relay commands: ggs/_relay/cmd/{deviceType}/{mac}
    if (!topic.startsWith('ggs/_relay/cmd/')) return;

    const parts = topic.split('/');
    const deviceType = parts[3];
    const mac = parts[4];
    if (!deviceType || !mac) return;

    try {
      const cmd = JSON.parse(payload.toString());
      const ALLOWED_METHODS = [
        'getConfigField', 'setConfigField',
        'getDevSta', 'getSysSta'
      ];
      if (!ALLOWED_METHODS.includes(cmd.method)) {
        console.warn(`[Relay] Blocked unknown method: ${cmd.method}`);
        return;
      }

      // Relay to local device via local broker
      const localTopic = `ggs/${deviceType}/${mac}/cmd`;
      console.log(`[Relay] Forwarding command to ${localTopic}: ${cmd.method}`);
      if (client && client.connected) {
        client.publish(localTopic, payload, { qos: 0 });
      } else {
        console.error('[Relay] Local MQTT client not connected, cannot relay command');
      }
    } catch (err) {
      console.error('[Relay] Parse error:', err.message);
    }
  });
  remoteClient.on('error', (err) => {
    console.error('[Forward] Error:', err.message);
  });
  remoteClient.on('close', () => {
    console.log('[Forward] Disconnected');
    stopHeartbeat();
    versionSyncTriggered = false; // Reset for next connection
  });
}

function forwardMessage(topic, payload) {
  if (remoteClient && remoteClient.connected) {
    // Tag payload so the receiver knows this is forwarded data (prevents chain re-forwarding)
    try {
      const msg = JSON.parse(payload.toString());
      msg._forwarded = true;
      remoteClient.publish(topic, JSON.stringify(msg), { qos: 0 });
    } catch {
      remoteClient.publish(topic, payload, { qos: 0 });
    }
  }
}

// ── Version Sync ─────────────────────────────────────
let versionSyncTriggered = false;

function readLocalVersions() {
  try {
    const vPath = path.resolve(process.cwd(), 'versions.local.json');
    const vData = JSON.parse(fs.readFileSync(vPath, 'utf-8'));
    const versions = {};
    for (const [comp, info] of Object.entries(vData.components || {})) {
      versions[comp] = info.version;
    }
    return { versions, autoUpdate: vData.autoUpdate || false };
  } catch {
    return { versions: {}, autoUpdate: false };
  }
}

function compareVersions(a, b) {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function handleRemoteVersions(payload) {
  if (versionSyncTriggered) return;

  try {
    const remote = JSON.parse(payload.toString());
    const remoteVersions = remote.versions || {};
    const { versions: localVersions, autoUpdate } = readLocalVersions();

    const behind = [];
    for (const [comp, remoteVer] of Object.entries(remoteVersions)) {
      const localVer = localVersions[comp] || '0.0.0';
      if (compareVersions(remoteVer, localVer) > 0) {
        behind.push(`${comp}: ${localVer} → ${remoteVer}`);
      }
    }

    if (behind.length > 0) {
      console.log(`[VersionSync] Remote server is ahead on: ${behind.join(', ')}`);
      if (autoUpdate) {
        versionSyncTriggered = true;
        console.log('[VersionSync] Auto-update enabled, triggering update check...');
        const { execFile } = require('child_process');
        execFile('node', ['-e',
          'const uc=require("./src/services/update-checker.cjs");uc.checkForUpdates({autoApply:true}).then(()=>process.exit(0)).catch(()=>process.exit(1))'
        ], { cwd: process.cwd(), timeout: 300000 }, (err) => {
          if (err) console.error('[VersionSync] Update check failed:', err.message);
          else console.log('[VersionSync] Update check completed');
        });
      } else {
        console.log('[VersionSync] Auto-update disabled, skipping');
      }
    } else {
      console.log('[VersionSync] All versions in sync with remote server');
    }
  } catch (err) {
    console.error('[VersionSync] Error comparing versions:', err.message);
  }
}

// Heartbeat for clone servers: lets the receiver know data is being forwarded
let heartbeatInterval = null;

function startHeartbeat() {
  if (heartbeatInterval) return;
  // Read versions once for heartbeat payload (re-read on reconnect)
  const { versions: localVersions, autoUpdate: localAutoUpdate } = readLocalVersions();

  heartbeatInterval = setInterval(() => {
    if (remoteClient && remoteClient.connected) {
      remoteClient.publish('ggs/_source/heartbeat', JSON.stringify({
        timestamp: Date.now(),
        host: MQTT_HOST,
        versions: localVersions,
        autoUpdate: localAutoUpdate
      }), { qos: 0 });
    }
  }, 5000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// Reload config every 30 seconds
setInterval(syncRemoteClient, 30000);

// Event emitter for real-time updates
const listeners = new Set();

export function onSensorData(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function emitSensorData(data) {
  listeners.forEach(cb => {
    try {
      cb(data);
    } catch (err) {
      console.error('[MQTT] Listener error:', err);
    }
  });
}

// Event emitter for Server->Device (phone app) messages
const downListeners = new Set();

export function onDownMessage(callback) {
  downListeners.add(callback);
  return () => downListeners.delete(callback);
}

function emitDownMessage(data) {
  downListeners.forEach(cb => {
    try {
      cb(data);
    } catch (err) {
      console.error('[MQTT] Down listener error:', err);
    }
  });
}

/**
 * Parse and store environmental sensor data
 */
async function storeEnvironmentData(deviceMac, data) {
  const sensor = data.sensor || data;

  if (!sensor.temp && !sensor.humi) return;

  const timestamp = new Date().toISOString();

  try {
    await query(`
      INSERT INTO sensors_environment (timestamp, device_mac, temp, humi, vpd, co2)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      timestamp,
      deviceMac,
      sensor.temp || null,
      sensor.humi || null,
      sensor.vpd || null,
      sensor.co2 || null
    ]);

    // Emit for real-time display
    emitSensorData({
      type: 'environment',
      deviceMac,
      timestamp,
      temp: sensor.temp,
      humi: sensor.humi,
      vpd: sensor.vpd,
      co2: sensor.co2
    });

  } catch (err) {
    console.error('[Store] Environment data error:', err.message);
  }
}

/**
 * Parse and store soil sensor data
 */
async function storeSoilData(deviceMac, sensors) {
  if (!Array.isArray(sensors)) return;

  const timestamp = new Date().toISOString();

  for (const sensor of sensors) {
    if (sensor.id === 'avg') continue; // Skip average, store individual sensors

    try {
      await query(`
        INSERT INTO sensors_soil (timestamp, device_mac, sensor_id, temp_soil, humi_soil, ec_soil)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        timestamp,
        deviceMac,
        sensor.id,
        sensor.tempSoil || null,
        sensor.humiSoil || null,
        sensor.ECSoil || null
      ]);

      emitSensorData({
        type: 'soil',
        deviceMac,
        sensorId: sensor.id,
        timestamp,
        tempSoil: sensor.tempSoil,
        humiSoil: sensor.humiSoil,
        ecSoil: sensor.ECSoil
      });

    } catch (err) {
      console.error('[Store] Soil data error:', err.message);
    }
  }
}

/**
 * Parse and store outlet states
 * Also tracks state changes and records events
 */
async function storeOutletStates(deviceMac, outlet) {
  if (!outlet) return;

  const timestamp = new Date().toISOString();

  for (const [key, value] of Object.entries(outlet)) {
    if (!key.startsWith('O') || typeof value !== 'object') continue;

    const isOn = value.on ?? value.mOnOff ?? 0;
    const stateKey = `${deviceMac}:${key}`;
    const lastState = lastSocketStates.get(stateKey);

    try {
      // Store current state (for history)
      await query(`
        INSERT INTO outlet_states (timestamp, device_mac, outlet, mode_type, is_on)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        timestamp,
        deviceMac,
        key,
        value.modeType ?? null,
        isOn
      ]);

      // Check if state changed - record event
      if (lastState === undefined || lastState !== isOn) {
        await query(`
          INSERT INTO socket_events (timestamp, device_mac, socket, is_on)
          VALUES ($1, $2, $3, $4)
        `, [
          timestamp,
          deviceMac,
          key,
          isOn
        ]);
        console.log(`[Store] Socket ${key} state changed: ${lastState} -> ${isOn}`);
        lastSocketStates.set(stateKey, isOn);
      }

      emitSensorData({
        type: 'outlet',
        deviceMac,
        outlet: key,
        timestamp,
        modeType: value.modeType,
        isOn: isOn
      });

    } catch (err) {
      console.error('[Store] Outlet state error:', err.message);
    }
  }
}

/**
 * Parse and store blower state
 * Tracks on/off status, power level, mode, and CO2 close status
 */
let lastBlowerState = null;

async function storeBlowerState(deviceMac, blower) {
  if (!blower) return;

  const timestamp = new Date().toISOString();
  const isOn = blower.on ?? blower.mOnOff ?? 0;
  const level = blower.level ?? blower.mLevel ?? 0;
  const modeType = blower.modeType ?? 0;
  const closeCO2 = blower.closeCO2 ?? 0;

  // Create state key for change detection
  const stateKey = `${isOn}:${level}:${modeType}:${closeCO2}`;

  try {
    // Only store if state changed (avoid flooding DB with identical records)
    if (lastBlowerState !== stateKey) {
      await query(`
        INSERT INTO blower_states (timestamp, device_mac, mode_type, level, is_on, close_co2)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        timestamp,
        deviceMac,
        modeType,
        level,
        isOn,
        closeCO2
      ]);

      console.log(`[Store] Blower state: on=${isOn}, level=${level}%, mode=${modeType}`);
      lastBlowerState = stateKey;
    }

    emitSensorData({
      type: 'blower',
      deviceMac,
      timestamp,
      modeType,
      level,
      isOn,
      closeCO2
    });

  } catch (err) {
    console.error('[Store] Blower state error:', err.message);
  }
}

/**
 * Parse and store fan state (CB devices have a separate oscillating fan)
 */
let lastFanState = null;

async function storeFanState(deviceMac, fan) {
  if (!fan) return;

  const timestamp = new Date().toISOString();
  const isOn = fan.on ?? fan.mOnOff ?? 0;
  const level = fan.level ?? fan.mLevel ?? 0;
  const modeType = fan.modeType ?? 0;
  const stateKey = `${isOn}:${level}:${modeType}`;

  try {
    if (lastFanState !== stateKey) {
      await query(`
        INSERT INTO fan_states (timestamp, device_mac, mode_type, level, is_on)
        VALUES ($1, $2, $3, $4, $5)
      `, [timestamp, deviceMac, modeType, level, isOn]);
      lastFanState = stateKey;
    }

    emitSensorData({
      type: 'fan',
      deviceMac,
      timestamp,
      modeType,
      level,
      isOn
    });
  } catch (err) {
    console.error('[Store] Fan state error:', err.message);
  }
}

/**
 * Parse and store light states
 */
async function storeLightStates(deviceMac, data) {
  const timestamp = new Date().toISOString();

  const lights = [
    { id: 'light', data: data.light },
    { id: 'light2', data: data.light2 }
  ];

  for (const light of lights) {
    if (!light.data) continue;

    try {
      await query(`
        INSERT INTO light_states (timestamp, device_mac, light_id, mode_type, level, is_on)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        timestamp,
        deviceMac,
        light.id,
        light.data.modeType ?? null,
        light.data.level ?? light.data.mLevel ?? null,
        light.data.mOnOff ?? null
      ]);

      emitSensorData({
        type: 'light',
        deviceMac,
        lightId: light.id,
        timestamp,
        modeType: light.data.modeType,
        level: light.data.level ?? light.data.mLevel,
        isOn: light.data.mOnOff
      });

    } catch (err) {
      console.error('[Store] Light state error:', err.message);
    }
  }
}

/**
 * Parse and store system status
 */
async function storeSystemStatus(deviceMac, sys) {
  if (!sys) return;

  const timestamp = new Date().toISOString();

  try {
    await query(`
      INSERT INTO system_status (timestamp, device_mac, firmware_ver, wifi_rssi, uptime, mem_free)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      timestamp,
      deviceMac,
      sys.ver || null,
      sys.wifi?.rssi || null,
      sys.upTime || null,
      sys.mem || null
    ]);
  } catch (err) {
    console.error('[Store] System status error:', err.message);
  }
}

/**
 * Process incoming MQTT message
 */
async function processMessage(topic, payload) {
  try {
    const message = JSON.parse(payload.toString());

    // Extract device MAC from topic: ggs/ps5/80b54e8ffff4/status
    const parts = topic.split('/');
    const deviceMac = parts[2]?.toUpperCase();
    const messageType = parts[3];

    if (!deviceMac) return;

    // Apply device source filter — block data from non-whitelisted UIDs/MACs
    // This also blocks forwarding to remote servers (only forward allowed data)
    const uid = message.uid || message.data?.uid || '';
    if (!isMessageAllowed(uid, deviceMac)) {
      return;
    }

    // Forward to remote server AFTER filter — but SKIP messages already forwarded
    // from another machine (prevents chain re-forwarding: MachineX→ThisMachine→Remote)
    if (!message._forwarded) {
      forwardMessage(topic, payload);
    }

    messageCount++;
    lastMessageTime = new Date();

    // Data may be nested under 'data' key (from getDevSta/getSysSta responses)
    const data = message.data || message;

    // Process based on message type
    switch (messageType) {
      case 'status':
        // Full device status from getDevSta
        // For PS5: data contains sensor, sensors, outlet, light, light2, blower
        // For LC: data contains mode, brightness, etc.
        if (data.sensor) await storeEnvironmentData(deviceMac, data);
        if (data.sensors) await storeSoilData(deviceMac, data.sensors);
        if (data.outlet) await storeOutletStates(deviceMac, data.outlet);
        if (data.light || data.light2) await storeLightStates(deviceMac, data);
        if (data.blower) await storeBlowerState(deviceMac, data.blower);
        if (data.fan) await storeFanState(deviceMac, data.fan);
        // For Light Controller (LC) - different structure
        if (data.brightness !== undefined && data.mode !== undefined) {
          await storeLightStates(deviceMac, {
            light: { modeType: data.mode, level: data.brightness, mOnOff: data.brightness > 0 ? 1 : 0 }
          });
        }
        break;

      case 'sensors':
        // Extracted sensor data (direct, not nested)
        await storeEnvironmentData(deviceMac, message);
        break;

      case 'system':
        // System info from getSysSta (data.sys)
        if (data.sys) await storeSystemStatus(deviceMac, data.sys);
        break;

      case 'events':
        // Operation logs
        // TODO: Implement event logging
        break;

      case 'down':
        // Server->Device commands (phone app, cloud commands)
        // Emit for live phone app stream — no DB storage needed
        emitDownMessage({
          timestamp: Date.now(),
          topic,
          deviceMac,
          payload: message
        });
        break;
    }

  } catch (err) {
    if (err instanceof SyntaxError) {
      // Not JSON, ignore
    } else {
      console.error('[MQTT] Process error:', err.message);
    }
  }
}

/**
 * Connect to MQTT broker
 */
export function connect() {
  const url = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;

  console.log(`[MQTT] Connecting to ${url}...`);

  client = mqtt.connect(url, {
    clientId: `s4r-ingestion-${Date.now()}`,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to broker');
    isConnected = true;

    // Subscribe to all topics
    TOPICS.forEach(topic => {
      client.subscribe(topic, { qos: 0 }, (err) => {
        if (err) {
          console.error(`[MQTT] Subscribe error for ${topic}:`, err.message);
        } else {
          console.log(`[MQTT] Subscribed to: ${topic}`);
        }
      });
    });
  });

  client.on('message', processMessage);

  client.on('error', (err) => {
    console.error('[MQTT] Connection error:', err.message);
    isConnected = false;
  });

  client.on('close', () => {
    console.log('[MQTT] Connection closed');
    isConnected = false;
  });

  client.on('reconnect', () => {
    console.log('[MQTT] Reconnecting...');
  });

  return client;
}

/**
 * Disconnect from MQTT broker
 */
export function disconnect() {
  if (client) {
    client.end(true);
    client = null;
    isConnected = false;
  }
}

/**
 * Get connection status
 */
export function getStatus() {
  return {
    connected: isConnected,
    messageCount,
    lastMessageTime,
    broker: `${MQTT_HOST}:${MQTT_PORT}`
  };
}

export default { connect, disconnect, getStatus, onSensorData, onDownMessage };

// Auto-start: Connect immediately when loaded by PM2 or run directly
// The process.env.pm_id is set by PM2 when running a process
const isPM2 = typeof process.env.pm_id !== 'undefined';
const isDirectRun = process.argv[1]?.includes('mqtt-ingestion');

if (isPM2 || isDirectRun) {
  console.log('[MQTT] Auto-starting MQTT ingestion service...');
  console.log('[MQTT] PM2:', isPM2, 'Direct:', isDirectRun);
  connect();
  syncRemoteClient();
}
