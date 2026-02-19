<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/SCHEDULE-4-REAL-LOGO.svg" alt="Schedule 4 Real" width="480" />
</p>

<p align="center">
  <em>WHERE REAL GROWERS COME TO PLAY</em>
</p>

<p align="center">
  <strong>Grow control system &bull; Plant genetics lab &bull; Encrypted multiplayer 3D game</strong>
</p>

<p align="center">
  <a href="https://schedule4real.com">https://schedule4real.com</a>
</p>

<p align="center">
  <a href="#-quick-install"><img src="https://img.shields.io/badge/install-one--liner-brightgreen?style=for-the-badge" alt="Install" /></a>
  <a href="#-spider-farmer-compatibility"><img src="https://img.shields.io/badge/Spider%20Farmer-GGS%20Compatible-blue?style=for-the-badge" alt="Spider Farmer" /></a>
  <a href="#-anonymous--encrypted-multiplayer"><img src="https://img.shields.io/badge/multiplayer-E2E%20encrypted-blueviolet?style=for-the-badge" alt="Encrypted" /></a>
  <a href="#-schedule-4-real-game"><img src="https://img.shields.io/badge/3D%20game-THREE.js-orange?style=for-the-badge" alt="3D Game" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20RPi%20%7C%20WSL%20%7C%20macOS-informational" alt="Platforms" />
  <img src="https://img.shields.io/badge/arch-x86--64%20%7C%20ARM64-informational" alt="Architectures" />
  <img src="https://img.shields.io/badge/license-source%20available-yellow" alt="License" />
  <img src="https://img.shields.io/badge/cloud-not%20required-success" alt="Local First" />
</p>

---

## Quick Install

```bash
curl -fsSL https://schedule4real.com/dist/install/install.sh | sudo bash
```

> The installer sets up everything automatically: Node.js, MQTT broker, time-series database, TLS proxy, and all services. Your grow room will be online in under 5 minutes.

### Supported Platforms

| Platform | Method | Notes |
|:---------|:-------|:------|
| **Linux x86-64** | Native | Recommended. Debian, Ubuntu, etc. |
| **Linux ARM64** | Native | Raspberry Pi 4/5 (2 GB+ RAM) |
| **Windows** | WSL or VirtualBox | Full functionality via Linux VM |
| **macOS** | Docker | Intel & Apple Silicon |

### Requirements

| | Minimum |
|:-|:--------|
| **RAM** | 2 GB |
| **Storage** | 10 GB |
| **Network** | Same LAN as your grow modules |

> ARM 32-bit (Raspberry Pi 3 and older) is not supported.

---

## What Is Schedule 4 Real?

Schedule 4 Real is a **locally-hosted grow room control platform** that gives you full ownership of your Spider Farmer GGS devices — no cloud, no subscriptions, no data leaving your network. It intercepts and reverse-engineers the MQTT protocol used by Spider Farmer modules, letting you monitor sensors, automate outlets, schedule lights, and control everything from a modern web interface on any device.

But this is not just another controller app.

Schedule 4 Real integrates a **complete plant genetics laboratory** for tracking strains, breeding projects, phenotype hunts, clones, and full grow cycle journals. It includes a **visual automation engine** where you build complex trigger flows by wiring nodes together. And it wraps everything inside a **first-person 3D game** where you can walk through virtual rooms, place interactive objects, control your real devices from in-game switches, and invite anyone into **fully anonymous, end-to-end encrypted multiplayer sessions** — no accounts, no tracking, no metadata leaks.

The game isn't just for growers. It's for anyone who wants to **learn about cultivation**, explore breeding and pheno hunting, or simply **have a private space to hang out** with friends. The communication protocol is built on onion-routed circuits with military-grade cryptography, and its source code is public.

### Spider Farmer Compatibility

Currently compatible with the full **Spider Farmer GGS** ecosystem:

- **Spider Farmer Power Strip 5** (PS5) — 5 outlets, exhaust fan, circulation fan, environment sensors, soil probes
- **Spider Farmer Light Controller** (LC) — dual channel grow lights with PPFD auto-control
- **Spider Farmer Control Box** (CB) — combined outlet and light control

> Future compatibility with other brands like **AC Infinity** and **Grolab by Open Grow** is being evaluated. The architecture is protocol-agnostic — new device integrations can be added without changing the core platform.

---

## Dashboard

Real-time monitoring and control — everything at a glance.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/dashboard.jpg" alt="Dashboard — Real-time environment monitoring" width="100%" />
</p>

The dashboard gives you a live view of your entire grow environment. All sensor data updates in real time via WebSocket — no manual refresh needed.

- **Environment sensors** — Temperature, humidity, VPD (air + leaf), CO2, updated every few seconds
- **Soil sensors** — Up to 6 wireless probes showing soil temperature, moisture (%), and electrical conductivity (EC)
- **Day/Night statistics** — Separate min, average, and max for each sensor during light-on and light-off periods
- **Socket control** — 5 outlet sockets with instant on/off toggle and mode indicator badges
- **Light status** — Brightness bar, current mode (Manual / TimeSlot / PPFD), countdown to next transition
- **Blower & fan** — Speed percentage, wattage, animated rotation indicator
- **Power summary** — Total consumption in watts, cost breakdown per socket, active device count
- **Event log** — Timeline of socket state changes with timestamp and trigger source (manual or automation)
- **Charts** — Temperature, humidity, VPD, CO2, wattage, blower/fan — from 1 hour to 90 days, with day/night shading and synced crosshair across all charts

---

## Device Control

Full control over every Spider Farmer GGS module — configure modes, schedules, and automation rules per device.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/settings.jpg" alt="Settings — Device configuration and environment targets" width="100%" />
</p>

### Outlets (O1–O5)

Each outlet supports 7 control modes:

| Mode | How it works |
|:-----|:-------------|
| **Manual** | Direct on/off toggle |
| **Time Slot** | Up to 12 scheduled periods per day |
| **Cycle** | Repeating intervals (e.g., 5 min on, 25 min off) |
| **Temperature** | Auto-trigger when temp exceeds threshold |
| **Humidity** | Auto-trigger when humidity exceeds threshold |
| **CO2** | Auto-trigger based on CO2 concentration |
| **Drip** | Irrigation with soil moisture feedback from wireless probes |

### Lights

| Mode | How it works |
|:-----|:-------------|
| **Manual** | Direct brightness 0–100% |
| **Time Slot** | Daily schedule with brightness per period |
| **Cycle** | Repeating on/off pattern |
| **PPFD Auto** | Automatically adjusts intensity to hit target photosynthetic flux (umol/m2/s) |

Sunrise/sunset simulation, dark temperature control, and per-light wattage configuration included.

### Blower, Fan & Environment

- Exhaust blower with speed curve editor (temperature-responsive speed ramp)
- Circulation fan with oscillation modes and natural wind pattern
- **VPD auto-control** — assign devices as extractors, humidifiers, or heaters with intelligent escalation
- Environment targets for day/night temperature, humidity, VPD range, and CO2

---

## Automation Engine

A visual node-based flow builder for creating complex automation rules — purpose-built for grow rooms.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/triggers.jpg" alt="Triggers — Visual automation flow builder" width="100%" />
</p>

Drag nodes onto the canvas, wire them together, and let the system handle the rest. No coding required.

| Node | What it does |
|:-----|:-------------|
| **Condition** | Sensor threshold with operator, hysteresis, and separate day/night values |
| **Schedule** | Time range or repeating interval with weekday selector |
| **Action** | Toggle outlet, set light mode, control blower speed |
| **Logic** | AND / OR gates to combine multiple conditions |
| **VPD Control** | Automatic VPD management with device roles and phase-aware targets |
| **Blower Curve** | Visual curve editor mapping temperature to fan speed |
| **Note** | Annotate your flows with comments |

Every execution is logged with timestamp, action taken, and sensor values at the time. Filter logs by 1H, 4H, 24H, or 7D. Global enable/disable lets you pause all automations with one click.

---

## Plant Genetics Laboratory

A complete grow journal, strain library, breeding planner, and phenotype analysis tool — all in one place.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/Laboratory.jpg" alt="Laboratory — Plant genetics and grow journal" width="100%" />
</p>

### Grow Journal

Track every plant from seed to harvest across **15 lifecycle stages**: Germination, Seedling, Early/Mid/Late Veg, Pre-Flower, Early/Mid/Late Flower, Flush, Harvest, Drying, Curing, and Archived. Each plant gets a day counter, photo gallery, and full observation timeline.

### Observation System

Log plant health, height, notes, and photos through a step-by-step wizard. The system automatically captures environment data (temperature, humidity, VPD) at the moment of each observation. Stage-based reminders tell you when it's time to check your plants.

### Strain Library

Catalog your genetics with breeder info, indica/sativa ratios, flowering times, seed type (regular, feminized, auto), and seed inventory. Link plants to strains for cross-strain performance comparison over time.

### Breeding Projects

Plan and track crosses with defined goals — line creation, stabilization, backcross, pheno hunting, or seed production. Manage your pollen bank (collection dates, viability, strain) and visualize genetic lineage with tree diagrams.

### Pheno Hunt & Keeper Selection

Score plants across 6 weighted categories (yield, potency, flavor, vigor, disease resistance, stability) using radar charts. Compare phenotypes side-by-side with photos. The **Keeper Engine** helps you identify the best mother plants based on your scoring profile (Standard, Commercial, Breeder, or Connoisseur).

### Cameras & Timelapse

Connect IP cameras for live feeds, scheduled captures, and automatic timelapse compilation. Browse photo galleries organized by camera and date.

### Reports

Harvest summaries, strain performance analytics, trend charts, and data export (CSV).

---

## Schedule 4 Real Game

A first-person 3D sandbox where your grow room comes to life. Walk through virtual spaces, place objects, control real devices, and invite anyone — all within an encrypted multiplayer experience.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/loby.jpg" alt="Lobby — Character selection and room browser" width="100%" />
</p>

The lobby is your starting point. Pick a character, browse your rooms or discover public ones, and step into any 3D environment. Create rooms by uploading custom GLB models — your actual grow tent, an apartment, a warehouse, whatever you want.

The game is designed for **two audiences**:

- **Growers** who want a visual, immersive way to monitor and control their cultivation — walk through your virtual room and flip real switches
- **Everyone else** who wants a private sandbox to hang out, learn about growing, or just explore — no grow hardware needed to play

---

## Anonymous & Encrypted Multiplayer

Invite anyone into your rooms. No accounts. No registration. No tracking. Every connection is routed through an encrypted onion network.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/loby-multiplayer-encrypted.jpg" alt="Encrypted multiplayer — Anonymous onion-routed connections" width="100%" />
</p>

### How It Works

```
You (Host)                 Relay Network                 Your Friend (Guest)
    |                           |                              |
    |--- 1-hop onion ---------> Tracker                        |
    |    (register room)        | stores encrypted blob        |
    |                           |                              |
    |                           |  <------ 1-hop onion --------|
    |                           |  (discover room)             |
    |                           |                              |
    |--- rendezvous cookie ---> Relay  <------ 2-hop onion ----|
    |                           | pairs both circuits          |
    |                           |                              |
    |<======= End-to-End encrypted channel (XChaCha20) =======>|
    |     voice, position, objects — relay CANNOT read this     |
```

### Cryptography

| Layer | Primitive |
|:------|:----------|
| Key exchange | **X25519** (Elliptic Curve Diffie-Hellman) per circuit hop |
| Encryption | **XChaCha20-Poly1305** AEAD per onion layer |
| Implementation | **libsodium** (WASM, runs in browser) |

### Privacy Guarantees

- **No relay can decrypt your traffic** — each hop only peels its own encryption layer
- **No tracker sees room contents** — metadata encrypted with a key only you and your guests know
- **Your IP is hidden from guests** — they connect through relays, never directly to you
- **No accounts or registration** — guests join via encrypted invite tokens
- **Chaff traffic** — dummy packets prevent traffic analysis
- **Federated relays** — anyone can run a relay node; gossip protocol connects them

The relay and onion routing source code is public. Even if every relay were compromised, the end-to-end encryption between host and guest remains unbreakable.

---

## Inside a Room

Upload any 3D model (GLB format) as a room. Calibrate the floor and scale, choose an environment preset (Forest, Cyberpunk, Beach, Office...), and start decorating.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-main.jpg" alt="Room — First-person 3D environment" width="100%" />
</p>

Navigate with WASD, sprint with Shift, jump with Space. Full physics: gravity, collision detection, dynamic ground tracking, auto step-up on small obstacles. Head bob while walking, smooth camera movement, and a radial quick-action menu on Q.

---

## Infinite Rooms & Doors

Create as many rooms as you want and interconnect them with doors. Each door can link to a different environment — build a hallway that connects your grow tent to a lounge, a shop, or a secret lab.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-infinite-rooms.jpg" alt="Infinite rooms — Interconnected environments with doors" width="100%" />
</p>

---

## Locked Doors & Private Zones

Put security keypads on any door. Only people who know the code can enter. Build a private "candy shop" behind a locked door — display your best genetics, your harvest collection, or anything you want to share exclusively with trusted visitors.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-lock.jpg" alt="Locked door — Keypad security system" width="100%" />
</p>

---

## Sandbox Mode

Place furniture, decorations, screens, interactive objects — hundreds of 3D assets auto-discovered from the asset library. Move, rotate, scale, duplicate, lock objects in place. Every room is your canvas.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-sandbox.jpg" alt="Sandbox — Place and arrange 3D objects" width="100%" />
</p>

---

## Real-Time Grow Control in 3D

Bind virtual objects to your real Spider Farmer devices. Display live sensor data on in-game screens. Flip switches that control actual outlets. Your grow room becomes an interactive 3D control panel.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-sensors.jpg" alt="In-game device control — Live sensor data and switches" width="100%" />
</p>

- **Display zones** — Show live temperature, humidity, VPD, CO2 on wall-mounted screens
- **Device switches** — Bind any object to a real outlet or light; toggle with a click
- **Keypads** — Program action chains that execute device commands
- **Behavior triggers** — Automate actions when a player enters a zone

---

## TV & Streaming

Place TVs in your rooms and tune into live IPTV channels. Browse by category (Sports, News, Music, Gaming), add custom m3u8 streams, save favorites. Watch together with friends in multiplayer.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-tv.jpg" alt="In-game TV — IPTV streaming with channel browser" width="100%" />
</p>

---

## Complete Feature List

### Dashboard & Monitoring

| Feature | |
|:--------|:-:|
| Real-time temperature, humidity, VPD, leaf VPD, CO2 | |
| Up to 6 wireless soil sensors (temp, moisture, EC) | |
| Day/Night statistics (min, avg, max per period) | |
| 5 outlet sockets with instant toggle and mode badges | |
| Dual light control (brightness, mode, countdown) | |
| Blower speed, wattage, CO2 close indicator | |
| Power consumption tracking with cost breakdown | |
| Socket event log with trigger source | |
| Charts: 1h to 90 days, synced crosshair, day/night shading | |
| Custom device naming | |

### Automation

| Feature | |
|:--------|:-:|
| Visual node-based flow editor | |
| Sensor conditions with hysteresis and day/night thresholds | |
| Time schedules (range + interval modes + weekday picker) | |
| AND/OR logic gates | |
| VPD auto-control with device role assignment | |
| Fan curve editor (sensor-to-speed mapping) | |
| Execution log with full audit trail | |
| Global enable/disable | |

### Laboratory

| Feature | |
|:--------|:-:|
| 15-stage plant lifecycle tracking | |
| Observation wizard with auto environment capture | |
| Photo gallery with lightbox | |
| Strain library (breeder, genetics, flowering time, inventory) | |
| Breeding projects with pollen bank and genetic trees | |
| Pheno hunt scoring with radar charts and Keeper Engine | |
| Camera feeds, timelapse, scheduled captures | |
| Reports, analytics, CSV export | |
| Grow rooms with 2D floor plan and device binding | |
| Achievement tracking and XP gamification | |

### 3D Game

| Feature | |
|:--------|:-:|
| First-person navigation (WASD, sprint, jump, crouch) | |
| Custom GLB room upload with floor calibration | |
| Object placement (move, rotate, scale, duplicate, lock) | |
| Environment presets and ambient lighting control | |
| Interactive TVs with IPTV/HLS streaming | |
| Keypads with security codes and door locks | |
| Display zones (images, video, text, sensor widgets) | |
| Device bindings (control real outlets/lights from 3D) | |
| Behavior system (proximity triggers, action chains) | |
| Post-processing (bloom, FXAA, color correction) | |

### Multiplayer

| Feature | |
|:--------|:-:|
| Anonymous join — no accounts, no registration | |
| End-to-end encrypted (XChaCha20-Poly1305) | |
| Onion-routed circuits (2-hop, relay-based) | |
| Real-time player sync (20Hz, interpolated) | |
| Voice chat (WebRTC peer-to-peer) | |
| Public room browser via anonymous tracker | |
| Invite tokens and 4-character room codes | |
| Password-protected rooms | |
| Federated relay network with gossip discovery | |
| Open source communication protocol | |

### System & Infrastructure

| Feature | |
|:--------|:-:|
| Service monitor with restart controls | |
| Database backup and restore | |
| Component-level auto-updates with changelog | |
| Live MQTT message viewer (raw device traffic) | |
| Optional relay node (contribute to the network) | |
| 90-day data retention with auto-cleanup | |
| Fully local — works without internet | |
| No telemetry, no analytics, no tracking | |

---

## Installation Guide

### Step 1 — Install

```bash
curl -fsSL https://schedule4real.com/dist/install/install.sh | sudo bash
```

The script installs and configures:
- **Node.js 22** (runtime)
- **Mosquitto** (MQTT broker, ports 1883/1884/9001)
- **QuestDB** (time-series database via Docker)
- **spiderproxy** (TLS MITM proxy for Spider Farmer traffic)
- **PM2** (process manager for all services)
- **Web interface** on port 3000

### Step 2 — Network Setup (Required)

Your Spider Farmer modules talk to their cloud server on port 8883 (MQTT over TLS). You need to redirect that traffic to your Schedule 4 Real server so the proxy can intercept it.

**On your router**, create a NAT port redirect:

| Setting | Value |
|:--------|:------|
| Protocol | TCP |
| Source | Any device on your LAN |
| Destination port | 8883 |
| Redirect to | `YOUR_SERVER_IP:8883` |

<details>
<summary><strong>Router-specific examples</strong></summary>

**OPNsense / pfSense:**
- Firewall > NAT > Port Forward
- Interface: LAN, Protocol: TCP
- Destination: any, port 8883
- Redirect target: SERVER_IP:8883

**Linux (iptables):**
```bash
iptables -t nat -A PREROUTING -p tcp --dport 8883 -j DNAT --to-destination SERVER_IP:8883
```

**Generic routers:**
- Open router admin panel (usually 192.168.1.1)
- Find NAT / Port Forwarding section
- Add rule: external port 8883 TCP to internal SERVER_IP:8883

</details>

> **Tip:** Assign a static IP (DHCP reservation) to both your server and your Spider Farmer modules for a stable setup.

### Step 3 — Open the App

- **Local network:** `http://YOUR_SERVER_IP:3000`
- **With a domain (optional):** Set up a reverse proxy (Nginx, Caddy, LiteSpeed) with SSL

### Optional — HTTPS

Some features require a secure context (HTTPS):
- Voice chat (WebRTC)
- Asset caching (Service Workers)
- Remote access over the internet

Free SSL with [Caddy](https://caddyserver.com):
```bash
caddy reverse-proxy --from yourdomain.com --to localhost:3000
```

### Optional — Multiplayer Relay

To let friends join your rooms from outside your local network:
- Forward port **9443** to your server, or
- Proxy through your domain: `location /rooms { proxy_pass http://localhost:9443; }`

Your installation can also act as a **public relay node** to help other users connect — enable it from System > Relay.

---

## Architecture

```
Spider Farmer Modules (PS5, LC, CB)
    | MQTT + TLS (port 8883)
    v
spiderproxy (TLS MITM)
    | Decrypts traffic, re-publishes locally
    | Optionally bridges to Spider Farmer cloud
    v
Mosquitto MQTT Broker (1883 / 1884 / 9001)
    |
    |---> mqtt-ingestion ---> QuestDB (90-day sensor history)
    |
    |---> Nuxt Server ------> WebSocket ---> Browser (real-time)
    |                    \---> REST API ---> Browser (control)
    |
    |---> supervisor -------> Trigger engine ---> Automated actions
    |
    |---> camera-service ---> Snapshots, timelapse
```

### Tech Stack

| Layer | Technology |
|:------|:-----------|
| Frontend | Nuxt 4 + Vue 3 + TypeScript + TailwindCSS |
| 3D Engine | THREE.js |
| Backend | Nuxt Nitro (166+ API endpoints + WebSocket) |
| Database | QuestDB (time-series, append-only) |
| MQTT | Mosquitto |
| Proxy | spiderproxy (PyInstaller binary) |
| Crypto | libsodium-wrappers (WASM) |
| Video | HLS.js |
| Voice | WebRTC |
| Build | Vite + esbuild + Docker buildx (ARM64) |

---

## Spider Farmer Compatibility

Schedule 4 Real works with the complete **Spider Farmer GGS** product line through reverse-engineered MQTT protocol integration:

| Module | Model | What You Can Control |
|:-------|:------|:---------------------|
| **Spider Farmer Power Strip 5** | SF-PS5 | 5 outlets (7 modes each), exhaust fan, circulation fan, environment sensors, up to 6 soil probes |
| **Spider Farmer Light Controller** | SF-LC | Light 1 + Light 2 (Manual, TimeSlot, Cycle, PPFD Auto), sunrise/sunset simulation |
| **Spider Farmer Control Box** | SF-CB | Combined outlet + light control with fan management |

> The official Spider Farmer app continues to work alongside Schedule 4 Real. The cloud bridge is maintained by default — you get local control AND cloud access simultaneously.

**Keywords:** Spider Farmer GGS, Spider Farmer Power Strip 5, Spider Farmer Light Controller, Spider Farmer Control Box, Spider Farmer local control, Spider Farmer automation, Spider Farmer alternative app, Spider Farmer MQTT, Spider Farmer grow controller, Spider Farmer smart controller, GGS grow controller, Spider Farmer home automation, SF-PS5, SF-LC, SF-CB, grow room controller, grow room automation, indoor grow controller, PPFD controller, VPD controller

---

<p align="center">
  <a href="https://schedule4real.com">schedule4real.com</a>
</p>
