<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/SCHEDULE-4-REAL-LOGO.svg" alt="Schedule 4 Real" width="480" />
</p>

<p align="center">
  <em>WHERE REAL GROWERS COME TO PLAY</em>
</p>

<p align="center">
  <strong>Grow control &bull; Genetics lab &bull; Plant diagnostics &bull; Grow encyclopedia &bull; 3D multiplayer</strong>
</p>

<p align="center">
  <a href="https://schedule4real.com">https://schedule4real.com</a>
</p>

<p align="center">
  <a href="#-quick-install"><img src="https://img.shields.io/badge/install-one--liner-brightgreen?style=for-the-badge" alt="Install" /></a>
  <a href="#-spider-farmer-compatibility"><img src="https://img.shields.io/badge/Spider%20Farmer-GGS%20Compatible-blue?style=for-the-badge" alt="Spider Farmer" /></a>
  <a href="#-anonymous--encrypted-multiplayer"><img src="https://img.shields.io/badge/multiplayer-E2E%20encrypted-blueviolet?style=for-the-badge" alt="Encrypted" /></a>
  <a href="#-schedule-4-real-game"><img src="https://img.shields.io/badge/3D%20game-THREE.js-orange?style=for-the-badge" alt="3D Game" /></a>
  <a href="#home-assistant-integration"><img src="https://img.shields.io/badge/Home%20Assistant-compatible-18BCF2?style=for-the-badge&logo=homeassistant&logoColor=white" alt="Home Assistant" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20RPi%20%7C%20WSL%20%7C%20macOS-informational" alt="Platforms" />
  <img src="https://img.shields.io/badge/arch-x86--64%20%7C%20ARM64-informational" alt="Architectures" />
  <img src="https://img.shields.io/badge/license-source%20available-yellow" alt="License" />
  <img src="https://img.shields.io/badge/cloud-not%20required-success" alt="Local First" />
</p>

---

## Table of Contents

- [Quick Install](#quick-install)
- [What Is Schedule 4 Real?](#what-is-schedule-4-real)
- [Dashboard](#dashboard)
- [Device Control](#device-control)
- [Automation Engine](#automation-engine)
- [Plant Genetics Laboratory](#plant-genetics-laboratory)
  - [Grow Journal](#grow-journal) · [Observations](#observation-system) · [Encyclopedia](#grow-encyclopedia) · [Plant Diagnostics](#plant-problem-diagnostic) · [Strains](#strain-library) · [Breeding](#breeding-projects) · [Pheno Hunt](#pheno-hunt--keeper-selection) · [Cameras](#cameras--timelapse) · [Inputs & Recipes](#inputs--recipes) · [Reports](#reports)
- [Schedule 4 Real Game](#schedule-4-real-game)
- [Anonymous & Encrypted Multiplayer](#anonymous--encrypted-multiplayer)
  - [Inside a Room](#inside-a-room) · [Infinite Rooms](#infinite-rooms--doors) · [Locked Doors](#locked-doors--private-zones) · [Sandbox](#sandbox-mode) · [Grow Control in 3D](#real-time-grow-control-in-3d) · [Voice Chat](#voice-chat) · [TV & Streaming](#tv--streaming)
- [AI Assistant](#ai-assistant)
- [Alarms & Alerts](#alarms--alerts)
- [Complete Feature List](#complete-feature-list)
- [Installation Guide](#installation-guide)
- [Architecture](#architecture)
- [Spider Farmer Compatibility](#spider-farmer-compatibility)
- [Source Available & Self-Hosted](#source-available--self-hosted)
- [Community](#community)

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

Schedule 4 Real integrates a **complete plant genetics laboratory** for tracking strains, breeding projects, phenotype hunts, clones, and full grow cycle journals. A **pheno hunt system** with weighted scoring across six categories, radar charts, and a Keeper Engine helps you identify your best mother plants. A built-in **grow encyclopedia** with 1,000+ searchable terms covers nutrients, diseases, pests, deficiencies, training techniques, and equipment — with an **interactive diagnostic tool** that walks you through identifying plant problems step by step (location → symptoms → probable causes with remedies). It includes a **visual automation engine** where you build complex trigger flows by wiring nodes together. And it wraps everything inside a **first-person 3D game** where you can walk through virtual rooms, place interactive objects, control your real devices from in-game switches, and invite anyone into **fully anonymous, end-to-end encrypted multiplayer sessions** — no accounts, no tracking, no metadata leaks.

The game isn't just for growers. It's for anyone who wants to **learn about cultivation**, explore the encyclopedia, try the diagnostic tools, or simply **have a private space to hang out** with friends. The communication protocol is built on onion-routed circuits with military-grade cryptography, and its source code is public.

### Spider Farmer Compatibility

Currently compatible with the full **Spider Farmer GGS** ecosystem:

| Module | Code | Capabilities |
|:-------|:-----|:-------------|
| **Control Box** (CB) | 1001 | Sensors, blower, fan, heater, humidifier, dehumidifier, soil probes, CO2, PPFD |
| **Power Strip 5** (PS5) | 1002 | 5 outlets, 2 lights, sensors, optional blower/fan |
| **Power Strip 10** (PS10) | 1007 | 10 outlets, 2 lights, sensors, optional blower/fan/heater |
| **Light Controller** (LC) | 1005 | 2 light channels, brightness, spectrum, TimeSlot/PPFD modes |

All modules work simultaneously — the app auto-detects devices and their capabilities from the actual hardware connected. Run a CB + PS5 + PS10 + LC all at once.

> Future compatibility with other brands is being evaluated. The architecture is protocol-agnostic — new device integrations can be added without changing the core platform.

---

## Dashboard

Real-time monitoring and control — everything at a glance.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/dashboard.jpg" alt="Dashboard — Real-time environment monitoring" width="100%" />
</p>

The dashboard gives you a live view of your entire grow environment. All sensor data updates in real time via WebSocket — no manual refresh needed.

- **Environment sensors** — Temperature, humidity, VPD (air + leaf), CO2, PPFD — updated every few seconds
- **Soil sensors** — Up to 6 wireless probes showing soil temperature, moisture (%), and electrical conductivity (EC)
- **Day/Night statistics** — Separate min, average, and max for each sensor during light-on and light-off periods
- **Socket control** — Up to 10 outlet sockets per device with instant on/off toggle, custom naming, and mode indicator badges
- **Light status** — Brightness bar, current mode (Manual / TimeSlot / PPFD), countdown to next transition
- **Blower & fan** — Speed percentage, wattage, animated rotation indicator, fan gear bar graph
- **Climate modules** — Heater, humidifier, dehumidifier status with auto mode badges
- **Power summary** — Total consumption in watts, cost breakdown per socket and climate module, electricity cost tracking
- **Event log** — Timeline of socket state changes with timestamp and trigger source (manual or automation)
- **Multi-device** — Sockets grouped by device (PS5, PS10), device selector when no main CB is present
- **Temperature units** — Switch between Celsius and Fahrenheit globally, persists across all views
- **Charts** — Temperature, humidity, VPD, CO2, PPFD, soil sensors, blower/fan — from 1 hour to 90 days, with day/night shading, synced crosshair across all charts, and socket activity overlay

---

## Device Control

Full control over every Spider Farmer GGS module — configure modes, schedules, and automation rules per device.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/settings.jpg" alt="Settings — Device configuration and environment targets" width="100%" />
</p>

### Outlets (up to 10 per device)

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
| **PPFD Auto** | Automatically adjusts intensity to hit target photosynthetic flux (umol/m2/s) |

Sunrise/sunset simulation, dark temperature control, and per-light wattage configuration included.

### Blower, Fan & Climate Modules

- Exhaust blower with speed curve editor (temperature-responsive speed ramp) — 5 modes: Manual, Environment, Time Slot, Cycle, Trigger
- Circulation fan with oscillation modes and natural wind simulation — 5 modes: Manual, Environment, Time Slot, Cycle, Trigger
- **Climate modules** — Heater, humidifier, dehumidifier control with per-device wattage configuration
- **VPD auto-control** — Intelligent algorithm with smart escalation (+5%/2min), plateau detection after 3 failures, device substitution (blower crashing temp → auto-switch to dehumidifier), emergency overrides, post-cooling heater suppression with trend analysis, day/night transition grace periods
- **9 built-in VPD stages** — Germination through drying/curing, or manual target entry. Reads current plant stage from Laboratory
- **Blower calibration curves** — Calibrate your blower's actual temp/humidity reduction per speed level
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

Every execution is logged with timestamp, action taken, and sensor values at the time. Filter logs by 1H, 4H, 24H, or 7D. Global enable/disable lets you pause all automations with one click. Immersive full-screen mode hides the sidebar for maximum canvas space. Dynamic device selectors support all sockets and climate modules across all connected devices (PS5, PS10, CB).

---

## Plant Genetics Laboratory

A complete grow journal, strain library, breeding planner, and phenotype analysis tool — all in one place.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/Laboratory.jpg" alt="Laboratory — Plant genetics and grow journal" width="100%" />
</p>

### Grow Journal

Track every plant from seed to harvest across **15 lifecycle stages**: Germination, Seedling, Early/Mid/Late Veg, Pre-Flower, Early/Mid/Late Flower, Flush, Harvest, Drying, Curing, and Archived. Each plant gets a day counter, photo gallery, and full observation timeline. Quick-add menu lets you create rooms, plants, strains, or hunts from any tab. Onboarding wizard guides first-time users. Interactive tutorials with overlay guides.

### Observation System

Log plant health, height, notes, and photos through a step-by-step wizard with 9 observation types: general, watering, nutrients, problem, training, transplant, photo, stress event, and feeding. The system automatically captures environment data (temperature, humidity, VPD) at the moment of each observation. Track training methods applied per plant (LST, HST, topping, FIM, ScrOG, SOG). Stage-based reminders tell you when it's time to check your plants. When you flag pest, disease, or deficiency issues, the wizard opens a **dedicated diagnostic step** that guides you through identifying the problem — select affected areas, match visible symptoms, and get ranked probable causes with remedies. Health and vigor scoring (0-100) per observation.

### Grow Encyclopedia

A searchable knowledge base with 1,000+ terms organized across domains: nutrients, diseases, pests, deficiencies, training methods, and grow equipment. Every entry includes detailed descriptions, visual guides, and stage-specific care recommendations. The encyclopedia is cross-linked with observations — diagnostic results link directly to the relevant encyclopedia entry for deeper reading. Supports metric and imperial units.

### Plant Problem Diagnostic

An interactive 3-step diagnostic tool integrated into both the observation wizard and the encyclopedia:

1. **Affected Area** — Select where on the plant you see the problem (upper leaves, lower leaves, stems, roots, flowers...)
2. **Symptoms** — Match what it looks like (yellowing, spots, curling, wilting, discoloration patterns...)
3. **Results** — Get probability-ranked diagnoses with descriptions, matching symptoms highlighted, and suggested remedies

The diagnostic considers your plant's current growth stage and grow medium to narrow down results. All diagnostic data is saved with the observation for historical tracking.

### Strain Library

Catalog your genetics with breeder info, indica/sativa ratios, flowering times, seed type (regular, feminized, auto), and seed inventory. Link plants to strains for cross-strain performance comparison over time.

### Breeding Projects

Plan and track crosses with defined goals — line creation, stabilization, backcross, pheno hunting, or seed production. Manage your pollen bank (collection dates, viability, strain), evaluate males, and visualize genetic lineage with tree diagrams.

### Pheno Hunt & Keeper Selection

Score plants across 6 weighted categories (yield, potency, flavor, vigor, disease resistance, stability) using radar charts. Compare phenotypes side-by-side with photos. The **Keeper Engine** helps you identify the best mother plants based on your scoring profile (Standard, Commercial, Breeder, or Connoisseur). **Stacked hunts** enable multi-generation tracking with population counts and pressure event logging. Terpene assessment profiles per phenotype.

### Cameras & Timelapse

Connect IP cameras via RTSP for live streaming (WebRTC, MSE, HLS fallback via go2rtc). Schedule photo captures with configurable intervals, time windows, and day-of-week selection (up to 3 schedules per camera). Automatic daily timelapse video generation and multi-day merge, up to 60fps. **Chart overlay** burns a sliding per-frame sensor data graph (temperature, humidity, VPD) into timelapse videos. **Text overlay** adds custom text to post-production. Browse photo galleries organized by camera and date, with fullscreen viewer and keyboard navigation. Guest mode allows camera viewing without exposing credentials. **Lab timelapse projects** track long-form plant growth across specific stages, date ranges, cameras, rooms, and plants.

### Inputs & Recipes

Track nutrients, additives, and feeding schedules. Recipe library for reusable nutrient mixes. Soil biology tracker for monitoring substrate health.

### Gamification

XP system with badges and progress tracking to encourage consistent journaling and observation habits.

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
- **Encrypted metadata** — room names, invite codes, and connection details are encrypted before reaching the relay
- **Federated relays** — anyone can run a relay node; gossip protocol connects them

The relay and onion routing source code is public. Even if every relay were compromised, the end-to-end encryption between host and guest remains unbreakable.

---

## Inside a Room

Upload any 3D model (GLB format) as a room. Calibrate the floor and scale, choose an environment preset (Forest, Cyberpunk, Beach, Office...), and start decorating.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-main.jpg" alt="Room — First-person 3D environment" width="100%" />
</p>

Navigate with WASD, sprint with Shift, jump with Space. On mobile, use the dual-stick virtual joystick (with left-handed mode). Full gamepad support. Full physics: gravity, collision detection, dynamic ground tracking, auto step-up on small obstacles. Head bob while walking, smooth camera movement, ambient dust particles in light beams, and a radial quick-action menu on Q. **Interactive watering** — equip a watering can with particle physics, pour water on pots with per-pot soil moisture tracking and visual color feedback. Refill at water sources. Full **undo/redo** history for all edits. Mesh optimization with LOD for large rooms.

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

Place furniture, decorations, screens, interactive objects — hundreds of 3D assets auto-discovered from the asset library. Move, rotate, scale, duplicate, lock objects in place. Build procedural grow tents with configurable dimensions, reflective mylar interiors, cloth door physics, and vent ports. Connect tents to fans and filters with flexible ducting tubes that use Verlet physics simulation. Every room is your canvas.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-sandbox.jpg" alt="Sandbox — Place and arrange 3D objects" width="100%" />
</p>

---

## Real-Time Grow Control in 3D

Bind virtual objects to your real Spider Farmer devices. Display live sensor data on in-game screens. Flip switches that control actual outlets. Your grow room becomes an interactive 3D control panel.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-sensors.jpg" alt="In-game device control — Live sensor data and switches" width="100%" />
</p>

- **Display zones** — Show live temperature, humidity, VPD, CO2 on wall-mounted screens, with real-time sensor charts
- **Phone casting** — Stream your phone's Spider Farmer app to an in-game display zone via SSE
- **Device switches** — Bind any object to a real outlet or light; toggle with a click
- **Keypads** — Program action chains that execute device commands
- **Behavior triggers** — Automate actions when a player enters a zone

---

## Voice Chat

Built-in voice chat over peer-to-peer WebRTC. No Discord, no third-party app — just talk while you walk. See who's speaking, mute yourself, and adjust volume, all inside the game. Voice data flows directly between players, never through our relay servers.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-crew.jpg" alt="Multiplayer session — friends exploring together with voice chat" width="100%" />
</p>

---

## TV & Streaming

Place TVs in your rooms and tune into live IPTV channels. Browse by category (Sports, News, Music, Gaming), add custom m3u8 streams, save favorites. Watch together with friends in multiplayer.

<p align="center">
  <img src="https://schedule4real.com/dist/screenshots/room-tv.jpg" alt="In-game TV — IPTV streaming with channel browser" width="100%" />
</p>

---

## AI Assistant

Connect a local **Ollama** instance or cloud AI provider for intelligent grow optimization. Multi-turn AI chat with full grow context and persistent conversation history. **Autonomous mode** lets the AI control blower, fan, and socket decisions. AI-powered plant health diagnostics for nutrient deficiency, pest, and disease identification. Configurable model selection, system prompt customization, and connection testing.

---

## Alarms & Alerts

Configurable threshold monitoring for your entire grow environment:

- **Climate alerts** — Temperature, humidity, CO2 min/max thresholds with deadband
- **Substrate alerts** — Soil temperature, moisture, EC thresholds
- **Device alerts** — Offline detection and hardware status
- **Lab notifications** — Event-driven alerts with urgency levels (urgent, important, info) and mark-as-read

---

## Feature Comparison

Built-in side-by-side comparison of Schedule 4 Real vs the official Spider Farmer App across 12 categories and 99+ features. Status indicators show what's available, in development, planned, or limited in each platform.

---

## Complete Feature List

### Dashboard & Monitoring

- Real-time temperature, humidity, VPD, leaf VPD, CO2, PPFD
- Up to 6 wireless soil sensors (temp, moisture, EC)
- Day/Night statistics (min, avg, max per period)
- Up to 10 outlet sockets per device with instant toggle and mode badges
- Multi-device support (CB + PS5 + PS10 + LC simultaneously)
- Dual light control (brightness, mode, countdown)
- Blower speed, fan gear bar graph, wattage, CO2 close indicator
- Climate module status (heater, humidifier, dehumidifier) with auto badges
- Power consumption tracking with cost breakdown per socket and climate module
- Socket event log with trigger source
- Charts: 1h to 90 days, synced crosshair, day/night shading, socket overlay
- Custom device and socket naming
- °C / °F temperature unit toggle (global, persists across all views)

### Automation

- Visual node-based flow editor
- Sensor conditions with hysteresis and day/night thresholds
- Time schedules (range + interval modes + weekday picker)
- AND/OR logic gates
- VPD auto-control with 9 built-in stages and device role assignment
- Smart escalation with plateau detection and device substitution
- Blower calibration curve editor (sensor-to-speed mapping)
- Dynamic device selectors for all sockets and climate modules
- Execution log with full audit trail
- Immersive full-screen canvas mode
- Global enable/disable

### Laboratory

- 15-stage plant lifecycle tracking
- Observation wizard with 9 types and auto environment capture
- Dedicated diagnostic step (affected area → symptoms → results)
- AI-powered plant health diagnostics (nutrient, pest, disease)
- Training methods tracking (LST, HST, topping, FIM, ScrOG, SOG)
- Grow encyclopedia with 1,000+ searchable terms
- Photo gallery with lightbox and side-by-side comparison
- Strain library with terpene profiling and performance charts
- Breeding projects with pollen bank, male evaluation, and genetic trees
- Pheno hunt scoring with radar charts, Keeper Engine, stacked hunts
- Camera feeds with RTSP/WebRTC streaming, timelapse with chart overlay
- Lab timelapse projects linking cameras, rooms, plants, and stages
- Inputs tracking, recipe library, soil biology tracker
- Reports, analytics, trend charts, CSV export
- Grow rooms with 2D floor plan, device overlay, and environment gauges
- Notification system with urgency levels and reminders
- Gamification with XP badges and progress tracking
- Onboarding wizard and interactive tutorials

### 3D Game

- First-person navigation (WASD, sprint, jump)
- Custom GLB room upload with floor calibration
- Object placement (move, rotate, scale, duplicate, lock) with undo/redo
- Environment presets and ambient lighting control
- Interactive TVs with IPTV/HLS streaming
- Keypads with security codes and door locks
- Display zones (images, video, text, sensor charts, phone casting)
- Device bindings (control real outlets/lights from 3D)
- Behavior system (proximity triggers, action chains)
- Procedural grow tent builder (frame, mylar, cloth door, vent ports)
- Flexible ducting system (Verlet physics, connects tents to fans/filters)
- Mobile joystick controls (dual-stick, left-handed mode) + gamepad
- Room mesh editor (toggle visibility, adjust polygon count)
- Surface polygon tracing tool for interactive zones
- Interactive watering system with particle physics and soil moisture
- Mesh optimization with LOD for performance
- Audio SFX engine with haptic feedback
- Particle effects (dust motes in light beams)
- Post-processing (bloom, FXAA, color correction)

### Multiplayer

- Anonymous join — no accounts, no registration
- End-to-end encrypted (XChaCha20-Poly1305)
- Onion-routed circuits (2-hop, relay-based)
- Real-time player sync (20Hz, interpolated)
- Voice chat (WebRTC peer-to-peer)
- Public room browser via anonymous tracker
- Invite tokens and 4-character room codes
- Password-protected rooms
- Federated relay network with gossip discovery
- Open source communication protocol

### System & Infrastructure

- Service monitor with start/stop/restart controls from UI
- Database backup, restore, download, and upload from another machine
- Component-level auto-updates with SHA-256 verification and rollback
- Cumulative changelog showing all changes between versions
- Live MQTT message viewer (raw device traffic)
- Climate alarm system (temp, humidity, CO2, soil thresholds)
- AI assistant with local Ollama or cloud provider integration
- Feature comparison page (S4R vs Spider Farmer App)
- Wi-Fi hotspot setup from UI (Raspberry Pi, etc.)
- Dynamic DNS — built-in No-IP DUC and Cloudflare DNS management
- Automated Nginx + Let's Encrypt SSL setup from UI
- Reverse proxy config generator (Nginx, Caddy, Apache, LiteSpeed, Traefik)
- MQTT source filtering — whitelist UIDs, block external data
- Remote data forwarding to another server (clone/passive mode)
- Optional relay node (contribute to the decentralized network)
- 90-day data retention with auto-cleanup
- Fully local — works without internet
- Home Assistant integration via MQTT auto-discovery
- No telemetry, no analytics, no tracking

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
- **ffmpeg + ImageMagick** (timelapse video generation and overlays)
- **PM2** (process manager for all services)
- **Web interface** on port 3000
- Detects architecture (x86-64 or ARM64) and selects the correct binaries

### Step 2 — Connect Your Modules (Required)

Your Spider Farmer modules talk to their cloud server on port 8883 (MQTT over TLS). You need to redirect that traffic to your Schedule 4 Real server so the proxy can intercept it. Choose one of these methods:

#### Method A: Wi-Fi Hotspot (Easiest)

Your server creates a dedicated Wi-Fi network for the controllers. **No router configuration needed.**

Requires: server with both Ethernet and Wi-Fi (Raspberry Pi, laptop, or PC with USB Wi-Fi adapter).

1. In the app, go to **Settings > How to Install > Connect Devices**
2. Select **Wi-Fi Hotspot**, enter a network name and password, click **Create Hotspot**
3. On the GGS controller, **hold the mode button for 5 seconds** to enter pairing mode
4. Use the Spider Farmer phone app to connect the controller to the hotspot network

Or via command line: `cd ~/schedule-4-real && sudo bash setup-hotspot.sh`

#### Method B: Router NAT (Advanced)

Redirect outgoing port 8883 traffic from your LAN to your server. Requires a router that supports outgoing NAT redirect (pfSense, OPNsense, MikroTik, OpenWrt, or Linux with iptables).

> **Note:** Most consumer routers (TP-Link, Netgear, Asus) do NOT support outgoing NAT redirect. Use the Wi-Fi Hotspot method instead.

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

**MikroTik:**
```bash
/ip firewall nat add chain=dstnat protocol=tcp dst-port=8883 action=dst-nat to-addresses=SERVER_IP to-ports=8883
```

**Linux (iptables):**
```bash
iptables -t nat -A PREROUTING -p tcp --dport 8883 -j DNAT --to-destination SERVER_IP:8883
iptables -t nat -A POSTROUTING -j MASQUERADE
```

</details>

> **Tip:** Assign a static IP (DHCP reservation) to your server for a stable setup.

After either method, restart your Spider Farmer modules (unplug and plug back in). Within a minute, sensor data will appear in the Dashboard.

### Step 3 — Open the App

- **Local network:** `http://YOUR_SERVER_IP:3000`
- **With a domain (optional):** Set up a reverse proxy (Nginx, Caddy, LiteSpeed) with SSL

### Optional — Domain & HTTPS

Some features require a secure context (HTTPS):
- Voice chat (WebRTC)
- Asset caching (Service Workers)
- Remote access over the internet

**Get a free domain** from [noip.com](https://www.noip.com/sign-up) — or install the No-IP DUC client directly from the app UI. Cloudflare DNS management is also built in.

The app generates ready-to-use reverse proxy configs for **Nginx, Caddy, Apache, LiteSpeed, and Traefik** — enter your domain in **Settings > How to Install > Your Domain**. If using Nginx, the app can install it and set up Let's Encrypt SSL automatically.

**Caddy** is the easiest option — handles SSL and WebSockets automatically:
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
Spider Farmer Modules (PS5, PS10, CB, LC)
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
    |---> supervisor -------> VPD automation, triggers, cameras, updates
    |
    |---> tunnel-agent -----> Relay network (onion routing)
    |
    |---> Home Assistant ---> MQTT discovery bridge
```

### Tech Stack

| Layer | Technology |
|:------|:-----------|
| Frontend | Nuxt 4 + Vue 3 + TypeScript + TailwindCSS |
| 3D Engine | THREE.js via TresJS |
| Backend | Nuxt Nitro (280+ API endpoints + WebSocket + SSE) |
| Database | QuestDB (time-series, append-only, Docker) |
| MQTT | Mosquitto |
| Proxy | spiderproxy (PyInstaller binary, x86-64 + ARM64) |
| Streaming | go2rtc (WebRTC, MSE, HLS) |
| Video | ffmpeg + ImageMagick (timelapse, overlays) |
| Crypto | libsodium-wrappers (WASM) |
| Voice | WebRTC (peer-to-peer) |
| Process | PM2 |
| Build | Vite + esbuild + Docker buildx (ARM64) |

---

## Spider Farmer Compatibility

Schedule 4 Real works with the complete **Spider Farmer GGS** product line through reverse-engineered MQTT protocol integration:

| Module | What You Can Control |
|:-------|:---------------------|
| **Control Box** (CB) | Environment sensors, blower, fan, heater, humidifier, dehumidifier, up to 6 soil probes, CO2, PPFD |
| **Power Strip 5** (PS5) | 5 outlets (7 modes each), 2 lights, sensors, optional blower/fan |
| **Power Strip 10** (PS10) | 10 outlets (7 modes each), 2 lights, sensors, optional blower/fan/heater |
| **Light Controller** (LC) | Light 1 + Light 2 (Manual, TimeSlot, PPFD Auto), sunrise/sunset simulation |

> The official Spider Farmer app continues to work alongside Schedule 4 Real. The cloud bridge is maintained by default — you get local control AND cloud access simultaneously.

### Home Assistant Integration

Bridge your Spider Farmer devices to [Home Assistant](https://www.home-assistant.io/) via MQTT auto-discovery. Every sensor, outlet, and light channel is exposed as a native entity — integrate your grow room into your full home automation setup with zero cloud dependency.

| Entity Type | Examples |
|:------------|:---------|
| **Sensors** | Temperature, humidity, VPD, leaf VPD, CO2, PPFD, soil moisture, soil EC — with long-term statistics |
| **Switches** | Up to 10 outlet sockets per device with on/off control |
| **Dimmers** | Light 1 + Light 2 brightness as number entities |
| **Fans** | Blower and circulation fan speed, natural wind mode |
| **Climate** | Heater, humidifier, dehumidifier on/off states |

All communication stays local — Home Assistant talks to Schedule 4 Real's MQTT broker on your LAN. No cloud service, no API keys, no internet required.

**Keywords:** Spider Farmer GGS, Spider Farmer Power Strip 5, Spider Farmer Power Strip 10, Spider Farmer Light Controller, Spider Farmer Control Box, Spider Farmer local control, Spider Farmer automation, Spider Farmer alternative app, Spider Farmer MQTT, Spider Farmer grow controller, Spider Farmer smart controller, GGS grow controller, Spider Farmer home automation, Spider Farmer Home Assistant, SF-PS5, SF-PS10, SF-LC, SF-CB, grow room controller, grow room automation, indoor grow controller, PPFD controller, VPD controller, Home Assistant grow room, MQTT grow controller, source available grow controller, self-hosted grow controller

---

## Source Available & Self-Hosted

Schedule 4 Real runs entirely on your hardware. No cloud services, no subscriptions, no data leaving your network.

- **Source available** — the onion relay network, encryption protocol, MQTT proxy, installer, and service infrastructure are fully open source. The web application is distributed as a compiled package while commercial partnerships with equipment brands are being finalized. A full open source release is planned for the future
- **Self-hosted** — runs on a Raspberry Pi, a NUC, a Proxmox VM, or any Linux machine
- **Works offline** — full functionality without internet access
- **Zero telemetry** — nothing phones home, no analytics, no crash reports
- **Auto-updates** — component-level updates with SHA-256 verification and automatic rollback on failure
- **Backup & restore** — one-click database backups, downloadable, uploadable from another machine, restorable to any point

---

## Community

<p align="center">
  <a href="https://discord.gg/wZU6mnY2Sn"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
</p>

---

## Sponsor

Schedule 4 Real is sponsored by [WEEDLIX](https://weedlix.com).

---

<p align="center">
  <a href="https://schedule4real.com">schedule4real.com</a>
</p>
