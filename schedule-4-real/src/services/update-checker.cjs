/**
 * Update Checker & Applier Service
 *
 * Checks for updates from remote manifest, downloads per-component archives,
 * verifies SHA256, backs up current files, applies updates, health-checks, and
 * rolls back on failure.
 *
 * Used by: supervisor-agent.cjs (2h interval) and API endpoints
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, exec } = require('child_process');
const https = require('https');
const http = require('http');

// Paths
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const VERSIONS_FILE = path.join(PROJECT_ROOT, 'versions.local.json');
const BACKUP_DIR = path.join(PROJECT_ROOT, '.backup');
const TEMP_DIR = '/tmp/s4r-updates';
const LOCK_FILE = '/tmp/s4r-update.lock';
const PROGRESS_FILE = '/tmp/s4r-update-progress.json';

// Remote manifest URL
const MANIFEST_URL = 'https://schedule4real.com/dist/install/versions.json';

// Component definitions: files/dirs to backup and restore, restart method
const COMPONENT_DEFS = {
  web: {
    label: 'Web App',
    paths: ['.output', 'package.json', 'package-lock.json'],
    restart: 'pm2',
    pm2Name: 's4r-web',
    pm2NameLegacy: 'spiderapp-web',
    postInstall: 'npm install --production 2>&1 | tail -3',
    healthCheck: { type: 'http', port: parseInt(process.env.API_PORT) || 3000, path: '/', timeout: 15000 }
  },
  ingest: {
    label: 'MQTT Ingestion',
    paths: ['src/services/mqtt-ingestion.js'],
    restart: 'pm2',
    pm2Name: 's4r-ingest',
    pm2NameLegacy: 'spiderapp-ingest',
    healthCheck: { type: 'pm2', name: 's4r-ingest', timeout: 10000 }
  },
  retention: {
    label: 'Data Retention',
    paths: ['src/services/data-retention.js'],
    restart: 'pm2',
    pm2Name: 's4r-retention',
    pm2NameLegacy: 'spiderapp-retention',
    healthCheck: { type: 'pm2', name: 's4r-retention', timeout: 10000 }
  },
  supervisor: {
    label: 'Supervisor Agent',
    paths: ['src/services/supervisor-agent.cjs', 'src/services/update-checker.cjs'],
    restart: 'pm2',
    pm2Name: 's4r-supervisor',
    pm2NameLegacy: 'spiderapp-supervisor',
    healthCheck: { type: 'pm2', name: 's4r-supervisor', timeout: 10000 }
  },
  proxy: {
    label: 'MQTT Proxy',
    paths: ['proxy/spiderproxy', 'proxy/spiderproxy-arm64'],
    restart: 'binary',
    binaryName: 'spiderproxy',
    startCmd: `cd ${path.join(PROJECT_ROOT, 'proxy')} && nohup ./spiderproxy > /dev/null 2>&1 &`,
    healthCheck: { type: 'port', port: parseInt(process.env.PROXY_PORT) || 8883, timeout: 10000 }
  },
  mosquitto: {
    label: 'Mosquitto Config',
    paths: ['proxy/mosquitto.conf'],
    restart: 'daemon',
    daemonName: 'mosquitto',
    startCmd: `mosquitto -c ${path.join(PROJECT_ROOT, 'proxy/mosquitto.conf')} -d`,
    healthCheck: { type: 'port', port: parseInt(process.env.MQTT_PORT) || 1883, timeout: 10000 }
  },
  schema: {
    label: 'Database Schema',
    paths: ['src/db'],
    restart: 'migration',
    healthCheck: { type: 'http', port: parseInt(process.env.QUESTDB_HTTP_PORT) || 9000, path: '/exec?query=SELECT%201', timeout: 10000 }
  },
  relay: {
    label: 'Relay Node',
    paths: ['src/services/relay', 'src/services/tunnel-agent.cjs', 'src/services/room-publisher.cjs'],
    restart: 'pm2',
    pm2Name: 's4r-relay',
    pm2NameLegacy: 'spiderapp-relay',
    pm2Extra: ['s4r-tunnel', 's4r-room-publisher'],
    pm2ExtraLegacy: ['spiderapp-tunnel', 'spiderapp-room-publisher'],
    postInstall: 'npm install sodium-native --save 2>/dev/null || true',
    healthCheck: { type: 'pm2', name: 's4r-relay', timeout: 10000 }
  }
};

// Dependency order for applying updates
const APPLY_ORDER = ['schema', 'mosquitto', 'proxy', 'ingest', 'retention', 'relay', 'supervisor', 'web'];

// State
let updateInProgress = false;
let lastError = null;

// --- File-based lock (persists across module instances) ---
// getUpdateChecker() clears require cache per API request, so the in-memory
// updateInProgress flag is unreliable. This file lock prevents concurrent applies.

function isUpdateLocked() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));

    // Check if the locking process is still alive
    if (lock.pid) {
      try {
        process.kill(lock.pid, 0); // Signal 0 = check if process exists
      } catch {
        // Process is dead — lock is orphaned (e.g. supervisor self-updated)
        // Allow 30s grace period in case PM2 is still restarting
        if (Date.now() - lock.startedAt > 30000) {
          console.log(`[Updater] Clearing orphaned lock (PID ${lock.pid} no longer running)`);
          try { fs.unlinkSync(LOCK_FILE); } catch {}
          clearProgress();
          return false;
        }
      }
    }

    // Stale after 2 minutes (safety valve)
    if (Date.now() - lock.startedAt > 120000) {
      console.log('[Updater] Clearing stale lock (2 minute timeout)');
      try { fs.unlinkSync(LOCK_FILE); } catch {}
      clearProgress();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function acquireUpdateLock() {
  if (isUpdateLocked()) return false;
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ startedAt: Date.now(), pid: process.pid }));
    return true;
  } catch {
    return false;
  }
}

function releaseUpdateLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function writeProgress(phase, component, current, total, error) {
  const data = { phase, component: component || null, current: current || 0, total: total || 0, error: error || null, timestamp: Date.now() };
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data)); } catch {}
  return data;
}

function clearProgress() {
  try { fs.unlinkSync(PROGRESS_FILE); } catch {}
}

function getProgress() {
  try {
    if (!fs.existsSync(PROGRESS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    // Stale after 2 minutes
    if (Date.now() - data.timestamp > 120000) {
      clearProgress();
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// --- Development environment detection ---
// CRITICAL: Prevent updates in development environment to avoid
// overwriting source code with obfuscated/compiled versions

function isDevEnvironment() {
  // Check for indicators that ONLY exist in development, not in production installs
  // Note: package.json and node_modules exist in production too (for service deps)
  const devOnlyIndicators = [
    // Git repository = development
    fs.existsSync(path.join(PROJECT_ROOT, '.git')),
    // CLAUDE.md = development documentation (not shipped)
    fs.existsSync(path.join(PROJECT_ROOT, 'CLAUDE.md')),
    // Source Vue/TypeScript files = development (production only has .output/)
    fs.existsSync(path.join(PROJECT_ROOT, 'app', 'pages')),
    // build-release.sh = build script only in dev
    fs.existsSync(path.join(PROJECT_ROOT, 'build-release.sh'))
  ];

  return devOnlyIndicators.some(i => i);
}

// --- File helpers ---

function readVersions() {
  try {
    return JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf-8'));
  } catch {
    return {
      autoUpdate: false,
      lastCheck: null,
      lastUpdate: null,
      schemaVersion: 1,
      components: {},
      updateHistory: []
    };
  }
}

function writeVersions(data) {
  fs.writeFileSync(VERSIONS_FILE, JSON.stringify(data, null, 2) + '\n');
}

// --- HTTP fetch helper ---

function fetchUrl(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    // No timeout — downloads can take as long as needed (660MB+ archives)
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
    });
    req.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

// --- SHA256 verification ---

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

// --- Backup & Restore ---

function backupComponent(component, timestamp) {
  const def = COMPONENT_DEFS[component];
  if (!def) return;

  const backupPath = path.join(BACKUP_DIR, timestamp, component);
  fs.mkdirSync(backupPath, { recursive: true });

  for (const relPath of def.paths) {
    const srcPath = path.join(PROJECT_ROOT, relPath);
    if (!fs.existsSync(srcPath)) continue;

    const destPath = path.join(backupPath, relPath);
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      execSync(`cp -a "${srcPath}" "${destPath}"`);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  console.log(`[Updater] Backed up ${component} to .backup/${timestamp}/${component}/`);
}

function restoreComponent(component, timestamp) {
  const def = COMPONENT_DEFS[component];
  if (!def) return false;

  const backupPath = path.join(BACKUP_DIR, timestamp, component);
  if (!fs.existsSync(backupPath)) {
    console.error(`[Updater] No backup found for ${component} at ${timestamp}`);
    return false;
  }

  for (const relPath of def.paths) {
    const srcPath = path.join(backupPath, relPath);
    const destPath = path.join(PROJECT_ROOT, relPath);
    if (!fs.existsSync(srcPath)) continue;

    // Remove current files
    if (fs.existsSync(destPath)) {
      const stat = fs.statSync(destPath);
      if (stat.isDirectory()) {
        execSync(`rm -rf "${destPath}"`);
      } else {
        fs.unlinkSync(destPath);
      }
    }

    // Restore from backup
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      execSync(`cp -a "${srcPath}" "${destPath}"`);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  console.log(`[Updater] Restored ${component} from .backup/${timestamp}/`);
  return true;
}

// --- Service restart ---

async function restartService(component) {
  const def = COMPONENT_DEFS[component];
  if (!def) return;

  try {
    switch (def.restart) {
      case 'pm2':
        try {
          execSync(`pm2 restart ${def.pm2Name}`, { stdio: 'pipe' });
        } catch {
          // Fallback to legacy name (pre-rebranding installations)
          if (def.pm2NameLegacy) {
            try { execSync(`pm2 restart ${def.pm2NameLegacy}`, { stdio: 'pipe' }); } catch {}
          }
        }
        // Restart extra PM2 services (e.g. relay also restarts tunnel-agent)
        if (def.pm2Extra) {
          for (let i = 0; i < def.pm2Extra.length; i++) {
            try {
              execSync(`pm2 restart ${def.pm2Extra[i]}`, { stdio: 'pipe' });
            } catch {
              if (def.pm2ExtraLegacy?.[i]) {
                try { execSync(`pm2 restart ${def.pm2ExtraLegacy[i]}`, { stdio: 'pipe' }); } catch {}
              }
            }
          }
        }
        break;
      case 'binary':
        try { execSync(`pkill -f ${def.binaryName}`, { stdio: 'pipe' }); } catch {}
        // Wait for port to be released
        await new Promise(r => setTimeout(r, 2000));
        // Start with spawn detached so it doesn't block the event loop
        require('child_process').spawn('bash', ['-c', def.startCmd], {
          detached: true, stdio: 'ignore'
        }).unref();
        break;
      case 'daemon':
        try { execSync(`pkill ${def.daemonName}`, { stdio: 'pipe' }); } catch {}
        // Wait for port to be released
        await new Promise(r => setTimeout(r, 2000));
        require('child_process').spawn('bash', ['-c', def.startCmd], {
          detached: true, stdio: 'ignore'
        }).unref();
        break;
      case 'migration':
        // Schema migrations are run during apply, no restart needed
        break;
    }
    console.log(`[Updater] Restarted ${component}`);
  } catch (err) {
    console.error(`[Updater] Failed to restart ${component}:`, err.message);
  }
}

// --- Health checks ---

function healthCheck(component) {
  const def = COMPONENT_DEFS[component];
  if (!def || !def.healthCheck) return Promise.resolve(true);

  const { type, timeout } = def.healthCheck;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      if (Date.now() - startTime > timeout) {
        console.error(`[Updater] Health check timeout for ${component}`);
        resolve(false);
        return;
      }

      try {
        switch (type) {
          case 'http': {
            const { port, path: urlPath } = def.healthCheck;
            const req = http.get(`http://127.0.0.1:${port}${urlPath || '/'}`, { timeout: 3000 }, (res) => {
              resolve(res.statusCode < 500);
            });
            req.on('error', () => setTimeout(check, 1000));
            req.on('timeout', () => { req.destroy(); setTimeout(check, 1000); });
            break;
          }
          case 'port': {
            const { port } = def.healthCheck;
            const result = execSync(`ss -tln | grep :${port}`, { stdio: 'pipe' }).toString();
            resolve(result.includes(`:${port}`));
            break;
          }
          case 'pm2': {
            const { name } = def.healthCheck;
            const result = execSync(`pm2 jlist`, { stdio: 'pipe' }).toString();
            const processes = JSON.parse(result);
            // Check both new and legacy PM2 names (transition period)
            const proc = processes.find(p => p.name === name || (def.pm2NameLegacy && p.name === def.pm2NameLegacy));
            resolve(proc && proc.pm2_env.status === 'online');
            break;
          }
          default:
            resolve(true);
        }
      } catch {
        setTimeout(check, 1000);
      }
    };

    // Wait a moment for service to start
    setTimeout(check, 2000);
  });
}

// --- Cleanup old backups ---

function cleanOldBackups(keepCount = 3) {
  if (!fs.existsSync(BACKUP_DIR)) return;

  const entries = fs.readdirSync(BACKUP_DIR)
    .filter(e => fs.statSync(path.join(BACKUP_DIR, e)).isDirectory())
    .sort()
    .reverse();

  for (let i = keepCount; i < entries.length; i++) {
    const dirPath = path.join(BACKUP_DIR, entries[i]);
    execSync(`rm -rf "${dirPath}"`);
    console.log(`[Updater] Removed old backup: ${entries[i]}`);
  }
}

// --- Schema migration ---

async function runSchemaMigration(fromVersion, toVersion, migrationData) {
  // First, trigger a database backup
  try {
    console.log('[Updater] Creating database backup before schema migration...');
    const questdbHost = process.env.QUESTDB_HOST || '127.0.0.1';
    const apiPort = process.env.API_PORT || 3000;
    await fetchUrl(`http://127.0.0.1:${apiPort}/api/system/backups`, 30000);
    // POST to create backup
    const postData = JSON.stringify({});
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: apiPort,
        path: '/api/system/backups',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': postData.length }
      }, (res) => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Backup API returned ${res.statusCode}`));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
    console.log('[Updater] Database backup created successfully');
  } catch (err) {
    console.error('[Updater] Database backup failed:', err.message);
    throw new Error('Cannot proceed with schema migration without backup');
  }

  // Run migration scripts in sequence
  const migrationDir = path.join(PROJECT_ROOT, 'src/db/migrations');
  if (!fs.existsSync(migrationDir)) {
    console.log('[Updater] No migrations directory found');
    return;
  }

  for (let v = fromVersion; v < toVersion; v++) {
    const migrationFile = path.join(migrationDir, `${String(v).padStart(3, '0')}_to_${String(v + 1).padStart(3, '0')}.cjs`);
    if (!fs.existsSync(migrationFile)) {
      console.log(`[Updater] Migration file not found: ${migrationFile}`);
      continue;
    }

    const migration = require(migrationFile);
    const pg = require('pg');
    const pool = new pg.Pool({
      host: process.env.QUESTDB_HOST || '127.0.0.1',
      port: parseInt(process.env.QUESTDB_PG_PORT) || 8812,
      user: process.env.QUESTDB_USER || 'spider',
      password: process.env.QUESTDB_PASSWORD || 'spider123',
      database: process.env.QUESTDB_DATABASE || 'qdb'
    });

    const queryFn = async (sql) => {
      const result = await pool.query(sql);
      return result.rows || [];
    };

    try {
      await migration.up(queryFn);
      console.log(`[Updater] Migration ${v} → ${v + 1} applied`);

      if (migration.verify) {
        const ok = await migration.verify(queryFn);
        if (!ok) throw new Error(`Migration ${v} → ${v + 1} verification failed`);
      }
    } finally {
      await pool.end();
    }
  }
}

// --- Main: Check for updates ---

async function checkForUpdates(options = {}) {
  const { autoApply = false, onProgress = null } = typeof options === 'object' ? options : {};

  if (updateInProgress || isUpdateLocked()) {
    console.log('[Updater] Update already in progress, skipping check');
    return { pending: [], inProgress: true };
  }

  // Check if in dev environment and add warning
  const isDev = isDevEnvironment();
  if (isDev) {
    console.warn('[Updater] WARNING: Running in development environment - updates will be BLOCKED');
  }

  console.log('[Updater] Checking for updates...');
  const versions = readVersions();

  try {
    const manifestBuffer = await fetchUrl(MANIFEST_URL);
    const manifest = JSON.parse(manifestBuffer.toString());

    if (manifest.manifestVersion !== 1) {
      console.error('[Updater] Unsupported manifest version:', manifest.manifestVersion);
      return { pending: [], error: 'Unsupported manifest version' };
    }

    const pending = [];
    const manifestChangelogs = {}; // Store full changelog from manifest for Version Info display

    for (const [component, remote] of Object.entries(manifest.components || {})) {
      const localVersion = versions.components[component]?.version || '0.0.0';

      // Store full manifest changelog for this component (for Version Info display)
      const rawChangelog = remote.changelog || [];
      if (rawChangelog.length > 0 && typeof rawChangelog[0] === 'object') {
        // New versioned format: [{version, changes}, ...]
        // Store entries up to and including the installed version
        manifestChangelogs[component] = rawChangelog
          .filter(entry => compareVersions(entry.version, localVersion) <= 0)
          .slice(0, 50) // Keep up to 50 versions of history
          .map(entry => ({ version: entry.version, changes: entry.changes || [] }));
      }

      if (compareVersions(remote.version, localVersion) > 0) {
        // Build changelog for pending: filter entries with version > installed
        let changelog = [];
        if (rawChangelog.length > 0 && typeof rawChangelog[0] === 'object') {
          // New versioned format: [{version, changes}, ...]
          changelog = rawChangelog
            .filter(entry => compareVersions(entry.version, localVersion) > 0)
            .map(entry => ({ version: entry.version, changes: entry.changes || [] }));
        } else if (rawChangelog.length > 0 && typeof rawChangelog[0] === 'string') {
          // Old flat format: ["msg1", "msg2"]
          changelog = [{ version: remote.version, changes: rawChangelog }];
        }

        pending.push({
          component,
          from: localVersion,
          to: remote.version,
          changelog,
          size: remote.size || 0,
          requires: remote.requires || {}
        });
      }
    }

    // Update lastCheck and store manifest changelogs
    versions.lastCheck = new Date().toISOString();
    versions.pending = pending;
    versions.manifestChangelogs = manifestChangelogs;
    writeVersions(versions);

    console.log(`[Updater] Found ${pending.length} pending update(s)`);

    // Auto-apply only when explicitly requested (supervisor path).
    // API check endpoint does NOT auto-apply to prevent race conditions
    // with manual "Update Now" button.
    if (autoApply && versions.autoUpdate && pending.length > 0 && !isDev) {
      console.log('[Updater] Auto-update enabled, applying updates...');
      await applyUpdates(pending.map(p => p.component), onProgress);
    } else if (autoApply && versions.autoUpdate && pending.length > 0 && isDev) {
      console.warn('[Updater] Auto-update SKIPPED: development environment detected');
    }

    return { pending, inProgress: false, isDev };
  } catch (err) {
    console.error('[Updater] Check failed:', err.message);
    lastError = err.message;
    versions.lastCheck = new Date().toISOString();
    writeVersions(versions);
    return { pending: [], error: err.message };
  }
}

// --- Main: Apply updates ---

async function applyUpdates(components = [], onProgress = null) {
  // CRITICAL SAFETY CHECK: Block updates in development environment
  // This prevents accidentally overwriting source code with obfuscated versions
  if (isDevEnvironment()) {
    console.error('[Updater] BLOCKED: Cannot apply updates in development environment!');
    console.error('[Updater] This would overwrite source code with compiled/obfuscated versions.');
    console.error('[Updater] To update, deploy to a production environment first.');
    return {
      success: false,
      error: 'Updates blocked in development environment to protect source code',
      isDev: true
    };
  }

  // Use file-based lock (works across module instances)
  if (isUpdateLocked()) {
    return { success: false, error: 'Update already in progress' };
  }

  if (!acquireUpdateLock()) {
    return { success: false, error: 'Update already in progress' };
  }

  updateInProgress = true;
  lastError = null;

  // Helper to broadcast progress via callback AND write to file
  function emitProgress(phase, component, current, total, error) {
    const data = writeProgress(phase, component, current, total, error);
    try { onProgress?.(data); } catch {}
  }
  const versions = readVersions();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const results = [];

  try {
    // Fetch current manifest
    const manifestBuffer = await fetchUrl(MANIFEST_URL);
    const manifest = JSON.parse(manifestBuffer.toString());

    // Filter and sort by dependency order
    const toUpdate = APPLY_ORDER.filter(c => {
      if (components.length > 0 && !components.includes(c)) return false;
      const remote = manifest.components[c];
      if (!remote) return false;
      const localVersion = versions.components[c]?.version || '0.0.0';
      return compareVersions(remote.version, localVersion) > 0;
    });

    if (toUpdate.length === 0) {
      updateInProgress = false;
      releaseUpdateLock();
      clearProgress();
      return { success: true, message: 'No updates to apply' };
    }

    // Ensure Node.js version matches manifest requirement
    if (manifest.requiredNodeMajor) {
      const currentMajor = parseInt(process.versions.node.split('.')[0]);
      const requiredMajor = parseInt(manifest.requiredNodeMajor);
      if (currentMajor < requiredMajor) {
        console.log(`[Updater] Node.js upgrade needed: v${currentMajor} → v${requiredMajor}`);
        try {
          // Install via nodesource (same method as installer)
          execSync(`curl -fsSL https://deb.nodesource.com/setup_${requiredMajor}.x | bash -`, { stdio: 'pipe', timeout: 60000 });
          execSync(`apt-get install -y nodejs`, { stdio: 'pipe', timeout: 120000 });
          const newVersion = execSync('node -v', { encoding: 'utf-8' }).trim();
          console.log(`[Updater] Node.js upgraded to ${newVersion}`);
        } catch (nodeErr) {
          console.warn(`[Updater] Node.js upgrade failed: ${nodeErr.message}`);
          console.warn('[Updater] Continuing with current Node.js version...');
        }
      }
    }

    // Check schema dependency
    for (const component of toUpdate) {
      const remote = manifest.components[component];
      if (remote.requires?.schema) {
        const requiredSchema = remote.requires.schema;
        const currentSchema = parseInt(versions.schemaVersion) || 0;
        if (currentSchema < requiredSchema && !toUpdate.includes('schema')) {
          updateInProgress = false;
          return { success: false, error: `${component} requires schema version ${requiredSchema}, current is ${currentSchema}` };
        }
      }
    }

    // Save a copy of versions before update for rollback
    const versionsBackupPath = path.join(BACKUP_DIR, timestamp);
    fs.mkdirSync(versionsBackupPath, { recursive: true });
    fs.copyFileSync(VERSIONS_FILE, path.join(versionsBackupPath, 'versions.local.json'));

    // Clean + create temp dir (removes partial downloads from previous failed attempts)
    try { execSync(`rm -rf "${TEMP_DIR}"`); } catch {}
    fs.mkdirSync(TEMP_DIR, { recursive: true });

    console.log(`[Updater] Applying ${toUpdate.length} update(s): ${toUpdate.join(', ')}`);

    let updateIdx = 0;
    for (const component of toUpdate) {
      updateIdx++;
      const remote = manifest.components[component];
      console.log(`[Updater] Updating ${component}: ${versions.components[component]?.version || '?'} → ${remote.version}`);

      try {
        // 1. Download archive
        const archiveUrl = remote.archive.startsWith('http')
          ? remote.archive
          : `https://schedule4real.com/dist/install/${remote.archive}`;
        const archivePath = path.join(TEMP_DIR, remote.archive);

        emitProgress('downloading', component, updateIdx, toUpdate.length);
        console.log(`[Updater] Downloading ${remote.archive}...`);
        await downloadFile(archiveUrl, archivePath);

        // 2. Verify SHA256
        const hash = sha256File(archivePath);
        if (hash !== remote.sha256) {
          throw new Error(`SHA256 mismatch: expected ${remote.sha256}, got ${hash}`);
        }
        console.log(`[Updater] SHA256 verified for ${component}`);

        // 3. Backup current files
        backupComponent(component, timestamp);

        // 4. Extract to temp location
        const extractDir = path.join(TEMP_DIR, component);
        fs.mkdirSync(extractDir, { recursive: true });
        execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`);

        emitProgress('installing', component, updateIdx, toUpdate.length);

        // 5. Schema migration (if applicable)
        if (component === 'schema' && remote.migrations) {
          const fromSchema = parseInt(versions.schemaVersion) || 0;
          const toSchema = parseInt(remote.version);
          if (toSchema > fromSchema) {
            await runSchemaMigration(fromSchema, toSchema, remote.migrations);
            versions.schemaVersion = toSchema;
          }
        }

        // 6. Apply: copy new files into place
        const def = COMPONENT_DEFS[component];
        for (const relPath of def.paths) {
          const srcPath = path.join(extractDir, relPath);
          const destPath = path.join(PROJECT_ROOT, relPath);

          if (!fs.existsSync(srcPath)) continue;

          // Remove current
          if (fs.existsSync(destPath)) {
            const stat = fs.statSync(destPath);
            if (stat.isDirectory()) {
              execSync(`rm -rf "${destPath}"`);
            } else {
              fs.unlinkSync(destPath);
            }
          }

          // Copy new
          const destDir = path.dirname(destPath);
          fs.mkdirSync(destDir, { recursive: true });
          const stat = fs.statSync(srcPath);
          if (stat.isDirectory()) {
            execSync(`cp -a "${srcPath}" "${destPath}"`);
          } else {
            fs.copyFileSync(srcPath, destPath);
            // Preserve execute permissions for binaries
            if (component === 'proxy') {
              fs.chmodSync(destPath, 0o755);
            }
          }
        }

        // 6b. Select correct proxy binary for current architecture
        if (component === 'proxy') {
          const arch = require('os').arch(); // 'x64', 'arm64', etc.
          const proxyDir = path.join(PROJECT_ROOT, 'proxy');
          const mainBin = path.join(proxyDir, 'spiderproxy');
          const arm64Bin = path.join(proxyDir, 'spiderproxy-arm64');

          if (arch === 'arm64' && fs.existsSync(arm64Bin)) {
            if (fs.existsSync(mainBin)) fs.unlinkSync(mainBin);
            fs.renameSync(arm64Bin, mainBin);
            fs.chmodSync(mainBin, 0o755);
            console.log('[Updater] Selected ARM64 proxy binary');
          } else if (fs.existsSync(arm64Bin)) {
            fs.unlinkSync(arm64Bin);
          }
        }

        // 6c. Run postInstall command if defined (e.g. npm install sodium-native for relay)
        if (def.postInstall) {
          try {
            console.log(`[Updater] Running postInstall for ${component}: ${def.postInstall}`);
            execSync(def.postInstall, { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 });
          } catch (postErr) {
            console.warn(`[Updater] postInstall for ${component} failed: ${postErr.message}`);
          }
        }

        // 6d. Ensure system dependencies for camera features (ffmpeg, imagemagick)
        if (component === 'web') {
          try {
            execSync('command -v ffmpeg', { stdio: 'pipe' });
          } catch {
            console.log('[Updater] Installing ffmpeg (needed for timelapse videos)...');
            try { execSync('apt-get install -y ffmpeg', { stdio: 'pipe', timeout: 120000 }); } catch {}
          }
          try {
            execSync('command -v convert', { stdio: 'pipe' });
          } catch {
            console.log('[Updater] Installing ImageMagick (needed for photo overlays)...');
            try { execSync('apt-get install -y imagemagick', { stdio: 'pipe', timeout: 120000 }); } catch {}
          }
        }

        // 7. Restart service (skip web - it restarts itself last after saving state)
        if (component === 'supervisor') {
          // SPECIAL CASE: Supervisor self-update
          // pm2 restart kills this very process, so health check, version save,
          // and cleanup would never execute. Save everything BEFORE restarting.
          if (!versions.components[component]) versions.components[component] = {};
          versions.components[component].version = remote.version;
          versions.components[component].installedAt = new Date().toISOString();
          writeVersions(versions);

          console.log(`[Updater] Successfully updated supervisor to ${remote.version}`);

          // Clean up before restart
          releaseUpdateLock();
          clearProgress();
          try { execSync(`rm -rf "${TEMP_DIR}"`); } catch {}
          cleanOldBackups(3);

          console.log('[Updater] Restarting supervisor — remaining updates will apply on next check');
          results.push({ component, success: true, version: remote.version });
          try {
            execSync(`pm2 restart ${COMPONENT_DEFS.supervisor.pm2Name}`, { stdio: 'pipe' });
          } catch {
            try { execSync(`pm2 restart ${COMPONENT_DEFS.supervisor.pm2NameLegacy}`, { stdio: 'pipe' }); } catch {}
          }
          // If we somehow survive the restart, return
          return { success: true, results };
        } else if (component !== 'web') {
          await restartService(component);

          // 8. Health check
          const healthy = await healthCheck(component);
          if (!healthy) {
            console.error(`[Updater] Health check failed for ${component}, rolling back...`);
            restoreComponent(component, timestamp);
            await restartService(component);
            throw new Error(`Health check failed for ${component}`);
          }
        }

        // 9. Update version in memory
        if (!versions.components[component]) versions.components[component] = {};
        versions.components[component].version = remote.version;
        versions.components[component].installedAt = new Date().toISOString();

        results.push({ component, success: true, version: remote.version });
        console.log(`[Updater] Successfully updated ${component} to ${remote.version}`);

        // Save progress incrementally (in case process dies on later steps)
        writeVersions(versions);

      } catch (err) {
        console.error(`[Updater] Failed to update ${component}:`, err.message);
        results.push({ component, success: false, error: err.message });
        lastError = `${component}: ${err.message}`;
        emitProgress('error', component, updateIdx, toUpdate.length, err.message);
        // Stop processing remaining components
        break;
      }
    }

    // Collect changelogs from successfully updated components
    const historyChangelog = [];
    for (const r of results) {
      if (r.success) {
        const rawChangelog = manifest.components[r.component]?.changelog || [];
        let messages = [];
        if (rawChangelog.length > 0 && typeof rawChangelog[0] === 'object') {
          // New versioned format - flatten all changes
          for (const entry of rawChangelog) {
            for (const change of (entry.changes || [])) {
              messages.push(change);
            }
          }
        } else if (rawChangelog.length > 0 && typeof rawChangelog[0] === 'string') {
          // Old flat format
          messages = rawChangelog;
        }
        if (messages.length > 0) {
          for (const msg of messages) {
            historyChangelog.push({ component: r.component, message: msg });
          }
        } else {
          historyChangelog.push({ component: r.component, message: `Updated to v${r.version}` });
        }
      }
    }

    // Write final state (history, cleanup pending)
    versions.lastUpdate = new Date().toISOString();
    delete versions.pending;
    versions.updateHistory = versions.updateHistory || [];
    versions.updateHistory.unshift({
      timestamp,
      results,
      changelog: historyChangelog,
      date: new Date().toISOString()
    });
    // Keep only last 10 history entries
    if (versions.updateHistory.length > 10) {
      versions.updateHistory = versions.updateHistory.slice(0, 10);
    }
    writeVersions(versions);

    // Clean temp files
    try { execSync(`rm -rf "${TEMP_DIR}"`); } catch {}

    // Clean old backups
    cleanOldBackups(3);

    const allSuccess = results.every(r => r.success);

    // Sync appdata immediately after any update (new assets may have been published)
    // MUST await before web restart — pm2 restart kills the process
    try {
      await syncAppData();
    } catch (err) {
      console.error('[Updater] Post-update appdata sync error:', err.message);
    }

    // Run post-update migrations (enable tunnel + relay for existing installs)
    runPostUpdateMigrations();

    // Persist PM2 process list so new/restarted services survive reboot
    try { execSync('pm2 save', { stdio: 'pipe', timeout: 10000 }); } catch {}

    // If web was updated, restart it LAST (this kills the current process)
    if (results.some(r => r.component === 'web' && r.success)) {
      console.log('[Updater] All state saved. Restarting web server...');
      emitProgress('restarting', 'web', toUpdate.length, toUpdate.length);
      updateInProgress = false;
      releaseUpdateLock();
      // Note: clearProgress() intentionally NOT called here — the new process
      // will start clean, and clients use the WS disconnect to detect restart.
      // Also restart camera service (shares src/services/ with web package)
      try { execSync('pm2 restart s4r-cameras', { stdio: 'pipe' }); } catch {
        try { execSync('pm2 restart spiderapp-cameras', { stdio: 'pipe' }); } catch {}
      }
      try { execSync(`pm2 restart ${COMPONENT_DEFS.web.pm2Name}`, { stdio: 'pipe' }); } catch {
        try { execSync(`pm2 restart ${COMPONENT_DEFS.web.pm2NameLegacy}`, { stdio: 'pipe' }); } catch {}
      }
      // PM2 restart is async — execSync returns before the process actually dies.
      // Do NOT emit 'done' here. The client detects the restart via WS disconnect
      // and reloads when it reconnects and sees the new version.
      return { success: allSuccess, results };
    }

    // Non-web update: broadcast 'done' and clean up
    emitProgress('done', null, toUpdate.length, toUpdate.length);
    releaseUpdateLock();
    clearProgress();

    return { success: allSuccess, results };

  } catch (err) {
    console.error('[Updater] Update process error:', err.message);
    lastError = err.message;
    emitProgress('error', null, 0, 0, err.message);
    releaseUpdateLock();
    clearProgress();
    // Clean up temp files on failure too
    try { execSync(`rm -rf "${TEMP_DIR}"`); } catch {}
    return { success: false, error: err.message, results };
  } finally {
    updateInProgress = false;
  }
}

// --- Rollback ---

async function rollback(timestamp) {
  if (updateInProgress) {
    return { success: false, error: 'Update in progress' };
  }

  updateInProgress = true;

  try {
    const backupPath = path.join(BACKUP_DIR, timestamp);
    if (!fs.existsSync(backupPath)) {
      return { success: false, error: `Backup not found: ${timestamp}` };
    }

    // Read the saved versions from that backup
    const savedVersionsPath = path.join(backupPath, 'versions.local.json');
    if (!fs.existsSync(savedVersionsPath)) {
      return { success: false, error: 'No versions.local.json in backup' };
    }

    const savedVersions = JSON.parse(fs.readFileSync(savedVersionsPath, 'utf-8'));

    // Find which components were in this backup
    const components = fs.readdirSync(backupPath)
      .filter(e => e !== 'versions.local.json' && fs.statSync(path.join(backupPath, e)).isDirectory());

    // Restore in reverse order
    const reverseOrder = [...APPLY_ORDER].reverse();
    const toRestore = reverseOrder.filter(c => components.includes(c));

    for (const component of toRestore) {
      console.log(`[Updater] Rolling back ${component}...`);
      restoreComponent(component, timestamp);
      await restartService(component);

      const healthy = await healthCheck(component);
      if (!healthy) {
        console.error(`[Updater] Health check failed after rollback of ${component}`);
      }
    }

    // Restore versions file
    fs.copyFileSync(savedVersionsPath, VERSIONS_FILE);

    console.log(`[Updater] Rollback to ${timestamp} complete`);
    return { success: true, components: toRestore };

  } catch (err) {
    console.error('[Updater] Rollback error:', err.message);
    return { success: false, error: err.message };
  } finally {
    updateInProgress = false;
  }
}

// --- Toggle auto-update ---

function toggleAutoUpdate() {
  const versions = readVersions();
  versions.autoUpdate = !versions.autoUpdate;
  writeVersions(versions);
  console.log(`[Updater] Auto-update ${versions.autoUpdate ? 'enabled' : 'disabled'}`);
  return versions.autoUpdate;
}

// --- Get status ---

function getStatus() {
  const versions = readVersions();
  return {
    autoUpdate: versions.autoUpdate,
    lastCheck: versions.lastCheck,
    lastUpdate: versions.lastUpdate,
    schemaVersion: versions.schemaVersion,
    installed: versions.components,
    pending: versions.pending || [],
    history: versions.updateHistory || [],
    inProgress: updateInProgress,
    lastError
  };
}

// --- Get available backups for rollback ---

function getBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];

  return fs.readdirSync(BACKUP_DIR)
    .filter(e => fs.statSync(path.join(BACKUP_DIR, e)).isDirectory())
    .sort()
    .reverse()
    .map(timestamp => {
      const dir = path.join(BACKUP_DIR, timestamp);
      const components = fs.readdirSync(dir)
        .filter(e => e !== 'versions.local.json' && fs.statSync(path.join(dir, e)).isDirectory());
      return { timestamp, components };
    });
}

// --- Version comparison (semver-like) ---

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

// --- Appdata Sync ---
// Downloads/updates static assets (models, images, sound, fonts, defaults)
// from the public HTTPS server. Runs alongside version checks.

const APPDATA_INDEX_URL = 'https://schedule4real.com/dist/install/appdata/appdata-index.json';
const APPDATA_BASE_URL = 'https://schedule4real.com/dist/install/appdata';
const APPDATA_DIR = path.join(PROJECT_ROOT, 'data', 'appdata');
const APPDATA_LOCAL_INDEX = path.join(APPDATA_DIR, 'appdata-index.json');

function md5File(filePath) {
  const hash = crypto.createHash('md5');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function syncAppData() {
  // CRITICAL: Never download cloud assets to development machines.
  // Dev machines only UPLOAD to FTP via build-release.sh — never download.
  if (isDevEnvironment()) {
    return { success: true, skipped: true };
  }
  if (process.env.APPDATA_SYNC_ENABLED === 'false') {
    console.log('[AppData] Sync disabled via APPDATA_SYNC_ENABLED=false');
    return { success: true, skipped: true };
  }

  console.log('[AppData] Checking for asset updates...');

  // 1. Download remote index
  let remoteIndex;
  try {
    const buf = await fetchUrl(APPDATA_INDEX_URL, 15000);
    remoteIndex = JSON.parse(buf.toString());
  } catch (err) {
    console.error('[AppData] Could not fetch remote index:', err.message);
    return { success: false, error: err.message };
  }

  const remoteFiles = remoteIndex.files || {};
  const remoteCount = Object.keys(remoteFiles).length;
  if (remoteCount === 0) {
    console.log('[AppData] Remote index is empty, skipping');
    return { success: true, downloaded: 0, deleted: 0 };
  }

  // 2. Build local index by reading existing files
  fs.mkdirSync(APPDATA_DIR, { recursive: true });
  const localFiles = {};

  // Read existing local index if available (faster than re-hashing everything)
  let localIndex = {};
  try {
    if (fs.existsSync(APPDATA_LOCAL_INDEX)) {
      localIndex = JSON.parse(fs.readFileSync(APPDATA_LOCAL_INDEX, 'utf-8'));
    }
  } catch {}
  const cachedFiles = localIndex.files || {};

  // Verify cached entries still exist and haven't changed size
  for (const [relPath, info] of Object.entries(cachedFiles)) {
    const fullPath = path.join(APPDATA_DIR, relPath);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && stat.size === info.size) {
        localFiles[relPath] = info;
      }
    } catch {}
  }

  // 3. Determine what to download and delete
  const toDownload = [];
  const toDelete = [];

  for (const [relPath, info] of Object.entries(remoteFiles)) {
    if (!localFiles[relPath] || localFiles[relPath].hash !== info.hash) {
      toDownload.push(relPath);
    }
  }

  for (const relPath of Object.keys(localFiles)) {
    if (!remoteFiles[relPath]) {
      toDelete.push(relPath);
    }
  }

  if (toDownload.length === 0 && toDelete.length === 0) {
    console.log(`[AppData] All ${remoteCount} assets up to date`);
    return { success: true, downloaded: 0, deleted: 0 };
  }

  console.log(`[AppData] ${toDownload.length} to download, ${toDelete.length} to delete`);

  // 4. Download new/changed files
  let downloaded = 0;
  let failed = 0;

  for (const relPath of toDownload) {
    const destPath = path.join(APPDATA_DIR, relPath);
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    // URL-encode path segments (spaces, special chars)
    const encodedPath = relPath.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `${APPDATA_BASE_URL}/${encodedPath}`;

    try {
      await downloadFile(url, destPath);
      downloaded++;
      if (downloaded % 10 === 0) {
        console.log(`[AppData] Downloaded ${downloaded}/${toDownload.length}`);
      }
    } catch (err) {
      console.error(`[AppData] Failed to download ${relPath}: ${err.message}`);
      try { fs.unlinkSync(destPath); } catch {}
      failed++;
    }
  }

  // 5. Delete removed files
  let deleted = 0;
  for (const relPath of toDelete) {
    const fullPath = path.join(APPDATA_DIR, relPath);
    try {
      fs.unlinkSync(fullPath);
      deleted++;
    } catch {}
  }

  // 6. Save remote index locally (becomes the new local cache)
  try {
    fs.writeFileSync(APPDATA_LOCAL_INDEX, JSON.stringify(remoteIndex, null, 2));
  } catch (err) {
    console.error('[AppData] Failed to save local index:', err.message);
  }

  console.log(`[AppData] Sync complete: ${downloaded} downloaded, ${deleted} deleted, ${failed} failed`);
  return { success: failed === 0, downloaded, deleted, failed };
}

// --- Post-update migrations ---
// These run ONCE after successful updates to enable new features on existing installs.

function runPostUpdateMigrations() {
  try {
    const envFile = path.join(PROJECT_ROOT, '.env');
    const relayConfigDir = path.join(PROJECT_ROOT, 'data', 'relay');
    const relayConfigFile = path.join(relayConfigDir, 'relay-config.json');

    // ═══════════════════════════════════════════════════════════════════
    // REBRANDING MIGRATION: spiderfarmer-dream → schedule-4-real
    // Renames PM2 processes, Docker container, nginx site, folder
    // ═══════════════════════════════════════════════════════════════════
    const rebrandingFlag = path.join(PROJECT_ROOT, 'data', '.rebranding-done');
    if (!fs.existsSync(rebrandingFlag)) {
      console.log('[Updater] Migration: Running rebranding (spiderfarmer → s4r)...');
      try {
        // 1. Delete all old PM2 processes (they'll be recreated with new names)
        const oldPm2Names = [
          'spiderapp-web', 'spiderapp-ingest', 'spiderapp-retention',
          'spiderapp-supervisor', 'spiderapp-mosquitto', 'spiderapp-proxy',
          'spiderapp-cameras', 'spiderapp-relay', 'spiderapp-tunnel',
          'spiderapp-room-publisher'
        ];
        for (const name of oldPm2Names) {
          try { execSync(`pm2 delete ${name}`, { stdio: 'pipe', timeout: 5000 }); } catch {}
        }
        console.log('[Updater] Migration: Deleted old PM2 processes');

        // 2. Rename Docker container
        try {
          execSync('docker rename spiderapp-questdb s4r-questdb', { stdio: 'pipe', timeout: 10000 });
          console.log('[Updater] Migration: Renamed Docker container to s4r-questdb');
        } catch {
          // Already renamed or doesn't exist
        }

        // 3. Rename nginx site config
        try {
          if (fs.existsSync('/etc/nginx/sites-available/spiderfarmer')) {
            execSync('mv /etc/nginx/sites-available/spiderfarmer /etc/nginx/sites-available/schedule4real', { stdio: 'pipe' });
            try { execSync('rm -f /etc/nginx/sites-enabled/spiderfarmer', { stdio: 'pipe' }); } catch {}
            execSync('ln -sf /etc/nginx/sites-available/schedule4real /etc/nginx/sites-enabled/', { stdio: 'pipe' });
            try { execSync('nginx -t && systemctl reload nginx', { stdio: 'pipe', timeout: 10000 }); } catch {}
            console.log('[Updater] Migration: Renamed nginx site to schedule4real');
          }
        } catch {}

        // 4. Rename installation folder (Linux inodes allow this while running)
        const currentDir = PROJECT_ROOT;
        const parentDir = path.dirname(currentDir);
        const currentName = path.basename(currentDir);
        if (currentName === 'spiderfarmer-dream') {
          const newDir = path.join(parentDir, 'schedule-4-real');
          try {
            fs.renameSync(currentDir, newDir);
            console.log('[Updater] Migration: Renamed folder to schedule-4-real');
            // Run pm2-start.sh from new path to create all processes with new names
            execSync(`bash ${path.join(newDir, 'pm2-start.sh')}`, {
              cwd: newDir, stdio: 'pipe', timeout: 60000
            });
            console.log('[Updater] Migration: Started all services from new path');
          } catch (renameErr) {
            console.warn('[Updater] Migration: Folder rename failed:', renameErr.message);
            // Fallback: just run pm2-start.sh from current path
            try {
              execSync(`bash ${path.join(currentDir, 'pm2-start.sh')}`, {
                cwd: currentDir, stdio: 'pipe', timeout: 60000
              });
            } catch {}
          }
        } else {
          // Already renamed or fresh install — just ensure pm2-start.sh creates new names
          try {
            execSync(`bash ${path.join(currentDir, 'pm2-start.sh')}`, {
              cwd: currentDir, stdio: 'pipe', timeout: 60000
            });
          } catch {}
        }

        // 5. Save PM2 state
        try { execSync('pm2 save', { stdio: 'pipe', timeout: 10000 }); } catch {}

        // 6. Write flag (use PROJECT_ROOT which may still resolve via inode)
        try {
          const flagDir = path.join(PROJECT_ROOT, 'data');
          fs.mkdirSync(flagDir, { recursive: true });
          fs.writeFileSync(rebrandingFlag, JSON.stringify({ date: new Date().toISOString() }));
        } catch {
          // If PROJECT_ROOT moved, try the new path
          try {
            const newFlagPath = path.join(path.dirname(PROJECT_ROOT), 'schedule-4-real', 'data', '.rebranding-done');
            fs.writeFileSync(newFlagPath, JSON.stringify({ date: new Date().toISOString() }));
          } catch {}
        }
        console.log('[Updater] Migration: Rebranding complete');
      } catch (err) {
        console.error('[Updater] Migration: Rebranding error:', err.message);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Migration: Enable tunnel + relay for existing installations
    // New installs get these defaults from install.sh; this handles upgrades.
    // ═══════════════════════════════════════════════════════════════════

    // 1. Enable TUNNEL_ENABLED in .env if not already set
    if (fs.existsSync(envFile)) {
      const envContent = fs.readFileSync(envFile, 'utf-8');
      if (!/^TUNNEL_ENABLED=/m.test(envContent)) {
        fs.appendFileSync(envFile, '\nTUNNEL_ENABLED=true\n');
        console.log('[Updater] Migration: Enabled TUNNEL_ENABLED in .env');
      }
    }

    // 2. Create relay-config.json with enabled=true if it doesn't exist
    if (!fs.existsSync(relayConfigFile)) {
      fs.mkdirSync(relayConfigDir, { recursive: true });
      const relayDefaults = {
        enabled: true,
        trackerEnabled: false,
        port: 9443,
        publicUrl: '',
        keyRotationIntervalMs: 3600000,
        sessionTtlMs: 300000,
        packetSize: 512,
        chaffIntervalMs: 100,
        maxCircuits: 10000,
        maxJitterMs: 3,
        roomTtlMs: 120000,
        roomHeartbeatIntervalMs: 60000,
        maxRooms: 50000,
      };
      fs.writeFileSync(relayConfigFile, JSON.stringify(relayDefaults, null, 2));
      console.log('[Updater] Migration: Created relay-config.json with relay enabled');
    } else {
      // If config exists but relay is disabled, enable it
      try {
        const cfg = JSON.parse(fs.readFileSync(relayConfigFile, 'utf-8'));
        if (cfg.enabled === false) {
          cfg.enabled = true;
          fs.writeFileSync(relayConfigFile, JSON.stringify(cfg, null, 2));
          console.log('[Updater] Migration: Enabled relay in existing relay-config.json');
        }
      } catch {}
    }

    // 3. Start relay PM2 process if config says enabled and it's not running
    try {
      const cfg = JSON.parse(fs.readFileSync(relayConfigFile, 'utf-8'));
      if (cfg.enabled) {
        const pm2List = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000 });
        const procs = JSON.parse(pm2List);
        const relayProc = procs.find(p => p.name === 's4r-relay' || p.name === 'spiderapp-relay');
        if (!relayProc) {
          execSync(
            `pm2 start src/services/relay/index.cjs --name s4r-relay --max-memory-restart 256M`,
            { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 10000 }
          );
          console.log('[Updater] Migration: Started s4r-relay PM2 process');
        } else if (relayProc.pm2_env?.status === 'stopped') {
          execSync(`pm2 restart ${relayProc.name}`, { stdio: 'pipe', timeout: 10000 });
          console.log(`[Updater] Migration: Restarted stopped ${relayProc.name}`);
        }
      }
    } catch (err) {
      console.warn('[Updater] Migration: Could not start relay:', err.message);
    }

    // 4. Start tunnel agent if TUNNEL_ENABLED and not running
    try {
      const envContent = fs.readFileSync(envFile, 'utf-8');
      if (/^TUNNEL_ENABLED=true$/m.test(envContent)) {
        const pm2List = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000 });
        const procs = JSON.parse(pm2List);
        const tunnelProc = procs.find(p => p.name === 's4r-tunnel' || p.name === 'spiderapp-tunnel');
        if (!tunnelProc) {
          execSync(
            `pm2 start src/services/tunnel-agent.cjs --name s4r-tunnel --max-memory-restart 128M --restart-delay 5000`,
            { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 10000 }
          );
          console.log('[Updater] Migration: Started s4r-tunnel PM2 process');
        }
      }
    } catch (err) {
      console.warn('[Updater] Migration: Could not start tunnel:', err.message);
    }

    // 5. Start room-publisher if TUNNEL_ENABLED and not running
    try {
      const envContent2 = fs.readFileSync(envFile, 'utf-8');
      if (/^TUNNEL_ENABLED=true$/m.test(envContent2)) {
        const pm2List = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000 });
        const procs = JSON.parse(pm2List);
        const pubProc = procs.find(p => p.name === 's4r-room-publisher' || p.name === 'spiderapp-room-publisher');
        if (!pubProc) {
          execSync(
            `pm2 start src/services/room-publisher.cjs --name s4r-room-publisher`,
            { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 10000 }
          );
          console.log('[Updater] Migration: Started s4r-room-publisher PM2 process');
        }
      }
    } catch (err) {
      console.warn('[Updater] Migration: Could not start room-publisher:', err.message);
    }

  } catch (err) {
    console.warn('[Updater] Post-update migration error:', err.message);
  }
}

// --- Exports ---

module.exports = {
  checkForUpdates,
  applyUpdates,
  rollback,
  toggleAutoUpdate,
  getStatus,
  getBackups,
  isUpdateLocked,
  getProgress,
  syncAppData,
  COMPONENT_DEFS
};
