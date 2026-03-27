/**
 * Camera Service
 * Independent service that manages go2rtc for IP camera streaming
 * and handles scheduled photo captures for timelapses.
 *
 * Responsibilities:
 * - Downloads go2rtc binary if missing (auto-detect arch)
 * - Spawns go2rtc as child process with generated config
 * - Health checks go2rtc every 30s
 * - Scheduled timelapse captures (saves to /data/webcam/{grow-id}/)
 * - Exposes HTTP API on port 1985 for reload/status commands from Nuxt
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const { Pool } = require('pg');

// ─── Configuration ───

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const BIN_PATH = path.join(BIN_DIR, 'go2rtc');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'go2rtc.yaml');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'webcam');
const SERVICE_PORT = 1985; // Internal API for Nuxt to call reload/status
const GO2RTC_API = 'http://127.0.0.1:1984/api';
const HEALTH_INTERVAL = 30000;
const CAPTURE_CHECK_INTERVAL = 60000; // Check for scheduled captures every 60s

// Load .env
try {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  }
} catch { /* ignore */ }

// ─── Database ───

const pool = new Pool({
  host: process.env.QUESTDB_HOST || '127.0.0.1',
  port: parseInt(process.env.QUESTDB_PG_PORT) || 8812,
  user: process.env.QUESTDB_USER || 'spider',
  password: process.env.QUESTDB_PASSWORD || 'spider123',
  database: process.env.QUESTDB_DATABASE || 'qdb',
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function dbQuery(text) {
  try {
    const result = await pool.query(text);
    return result.rows;
  } catch (err) {
    console.error('[Camera] DB query error:', err.message);
    return [];
  }
}

// ─── Camera Config from DB ───

async function loadCameras() {
  const rows = await dbQuery(`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY timestamp DESC) as rn
      FROM cameras
    )
    WHERE rn = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
    ORDER BY sort_order ASC, name ASC
  `);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    protocol: r.protocol || 'rtsp',
    host: r.host,
    port: r.port || 554,
    path: r.path || '/',
    username: r.username || '',
    password: r.password || '',
    enabled: r.enabled === 1,
    order: r.sort_order || 0,
  }));
}

function buildStreamUrl(cam) {
  const auth = cam.username ? `${cam.username}:${cam.password}@` : '';
  const p = cam.path.startsWith('/') ? cam.path : `/${cam.path}`;
  switch (cam.protocol) {
    case 'rtsp': return `rtsp://${auth}${cam.host}:${cam.port}${p}`;
    case 'rtsp-tcp': return `rtsp://${auth}${cam.host}:${cam.port}${p}#transport=tcp`;
    case 'onvif': return `onvif://${auth}${cam.host}:${cam.port}`;
    case 'http-mjpeg': return `http://${auth}${cam.host}:${cam.port}${p}`;
    default: return `rtsp://${auth}${cam.host}:${cam.port}${p}`;
  }
}

function generateYaml(cameras) {
  const enabled = cameras.filter(c => c.enabled);
  if (enabled.length === 0) return 'api:\n  listen: ":1984"\n\nstreams: {}\n';
  const lines = ['api:', '  listen: ":1984"', '', 'webrtc:', '  candidates:', '    - stun:stun.l.google.com:19302', '', 'streams:'];
  for (const cam of enabled) {
    lines.push(`  ${cam.id}:`, `    - ${buildStreamUrl(cam)}`);
  }
  return lines.join('\n') + '\n';
}

async function writeConfig() {
  const cameras = await loadCameras();
  fs.writeFileSync(CONFIG_PATH, generateYaml(cameras));
  return cameras.filter(c => c.enabled).length;
}

// ─── go2rtc Binary Management ───

function getArchSuffix() {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  return 'amd64';
}

function downloadBinary() {
  const arch = getArchSuffix();
  const url = `https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_${arch}`;
  console.log(`[Camera] Downloading go2rtc binary for linux_${arch}...`);

  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  return new Promise((resolve) => {
    const follow = (targetUrl, depth = 0) => {
      if (depth > 5) { resolve(false); return; }
      const getter = targetUrl.startsWith('https') ? https.get : http.get;
      getter(targetUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location, depth + 1);
          return;
        }
        if (res.statusCode !== 200) {
          console.error(`[Camera] Download failed: HTTP ${res.statusCode}`);
          resolve(false);
          return;
        }
        const ws = fs.createWriteStream(BIN_PATH);
        pipeline(res, ws)
          .then(() => { fs.chmodSync(BIN_PATH, 0o755); console.log('[Camera] Binary downloaded'); resolve(true); })
          .catch((err) => { console.error('[Camera] Download error:', err.message); resolve(false); });
      }).on('error', (err) => { console.error('[Camera] Download error:', err.message); resolve(false); });
    };
    follow(url);
  });
}

// ─── go2rtc Process Management ───

let child = null;
let healthTimer = null;
let captureTimer = null;
let isShuttingDown = false;
let lastError = null; // Track why go2rtc isn't running

async function startGo2rtc() {
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    child = null;
  }

  // Kill orphaned go2rtc processes from previous camera service instances.
  // Check if port 1984 is already in use — if so, kill that process specifically.
  try {
    const { execSync } = require('child_process');
    const lsofOut = execSync('lsof -ti :1984 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (lsofOut) {
      for (const pid of lsofOut.split('\n').filter(Boolean)) {
        try { process.kill(parseInt(pid), 'SIGKILL'); } catch { /* already dead */ }
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } catch { /* port not in use — good */ }

  if (!fs.existsSync(BIN_PATH)) {
    const ok = await downloadBinary();
    if (!ok) {
      lastError = 'go2rtc binary missing — download from GitHub failed. Check internet connection or download manually to bin/go2rtc';
      console.error(`[Camera] ${lastError}`);
      return false;
    }
  }

  const count = await writeConfig();
  if (count === 0) {
    lastError = null; // Not an error — just no cameras configured
    console.log('[Camera] No enabled cameras, go2rtc not started');
    return false;
  }
  lastError = null;

  // Ensure binary is executable (may lose +x after copy/extract)
  try { fs.chmodSync(BIN_PATH, 0o755); } catch { /* ignore */ }

  console.log(`[Camera] Starting go2rtc with ${count} camera(s)...`);
  child = spawn(BIN_PATH, ['-config', CONFIG_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: PROJECT_ROOT,
  });

  child.stdout.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[go2rtc] ${msg}`);
  });
  child.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[go2rtc] ${msg}`);
  });

  child.on('exit', (code) => {
    console.log(`[Camera] go2rtc exited (code ${code})`);
    child = null;
    if (!isShuttingDown) {
      console.log('[Camera] Restarting go2rtc in 5s...');
      setTimeout(() => startGo2rtc(), 5000);
    }
  });

  // Warm up: pre-connect all cameras by requesting a snapshot from each.
  // go2rtc only establishes RTSP/HTTP connections to cameras on-demand,
  // so without this the first request after startup would fail or be slow.
  setTimeout(() => warmUpCameras(), 3000);

  return true;
}

async function warmUpCameras() {
  if (!child || isShuttingDown) return;
  try {
    const cameras = await loadCameras();
    const enabled = cameras.filter(c => c.enabled);
    if (enabled.length === 0) return;
    console.log(`[Camera] Warming up ${enabled.length} camera(s)...`);
    for (const cam of enabled) {
      try {
        await fetch(`${GO2RTC_API}/frame.jpeg?src=${encodeURIComponent(cam.id)}`).catch(() => {});
      } catch { /* ignore — just triggering connection */ }
    }
    console.log('[Camera] Warm-up complete');
  } catch (err) {
    console.warn('[Camera] Warm-up failed:', err.message);
  }
}

async function stopGo2rtc() {
  if (child) {
    console.log('[Camera] Stopping go2rtc...');
    const pid = child.pid;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    child = null;
    // Force kill after 2s if still alive
    if (pid) {
      setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 2000);
    }
  }
}

async function reloadGo2rtc() {
  console.log('[Camera] Reloading...');
  await startGo2rtc();
}

async function healthCheck() {
  if (!child || isShuttingDown) return;
  try {
    const res = await fetch(GO2RTC_API).catch(() => null);
    if (!res || !res.ok) {
      console.warn('[Camera] go2rtc health check failed, restarting...');
      await startGo2rtc();
    }
  } catch {
    console.warn('[Camera] go2rtc health check error');
  }
}

// ─── Snapshot / Timelapse Capture ───

/**
 * Capture a single frame from a camera via go2rtc.
 * go2rtc connects to the RTSP stream on-demand when a frame is requested,
 * captures a keyframe, returns JPEG, and disconnects when idle.
 * This works independently of the web app — only needs go2rtc running (PM2).
 */
async function captureSnapshot(cameraId, outputPath) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Retry with increasing delays — RTSP cameras can take time to connect and send a keyframe
  const MAX_ATTEMPTS = 5;
  const DELAYS = [0, 3000, 5000, 8000, 10000]; // wait before each retry

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, DELAYS[attempt]));
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s per attempt
      const res = await fetch(`${GO2RTC_API}/frame.jpeg?src=${encodeURIComponent(cameraId)}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 1000) throw new Error('Frame too small');
      fs.writeFileSync(outputPath, buffer);
      console.log(`[Camera] Snapshot saved: ${outputPath} (${buffer.length} bytes)`);
      return true;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS - 1) {
        console.log(`[Camera] Capture attempt ${attempt + 1}/${MAX_ATTEMPTS} failed for ${cameraId}, retrying...`);
      } else {
        console.error(`[Camera] Snapshot failed for ${cameraId} after ${MAX_ATTEMPTS} attempts: ${err.message}`);
      }
    }
  }
  return false;
}

// ─── Photo Overlay (ImageMagick) ───

/**
 * Load overlay settings for a camera from DB.
 */
async function loadOverlaySettings(cameraId) {
  try {
    // Strict alphanumeric validation to prevent SQL injection
    if (!/^[a-zA-Z0-9_-]+$/.test(cameraId)) return { enabled: false };

    const rows = await dbQuery(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY camera_id ORDER BY timestamp DESC) as rn
        FROM camera_overlay_settings
      )
      WHERE rn = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
        AND camera_id = '${cameraId}'
    `);
    if (rows && rows.length > 0) {
      const r = rows[0];
      return {
        enabled: r.enabled === 1,
        position: r.position || 'bottom-left',
        show_date: r.show_date === 1,
        date_format: r.date_format || 'YYYY-MM-DD',
        show_time: r.show_time === 1,
        show_day_counter: r.show_day_counter === 1,
        day_counter_start: r.day_counter_start || '',
        day_counter_label: r.day_counter_label || 'Day',
        custom_text: r.custom_text || '',
        font_size: r.font_size || 36,
        text_color: r.text_color || 'white',
      };
    }
  } catch { /* ignore */ }
  return { enabled: false };
}

/**
 * Build overlay text from settings.
 */
function buildOverlayText(settings, now) {
  const parts = [];
  if (settings.custom_text) parts.push(settings.custom_text);
  if (settings.show_day_counter && settings.day_counter_start) {
    const start = new Date(settings.day_counter_start + 'T00:00:00');
    const diffMs = now.getTime() - start.getTime();
    const dayNum = Math.max(1, Math.floor(diffMs / 86400000) + 1);
    parts.push(`${settings.day_counter_label || 'Day'} ${dayNum}`);
  }
  if (settings.show_date) {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    switch (settings.date_format) {
      case 'DD/MM/YYYY': parts.push(`${dd}/${mm}/${yyyy}`); break;
      case 'MM/DD/YYYY': parts.push(`${mm}/${dd}/${yyyy}`); break;
      default: parts.push(`${yyyy}-${mm}-${dd}`);
    }
  }
  if (settings.show_time) {
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    parts.push(`${hh}:${mi}:${ss}`);
  }
  return parts.join(' | ');
}

/**
 * Apply text overlay to JPEG using ImageMagick convert.
 */
function applyPhotoOverlay(filePath, settings, now) {
  const text = buildOverlayText(settings, now);
  if (!text) return Promise.resolve(false);

  const gravityMap = {
    'top-left': 'NorthWest', 'top-right': 'NorthEast',
    'bottom-right': 'SouthEast', 'bottom-left': 'SouthWest',
  };
  const colorMap = {
    'yellow': '#FFDD00', 'green': '#00FF88', 'cyan': '#00DDFF', 'red': '#FF4444', 'white': '#FFFFFF',
  };
  const gravity = gravityMap[settings.position] || 'SouthWest';
  const color = colorMap[settings.text_color] || '#FFFFFF';
  const size = Math.max(18, Math.min(72, settings.font_size || 36));

  const args = [
    filePath,
    '-gravity', gravity,
    '-font', 'DejaVu-Sans-Bold',
    '-pointsize', String(size),
    '-fill', 'rgba(0,0,0,0.9)', '-stroke', 'rgba(0,0,0,0.9)', '-strokewidth', '3',
    '-annotate', '+20+20', text,
    '-stroke', 'none', '-fill', color,
    '-annotate', '+20+20', text,
    filePath,
  ];

  return new Promise((resolve) => {
    execFile('convert', args, { timeout: 10000 }, (err) => {
      if (err) {
        console.error('[Camera] Overlay error:', err.message);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// Cache overlay settings per camera (refresh every 5 min)
const overlayCache = new Map(); // cameraId → { settings, fetchedAt }
const OVERLAY_CACHE_TTL = 5 * 60 * 1000;

async function getOverlaySettings(cameraId) {
  const cached = overlayCache.get(cameraId);
  if (cached && Date.now() - cached.fetchedAt < OVERLAY_CACHE_TTL) {
    return cached.settings;
  }
  const settings = await loadOverlaySettings(cameraId);
  overlayCache.set(cameraId, { settings, fetchedAt: Date.now() });
  return settings;
}

// ─── Auto Video Generation ───

const VIDEO_DIR = path.join(PROJECT_ROOT, 'data', 'webcam-videos');
const lastCaptureDateByCamera = new Map(); // cameraId → 'YYYY-MM-DD'

/**
 * Generate timelapse video for a specific camera+day using ffmpeg.
 * Returns true if video was created, false otherwise.
 */
function generateDailyVideo(cameraId, date, fps = 10) {
  const dayDir = path.join(DATA_DIR, cameraId, 'timelapse', date);
  if (!fs.existsSync(dayDir)) return Promise.resolve(false);

  const photos = fs.readdirSync(dayDir).filter(f => f.endsWith('.jpg')).sort();
  if (photos.length < 2) return Promise.resolve(false);

  if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const videoPath = path.join(VIDEO_DIR, `${cameraId}_${date}_${fps}fps.mp4`);

  // Skip if video already exists and is newer than the last photo
  if (fs.existsSync(videoPath)) {
    const videoMtime = fs.statSync(videoPath).mtimeMs;
    const lastPhotoPath = path.join(dayDir, photos[photos.length - 1]);
    const photoMtime = fs.statSync(lastPhotoPath).mtimeMs;
    if (videoMtime > photoMtime) return Promise.resolve(false);
  }

  console.log(`[Camera] Auto-generating video: ${cameraId} ${date} (${photos.length} photos, ${fps}fps)`);

  return new Promise((resolve) => {
    const args = [
      '-y', '-framerate', String(fps),
      '-pattern_type', 'glob',
      '-i', path.join(dayDir, '*.jpg'),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      videoPath,
    ];

    execFile('ffmpeg', args, { timeout: 300000 }, (err, _stdout, stderr) => {
      if (err) {
        console.error(`[Camera] Auto-video failed for ${date}:`, stderr?.slice(0, 200));
        resolve(false);
      } else {
        const size = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0;
        console.log(`[Camera] Auto-video created: ${videoPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
        resolve(true);
      }
    });
  });
}

/**
 * On startup: find days with photos but no video and generate them.
 */
async function catchUpMissingVideos() {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    const cameraIds = fs.readdirSync(DATA_DIR).filter(d => {
      const tlDir = path.join(DATA_DIR, d, 'timelapse');
      return fs.existsSync(tlDir) && fs.statSync(tlDir).isDirectory();
    });

    const today = new Date().toISOString().split('T')[0];

    for (const camId of cameraIds) {
      const tlDir = path.join(DATA_DIR, camId, 'timelapse');
      const dateDirs = fs.readdirSync(tlDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today)
        .sort();

      for (const dateDir of dateDirs) {
        const dayPath = path.join(tlDir, dateDir);
        const photos = fs.readdirSync(dayPath).filter(f => f.endsWith('.jpg'));
        if (photos.length < 2) continue;

        // Check if any video exists for this day
        let hasVideo = false;
        if (fs.existsSync(VIDEO_DIR)) {
          hasVideo = fs.readdirSync(VIDEO_DIR).some(f =>
            f.startsWith(`${camId}_${dateDir}_`) && f.endsWith('.mp4')
          );
        }

        if (!hasVideo) {
          await generateDailyVideo(camId, dateDir);
        }
      }
    }
  } catch (err) {
    console.error('[Camera] Catch-up video generation error:', err.message);
  }
}

// ─── Timelapse Schedule Engine ───

// Track last capture time per schedule (in-memory, survives restarts via filesystem scan)
const lastCaptureBySchedule = new Map(); // scheduleId → Date

// Custom HTTPS agent that accepts self-signed certificates (IP Webcam cameras)
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Capture photo directly from camera via IP Webcam HTTPS API.
 * For timelapse: uses /photo.jpg (NO autofocus) to preserve focus/zoom consistency.
 * For manual: uses /photoaf.jpg (with autofocus) for best single-shot quality.
 */
async function captureFromCamera(host, port, outputPath, { useAutofocus = false } = {}) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Timelapse MUST NOT trigger autofocus — it changes zoom/focus and ruins the sequence
  const photoPath = useAutofocus ? '/photoaf.jpg' : '/photo.jpg';
  const urls = [
    { url: `https://${host}:${port}${photoPath}`, agent: insecureAgent },
    { url: `http://${host}:${port}${photoPath}`, agent: undefined },
  ];

  for (const { url, agent } of urls) {
    try {
      const buf = await new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { agent, timeout: 15000 }, (res) => {
          const ct = res.headers['content-type'] || '';
          if (!ct.includes('image')) {
            req.destroy();
            reject(new Error('Not an image response'));
            return;
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      });

      if (buf && buf.length > 1000) {
        fs.writeFileSync(outputPath, buf);
        console.log(`[Camera] Timelapse captured: ${outputPath} (${buf.length} bytes)`);
        return true;
      }
    } catch {
      continue;
    }
  }

  console.error(`[Camera] Timelapse capture failed for ${host}:${port}`);
  return false;
}

/**
 * Check if a schedule should fire right now.
 */
function shouldCapture(schedule, now) {
  // Check day of week
  if (schedule.days_active !== 'all') {
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const todayName = dayNames[now.getDay()];
    const activeDays = schedule.days_active.split(',').map(d => d.trim().toLowerCase());
    if (!activeDays.includes(todayName)) return false;
  }

  // Check time window
  if (schedule.start_time && schedule.end_time) {
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = schedule.start_time.split(':').map(Number);
    const [endH, endM] = schedule.end_time.split(':').map(Number);
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    if (startMin <= endMin) {
      // Normal range (e.g. 08:00 - 20:00)
      if (currentMinutes < startMin || currentMinutes > endMin) return false;
    } else {
      // Overnight range (e.g. 20:00 - 06:00)
      if (currentMinutes < startMin && currentMinutes > endMin) return false;
    }
  }

  // Check interval since last capture
  const lastCapture = lastCaptureBySchedule.get(schedule.id);
  if (lastCapture) {
    const elapsedMs = now.getTime() - lastCapture.getTime();
    const intervalMs = schedule.interval_minutes * 60 * 1000;
    if (elapsedMs < intervalMs) return false;
  }

  return true;
}

/**
 * Main scheduler loop — runs every 60s.
 * Queries active schedules from DB, checks timing, captures photos.
 */
async function checkScheduledCaptures() {
  try {
    // Load active schedules
    const rows = await dbQuery(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY timestamp DESC) as rn
        FROM camera_timelapse_schedules
      )
      WHERE rn = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
        AND enabled = 1
    `);

    if (!rows || rows.length === 0) return;

    // Load cameras for host/port lookup
    const cameras = await loadCameras();
    const cameraMap = new Map();
    for (const cam of cameras) {
      if (cam.enabled) cameraMap.set(cam.id, cam);
    }

    const now = new Date();

    for (const row of rows) {
      const schedule = {
        id: row.id,
        camera_id: row.camera_id,
        enabled: row.enabled === 1,
        interval_minutes: row.interval_minutes || 30,
        start_time: row.start_time || '',
        end_time: row.end_time || '',
        days_active: row.days_active || 'all',
      };

      const cam = cameraMap.get(schedule.camera_id);
      if (!cam) continue;

      if (!shouldCapture(schedule, now)) continue;

      // Build output path: /data/webcam/{camera-id}/timelapse/{YYYY-MM-DD}/{HH-MM-SS}.jpg
      // Use local time consistently (not UTC)
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
      const outputPath = path.join(DATA_DIR, cam.id, 'timelapse', dateStr, `${timeStr}.jpg`);

      // Try direct HTTP capture first, then ffmpeg RTSP, then go2rtc frame
      let success = await captureFromCamera(cam.host, cam.port, outputPath);
      if (!success) {
        success = await captureSnapshot(cam.id, outputPath);
      }
      if (success) {
        lastCaptureBySchedule.set(schedule.id, now);
        // Apply overlay if enabled
        const overlay = await getOverlaySettings(cam.id);
        if (overlay && overlay.enabled) {
          await applyPhotoOverlay(outputPath, overlay, now);
        }

        // Auto-generate video when day changes
        const prevDate = lastCaptureDateByCamera.get(cam.id);
        lastCaptureDateByCamera.set(cam.id, dateStr);
        if (prevDate && prevDate !== dateStr) {
          // Day changed — generate video for the completed day (async, don't block)
          generateDailyVideo(cam.id, prevDate).catch(err => {
            console.error(`[Camera] Auto-video failed for ${cam.id} ${prevDate}:`, err.message);
          });
        }
      }
    }
  } catch (err) {
    console.error('[Camera] Schedule check error:', err.message);
  }
}

// ─── Internal HTTP API (for Nuxt to call) ───

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST' && req.url === '/reload') {
    await reloadGo2rtc();
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.end(JSON.stringify({
      running: child !== null && !child.killed,
      pid: child?.pid || null,
      error: lastError || null,
      binaryExists: fs.existsSync(BIN_PATH),
    }));
    return;
  }

  // Proxy snapshot request: /snapshot/{cameraId}
  if (req.method === 'GET' && req.url.startsWith('/snapshot/')) {
    const cameraId = req.url.slice('/snapshot/'.length);
    try {
      const goRes = await fetch(`${GO2RTC_API}/frame.jpeg?src=${encodeURIComponent(cameraId)}`);
      if (!goRes.ok) {
        res.writeHead(goRes.status);
        res.end(JSON.stringify({ error: 'Snapshot unavailable' }));
        return;
      }
      const buf = Buffer.from(await goRes.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
      res.end(buf);
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── Lifecycle ───

function cleanup() {
  isShuttingDown = true;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  stopGo2rtc();
  server.close();
  pool.end().catch(() => {});
  console.log('[Camera] Service stopped');
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

async function main() {
  console.log('[Camera] ══════════════════════════════════');
  console.log('[Camera] Camera Service starting...');
  console.log('[Camera] ══════════════════════════════════');

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Wait for DB to be ready
  let dbReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      await pool.query('SELECT 1');
      dbReady = true;
      break;
    } catch {
      console.log(`[Camera] Waiting for database... (${i + 1}/10)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!dbReady) {
    console.error('[Camera] Database not available, exiting');
    process.exit(1);
  }

  // Start go2rtc
  await startGo2rtc();

  // Health check timer
  healthTimer = setInterval(healthCheck, HEALTH_INTERVAL);

  // Timelapse scheduled capture timer — checks DB every 60s
  captureTimer = setInterval(checkScheduledCaptures, CAPTURE_CHECK_INTERVAL);
  console.log('[Camera] Timelapse scheduler active (checking every 60s)');

  // Generate videos for any past days missing videos (runs once on startup)
  catchUpMissingVideos().then(() => {
    console.log('[Camera] Catch-up video generation complete');
  });

  // Internal HTTP API
  server.listen(SERVICE_PORT, '127.0.0.1', () => {
    console.log(`[Camera] Internal API listening on 127.0.0.1:${SERVICE_PORT}`);
  });

  console.log('[Camera] Service ready');
}

main().catch(err => {
  console.error('[Camera] Fatal error:', err);
  process.exit(1);
});
