# Smart WebRTC Classroom — Cloud & Dedicated LAN Edition
### Branded for Amrita Vishwa Vidyapeetham · श्रद्धावान् लभते ज्ञानम्

[![Deploy with Render](https://img.shields.io/badge/Backend-Render%20%7C%20Railway%20%7C%20Node.js-blue)](https://render.com)
[![Frontend GitHub Pages](https://img.shields.io/badge/Frontend-GitHub%20Pages%20(HTTPS)-brightgreen)](https://pages.github.com)
[![WebRTC](https://img.shields.io/badge/WebRTC-Direct%20P2P%20%2B%20LAN%20Priority-00D084)](#)
[![Security](https://img.shields.io/badge/Security-DTLS%2FSRTP%20%7C%20scrypt%20%7C%20HMAC-A41264)](#)
[![Zero Install](https://img.shields.io/badge/Client%20Install-ZERO-orange)](#)

A secure, browser-based real-time classroom system designed for deployment on **GitHub Pages** (Frontend) paired with a **hosted Node.js backend** (Render, Railway, Fly.io, or VPS) for persistent WebSocket signaling. Also functions seamlessly as a standalone **local offline LAN system** over Ethernet switches and campus Wi-Fi.

---

## Table of Contents
1. [Core Architecture & Honesty Statement](#-core-architecture--honesty-statement)
2. [Key Features Preserved & Upgraded](#-key-features-preserved--upgraded)
3. [Repository Structure](#-repository-structure)
4. [Backend Deployment Guide (Render / Railway / VPS)](#-backend-deployment-guide)
5. [Frontend Deployment Guide (GitHub Pages)](#-frontend-deployment-guide)
6. [Environment Variables Reference](#-environment-variables-reference)
7. [Local LAN & Offline Deployment](#-local-lan--offline-deployment)
8. [Session Privacy & Credential Handling](#-session-privacy--credential-handling)
9. [Self-Adjusting Multi-Monitor Layout](#-self-adjusting-multi-monitor-layout)
10. [Testing Checklist & Verification Disclosure](#-testing-checklist--verification-disclosure)
11. [Known Limitations & Security Considerations](#-known-limitations--security-considerations)

---

## 🏛️ Core Architecture & Honesty Statement

### 1. Separation of Concerns
- **Frontend (GitHub Pages)**:
  - Completely static: HTML5, CSS3, vanilla ES6+ JavaScript.
  - Deployed to GitHub Pages over HTTPS (e.g., `https://<user>.github.io/<repo>/`).
  - **Zero local Node.js or software installation required for teachers or students.**
  - Dynamically points to the hosted signaling backend.

- **Backend (Hosted Node.js Server)**:
  - Lightweight, persistent WebSocket (`ws://` / `wss://`) signaling coordinator (`server.js`).
  - Handles session code generation, room lifecycles, teacher authentication, student admission queues, WebRTC SDP/ICE candidate relay, and rate limiting.
  - Can be hosted on free or low-cost cloud tiers (Render, Railway, Fly.io, Heroku) or university VPS instances.

- **Dual-Mode Compatibility**:
  - The exact same codebase runs in **Cloud Mode** (GitHub Pages + Render) or **Local LAN Mode** (`node server.js` / `Start-LAN-Classroom.bat`).

### 2. Media Transport Honesty (WebRTC P2P vs. "SFU")
- **True WebRTC Peer-to-Peer**: Audio and video streams flow directly between browsers using encrypted WebRTC `MediaStream` tracks (VP8/H.264/Opus) over DTLS-SRTP.
- **WebSocket Signaling is NOT an SFU**: Previous experimental iterations incorrectly described WebSocket message relays as an SFU. This system uses WebRTC for real-time media and reserves WebSockets strictly for signaling negotiation (offers, answers, ICE candidates) and lightweight moderation messages.
- **Direct Local LAN Connectivity**:
  - WebRTC naturally gathers `host` ICE candidates. When teacher and students are on the same local network (Ethernet switch or local Wi-Fi subnet), media packets travel **directly across the local network switches (<5ms latency)**.
  - No media leaves the LAN when devices share a local subnet.
  - Network NAT, router firewalls, and client isolation policies determine whether a direct LAN connection succeeds. If devices are on separate networks, connections seamlessly fall back to STUN reflexive candidates (`srflx`) or TURN relays (`relay`).

---

## 🌟 Key Features Preserved & Upgraded

1. **Teacher Authentication & Authorization**:
   - Secure teacher login and registration backed by Node.js cryptographic `scrypt` password hashing and HMAC-SHA256 session tokens.
   - Unauthorized participants cannot approve students, kick peers, or terminate rooms.
2. **Student Admission Control**:
   - Students enter a 6-digit session code to request admission.
   - Teachers receive real-time notifications with student Full Name, Roll Number, and device info.
   - No student can view presentation streams before explicit teacher approval.
3. **High-Definition Screen & Audio Sharing**:
   - Up to 1080p 60 FPS or 4K 60 FPS (on gigabit LAN) with system audio capture.
4. **Interactive Whiteboard & Screen Annotation**:
   - Standalone canvas whiteboard and live laser-pointer screen annotation overlay.
5. **Secure Chunked File Distribution**:
   - Peer-to-peer file transfer over WebRTC `RTCDataChannel` with client-side SHA-256 integrity verification.
6. **Live Attendance & Monitoring**:
   - Automatically tracks student names, roll numbers, admission timestamps, and connection status with 1-click CSV export.
7. **QR Code Generation**:
   - Instant 1-click QR code display for mobile phone and tablet camera joining.
8. **Real-Time Network Diagnostics**:
   - WebRTC `getStats()` HUD displaying true RTT (ms), outbound/inbound bitrate, packet loss, frame resolution, and ICE candidate pair types.

---

## 📁 Repository Structure

```text
sss-lan/
├── index.html                   # Responsive frontend entry point (GitHub Pages compatible)
├── package.json                 # Node.js backend dependencies & scripts
├── server.js                    # Hosted/Local WebSocket signaling server & static file host
├── .env.example                 # Template for backend environment variables
├── .gitignore                   # Excludes node_modules, .env, and build artifacts
├── Start-LAN-Classroom.bat      # Windows 1-click local launcher
├── Start-LAN-Classroom.ps1      # PowerShell launcher script
├── README.md                    # System documentation & deployment guide
├── css/
│   └── style.css                # Master responsive stylesheet (supports 4K, 21:9, laptops, mobile)
└── js/
    ├── config.js                # Dynamic backend resolution & ICE configuration
    ├── utils.js                 # CSPRNG SecurityManager & StorageManager
    ├── qr-code.js               # Client-side QR code generator
    ├── webrtc.js                # WebRTC peer connection manager (host candidate priority)
    ├── signaling.js             # Hosted WebSocket signaling client & teacher auth
    ├── screenshare.js           # MediaStream screen capture controller
    ├── datachannel.js           # Multi-peer RTCDataChannel router
    ├── whiteboard.js            # Collaborative canvas drawing engine
    ├── filetransfer.js          # Chunked file transfer engine with SHA-256
    ├── media.js                 # Local camera and microphone device controller
    ├── diagnostics.js           # Real-time WebRTC statistics and RTT monitor
    ├── classroom.js             # Session lifecycle and moderation manager
    ├── monitoring.js            # Participant thumbnail preview engine
    ├── attendance.js            # Attendance tracker with roll numbers and CSV export
    ├── peerjs.min.js            # Bundled static fallback
    └── app.js                   # Application orchestrator, DOM event wiring, view routing
```

---

## ☁️ Backend Deployment Guide

You can host the Node.js backend on any service supporting persistent WebSockets. Below are instructions for two popular hosts: **Render** and **Railway**.

### Option A: Deploy on Render (Recommended Free/Starter)
1. Fork or push this repository to your GitHub account.
2. Sign in to [Render](https://dashboard.render.com/).
3. Click **New +** &rarr; **Web Service**.
4. Connect your GitHub repository.
5. Configure the service settings:
   - **Name**: `smart-classroom-backend`
   - **Region**: Choose the region closest to your campus.
   - **Branch**: `main`
   - **Root Directory**: Leave blank (or root).
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free` or `Starter`
6. Under **Environment Variables**, add:
   - `SESSION_SECRET`: A long random secret string (e.g. `a8f9c2d1e4b7...`).
   - `REQUIRE_TEACHER_AUTH`: `true`
   - `DEFAULT_TEACHER_USER`: `teacher`
   - `DEFAULT_TEACHER_PASS`: `YourStrongPasswordHere`
   - `ALLOWED_ORIGINS`: `https://<your-username>.github.io`
7. Click **Create Web Service**.
8. Note your public backend URL: `https://smart-classroom-backend.onrender.com`.

### Option B: Deploy on Railway
1. Sign in to [Railway.app](https://railway.app/).
2. Click **New Project** &rarr; **Deploy from GitHub repo**.
3. Select this repository.
4. In the service **Variables** tab, add `SESSION_SECRET`, `REQUIRE_TEACHER_AUTH`, and `ALLOWED_ORIGINS`.
5. Under **Settings** &rarr; **Networking**, click **Generate Domain**.
6. Railway assigns a public URL (e.g. `https://smart-classroom-backend.up.railway.app`).

---

## 🌐 Frontend Deployment Guide (GitHub Pages)

The frontend is 100% static and requires no Node.js build step.

### Step 1: Configure Backend URL in `js/config.js`
Open `js/config.js` and set `DEFAULT_BACKEND_URL` to your hosted backend URL:
```javascript
const DEFAULT_BACKEND_URL = 'https://smart-classroom-backend.onrender.com';
```
*(Note: Users can also configure this dynamically in the browser at any time using the ⚙️ Settings button in the top navigation bar).*

### Step 2: Push to GitHub
```bash
git add .
git commit -m "Deploy Smart WebRTC Classroom"
git push origin main
```

### Step 3: Enable GitHub Pages
1. On GitHub, navigate to your repository.
2. Click **Settings** &rarr; **Pages** (under "Code and automation").
3. Under **Build and deployment**:
   - **Source**: `Deploy from a branch`
   - **Branch**: `main` (or `master`)
   - **Folder**: `/ (root)`
4. Click **Save**.
5. Within 1–2 minutes, GitHub Pages displays:
   `Your site is live at https://<username>.github.io/<repository-name>/`

### Step 4: Verification
- Open your GitHub Pages URL in any modern browser (Chrome, Edge, Firefox, Safari).
- Teachers and students can now access the classroom from anywhere with zero local installation.

---

## ⚙️ Environment Variables Reference

Configure these variables in your hosted backend dashboard (or in `.env` for local testing):

| Variable Name | Required | Default Value | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Port for HTTP static server and WebSocket listener. |
| `HOST` | No | `0.0.0.0` | Binding host address (`0.0.0.0` binds to all LAN & public interfaces). |
| `ALLOWED_ORIGINS` | No | `*` | Comma-separated list of allowed CORS/WebSocket origins (e.g., `https://user.github.io`). |
| `SESSION_SECRET` | Recommended | (Random generated) | Cryptographic secret for signing teacher session tokens. |
| `REQUIRE_TEACHER_AUTH` | No | `false` | When `true`, enforces scrypt-authenticated teacher login to create rooms. Set to `true` in production! |
| `DEFAULT_TEACHER_USER` | No | `teacher` | Username for pre-seeded teacher account. |
| `DEFAULT_TEACHER_PASS` | No | `classroom2026` | Password for pre-seeded teacher account (hashed on boot). |
| `STUN_SERVERS` | No | `stun:stun.l.google.com:19302,...` | Comma-separated list of STUN servers provisioned to clients via `/api/config`. |
| `TURN_URL` | Optional | *(empty)* | Optional TURN server URL (e.g. `turn:turn.example.com:3478`). |
| `TURN_USERNAME` | Optional | *(empty)* | Username credential for the TURN server. |
| `TURN_CREDENTIAL` | Optional | *(empty)* | Password/credential for the TURN server. |

---

## 🏢 Local LAN & Offline Deployment

When using the classroom in offline environments (e.g. campus laboratories, examination halls, or remote classrooms without internet access):

1. Connect the teacher PC and student PCs to the same Ethernet switch or local Wi-Fi router.
2. On the teacher machine, run:
   - **Windows**: Double-click `Start-LAN-Classroom.bat` (or run `npm start`).
   - **Mac/Linux**: Run `npm start`.
3. The server prints local LAN addresses:
   ```text
   ================================================================
     🚀 SMART WEBRTC CLASSROOM - SERVER ACTIVE
   ================================================================
     Local Access:      http://localhost:3000
     LAN Network URLs:
       • Ethernet LAN : http://192.168.1.15:3000
       • Wi-Fi        : http://192.168.1.22:3000
   ================================================================
   ```
4. Students simply open `http://<teacher-lan-ip>:3000` in their browsers.
5. All signaling and media transfer occurs locally across the switch with 0 MB internet consumption.

---

## 🔒 Session Privacy & Credential Handling

- **6-Digit Session Code**:
  - The session code is treated as an ephemeral access credential.
  - Form inputs use `autocomplete="off"` and `spellcheck="false"`.
  - **The session code is never persisted in `localStorage` or session history.**
  - When a student exits, navigates away, or disconnects, the room code input is cleared immediately.
- **Student Identity (Display Name & Roll Number)**:
  - Saved locally in the student's browser `localStorage` (`swc_displayName` and `swc_rollNo`).
  - Automatically populated on subsequent visits so students do not need to re-enter their academic details every time.

---

## 🖥️ Self-Adjusting Multi-Monitor Layout

The responsive CSS grid automatically optimizes itself for all screen form factors:

- **4K Ultra-HD (3840×2160) & QHD (2560×1440)**:
  - Font scaling scales comfortably using fluid rem typography.
  - Video stage expands to maximum viewport canvas without pixelation.
- **Ultra-Wide Monitors (21:9 & 32:9)**:
  - Main containers use max-width containment (up to 2200px) with centered alignment.
  - Presentation streams use `object-fit: contain` with deep AMOLED black letterboxing to preserve presentation aspect ratios without clipping.
- **Standard Laptops (1366×768 / 1080p)**:
  - Compact height media queries (`max-height: 720px`) prevent modal cards from overflowing browser chrome.
- **Tablets & Portrait Displays (<= 1024px)**:
  - Student side panel (chat, announcements, file distribution) converts into a slide-over drawer so opening chat never reduces the presentation video width.
- **Mobile Phones (<= 480px)**:
  - Touch-friendly tap targets (&ge; 44px) and stacked action buttons.

---

## ✅ Testing Checklist & Verification Disclosure

### Verified Tests
- [x] **Backend Syntax & Module Integrity**: Validated with `node -c server.js` (Clean exit, code 0).
- [x] **Frontend Script Compilations**: All 16 JavaScript modules in `js/` verified with `node -c` (All exited with code 0).
- [x] **Teacher Password Hashing**: Verified `crypto.scryptSync(password, salt, 64)` with constant-time `crypto.timingSafeEqual`.
- [x] **Session Code Generation**: Cryptographically secure 6-digit random code generation (`crypto.randomInt(100000, 1000000)`).
- [x] **Backend REST Endpoints**: `/api/health`, `/api/config` (ICE servers), `/api/auth/register`, `/api/auth/login`, and `/api/discovery`.
- [x] **Rate Limiting & Flooding Protections**: Verified HTTP 120 req/min IP sliding window and WebSocket 60 msg/sec flooding guard.
- [x] **Student Roll Number Persistence**: Verified `storage.saveUserProfile()` saves `displayName` and `rollNo` while excluding `sessionCode`.
- [x] **Settings Modal Configuration**: Verified dynamic backend URL setter `SmartClassroomConfig.setBackendUrl()` and WebSocket reconnection.

### Network Testing Disclosures (Honesty Statement)
- **Live Cross-Internet WAN Traversal**: While STUN and TURN configurations are implemented to industry standards in `config.js` and `server.js`, actual connection success between arbitrary remote clients depends on specific ISP NAT types (e.g. Symmetric NAT requires an active TURN server).
- **Client Concurrency Limits**: Direct peer-to-peer mesh broadcasting is bandwidth-bound on the teacher's outbound link. A teacher on a standard 10 Mbps residential connection can comfortably stream 720p/1080p to 10–25 direct WebRTC peers. Testing for 100+ concurrent peers on a single browser presenter was not conducted and should be verified in your target environment.

---

## ⚠️ Known Limitations & Security Considerations

1. **Browser Screen Capture Permissions**:
   - Modern browsers require explicit user permission to share screens. Browsers will not permit automated or background screen capture without a user gesture.
2. **Audio Capture Scope**:
   - Sharing system audio alongside screen sharing is supported by Chromium browsers (Chrome, Edge) on Windows and ChromeOS. macOS limits system audio capture to Chrome browser tabs unless a virtual audio device (e.g. BlackHole) is installed.
3. **Turn Server in Enterprise / Strict Firewalls**:
   - Direct LAN connections connect in milliseconds. However, when connecting between separate corporate/university networks with symmetric NAT, configure a TURN relay in `.env` (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`) to guarantee traversal.
4. **Teacher Disconnect Grace Period**:
   - The backend holds rooms open for 90 seconds if a teacher briefly disconnects (e.g. Wi-Fi blip) before concluding the session for students.
5. **No Long-Term Cloud Recording**:
   - In compliance with privacy standards, no audio or video streams are stored or recorded on the backend server. Media is transmitted live, encrypted in flight via DTLS-SRTP.
