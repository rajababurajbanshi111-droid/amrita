/**
 * SMART WEBRTC CLASSROOM - Production Node.js Backend & WebRTC Signaling Server
 * 
 * Supports both:
 * 1. Hosted Cloud Deployment (Render, Railway, Fly.io, Heroku, VPS) with WSS & HTTPS.
 * 2. Pure Offline Local LAN / Ethernet Deployment.
 * 
 * Architecture:
 * - Secure Teacher Authentication (Scrypt password hashing, session tokens)
 * - Cryptographic 6-digit session code generation & room lifecycle management
 * - Rate limiting against brute-force attacks and socket abuse
 * - WebRTC Signaling Broker (Offer/Answer/ICE candidate exchange)
 * - Dynamic STUN/TURN server provisioning via /api/config
 * - Student admission approval queue and teacher moderation
 * - Static client file serving for local deployment & CORS-enabled for GitHub Pages
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// --- 1. Environment & Configuration ---
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CLIENT_DIR = __dirname;

// Allowed frontend origins (e.g. GitHub Pages https://<username>.github.io, localhost)
const rawAllowedOrigins = process.env.ALLOWED_ORIGINS || '';
const ALLOWED_ORIGINS = rawAllowedOrigins
  ? rawAllowedOrigins.split(',').map((o) => o.trim().toLowerCase())
  : [];

// STUN / TURN Server Configuration from Environment
const STUN_SERVERS = (process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
  .split(',')
  .map((s) => ({ urls: s.trim() }));

const TURN_URL = process.env.TURN_URL || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

const ICE_SERVERS = [...STUN_SERVERS];
if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
  ICE_SERVERS.push({
    urls: TURN_URL.split(',').map((u) => u.trim()),
    username: TURN_USERNAME,
    credential: TURN_CREDENTIAL
  });
}

// Session Secret for HMAC tokens
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ============================================================================
// 2. Teacher Authentication & Security Subsystem
// ============================================================================

class TeacherAuthManager {
  constructor() {
    this.teachers = new Map(); // username -> { username, displayName, salt, hash, createdAt }
    this.activeTokens = new Map(); // token -> { username, displayName, createdAt, expiresAt }
    this.tokenLifetimeMs = 24 * 60 * 60 * 1000; // 24 hours

    // Seed optional default admin account if provided in environment
    const defaultUser = process.env.DEFAULT_TEACHER_USER;
    const defaultPass = process.env.DEFAULT_TEACHER_PASS;
    if (defaultUser && defaultPass) {
      this.register(defaultUser, defaultPass, process.env.DEFAULT_TEACHER_NAME || 'Professor');
      console.log(`[Auth] Seeded default teacher account: ${defaultUser}`);
    }
  }

  hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  register(username, password, displayName) {
    const cleanUser = (username || '').trim().toLowerCase();
    const cleanName = (displayName || '').trim() || cleanUser;

    if (!cleanUser || cleanUser.length < 3 || cleanUser.length > 30) {
      return { success: false, reason: 'Username must be between 3 and 30 characters.' };
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(cleanUser)) {
      return { success: false, reason: 'Username can only contain letters, numbers, dots, and underscores.' };
    }
    if (!password || password.length < 6) {
      return { success: false, reason: 'Password must be at least 6 characters long.' };
    }
    if (this.teachers.has(cleanUser)) {
      return { success: false, reason: 'Username is already registered. Please sign in.' };
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = this.hashPassword(password, salt);

    const record = {
      username: cleanUser,
      displayName: cleanName,
      salt,
      hash,
      createdAt: Date.now()
    };
    this.teachers.set(cleanUser, record);

    // Automatically issue token
    const token = this.createSessionToken(record);
    return {
      success: true,
      token,
      user: { username: cleanUser, displayName: cleanName }
    };
  }

  login(username, password) {
    const cleanUser = (username || '').trim().toLowerCase();
    const record = this.teachers.get(cleanUser);

    if (!record) {
      return { success: false, reason: 'Invalid username or password.' };
    }

    const computedHash = this.hashPassword(password, record.salt);
    const hashBuffer = Buffer.from(record.hash, 'hex');
    const compBuffer = Buffer.from(computedHash, 'hex');

    if (hashBuffer.length !== compBuffer.length || !crypto.timingSafeEqual(hashBuffer, compBuffer)) {
      return { success: false, reason: 'Invalid username or password.' };
    }

    const token = this.createSessionToken(record);
    return {
      success: true,
      token,
      user: { username: record.username, displayName: record.displayName }
    };
  }

  createSessionToken(record) {
    const randomHex = crypto.randomBytes(32).toString('hex');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(`${record.username}:${randomHex}`).digest('hex');
    const token = `${randomHex}.${signature}`;

    const now = Date.now();
    this.activeTokens.set(token, {
      username: record.username,
      displayName: record.displayName,
      createdAt: now,
      expiresAt: now + this.tokenLifetimeMs
    });

    return token;
  }

  validateToken(token) {
    if (!token || typeof token !== 'string') return null;
    const session = this.activeTokens.get(token);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.activeTokens.delete(token);
      return null;
    }
    return session;
  }

  invalidateToken(token) {
    return this.activeTokens.delete(token);
  }
}

// ============================================================================
// 3. Session & Classroom Manager
// ============================================================================

class SessionManager {
  constructor() {
    this.rooms = new Map(); // roomCode -> RoomInfo
    this.maxStudentsPerRoom = parseInt(process.env.MAX_STUDENTS_PER_ROOM || '150', 10);
    this.roomTimeoutMs = 3 * 60 * 60 * 1000; // 3 hours max session lifetime
    this.teacherGracePeriodMs = 90 * 1000;   // 90s grace period for teacher reconnection

    // Sweep stale rooms periodically
    this.cleanupTimer = setInterval(() => this.cleanupStaleRooms(), 5 * 60 * 1000);
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  generateSessionCode() {
    const chars = '0123456789';
    let code = '';
    let attempts = 0;
    do {
      const bytes = crypto.randomBytes(6);
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars[bytes[i] % chars.length];
      }
      attempts++;
    } while (this.rooms.has(code) && attempts < 10000);
    return code;
  }

  createRoom(teacherId, teacherName, teacherToken, requestedCode = null) {
    let code = requestedCode;

    // Allow re-claiming existing room if matching teacherToken
    if (code && this.rooms.has(code)) {
      const existing = this.rooms.get(code);
      if (existing.teacherToken === teacherToken) {
        existing.teacherId = teacherId;
        existing.teacherName = teacherName;
        existing.lastActivity = Date.now();
        console.log(`[SessionManager] Teacher ${teacherName} re-claimed room ${code}`);
        return existing;
      }
    }

    if (!code || this.rooms.has(code)) {
      code = this.generateSessionCode();
    }

    const room = {
      code,
      teacherId,
      teacherName,
      teacherToken,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      maxStudents: this.maxStudentsPerRoom,
      students: new Map(),      // studentId -> { id, name, rollNo, joinedAt }
      pendingQueue: new Map()   // studentId -> { id, name, rollNo, joinedAt, clientInfo }
    };

    this.rooms.set(code, room);
    console.log(`[SessionManager] Created classroom: ${code} by ${teacherName} (Teacher ID: ${teacherId})`);
    return room;
  }

  getRoom(code) {
    if (!code) return null;
    return this.rooms.get(code.trim());
  }

  verifyTeacher(code, teacherToken) {
    const room = this.getRoom(code);
    if (!room || !teacherToken) return false;
    return room.teacherToken === teacherToken;
  }

  addPendingStudent(code, studentId, studentName, rollNo, clientInfo) {
    const room = this.getRoom(code);
    if (!room) return { ok: false, reason: 'Classroom not found or session has expired.' };

    if (room.students.size >= room.maxStudents) {
      return { ok: false, reason: `Classroom has reached maximum capacity (${room.maxStudents} students).` };
    }

    room.lastActivity = Date.now();
    room.pendingQueue.set(studentId, {
      id: studentId,
      name: studentName,
      rollNo: rollNo || 'N/A',
      joinedAt: Date.now(),
      clientInfo: clientInfo || {}
    });

    return { ok: true, room };
  }

  approveStudent(code, studentId, teacherToken) {
    const room = this.getRoom(code);
    if (!room) return null;
    if (room.teacherToken !== teacherToken) return null;

    const student = room.pendingQueue.get(studentId);
    if (!student) return null;

    room.pendingQueue.delete(studentId);
    student.approved = true;
    room.students.set(studentId, student);
    room.lastActivity = Date.now();
    return student;
  }

  rejectStudent(code, studentId, teacherToken) {
    const room = this.getRoom(code);
    if (!room) return false;
    if (room.teacherToken !== teacherToken) return false;

    return room.pendingQueue.delete(studentId);
  }

  removeParticipant(socketId) {
    for (const [code, room] of this.rooms.entries()) {
      if (room.teacherId === socketId) {
        return { roomCode: code, wasTeacher: true, room };
      }
      if (room.students.has(socketId)) {
        room.students.delete(socketId);
        return { roomCode: code, wasTeacher: false, room };
      }
      if (room.pendingQueue.has(socketId)) {
        room.pendingQueue.delete(socketId);
        return { roomCode: code, wasTeacher: false, room };
      }
    }
    return null;
  }

  deleteRoom(code, teacherToken) {
    const room = this.getRoom(code);
    if (!room) return false;
    if (teacherToken && room.teacherToken !== teacherToken) return false;

    return this.rooms.delete(code);
  }

  cleanupStaleRooms() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      if (now - room.lastActivity > this.roomTimeoutMs) {
        this.rooms.delete(code);
        console.log(`[SessionManager] Cleaned up inactive room: ${code}`);
      }
    }
  }

  getActiveRoomCount() {
    return this.rooms.size;
  }

  getTotalStudentCount() {
    let total = 0;
    for (const room of this.rooms.values()) {
      total += room.students.size;
    }
    return total;
  }
}

// ============================================================================
// 4. Rate Limiter & Input Security Guard
// ============================================================================

class AuthGuard {
  constructor() {
    this.ipAttempts = new Map(); // ip -> { count, windowStart }
    this.maxAttemptsPerMinute = 120; // 120 requests/min per IP
    this.socketMessageCounts = new Map(); // socket -> { count, windowStart }
  }

  isRateLimited(ip) {
    const now = Date.now();
    const record = this.ipAttempts.get(ip);
    if (!record) {
      this.ipAttempts.set(ip, { count: 1, windowStart: now });
      return false;
    }

    if (now - record.windowStart > 60000) {
      record.count = 1;
      record.windowStart = now;
      return false;
    }

    record.count++;
    return record.count > this.maxAttemptsPerMinute;
  }

  isSocketFlooding(ws) {
    const now = Date.now();
    let record = this.socketMessageCounts.get(ws);
    if (!record) {
      record = { count: 1, windowStart: now };
      this.socketMessageCounts.set(ws, record);
      return false;
    }

    if (now - record.windowStart > 1000) {
      record.count = 1;
      record.windowStart = now;
      return false;
    }

    record.count++;
    return record.count > 60; // Max 60 messages/sec per WebSocket
  }

  cleanSocket(ws) {
    this.socketMessageCounts.delete(ws);
  }

  isValidRoomCode(code) {
    if (!code || typeof code !== 'string') return false;
    return /^\d{6}$/.test(code.trim());
  }

  sanitizeString(input, maxLength = 100) {
    if (typeof input !== 'string') return '';
    return input.replace(/[<>]/g, '').trim().slice(0, maxLength);
  }
}

// ============================================================================
// 5. WebRTC Signaling Protocol Handler
// ============================================================================

class SignalingHandler {
  constructor(sessionManager, authManager, authGuard) {
    this.sessionManager = sessionManager;
    this.authManager = authManager;
    this.authGuard = authGuard;

    this.clients = new Map();     // ws -> ClientConnection
    this.clientsById = new Map(); // clientId -> ClientConnection
    this.teacherGraceTimers = new Map(); // roomCode -> Timer

    // Heartbeat watchdog (30 seconds)
    this.heartbeatTimer = setInterval(() => this.heartbeatSweep(), 30000);
    if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  handleConnection(ws, remoteIp) {
    const clientId = `peer_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const conn = {
      socket: ws,
      clientId,
      ip: remoteIp,
      role: 'guest',
      roomCode: null,
      teacherToken: null,
      name: null,
      isAlive: true
    };

    this.clients.set(ws, conn);
    this.clientsById.set(clientId, conn);

    // Send welcome and client ID assignment
    this.send(conn, {
      type: 'connection_ack',
      clientId,
      serverTime: Date.now()
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // Binary media flows over WebRTC DataChannel/MediaStream, not WS

      if (this.authGuard.isSocketFlooding(ws)) {
        console.warn(`[Signaling] Client ${clientId} flooding socket. Message dropped.`);
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        this.routeMessage(conn, msg);
      } catch (err) {
        console.warn(`[Signaling] Malformed JSON from ${clientId}:`, err.message);
      }
    });

    ws.on('pong', () => {
      conn.isAlive = true;
    });

    ws.on('close', () => {
      this.handleDisconnect(conn);
    });

    ws.on('error', (err) => {
      console.warn(`[Signaling] Socket error on ${clientId}:`, err.message);
    });
  }

  routeMessage(conn, msg) {
    if (!msg || !msg.type) return;

    // Ping / Pong Keepalive
    if (msg.type === 'ping') {
      conn.isAlive = true;
      this.send(conn, { type: 'pong', timestamp: Date.now() });
      return;
    }

    switch (msg.type) {
      // --- Teacher Registration ---
      case 'teacher_register': {
        const res = this.authManager.register(msg.username, msg.password, msg.displayName);
        if (!res.success) {
          this.send(conn, { type: 'teacher_auth_error', reason: res.reason });
          return;
        }
        conn.teacherToken = res.token;
        this.send(conn, {
          type: 'teacher_auth_success',
          token: res.token,
          user: res.user
        });
        break;
      }

      // --- Teacher Login ---
      case 'teacher_login': {
        const res = this.authManager.login(msg.username, msg.password);
        if (!res.success) {
          this.send(conn, { type: 'teacher_auth_error', reason: res.reason });
          return;
        }
        conn.teacherToken = res.token;
        this.send(conn, {
          type: 'teacher_auth_success',
          token: res.token,
          user: res.user
        });
        break;
      }

      // --- Teacher Creates Classroom ---
      case 'room_create': {
        const token = msg.authToken || conn.teacherToken;
        const auth = this.authManager.validateToken(token);

        // Allow demo/guest teacher launch if configured or if token matches
        let teacherDisplayName = msg.teacherName;
        if (auth) {
          teacherDisplayName = auth.displayName;
          conn.teacherToken = token;
        } else if (!token && process.env.REQUIRE_TEACHER_AUTH === 'true') {
          this.send(conn, { type: 'auth_error', reason: 'Teacher authentication required to create a classroom.' });
          return;
        }

        conn.role = 'teacher';
        conn.name = this.authGuard.sanitizeString(teacherDisplayName || 'Teacher');

        const requestedCode = (msg.roomCode && /^\d{6}$/.test(msg.roomCode)) ? msg.roomCode : null;

        // Cancel grace period if teacher reconnected
        if (requestedCode && this.teacherGraceTimers.has(requestedCode)) {
          clearTimeout(this.teacherGraceTimers.get(requestedCode));
          this.teacherGraceTimers.delete(requestedCode);
          console.log(`[Signaling] Re-bound teacher ${conn.clientId} to room ${requestedCode} (grace timer cleared)`);
        }

        const room = this.sessionManager.createRoom(conn.clientId, conn.name, conn.teacherToken, requestedCode);
        conn.roomCode = room.code;

        this.send(conn, {
          type: 'room_created',
          roomCode: room.code,
          teacherId: conn.clientId,
          iceServers: ICE_SERVERS
        });
        break;
      }

      // --- Student Requests Join ---
      case 'room_join_request': {
        const code = msg.roomCode;
        if (!this.authGuard.isValidRoomCode(code)) {
          this.send(conn, { type: 'room_join_rejected', reason: 'Invalid 6-digit session code.' });
          return;
        }

        if (this.authGuard.isRateLimited(conn.ip)) {
          this.send(conn, { type: 'room_join_rejected', reason: 'Too many requests. Please wait a moment.' });
          return;
        }

        const room = this.sessionManager.getRoom(code);
        if (!room) {
          this.send(conn, { type: 'room_join_rejected', reason: 'Classroom not found or session has expired.' });
          return;
        }

        conn.role = 'student';
        conn.roomCode = code;
        conn.name = this.authGuard.sanitizeString(msg.studentName || 'Student');
        conn.rollNo = this.authGuard.sanitizeString(msg.rollNo || (msg.clientInfo && msg.clientInfo.rollNo) || 'N/A');

        const result = this.sessionManager.addPendingStudent(code, conn.clientId, conn.name, conn.rollNo, msg.clientInfo);
        if (!result.ok) {
          this.send(conn, { type: 'room_join_rejected', reason: result.reason });
          return;
        }

        // Notify Teacher of pending admission request
        const teacher = this.clientsById.get(room.teacherId);
        if (teacher) {
          this.send(teacher, {
            type: 'room_join_request',
            senderId: conn.clientId,
            studentName: conn.name,
            rollNo: conn.rollNo,
            clientInfo: msg.clientInfo || {}
          });
        }
        break;
      }

      // --- Teacher Approves Student ---
      case 'room_approve_student': {
        const token = msg.authToken || conn.teacherToken;
        if (conn.role !== 'teacher' || !conn.roomCode) return;

        const studentId = msg.studentId;
        const approved = this.sessionManager.approveStudent(conn.roomCode, studentId, token);
        if (approved) {
          const studentConn = this.clientsById.get(studentId);
          if (studentConn) {
            this.send(studentConn, {
              type: 'room_join_approved',
              roomCode: conn.roomCode,
              teacherId: conn.clientId,
              iceServers: ICE_SERVERS
            });
          }
        } else {
          this.send(conn, { type: 'auth_error', reason: 'Unauthorized: cannot approve student without teacher credentials.' });
        }
        break;
      }

      // --- Teacher Rejects Student ---
      case 'room_reject_student': {
        const token = msg.authToken || conn.teacherToken;
        if (conn.role !== 'teacher' || !conn.roomCode) return;

        const studentId = msg.studentId;
        const rejected = this.sessionManager.rejectStudent(conn.roomCode, studentId, token);
        if (rejected) {
          const studentConn = this.clientsById.get(studentId);
          if (studentConn) {
            this.send(studentConn, {
              type: 'room_join_rejected',
              reason: msg.reason || 'Teacher declined admission.'
            });
          }
        }
        break;
      }

      // --- WebRTC Peer-to-Peer Signaling (Offer, Answer, Candidate) ---
      case 'signal_offer':
      case 'signal_answer':
      case 'signal_candidate': {
        const recipientId = msg.recipientId;
        const target = recipientId ? this.clientsById.get(recipientId) : null;
        if (target && target.roomCode === conn.roomCode) {
          this.send(target, {
            type: msg.type,
            senderId: conn.clientId,
            payload: msg.payload
          });
        }
        break;
      }

      // --- Student Requests Stream from Teacher ---
      case 'request_stream': {
        if (conn.roomCode) {
          const room = this.sessionManager.getRoom(conn.roomCode);
          if (room) {
            const teacher = this.clientsById.get(room.teacherId);
            if (teacher) {
              this.send(teacher, {
                type: 'request_stream',
                senderId: conn.clientId,
                roomCode: conn.roomCode
              });
            }
          }
        }
        break;
      }

      // --- Teacher Broadcasts Screen Share Started / Stopped ---
      case 'stream_started':
      case 'stream_stopped': {
        if (conn.role === 'teacher' && conn.roomCode) {
          this.broadcast(conn.roomCode, {
            type: msg.type,
            senderId: conn.clientId,
            payload: msg.payload || {}
          });
        }
        break;
      }

      // --- Teacher Kicks Student ---
      case 'student_kick': {
        const token = msg.authToken || conn.teacherToken;
        if (!this.sessionManager.verifyTeacher(conn.roomCode, token)) {
          this.send(conn, { type: 'auth_error', reason: 'Unauthorized: only teacher can remove students.' });
          return;
        }

        const target = this.clientsById.get(msg.recipientId);
        if (target && target.roomCode === conn.roomCode) {
          this.send(target, { type: 'student_left', reason: 'Removed by teacher.' });
          target.socket.close();
        }
        break;
      }

      // --- Teacher Terminates Room ---
      case 'room_terminate': {
        const token = msg.authToken || conn.teacherToken;
        if (!this.sessionManager.verifyTeacher(conn.roomCode, token)) {
          this.send(conn, { type: 'auth_error', reason: 'Unauthorized: only teacher can end classroom.' });
          return;
        }

        const code = conn.roomCode;
        if (this.teacherGraceTimers.has(code)) {
          clearTimeout(this.teacherGraceTimers.get(code));
          this.teacherGraceTimers.delete(code);
        }

        this.sessionManager.deleteRoom(code, token);
        this.broadcast(code, { type: 'room_terminated' });
        break;
      }

      // --- Broadcasts (Announcements, Chat, Whiteboard, Reactions, Hand Raise) ---
      case 'announcement': {
        if (conn.role === 'teacher' && conn.roomCode) {
          this.broadcast(conn.roomCode, {
            type: 'announcement',
            senderId: conn.clientId,
            payload: msg.payload
          });
        }
        break;
      }

      case 'chat_message': {
        if (conn.roomCode) {
          const cleanText = this.authGuard.sanitizeString(msg.payload?.text || '', 500);
          this.broadcast(conn.roomCode, {
            type: 'chat_message',
            senderId: conn.clientId,
            payload: {
              ...msg.payload,
              text: cleanText,
              sender: conn.name || 'Anonymous',
              rollNo: conn.rollNo || 'N/A'
            }
          });
        }
        break;
      }

      case 'wb_stroke':
      case 'wb_clear': {
        if (conn.roomCode) {
          this.broadcast(conn.roomCode, {
            type: msg.type,
            senderId: conn.clientId,
            payload: msg.payload
          }, conn.clientId);
        }
        break;
      }

      case 'reaction':
      case 'raise_hand': {
        if (conn.roomCode) {
          this.broadcast(conn.roomCode, {
            type: msg.type,
            senderId: conn.clientId,
            payload: msg.payload
          });
        }
        break;
      }

      case 'file_control': {
        if (msg.recipientId) {
          const target = this.clientsById.get(msg.recipientId);
          if (target && target.roomCode === conn.roomCode) {
            this.send(target, {
              type: 'file_control',
              senderId: conn.clientId,
              payload: msg.payload
            });
          }
        } else if (conn.roomCode) {
          this.broadcast(conn.roomCode, {
            type: 'file_control',
            senderId: conn.clientId,
            payload: msg.payload
          }, conn.clientId);
        }
        break;
      }

      default: {
        if (msg.recipientId) {
          const target = this.clientsById.get(msg.recipientId);
          if (target && target.roomCode === conn.roomCode) {
            this.send(target, { ...msg, senderId: conn.clientId });
          }
        }
        break;
      }
    }
  }

  handleDisconnect(conn) {
    console.log(`[Signaling] Peer disconnected: ${conn.clientId} (Role: ${conn.role}, Room: ${conn.roomCode})`);
    this.authGuard.cleanSocket(conn.socket);
    this.clients.delete(conn.socket);
    this.clientsById.delete(conn.clientId);

    const result = this.sessionManager.removeParticipant(conn.clientId);
    if (!result) return;

    const { roomCode, wasTeacher, room } = result;

    if (wasTeacher) {
      console.log(`[Signaling] Teacher disconnected from room ${roomCode}. Holding 90s grace period.`);
      if (this.teacherGraceTimers.has(roomCode)) {
        clearTimeout(this.teacherGraceTimers.get(roomCode));
      }

      const timer = setTimeout(() => {
        const activeRoom = this.sessionManager.getRoom(roomCode);
        if (activeRoom && activeRoom.teacherId === conn.clientId) {
          console.log(`[Signaling] Teacher grace period expired for room ${roomCode}. Concluding session.`);
          this.sessionManager.deleteRoom(roomCode);
          this.broadcast(roomCode, { type: 'room_terminated' });
        }
        this.teacherGraceTimers.delete(roomCode);
      }, this.sessionManager.teacherGracePeriodMs);

      this.teacherGraceTimers.set(roomCode, timer);
    } else {
      // Notify Teacher that a student left
      const teacher = this.clientsById.get(room.teacherId);
      if (teacher) {
        this.send(teacher, { type: 'student_left', studentId: conn.clientId });
      }
    }
  }

  send(conn, data) {
    if (conn.socket.readyState === WebSocket.OPEN) {
      try {
        conn.socket.send(JSON.stringify(data));
      } catch (e) {
        console.warn(`[Signaling] Send error to ${conn.clientId}:`, e.message);
      }
    }
  }

  broadcast(roomCode, data, excludeClientId = null) {
    const payload = JSON.stringify(data);
    for (const conn of this.clients.values()) {
      if (conn.roomCode === roomCode && conn.clientId !== excludeClientId) {
        if (conn.socket.readyState === WebSocket.OPEN) {
          try {
            conn.socket.send(payload);
          } catch (e) {}
        }
      }
    }
  }

  heartbeatSweep() {
    for (const [ws, conn] of this.clients.entries()) {
      if (!conn.isAlive) {
        console.warn(`[Signaling] Client ${conn.clientId} failed heartbeat watchdog. Terminating.`);
        ws.terminate();
        this.handleDisconnect(conn);
        continue;
      }
      conn.isAlive = false;
      try {
        ws.ping();
      } catch (e) {}
    }
  }
}

// ============================================================================
// 6. HTTP Server, API Routes & Static Assets
// ============================================================================

const sessionManager = new SessionManager();
const authManager = new TeacherAuthManager();
const authGuard = new AuthGuard();
const signalingHandler = new SignalingHandler(sessionManager, authManager, authGuard);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({ name, address: addr.address });
      }
    }
  }
  return result;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const clientOrigin = req.headers.origin || '';

  // Origin Validation & CORS
  let allowOrigin = '*';
  if (ALLOWED_ORIGINS.length > 0) {
    if (ALLOWED_ORIGINS.includes(clientOrigin.toLowerCase())) {
      allowOrigin = clientOrigin;
    } else {
      allowOrigin = ALLOWED_ORIGINS[0];
    }
  }

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: Health Check (Render, Railway, Uptime monitors)
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Smart-WebRTC-Classroom-Backend',
      version: '2.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      activeClassrooms: sessionManager.getActiveRoomCount(),
      connectedStudents: sessionManager.getTotalStudentCount()
    }));
    return;
  }

  // API: Dynamic STUN/TURN ICE Configuration
  if (pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      iceServers: ICE_SERVERS,
      maxStudents: sessionManager.maxStudentsPerRoom,
      wsEndpoint: '/ws'
    }));
    return;
  }

  // API: Teacher Authentication (REST)
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const result = authManager.register(data.username, data.password, data.displayName);
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, reason: 'Invalid JSON body.' }));
      }
    });
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const result = authManager.login(data.username, data.password);
        res.writeHead(result.success ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, reason: 'Invalid JSON body.' }));
      }
    });
    return;
  }

  // API: LAN Discovery Endpoint
  if (pathname === '/api/discovery') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'Smart-WebRTC-Classroom',
      interfaces: getLocalIPv4Addresses().map((i) => ({ ...i, url: `http://${i.address}:${PORT}` })),
      activeClassrooms: sessionManager.getActiveRoomCount(),
      totalStudents: sessionManager.getTotalStudentCount()
    }));
    return;
  }

  // Static File Serving (for local execution or preview)
  const safePath = path.normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(CLIENT_DIR, safePath);

  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access Denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ============================================================================
// 7. WebSocket Server Setup (/ws)
// ============================================================================

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/ws') {
    // Check Origin if ALLOWED_ORIGINS is enforced
    const origin = (request.headers.origin || '').toLowerCase();
    if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
      console.warn(`[Signaling] Rejected WebSocket upgrade from unauthorized origin: ${origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const clientIp = request.headers['x-forwarded-for']
        ? request.headers['x-forwarded-for'].split(',')[0].trim()
        : request.socket.remoteAddress || '127.0.0.1';
      signalingHandler.handleConnection(ws, clientIp);
    });
  } else {
    socket.destroy();
  }
});

// Start Server Listen
server.listen(PORT, HOST, () => {
  console.log('================================================================');
  console.log('  🚀 SMART WEBRTC CLASSROOM - HOSTED BACKEND SERVER');
  console.log('================================================================');
  console.log(`  Listening Address: http://${HOST}:${PORT}`);
  console.log(`  WebSocket Channel: ws://${HOST}:${PORT}/ws (or wss:// in production)`);
  console.log(`  Health Check:      http://${HOST}:${PORT}/api/health`);
  console.log(`  ICE Config API:    http://${HOST}:${PORT}/api/config`);
  if (ICE_SERVERS.length > 0) {
    console.log(`  STUN/TURN Servers: ${ICE_SERVERS.length} configured`);
  }
  const ips = getLocalIPv4Addresses();
  if (ips.length > 0) {
    console.log('  Local Network URLs:');
    ips.forEach((i) => console.log(`    • ${i.name.padEnd(16)}: http://${i.address}:${PORT}`));
  }
  console.log('================================================================\n');
});

// Graceful Termination
function shutdown() {
  console.log('\n[Server] Shutting down gracefully...');
  wss.close();
  server.close(() => {
    console.log('[Server] Process closed cleanly.');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
