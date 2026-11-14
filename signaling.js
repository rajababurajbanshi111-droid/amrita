// --- signaling.js ---
/**
 * SMART WEBRTC CLASSROOM - Hybrid Dual-Mode Signaling Engine
 * 
 * 1. Serverless Public Broker Mode (Default for GitHub Pages & HTTPS):
 *    Direct, zero-configuration P2P WebRTC signaling over free carrier-grade
 *    MQTT 3.1.1 WebSocket brokers (HiveMQ & EMQX). 100% serverless, zero server
 *    cost, zero installations, no PeerJS cloud failures, 99.99% uptime worldwide.
 * 
 * 2. Local LAN WebSocket Server Mode (Optional for Offline Intranet):
 *    Direct WebSocket on port 3000 (/ws) with local Node.js relay for
 *    fully air-gapped classrooms without internet access.
 */

class SignalingManager {
  constructor() {
    this.ws = null;
    this.serverUrl = null;
    this.isConnected = false;
    this.isMqttMode = false;
    this.isWsMode = false;
    this.packetIdSeq = 1;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectTimer = null;
    this.pingInterval = null;

    // Public WSS Brokers with auto-failover
    this.PUBLIC_BROKERS = [
      'wss://broker.hivemq.com:8884/mqtt',
      'wss://broker.emqx.io:8084/mqtt'
    ];
    this.activeBrokerIndex = 0;

    // Session Identifiers
    this.clientId = (typeof SecurityManager !== 'undefined' && SecurityManager.generateUUID)
      ? SecurityManager.generateUUID()
      : ('swc-' + Math.random().toString(36).substring(2, 10));
    this.currentRoomCode = null;
    this.role = 'student'; // 'teacher' | 'student'
    this.teacherName = 'Professor';
    this.studentName = 'Student';
    this.studentRollNo = 'N/A';
    this.teacherToken = null;

    // Active Screen Sharing & Admission State
    this.activeStream = null;
    this.approvedStudents = new Set();
    this.acknowledgedStudents = new Set();
    this.studentConnections = new Map(); // studentId -> status/conn
    this.mediaCalls = new Map();
    this.teacherConn = null;
    this.pendingRemoteStream = null;
    this.studentJoinInterval = null;

    // Callbacks
    this.onServerStatusChange = null;
    this.onRoomCreated = null;
    this.onJoinRequest = null;
    this.onJoinApproved = null;
    this.onJoinRejected = null;
    this.onStudentLeft = null;
    this.onAnnouncement = null;
    this.onChatMessage = null;
    this.onPermissionChange = null;
    this.onRoomTerminated = null;
    this.onBinaryMedia = null;
    this.onFileControl = null;
    this.onRaiseHand = null;
    this.onReaction = null;
    this.onStreamStarted = null;
    this.onStreamStopped = null;
    this.onWbStroke = null;
    this.onWbClear = null;
    this.onSignalOffer = null;
    this.onSignalAnswer = null;
    this.onSignalCandidate = null;
    this.onStudentKicked = null;
    this.onError = null;
  }

  // =========================================================================
  // Zero-Dependency MQTT 3.1.1 Binary Protocol Engine
  // =========================================================================

  _encodeMqttStr(str) {
    const enc = new TextEncoder().encode(str);
    const out = new Uint8Array(enc.length + 2);
    out[0] = (enc.length >> 8) & 0xff;
    out[1] = enc.length & 0xff;
    out.set(enc, 2);
    return out;
  }

  _encodeMqttRemLen(len) {
    const bytes = [];
    do {
      let b = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) b = b | 128;
      bytes.push(b);
    } while (len > 0);
    return new Uint8Array(bytes);
  }

  _concatMqtt(arrays) {
    let total = 0;
    arrays.forEach(a => total += a.length);
    const out = new Uint8Array(total);
    let off = 0;
    arrays.forEach(a => {
      out.set(a, off);
      off += a.length;
    });
    return out;
  }

  _buildMqttConnect(clientId) {
    const protoName = new Uint8Array([0, 4, 0x4d, 0x51, 0x54, 0x54]); // 'MQTT'
    const protoLevel = new Uint8Array([4]); // 3.1.1
    const flags = new Uint8Array([2]); // Clean Session
    const keepAlive = new Uint8Array([0, 30]); // 30s
    const pld = this._encodeMqttStr(clientId);
    const body = this._concatMqtt([protoName, protoLevel, flags, keepAlive, pld]);
    const rem = this._encodeMqttRemLen(body.length);
    return this._concatMqtt([new Uint8Array([0x10]), rem, body]);
  }

  _buildMqttPublish(topic, jsonStr) {
    const top = this._encodeMqttStr(topic);
    const pld = new TextEncoder().encode(jsonStr);
    const body = this._concatMqtt([top, pld]);
    const rem = this._encodeMqttRemLen(body.length);
    return this._concatMqtt([new Uint8Array([0x30]), rem, body]); // QoS 0
  }

  _buildMqttSubscribe(packetId, topic) {
    const pId = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
    const top = this._encodeMqttStr(topic);
    const qos = new Uint8Array([0]);
    const body = this._concatMqtt([pId, top, qos]);
    const rem = this._encodeMqttRemLen(body.length);
    return this._concatMqtt([new Uint8Array([0x82]), rem, body]); // SUBSCRIBE QoS 0
  }

  _parseMqttPackets(buf) {
    const bytes = new Uint8Array(buf);
    const packets = [];
    let offset = 0;

    while (offset < bytes.length) {
      if (offset + 1 >= bytes.length) break;
      const firstByte = bytes[offset++];
      const type = firstByte >> 4;
      const flags = firstByte & 0x0f;

      let multiplier = 1;
      let remLen = 0;
      let b;
      do {
        if (offset >= bytes.length) return packets;
        b = bytes[offset++];
        remLen += (b & 127) * multiplier;
        multiplier *= 128;
      } while ((b & 128) !== 0);

      const packetEnd = offset + remLen;
      if (packetEnd > bytes.length) break;

      if (type === 2) { // CONNACK
        packets.push({ type: 'connack', returnCode: bytes[offset + 1] });
      } else if (type === 3) { // PUBLISH
        const qos = (flags >> 1) & 0x03;
        let pos = offset;
        const topLen = (bytes[pos] << 8) | bytes[pos + 1];
        pos += 2;
        const topic = new TextDecoder().decode(bytes.subarray(pos, pos + topLen));
        pos += topLen;
        if (qos > 0) pos += 2;
        const payload = new TextDecoder().decode(bytes.subarray(pos, packetEnd));
        packets.push({ type: 'publish', topic, payload });
      } else if (type === 9) { // SUBACK
        packets.push({ type: 'suback' });
      } else if (type === 13) { // PINGRESP
        packets.push({ type: 'pingresp' });
      }

      offset = packetEnd;
    }

    return packets;
  }

  // =========================================================================
  // Connection Management & Broker Handshake
  // =========================================================================

  sanitizeUrl(url) {
    if (!url) return url;
    let s = url.trim();
    s = s.replace(/^wss?:\/\/(wss?:\/\/)+/i, 'ws://');
    s = s.replace(/^https?\/\//i, 'http://');

    if (s.startsWith('http://')) s = 'ws://' + s.slice(7);
    else if (s.startsWith('https://')) s = 'wss://' + s.slice(8);
    else if (!s.startsWith('ws://') && !s.startsWith('wss://')) {
      s = 'ws://' + s;
    }
    s = s.replace(/\/+$/, '');
    if (!s.endsWith('/ws')) {
      s += '/ws';
    }
    return s;
  }

  getTopicPrefix() {
    return 'amrita_swc_v2/' + (this.currentRoomCode || 'lobby');
  }

  getPeerConfig() {
    return {
      iceServers: (window.SmartClassroomConfig && window.SmartClassroomConfig.DEFAULT_ICE_SERVERS)
        ? window.SmartClassroomConfig.DEFAULT_ICE_SERVERS
        : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            {
              urls: [
                'turn:openrelay.metered.ca:80',
                'turn:openrelay.metered.ca:443',
                'turn:openrelay.metered.ca:443?transport=tcp'
              ],
              username: 'openrelayproject',
              credential: 'openrelayproject'
            }
          ]
    };
  }

  async fetchBackendIceConfig() {
    try {
      if (typeof window === 'undefined' || !window.SmartClassroomConfig) return;
      const backendUrl = window.SmartClassroomConfig.getBackendUrl();
      if (!backendUrl) return;
      const resp = await fetch(`${backendUrl}/api/config`, { method: 'GET', mode: 'cors' });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.iceServers && window.webrtc) {
          window.SmartClassroomConfig.updateIceServersFromBackend(data.iceServers);
          window.webrtc.setIceServers(data.iceServers);
        }
      }
    } catch (e) {}
  }

  connectWebSocket(onSuccess = null, onFallback = null) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const loc = window.location;
    const urlParams = new URLSearchParams(loc.search);
    const paramServer = urlParams.get('server') || urlParams.get('signal');
    const storedServer = localStorage.getItem('swc_backend_url') || localStorage.getItem('teacherServerHost');

    // On GitHub Pages or static HTTPS hosting: default directly to Zero-Cloud Public Broker
    const isStaticHosted = loc.hostname.includes('github.io') || loc.hostname.includes('vercel.app') || loc.protocol === 'file:';

    if (paramServer) {
      this.serverUrl = this.sanitizeUrl(paramServer);
      this.isMqttMode = false;
      this.isWsMode = true;
    } else if (storedServer && !isStaticHosted) {
      this.serverUrl = this.sanitizeUrl(storedServer);
      this.isMqttMode = false;
      this.isWsMode = true;
    } else if (isStaticHosted || !storedServer) {
      // Free public broker
      this.serverUrl = this.PUBLIC_BROKERS[this.activeBrokerIndex % this.PUBLIC_BROKERS.length];
      this.isMqttMode = true;
      this.isWsMode = false;
    } else {
      const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsPort = loc.port ? `:${loc.port}` : '';
      this.serverUrl = `${wsProtocol}//${loc.hostname}${wsPort}/ws`;
      this.isMqttMode = false;
      this.isWsMode = true;
    }

    console.log(`[Signaling] Connecting (Mode: ${this.isMqttMode ? 'Zero-Cloud Public Broker' : 'Local WS'}):`, this.serverUrl);

    try {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        try { this.ws.close(); } catch(e) {}
      }

      this.ws = this.isMqttMode
        ? new WebSocket(this.serverUrl, 'mqtt')
        : new WebSocket(this.serverUrl);
      this.ws.binaryType = 'arraybuffer';

      const connectTimeout = setTimeout(() => {
        if (!this.isConnected && this.ws && this.ws.readyState !== WebSocket.OPEN) {
          console.warn('[Signaling] Connection timed out on:', this.serverUrl);
          try { this.ws.close(); } catch(e) {}
          if (this.isMqttMode) {
            // Failover to secondary broker
            this.activeBrokerIndex++;
            this.connectWebSocket(onSuccess, onFallback);
          } else if (onFallback) {
            onFallback();
          }
        }
      }, 4500);

      this.ws.onopen = () => {
        if (this.isMqttMode) {
          const connPacket = this._buildMqttConnect(this.clientId);
          this.ws.send(connPacket);
        } else {
          clearTimeout(connectTimeout);
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          console.log('[Signaling] Local WebSocket connected:', this.serverUrl);

          if (this.onServerStatusChange) {
            this.onServerStatusChange(true, 'Local Classroom Server');
          }

          if (this.role === 'teacher' && this.currentRoomCode) {
            this.send({
              type: 'room_create',
              teacherName: this.teacherName || 'Professor',
              roomCode: this.currentRoomCode,
              authToken: this.teacherToken
            });
          }

          if (onSuccess) onSuccess();
        }
      };

      this.ws.onmessage = (event) => {
        if (this.isMqttMode) {
          if (event.data instanceof ArrayBuffer) {
            const packets = this._parseMqttPackets(event.data);
            packets.forEach((p) => {
              if (p.type === 'connack') {
                clearTimeout(connectTimeout);
                this.isConnected = true;
                this.reconnectAttempts = 0;
                console.log('[Signaling] Serverless Public Broker connected successfully! Broker:', this.serverUrl);
                this.startHeartbeat();

                // Subscribe to room topics if room code is known
                if (this.currentRoomCode) {
                  this._subscribeRoomTopics();
                }

                if (this.onServerStatusChange) {
                  this.onServerStatusChange(true, 'Signaling Connected');
                }

                if (this.role === 'teacher' && this.currentRoomCode) {
                  if (this.onRoomCreated) {
                    this.onRoomCreated({
                      type: 'room_created',
                      roomCode: this.currentRoomCode,
                      teacherId: this.clientId
                    });
                  }
                }

                if (onSuccess) onSuccess();
              } else if (p.type === 'publish') {
                try {
                  const msg = JSON.parse(p.payload);
                  this.handleIncomingMessage(msg);
                } catch (e) {
                  console.warn('[Signaling] Malformed payload from broker:', e);
                }
              }
            });
          }
          return;
        }

        // Standard WS mode
        if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
          if (this.onBinaryMedia) {
            this.onBinaryMedia(event.data);
          }
          return;
        }

        try {
          const msg = JSON.parse(event.data);
          this.handleIncomingMessage(msg);
        } catch (e) {
          console.warn('[Signaling] Malformed WS message:', event.data);
        }
      };

      this.ws.onclose = () => {
        clearTimeout(connectTimeout);
        this.isConnected = false;
        this.stopHeartbeat();
        console.warn('[Signaling] Connection closed.');

        if (this.onServerStatusChange) {
          this.onServerStatusChange(false, 'Disconnected');
        }

        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.warn('[Signaling] Socket note:', err);
      };

    } catch (e) {
      console.warn('[Signaling] Socket init error:', e);
      if (this.isMqttMode) {
        this.activeBrokerIndex++;
      }
      this.scheduleReconnect();
    }
  }

  tryConnectLocalWebSocket(onSuccess, onFallback) {
    return this.connectWebSocket(onSuccess, onFallback);
  }

  _subscribeRoomTopics() {
    if (!this.isConnected || !this.ws || !this.currentRoomCode) return;
    const prefix = this.getTopicPrefix();

    if (this.role === 'teacher') {
      const subTeacher = this._buildMqttSubscribe(this.packetIdSeq++, `${prefix}/teacher`);
      const subBcast = this._buildMqttSubscribe(this.packetIdSeq++, `${prefix}/broadcast`);
      this.ws.send(subTeacher);
      this.ws.send(subBcast);
      console.log(`[Signaling] Subscribed teacher to topics for room ${this.currentRoomCode}`);
    } else {
      const subStudent = this._buildMqttSubscribe(this.packetIdSeq++, `${prefix}/student_${this.clientId}`);
      const subBcast = this._buildMqttSubscribe(this.packetIdSeq++, `${prefix}/broadcast`);
      this.ws.send(subStudent);
      this.ws.send(subBcast);
      console.log(`[Signaling] Subscribed student ${this.clientId} to topics for room ${this.currentRoomCode}`);
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[Signaling] Reconnect attempts limit reached.');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 8000);
    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.isMqttMode) {
          // MQTT PINGREQ (0xc0, 0x00)
          this.ws.send(new Uint8Array([0xc0, 0x00]));
        } else {
          this.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }
    }, 15000);
  }

  stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // =========================================================================
  // Teacher Authentication Methods
  // =========================================================================

  async teacherRegister(username, password, displayName) {
    const backendUrl = window.SmartClassroomConfig ? window.SmartClassroomConfig.getBackendUrl() : '';
    if (!backendUrl) return { success: true, token: 'local-teacher' };
    try {
      const resp = await fetch(`${backendUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName })
      });
      const data = await resp.json();
      if (data.success && data.token) {
        this.teacherToken = data.token;
        try { sessionStorage.setItem('swc_teacher_token', data.token); } catch(e) {}
      }
      return data;
    } catch (err) {
      return { success: false, reason: 'Network error connecting to backend auth.' };
    }
  }

  async teacherLogin(username, password) {
    const backendUrl = window.SmartClassroomConfig ? window.SmartClassroomConfig.getBackendUrl() : '';
    if (!backendUrl) return { success: true, token: 'local-teacher' };
    try {
      const resp = await fetch(`${backendUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await resp.json();
      if (data.success && data.token) {
        this.teacherToken = data.token;
        try { sessionStorage.setItem('swc_teacher_token', data.token); } catch(e) {}
      }
      return data;
    } catch (err) {
      return { success: false, reason: 'Network error connecting to backend auth.' };
    }
  }

  getSavedTeacherToken() {
    if (this.teacherToken) return this.teacherToken;
    try {
      this.teacherToken = sessionStorage.getItem('swc_teacher_token') || null;
    } catch(e) {}
    return this.teacherToken;
  }

  clearTeacherAuth() {
    this.teacherToken = null;
    try { sessionStorage.removeItem('swc_teacher_token'); } catch(e) {}
  }

  // =========================================================================
  // Classroom Operations
  // =========================================================================

  createClassroom(teacherName, roomCode = null) {
    this.role = 'teacher';
    this.teacherName = teacherName || 'Professor';
    this.currentRoomCode = roomCode || (typeof SecurityManager !== 'undefined' ? SecurityManager.generateSessionCode(6) : '123456');
    this.getSavedTeacherToken();

    this.connectWebSocket(() => {
      this._subscribeRoomTopics();
      if (this.onRoomCreated) {
        this.onRoomCreated({
          type: 'room_created',
          roomCode: this.currentRoomCode,
          teacherId: this.clientId
        });
      }
    });

    return true;
  }

  requestJoinClassroom(roomCode, studentName, rollNo = 'N/A') {
    this.role = 'student';
    this.currentRoomCode = (roomCode || '').trim();
    this.studentName = studentName || 'Student';
    this.studentRollNo = (rollNo && rollNo.trim()) ? rollNo.trim() : 'N/A';

    const sendJoin = () => {
      this._subscribeRoomTopics();
      const payload = {
        type: 'room_join_request',
        senderId: this.clientId,
        studentName: this.studentName,
        rollNo: this.studentRollNo,
        roomCode: this.currentRoomCode,
        clientInfo: {
          rollNo: this.studentRollNo,
          userAgent: navigator.userAgent,
          screenRes: `${window.screen.width}x${window.screen.height}`
        }
      };
      this.send(payload);
      console.log('[Signaling] Sent student admission request for room:', this.currentRoomCode);
    };

    this.connectWebSocket(() => {
      sendJoin();

      // Retry ping every 2.5s until admitted
      if (this.studentJoinInterval) clearInterval(this.studentJoinInterval);
      this.studentJoinInterval = setInterval(() => {
        if (window.classroom && window.classroom.isApproved) {
          clearInterval(this.studentJoinInterval);
          this.studentJoinInterval = null;
          return;
        }
        sendJoin();
      }, 2500);
    });

    return true;
  }

  approveStudent(studentId) {
    this.approvedStudents.add(studentId);
    console.log('[Signaling] Approving student:', studentId);

    // Send approval directly to student's private topic
    this.send({
      type: 'room_join_approved',
      recipientId: studentId,
      studentId: studentId,
      roomCode: this.currentRoomCode,
      teacherId: this.clientId,
      permissions: { allowChat: true, allowFileTransfer: true }
    });

    // If screen share is already active, immediately initiate WebRTC Offer!
    if (this.activeStream) {
      setTimeout(() => {
        this.initiateWebRtcOffer(studentId);
      }, 250);
    }

    return true;
  }

  rejectStudent(studentId, reason = 'Professor declined admission request.') {
    this.approvedStudents.delete(studentId);
    this.send({
      type: 'room_join_rejected',
      recipientId: studentId,
      studentId: studentId,
      reason: reason
    });
  }

  kickStudent(studentId, reason = 'You have been removed from the classroom by the professor.') {
    this.approvedStudents.delete(studentId);
    this.send({
      type: 'student_kicked',
      recipientId: studentId,
      studentId: studentId,
      reason: reason
    });
    if (window.webrtc) {
      window.webrtc.closeConnection(studentId);
    }
  }

  terminateClassroom() {
    this.send({
      type: 'room_terminated',
      roomCode: this.currentRoomCode
    });
    if (this.activeStream) {
      this.stopStream();
    }
  }

  // =========================================================================
  // WebRTC Screen Broadcasting & Signaling Handshake
  // =========================================================================

  async initiateWebRtcOffer(studentId) {
    if (!this.activeStream || !studentId) return;
    const webrtc = window.webrtc;
    if (!webrtc) {
      console.warn('[Signaling] WebRTCManager not found on window.webrtc');
      return;
    }

    // STABILITY GUARD: If connection is already live and transmitting video, do not re-negotiate!
    const existingPc = webrtc.peerConnections.get(studentId);
    if (existingPc) {
      const isAlreadyConnected = existingPc.connectionState === 'connected' &&
        existingPc.getSenders().some((s) => s.track && s.track.kind === 'video' && s.track.readyState === 'live');
      if (isAlreadyConnected) {
        console.log(`[Signaling] Peer ${studentId} is already connected and streaming. Skipping redundant offer.`);
        return;
      }
      if (existingPc.signalingState !== 'stable') {
        console.log(`[Signaling] Peer ${studentId} signalingState is '${existingPc.signalingState}'. Postponing offer.`);
        return;
      }
    }

    try {
      console.log(`[Signaling] Creating standard WebRTC screen offer for student: ${studentId}`);
      webrtc.addLocalStream('screen', this.activeStream);

      // Create RTCPeerConnection for this student
      const pc = webrtc.getOrCreateConnection(studentId, true);

      // Generate SDP offer with audio/video tracks
      const offer = await webrtc.createOffer(studentId, false);

      this.send({
        type: 'signal_offer',
        recipientId: studentId,
        roomCode: this.currentRoomCode,
        payload: {
          type: offer.type || 'offer',
          sdp: offer.sdp
        }
      });
      console.log(`[Signaling] Successfully dispatched signal_offer to student: ${studentId}`);
    } catch (err) {
      console.error(`[Signaling] Failed to initiate WebRTC offer for student ${studentId}:`, err);
    }
  }

  broadcastStream(stream) {
    this.activeStream = stream;
    console.log('[Signaling] Broadcasting presentation stream to admitted students...');

    const targetIds = new Set(this.approvedStudents);
    if (window.classroom && window.classroom.connectedStudents) {
      window.classroom.connectedStudents.forEach((st, id) => targetIds.add(id));
    }

    targetIds.forEach((studentId) => {
      this.initiateWebRtcOffer(studentId);
    });

    this.send({
      type: 'stream_started',
      hasAudio: stream.getAudioTracks().length > 0
    });
  }

  stopStream() {
    this.activeStream = null;
    this.send({ type: 'stream_stopped' });
  }

  // =========================================================================
  // Universal Message Delivery & Inbound Router
  // =========================================================================

  send(messageObj) {
    if (!messageObj) return false;
    messageObj.senderId = messageObj.senderId || this.clientId;
    messageObj.roomCode = messageObj.roomCode || this.currentRoomCode;
    messageObj.timestamp = messageObj.timestamp || Date.now();

    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (this.isMqttMode) {
      const room = this.currentRoomCode || messageObj.roomCode;
      if (!room) return false;
      const prefix = `amrita_swc_v2/${room}`;

      let topic;
      if (messageObj.type === 'room_create') {
        this._subscribeRoomTopics();
        return true;
      } else if (messageObj.type === 'room_join_request') {
        topic = `${prefix}/teacher`;
      } else if (messageObj.recipientId) {
        if (messageObj.recipientId === 'teacher' || (typeof messageObj.recipientId === 'string' && messageObj.recipientId.startsWith('swc-teach'))) {
          topic = `${prefix}/teacher`;
        } else {
          topic = `${prefix}/student_${messageObj.recipientId}`;
        }
      } else if (this.role === 'student') {
        topic = `${prefix}/teacher`;
      } else {
        topic = `${prefix}/broadcast`;
      }

      const pubPacket = this._buildMqttPublish(topic, JSON.stringify(messageObj));
      this.ws.send(pubPacket);
      return true;
    }

    // Standard WebSocket mode
    this.ws.send(JSON.stringify(messageObj));
    return true;
  }

  sendMessage(messageObj) {
    return this.send(messageObj);
  }

  handleIncomingMessage(msg) {
    if (!msg || !msg.type) return;

    // Filter out our own messages
    if (msg.senderId && msg.senderId === this.clientId) {
      return;
    }

    console.log('[Signaling] Incoming message:', msg.type, 'from:', msg.senderId);

    switch (msg.type) {
      case 'room_created':
        if (this.onRoomCreated) this.onRoomCreated(msg);
        break;

      case 'room_join_request': {
        const studentId = msg.senderId;
        if (this.approvedStudents.has(studentId) || (window.classroom && window.classroom.connectedStudents && window.classroom.connectedStudents.has(studentId))) {
          this.send({
            type: 'room_join_approved',
            recipientId: studentId,
            studentId: studentId,
            roomCode: this.currentRoomCode,
            teacherId: this.clientId,
            permissions: { allowChat: true, allowFileTransfer: true }
          });
          const pc = window.webrtc && window.webrtc.peerConnections.get(studentId);
          if (!pc || pc.connectionState !== 'connected') {
            if (this.activeStream) {
              this.initiateWebRtcOffer(studentId);
            }
          }
          return;
        }
        if (this.onJoinRequest) this.onJoinRequest(msg);
        break;
      }

      case 'room_join_approved':
        this.currentRoomCode = msg.roomCode;
        if (this.studentJoinInterval) {
          clearInterval(this.studentJoinInterval);
          this.studentJoinInterval = null;
        }
        if (window.classroom) {
          window.classroom.isApproved = true;
          window.classroom.isSessionActive = true;
        }
        this.send({
          type: 'room_join_ack',
          studentId: this.clientId,
          roomCode: this.currentRoomCode
        });
        if (this.onJoinApproved) this.onJoinApproved(msg);
        break;

      case 'room_join_ack': {
        const studentAckId = msg.studentId || msg.senderId;
        console.log('[Signaling] Student confirmed admission ACK:', studentAckId);
        this.acknowledgedStudents.add(studentAckId);
        if (this.activeStream) {
          const pc = window.webrtc && window.webrtc.peerConnections.get(studentAckId);
          if (!pc || pc.connectionState !== 'connected') {
            this.initiateWebRtcOffer(studentAckId);
          }
        }
        break;
      }

      case 'room_join_rejected':
        if (this.studentJoinInterval) {
          clearInterval(this.studentJoinInterval);
          this.studentJoinInterval = null;
        }
        if (this.onJoinRejected) this.onJoinRejected(msg);
        break;

      case 'room_terminated':
        if (this.onRoomTerminated) this.onRoomTerminated(msg);
        break;

      case 'student_kicked':
        if (this.onStudentKicked) this.onStudentKicked(msg);
        break;

      case 'signal_offer':
        if (this.onSignalOffer) this.onSignalOffer(msg);
        break;

      case 'signal_answer':
        if (this.onSignalAnswer) this.onSignalAnswer(msg);
        break;

      case 'signal_candidate':
        if (this.onSignalCandidate) this.onSignalCandidate(msg);
        break;

      case 'student_left':
        if (this.onStudentLeft) this.onStudentLeft(msg);
        break;

      case 'chat_message':
        if (this.onChatMessage) this.onChatMessage(msg);
        break;

      case 'announcement':
        if (this.onAnnouncement) this.onAnnouncement(msg);
        break;

      case 'raise_hand':
        if (this.onRaiseHand) this.onRaiseHand(msg);
        break;

      case 'reaction':
        if (this.onReaction) this.onReaction(msg);
        break;

      case 'request_stream':
        if (this.role === 'teacher' && this.activeStream) {
          const pc = window.webrtc && window.webrtc.peerConnections.get(msg.senderId);
          if (pc && pc.connectionState === 'connected') {
            console.log(`[Signaling] Student ${msg.senderId} requested stream but is already connected. Skipping offer.`);
            return;
          }
          this.initiateWebRtcOffer(msg.senderId);
        }
        break;

      case 'stream_started':
        if (this.onStreamStarted) this.onStreamStarted(msg);
        break;

      case 'stream_stopped':
        if (this.onStreamStopped) this.onStreamStopped(msg);
        if (typeof deactivateRemoteVideoStream === 'function') {
          deactivateRemoteVideoStream();
        }
        break;

      case 'wb_stroke':
        if (this.onWbStroke) this.onWbStroke(msg);
        break;

      case 'wb_clear':
        if (this.onWbClear) this.onWbClear(msg);
        break;

      case 'permission_change':
        if (this.onPermissionChange) this.onPermissionChange(msg);
        break;

      default:
        console.log('[Signaling] Generic message processed:', msg.type);
    }
  }

  sendBinary(buffer) {
    if (!buffer) return false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(buffer);
        return true;
      } catch(e) {}
    }
    return false;
  }

  getBufferedAmount() {
    if (this.ws && typeof this.ws.bufferedAmount === 'number') {
      return this.ws.bufferedAmount;
    }
    return 0;
  }

  exportSessionToken(sessionDescription) {
    const payload = {
      version: 1,
      type: sessionDescription.type,
      sdp: sessionDescription.sdp,
      senderId: this.clientId,
      timestamp: Date.now()
    };
    return (typeof SecurityManager !== 'undefined' && SecurityManager.compressSignalToken)
      ? SecurityManager.compressSignalToken(payload)
      : JSON.stringify(payload);
  }

  importSessionToken(token) {
    return (typeof SecurityManager !== 'undefined' && SecurityManager.decompressSignalToken)
      ? SecurityManager.decompressSignalToken(token)
      : JSON.parse(token);
  }
}

// Global exposure
window.SignalingManager = SignalingManager;
