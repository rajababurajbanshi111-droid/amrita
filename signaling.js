// --- signaling.js ---
/**
 * SMART WEBRTC CLASSROOM - Dual-Mode Hybrid Signaling & SFU Engine
 * Automatically detects and runs:
 * 1. Mode A (Local LAN Server): Direct high-speed WebSocket on port 3000 (/ws) with 
 *    built-in SFU relay. 100% offline, zero internet, zero STUN/TURN, zero firewall blocks.
 * 2. Mode B (Serverless Cloud): Automatic fallback to PeerJS (0.peerjs.com:443) with
 *    standard STUN/TURN traversal for GitHub Pages / static hosting.
 */

class SignalingManager {
  constructor() {
    this.peer = null;
    this.role = 'student'; // 'teacher' | 'student'
    this.currentRoomCode = null;
    this.teacherName = 'Teacher';
    this.studentName = 'Student';
    this.clientId = SecurityManager.generateUUID();
    this.isConnected = false;
    this.isMqttMode = false;
    this.serverUrl = '0.peerjs.com:443';

    // Local LAN WebSocket Mode
    this.ws = null;
    this.isWsMode = false;

    // Connections map (for teacher: studentPeerId -> DataConnection; for student: teacherConn)
    this.studentConnections = new Map(); // studentId -> DataConnection
    this.mediaCalls = new Map();         // studentId -> MediaConnection
    this.teacherConn = null;             // DataConnection to teacher
    this.activeStream = null;            // Active screen share stream (if teacher)

    // Robust Admission State Tracking
    this.approvedStudents = new Set();      // studentIds approved by teacher
    this.acknowledgedStudents = new Set();  // studentIds that confirmed receipt of approval
    this.pendingRemoteStream = null;        // Remote screen stream buffered before/during admission
    this.studentJoinInterval = null;        // Periodic ping while waiting for admission
    this.approvalRetryTimers = new Map();   // studentId -> timer

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
  }

  getPeerConfig() {
    return {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' },
          { urls: 'stun:stun4.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: 'stun:stun.services.mozilla.com:3478' },
          {
            urls: [
              'turn:openrelay.metered.ca:80',
              'turn:openrelay.metered.ca:443',
              'turn:openrelay.metered.ca:443?transport=tcp',
              'turn:standard.relay.metered.ca:80',
              'turn:standard.relay.metered.ca:443',
              'turn:standard.relay.metered.ca:443?transport=tcp'
            ],
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: [
              'turn:eu-0.turn.peerjs.com:3478',
              'turn:us-0.turn.peerjs.com:3478'
            ],
            username: 'peerjs',
            credential: 'peerjsp'
          }
        ],
        sdpSemantics: 'unified-plan',
        iceCandidatePoolSize: 4
      }
    };
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.isWsMode && this.ws && this.ws.readyState === 1) {
        try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch(e) {}
      } else if (this.peer && this.peer.socket && this.peer.socket._ws && this.peer.socket._ws.readyState === WebSocket.OPEN) {
        try { this.peer.socket._ws.send(JSON.stringify({ type: 'HEARTBEAT' })); } catch(e) {}
      }
    }, 15000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Fetches dynamic STUN and TURN configurations from backend /api/config
   */
  async fetchBackendIceConfig() {
    try {
      if (typeof window === 'undefined' || !window.SmartClassroomConfig) return;
      const backendUrl = window.SmartClassroomConfig.getBackendUrl();
      const resp = await fetch(`${backendUrl}/api/config`, { method: 'GET', mode: 'cors' });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.iceServers && window.webrtc) {
          window.SmartClassroomConfig.updateIceServersFromBackend(data.iceServers);
          window.webrtc.setIceServers(data.iceServers);
          console.log('[Signaling] Loaded dynamic ICE servers from backend:', data.iceServers);
        }
      }
    } catch (e) {
      console.log('[Signaling] Could not fetch backend ICE config (using defaults):', e.message);
    }
  }

  /**
   * Connects to the hosted or local WebSocket backend
   */
  connectWebSocket(onSuccess, onFallback) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (onSuccess) onSuccess();
      return true;
    }

    this.fetchBackendIceConfig();

    const wsUrl = window.SmartClassroomConfig
      ? window.SmartClassroomConfig.getWebSocketUrl()
      : ((window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host + '/ws');

    console.log('[Signaling] Connecting to backend WebSocket:', wsUrl);
    let opened = false;
    let ws = null;

    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      console.warn('[Signaling] WebSocket initialization error:', e);
      if (onFallback) onFallback();
      return false;
    }

    const timer = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch(e) {}
        if (onFallback) onFallback();
      }
    }, 4000);

    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      this.ws = ws;
      this.isWsMode = true;
      this.isConnected = true;
      console.log('[Signaling] Connected to backend WebSocket signaling server:', wsUrl);
      if (this.onServerStatusChange) {
        const label = wsUrl.includes('localhost') || wsUrl.includes('127.0.0.1')
          ? 'Local LAN Server'
          : 'Hosted Signaling Backend';
        this.onServerStatusChange(true, label);
      }
      this.startHeartbeat();
      if (onSuccess) onSuccess();
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
        if (typeof this.onBinaryMedia === 'function') {
          this.onBinaryMedia(event.data);
        }
        return;
      }
      try {
        const msg = JSON.parse(event.data);
        this.handleIncomingMessage(msg);
      } catch (e) {
        console.warn('[Signaling] Malformed message from backend server:', e);
      }
    };

    ws.onerror = (err) => {
      if (!opened) {
        clearTimeout(timer);
        if (onFallback) onFallback();
      }
    };

    ws.onclose = () => {
      if (this.isWsMode) {
        console.warn('[Signaling] Backend WebSocket connection closed.');
        this.isConnected = false;
        if (this.onServerStatusChange) this.onServerStatusChange(false, 'Disconnected');
      }
    };

    return true;
  }

  tryConnectLocalWebSocket(onSuccess, onFallback) {
    return this.connectWebSocket(onSuccess, onFallback);
  }

  // --- Teacher Authentication Methods ---
  async teacherRegister(username, password, displayName) {
    const backendUrl = window.SmartClassroomConfig ? window.SmartClassroomConfig.getBackendUrl() : '';
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
        try { sessionStorage.setItem('swc_teacher_name', data.user.displayName); } catch(e) {}
      }
      return data;
    } catch (err) {
      return { success: false, reason: 'Network error connecting to backend authentication.' };
    }
  }

  async teacherLogin(username, password) {
    const backendUrl = window.SmartClassroomConfig ? window.SmartClassroomConfig.getBackendUrl() : '';
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
        try { sessionStorage.setItem('swc_teacher_name', data.user.displayName); } catch(e) {}
      }
      return data;
    } catch (err) {
      return { success: false, reason: 'Network error connecting to backend authentication.' };
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
    try { sessionStorage.removeItem('swc_teacher_name'); } catch(e) {}
  }

  // Teacher initializes classroom
  createClassroom(teacherName, roomCode = null) {
    this.role = 'teacher';
    this.teacherName = teacherName || 'Teacher';
    this.currentRoomCode = roomCode || SecurityManager.generateSessionCode(6);
    this.getSavedTeacherToken();

    this.connectWebSocket(
      () => {
        // Backend WebSocket Server Mode
        console.log('[Signaling] Registering classroom with backend server:', this.currentRoomCode);
        this.ws.send(JSON.stringify({
          type: 'room_create',
          teacherName: this.teacherName,
          authToken: this.teacherToken,
          roomCode: this.currentRoomCode
        }));
        if (this.onRoomCreated) {
          this.onRoomCreated({
            type: 'room_created',
            roomCode: this.currentRoomCode,
            teacherId: this.clientId
          });
        }
      },
      () => {
        // Fallback to PeerJS Serverless Mode
        this.initPeerJsTeacher();
      }
    );

    return true;
  }

  initPeerJsTeacher() {
    const teacherPeerId = 'smartclass-room-' + this.currentRoomCode + '-teacher';
    this.clientId = teacherPeerId;

    if (this.peer && !this.peer.destroyed) {
      try { this.peer.destroy(); } catch (e) {}
    }

    try {
      this.peer = new Peer(teacherPeerId, this.getPeerConfig());

      this.peer.on('open', (id) => {
        console.log('[Signaling] Teacher PeerJS session active with ID:', id);
        this.isConnected = true;
        this.startHeartbeat();
        if (this.onServerStatusChange) this.onServerStatusChange(true, 'PeerJS Serverless (Port 443)');
        if (this.onRoomCreated) {
          this.onRoomCreated({
            type: 'room_created',
            roomCode: this.currentRoomCode,
            teacherId: id
          });
        }
      });

      this.peer.on('connection', (conn) => {
        console.log('[Signaling] Student incoming connection:', conn.peer);
        this.studentConnections.set(conn.peer, conn);

        const handleJoinAttempt = (studentName) => {
          if (this.approvedStudents.has(conn.peer)) {
            console.log('[Signaling] Student is already approved. Re-sending admission token:', conn.peer);
            this.sendApprovalToStudent(conn.peer);
            if (this.activeStream) {
              this.dispatchCallToStudent(conn.peer);
            }
            return;
          }
          this.handleIncomingMessage({
            type: 'room_join_request',
            senderId: conn.peer,
            studentName: studentName || 'Student',
            roomCode: this.currentRoomCode
          }, conn.peer);
        };

        if (conn.metadata && conn.metadata.studentName) {
          handleJoinAttempt(conn.metadata.studentName);
        }

        conn.on('open', () => {
          console.log('[Signaling] Data channel opened with student:', conn.peer);
          this.studentConnections.set(conn.peer, conn);
          if (conn.peerConnection && window.webrtc) {
            window.webrtc.peerConnections.set(conn.peer, conn.peerConnection);
          }
          if (this.approvedStudents.has(conn.peer)) {
            this.sendApprovalToStudent(conn.peer);
            if (this.activeStream) {
              this.dispatchCallToStudent(conn.peer);
            }
          }
        });

        conn.on('data', (data) => {
          try {
            const msg = typeof data === 'string' ? JSON.parse(data) : data;
            this.handleIncomingMessage(msg, conn.peer);
          } catch (e) {
            console.warn('[Signaling] Malformed incoming message:', e);
          }
        });

        conn.on('close', () => {
          console.log('[Signaling] Student disconnected:', conn.peer);
          this.studentConnections.delete(conn.peer);
          if (this.mediaCalls.has(conn.peer)) {
            try { this.mediaCalls.get(conn.peer).close(); } catch(e) {}
            this.mediaCalls.delete(conn.peer);
          }
          if (this.onStudentLeft) {
            this.onStudentLeft({ studentId: conn.peer });
          }
        });

        conn.on('error', (err) => {
          console.warn('[Signaling] Student connection error:', conn.peer, err);
        });
      });

      this.peer.on('error', (err) => {
        console.warn('[Signaling] PeerJS Teacher error:', err.type, err.message);
        if (err.type === 'unavailable-id') {
          console.warn('[Signaling] Room code collision. Generating new code...');
          this.currentRoomCode = SecurityManager.generateSessionCode(6);
          this.initPeerJsTeacher();
        }
      });

      this.peer.on('disconnected', () => {
        console.log('[Signaling] Teacher disconnected from signaling cloud. Reconnecting...');
        if (this.peer && !this.peer.destroyed) {
          this.peer.reconnect();
        }
      });
    } catch (e) {
      console.error('[Signaling] Failed to initialize PeerJS Teacher:', e);
    }
  }

  // Student requests admission
  requestJoinClassroom(roomCode, studentName, rollNo = 'N/A') {
    this.role = 'student';
    this.currentRoomCode = (roomCode || '').trim();
    this.studentName = studentName || 'Student';
    this.studentRollNo = (rollNo && rollNo.trim()) ? rollNo.trim() : 'N/A';

    this.tryConnectLocalWebSocket(
      () => {
        // LAN WebSocket Server Mode
        console.log('[Signaling] Sending student join request via LAN server...');
        this.ws.send(JSON.stringify({
          type: 'room_join_request',
          roomCode: this.currentRoomCode,
          studentName: this.studentName,
          rollNo: this.studentRollNo,
          clientInfo: {
            rollNo: this.studentRollNo,
            userAgent: navigator.userAgent,
            screenRes: window.screen.width + 'x' + window.screen.height
          }
        }));
      },
      () => {
        // PeerJS Serverless Mode
        this.initPeerJsStudent();
      }
    );

    return true;
  }

  initPeerJsStudent() {
    if (this.studentJoinInterval) {
      clearInterval(this.studentJoinInterval);
      this.studentJoinInterval = null;
    }

    if (this.peer && !this.peer.destroyed) {
      try { this.peer.destroy(); } catch (e) {}
    }

    try {
      this.peer = new Peer(this.getPeerConfig());

      this.peer.on('open', (myId) => {
        console.log('[Signaling] Student PeerJS ready with ID:', myId);
        this.clientId = myId;
        this.isConnected = true;
        this.startHeartbeat();
        if (this.onServerStatusChange) this.onServerStatusChange(true, 'PeerJS Serverless (Port 443)');

        const teacherPeerId = 'smartclass-room-' + this.currentRoomCode + '-teacher';
        console.log('[Signaling] Connecting student to teacher:', teacherPeerId);

        const conn = this.peer.connect(teacherPeerId, {
          serialization: 'binary',
          metadata: { studentName: this.studentName, rollNo: this.studentRollNo || 'N/A' }
        });

        this.teacherConn = conn;

        const sendJoinPing = () => {
          if (conn && conn.open) {
            try {
              conn.send({
                type: 'room_join_request',
                senderId: myId,
                studentName: this.studentName,
                rollNo: this.studentRollNo || 'N/A',
                roomCode: this.currentRoomCode,
                clientInfo: {
                  userAgent: navigator.userAgent,
                  screenRes: window.screen.width + 'x' + window.screen.height
                }
              });
              console.log('[Signaling] Sent join request ping to professor');
            } catch(e) {}
          }
        };

        conn.on('open', () => {
          console.log('[Signaling] Data channel connected to professor! Sending join request...');
          if (conn.peerConnection && window.webrtc) {
            window.webrtc.peerConnections.set(teacherPeerId, conn.peerConnection);
          }
          sendJoinPing();
        });

        // Periodic join request ping while waiting for admission approval
        this.studentJoinInterval = setInterval(() => {
          if (window.classroom && window.classroom.isApproved) {
            clearInterval(this.studentJoinInterval);
            this.studentJoinInterval = null;
            return;
          }
          sendJoinPing();
        }, 1500);

        conn.on('data', (data) => {
          if (data instanceof ArrayBuffer || data instanceof Blob || (data && data.byteLength !== undefined) || (data && data.buffer instanceof ArrayBuffer)) {
            if (typeof this.onBinaryMedia === 'function') {
              const buf = data instanceof Blob ? data : (data instanceof ArrayBuffer ? data : (data.buffer || data));
              this.onBinaryMedia(buf);
            }
            return;
          }

          try {
            const msg = typeof data === 'string' ? JSON.parse(data) : data;
            this.handleIncomingMessage(msg);
          } catch (e) {
            console.warn('[Signaling] Error parsing incoming data from teacher:', e);
          }
        });

        conn.on('close', () => {
          console.warn('[Signaling] Connection to teacher lost.');
          if (this.onRoomTerminated) this.onRoomTerminated();
        });

        conn.on('error', (err) => {
          console.error('[Signaling] Teacher connection error:', err);
        });
      });

      // Handle incoming screen presentation call from teacher
      this.peer.on('call', (call) => {
        console.log('[Signaling] Incoming presentation call from teacher:', call.peer);
        call.answer();

        // Teacher initiating media call confirms admission! Unlock stage immediately!
        if (window.classroom) {
          window.classroom.isApproved = true;
          window.classroom.isSessionActive = true;
        }

        const waitBox = document.getElementById('studentWaitingApprovalBox');
        const autoForm = document.getElementById('studentAutoJoinForm');
        const joinScr = document.getElementById('studentJoinScreen');
        const classScr = document.getElementById('studentClassroomScreen');
        if (waitBox) waitBox.style.setProperty('display', 'none', 'important');
        if (autoForm) autoForm.style.setProperty('display', 'none', 'important');
        if (joinScr) joinScr.style.setProperty('display', 'none', 'important');
        if (classScr) classScr.style.setProperty('display', 'flex', 'important');
        if (typeof switchView === 'function') switchView('student');

        if (call.peerConnection) {
          if (window.webrtc) {
            window.webrtc.peerConnections.set('media-' + call.peer, call.peerConnection);
          }
          call.peerConnection.addEventListener('track', (event) => {
            console.log('[Signaling] Native RTCPeerConnection track event fired! Kind:', event.track.kind);
            const rStream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
            this.pendingRemoteStream = rStream;
            if (rStream.getVideoTracks().length > 0 && typeof activateRemoteVideoStream === 'function') {
              activateRemoteVideoStream(rStream);
            }
          });
        }

        call.on('stream', (remoteStream) => {
          console.log('[Signaling] Presentation stream received! Tracks:', remoteStream.getTracks().length);
          this.pendingRemoteStream = remoteStream;

          if (typeof remoteStream.addEventListener === 'function') {
            remoteStream.onaddtrack = () => {
              if (typeof activateRemoteVideoStream === 'function') {
                activateRemoteVideoStream(remoteStream);
              }
            };
          }

          if (typeof activateRemoteVideoStream === 'function') {
            activateRemoteVideoStream(remoteStream);
          }

          if (this.teacherConn && this.teacherConn.open) {
            try {
              this.teacherConn.send({
                type: 'room_join_ack',
                studentId: this.clientId,
                roomCode: this.currentRoomCode
              });
            } catch(e) {}
          }
        });

        call.on('close', () => {
          console.log('[Signaling] Presentation call closed by teacher');
          this.pendingRemoteStream = null;
          if (typeof deactivateRemoteVideoStream === 'function') {
            deactivateRemoteVideoStream();
          }
        });
      });

      this.peer.on('error', (err) => {
        console.warn('[Signaling] PeerJS Student error:', err.type, err.message);
        if (err.type === 'peer-unavailable') {
          if (typeof showToast === 'function') {
            showToast('Room ' + this.currentRoomCode + ' not found. Ensure professor is broadcasting.', 'warning');
          }
        }
      });
    } catch (e) {
      console.error('[Signaling] Failed to initialize Student PeerJS:', e);
    }
  }

  // Teacher sends admission approval to student over data connection
  sendApprovalToStudent(studentId) {
    const conn = this.studentConnections.get(studentId);
    if (!conn) return;

    const payload = {
      type: 'room_join_approved',
      roomCode: this.currentRoomCode,
      teacherId: this.clientId,
      recipientId: studentId,
      timestamp: Date.now()
    };

    if (conn.open) {
      try {
        conn.send(payload);
        console.log('[Signaling] Sent room_join_approved to student:', studentId);
      } catch (e) {
        console.warn('[Signaling] Error sending room_join_approved:', e);
      }
    } else {
      const onOpenDeliver = () => {
        try {
          conn.send(payload);
          console.log('[Signaling] Sent room_join_approved on data channel open to student:', studentId);
        } catch(e) {}
      };
      if (typeof conn.once === 'function') {
        conn.once('open', onOpenDeliver);
      } else {
        conn.on('open', onOpenDeliver);
      }
    }
  }

  // Teacher approves student
  approveStudent(studentId) {
    this.approvedStudents.add(studentId);
    console.log('[Signaling] Approving student:', studentId);

    // If running in WebSocket mode:
    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({
          type: 'room_approve_student',
          studentId: studentId,
          authToken: this.teacherToken
        }));
        console.log('[Signaling] Delivered room_approve_student to backend for student:', studentId);
        // If teacher is currently sharing screen, immediately send WebRTC offer!
        if (this.activeStream) {
          setTimeout(() => {
            this.initiateWebRtcOffer(studentId);
          }, 350);
        }
      } catch(e) {}
      return true;
    }

    // In PeerJS mode:
    this.sendApprovalToStudent(studentId);

    if (this.approvalRetryTimers.has(studentId)) {
      clearInterval(this.approvalRetryTimers.get(studentId));
    }
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (this.acknowledgedStudents.has(studentId) || attempts > 50 || !this.approvedStudents.has(studentId)) {
        clearInterval(timer);
        this.approvalRetryTimers.delete(studentId);
        return;
      }
      this.sendApprovalToStudent(studentId);
    }, 400);
    this.approvalRetryTimers.set(studentId, timer);

    if (this.activeStream && this.peer) {
      this.dispatchCallToStudent(studentId);
    }

    return true;
  }

  // Teacher rejects student admission
  rejectStudent(studentId, reason = 'Teacher declined admission.') {
    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({
          type: 'room_reject_student',
          studentId: studentId,
          reason: reason,
          authToken: this.teacherToken
        }));
      } catch(e) {}
    }
  }

  // Teacher removes/kicks a student
  kickStudent(studentId, reason = 'Removed by teacher.') {
    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({
          type: 'student_kick',
          recipientId: studentId,
          reason: reason,
          authToken: this.teacherToken
        }));
      } catch(e) {}
    }
    this.approvedStudents.delete(studentId);
  }

  // Teacher ends classroom session
  terminateClassroom() {
    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({
          type: 'room_terminate',
          authToken: this.teacherToken
        }));
      } catch(e) {}
    }
    this.approvedStudents.clear();
  }

  // Helper to dispatch media presentation call to a student
  dispatchCallToStudent(studentId) {
    if (!this.activeStream || !this.peer) return;
    try {
      if (this.mediaCalls.has(studentId)) {
        const existingCall = this.mediaCalls.get(studentId);
        if (existingCall && (existingCall.open || (existingCall.peerConnection && existingCall.peerConnection.connectionState === 'connected'))) {
          console.log('[Signaling] Media call already active for student:', studentId);
          return;
        }
        try { existingCall.close(); } catch(e) {}
      }
      console.log('[Signaling] Dispatching media presentation call to student:', studentId);
      const call = this.peer.call(studentId, this.activeStream);
      this.mediaCalls.set(studentId, call);
    } catch (e) {
      console.warn('[Signaling] Error dispatching media call to student ' + studentId + ':', e);
    }
  }

  // Teacher rejects student admission request
  rejectStudent(studentId, reason = 'Professor declined admission request.') {
    this.approvedStudents.delete(studentId);
    this.acknowledgedStudents.delete(studentId);

    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({
          type: 'room_reject_student',
          studentId: studentId,
          reason: reason
        }));
      } catch(e) {}
      return true;
    }

    const conn = this.studentConnections.get(studentId);
    if (conn) {
      try {
        conn.send({
          type: 'room_join_rejected',
          reason: reason,
          recipientId: studentId
        });
        setTimeout(() => {
          try { conn.close(); } catch(e) {}
        }, 400);
      } catch(e) {}
    }
    this.studentConnections.delete(studentId);
    return true;
  }

  // Teacher kicks/removes an admitted student
  kickStudent(studentId, reason = 'You have been removed from the classroom by the professor.') {
    console.log('[Signaling] Kicking student:', studentId);
    this.approvedStudents.delete(studentId);
    this.acknowledgedStudents.delete(studentId);

    if (this.mediaCalls.has(studentId)) {
      try {
        const call = this.mediaCalls.get(studentId);
        call.close();
      } catch(e) {}
      this.mediaCalls.delete(studentId);
    }

    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({
          type: 'student_kick',
          recipientId: studentId
        }));
      } catch(e) {}
      return true;
    }

    const conn = this.studentConnections.get(studentId);
    if (conn) {
      try {
        conn.send({
          type: 'student_kicked',
          reason: reason,
          recipientId: studentId
        });
        setTimeout(() => {
          try { conn.close(); } catch(e) {}
        }, 400);
      } catch(e) {}
    }
    this.studentConnections.delete(studentId);
    return true;
  }

  // Alias for send
  sendMessage(msg) {
    return this.send(msg);
  }

  // Teacher initiates pure LAN WebRTC Offer to student for high-resolution screen sharing
  async initiateWebRtcOffer(studentId) {
    if (!this.activeStream || !studentId) return;
    const webrtc = window.webrtc;
    if (!webrtc) {
      console.warn('[Signaling] WebRTCManager not found on window.webrtc');
      return;
    }

    try {
      console.log(`[Signaling] Creating pure LAN WebRTC screen offer for student: ${studentId}`);
      // Register stream with WebRTC manager
      webrtc.addLocalStream('screen', this.activeStream);

      // Ensure RTCPeerConnection exists for student as initiator
      const pc = webrtc.getOrCreateConnection(studentId, true);

      // Create offer (Trickle ICE: gather immediately without stalling)
      const offer = await webrtc.createOffer(studentId, false);

      // Send offer directly over local LAN WebSocket
      this.send({
        type: 'signal_offer',
        recipientId: studentId,
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

  // Teacher broadcasts active screen stream
  broadcastStream(stream) {
    this.activeStream = stream;

    if (this.isWsMode) {
      console.log('[Signaling] Broadcasting presentation stream to admitted students via WebSocket WebRTC...');
      const targetIds = new Set(this.approvedStudents);
      if (window.classroom && window.classroom.connectedStudents) {
        window.classroom.connectedStudents.forEach((st, id) => targetIds.add(id));
      }
      targetIds.forEach((studentId) => {
        this.initiateWebRtcOffer(studentId);
      });
    } else if (this.peer) {
      console.log('[Signaling] Broadcasting presentation stream to admitted students via WebRTC...');
      this.studentConnections.forEach((conn, studentId) => {
        if (!this.approvedStudents.has(studentId) && !(window.classroom && window.classroom.connectedStudents && window.classroom.connectedStudents.has(studentId))) {
          console.log('[Signaling] Skipping unadmitted student during screen broadcast:', studentId);
          return;
        }
        this.dispatchCallToStudent(studentId);
      });
    }

    this.send({
      type: 'stream_started',
      hasAudio: stream.getAudioTracks().length > 0
    });
  }

  // Teacher stops broadcasting screen stream
  stopStream() {
    this.activeStream = null;
    this.mediaCalls.forEach((call) => {
      try { call.close(); } catch (e) {}
    });
    this.mediaCalls.clear();
    this.send({ type: 'stream_stopped' });
  }

  // Universal send
  send(messageObj) {
    if (!messageObj) return false;
    messageObj.senderId = messageObj.senderId || this.clientId;
    messageObj.roomCode = messageObj.roomCode || this.currentRoomCode;
    messageObj.timestamp = messageObj.timestamp || Date.now();

    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(messageObj));
        return true;
      } catch(e) {}
    }

    if (this.role === 'student') {
      if (this.teacherConn && this.teacherConn.open) {
        this.teacherConn.send(messageObj);
        return true;
      }
      return false;
    }

    // Teacher sending directly to an individual student
    if (messageObj.recipientId) {
      const conn = this.studentConnections.get(messageObj.recipientId);
      if (conn && conn.open) {
        conn.send(messageObj);
        return true;
      }
      return false;
    }

    // Teacher broadcasting to all students
    let count = 0;
    this.studentConnections.forEach((conn) => {
      if (conn && conn.open) {
        try {
          conn.send(messageObj);
          count++;
        } catch (e) {}
      }
    });
    return count > 0;
  }

  // Message dispatcher & relay
  handleIncomingMessage(msg, fromPeer = null) {
    if (!msg || !msg.type) return;

    if (this.role === 'teacher' && fromPeer && !this.isWsMode) {
      const shouldRelay = ['chat_message', 'reaction', 'wb_stroke', 'wb_clear', 'announcement', 'raise_hand'].includes(msg.type);
      if (shouldRelay) {
        this.studentConnections.forEach((conn) => {
          if (conn.peer !== fromPeer && conn.open) {
            try { conn.send(msg); } catch (e) {}
          }
        });
      }
    }

    switch (msg.type) {
      case 'room_created':
        this.currentRoomCode = msg.roomCode;
        if (this.onRoomCreated) this.onRoomCreated(msg);
        break;

      case 'room_join_request':
        const studentId = fromPeer || msg.senderId;
        if (this.approvedStudents.has(studentId) || (window.classroom && window.classroom.connectedStudents && window.classroom.connectedStudents.has(studentId))) {
          console.log('[Signaling] Student pinged but is ALREADY approved! Re-sending approval:', studentId);
          this.approveStudent(studentId);
          return;
        }
        if (this.onJoinRequest) this.onJoinRequest(msg);
        break;

      case 'room_join_approved':
        this.currentRoomCode = msg.roomCode;
        if (this.teacherConn && this.teacherConn.open) {
          try {
            this.teacherConn.send({
              type: 'room_join_ack',
              studentId: this.clientId,
              roomCode: this.currentRoomCode
            });
            console.log('[Signaling] Sent admission ACK back to professor');
          } catch(e) {}
        }
        if (this.onJoinApproved) this.onJoinApproved(msg);
        break;

      case 'room_join_ack': {
        const studentAckId = fromPeer || msg.studentId || msg.senderId;
        console.log('[Signaling] Student confirmed admission ACK:', studentAckId);
        this.acknowledgedStudents.add(studentAckId);
        if (this.activeStream) {
          if (this.isWsMode) {
            this.initiateWebRtcOffer(studentAckId);
          } else if (this.peer) {
            this.dispatchCallToStudent(studentAckId);
          }
        }
        break;
      }

      case 'room_join_rejected':
        if (this.onJoinRejected) this.onJoinRejected(msg);
        break;

      case 'room_terminated':
        if (this.onRoomTerminated) this.onRoomTerminated(msg);
        break;

      case 'student_kicked':
        console.warn('[Signaling] Student received kick notice:', msg.reason);
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

      case 'request_stream': {
        const reqStudentId = fromPeer || msg.senderId;
        console.log('[Signaling] Student requested stream presentation call. Dispatching to:', reqStudentId);
        if (this.role === 'teacher' && this.activeStream) {
          if (this.isWsMode) {
            this.initiateWebRtcOffer(reqStudentId);
          } else if (this.peer) {
            this.dispatchCallToStudent(reqStudentId);
          }
        }
        break;
      }

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

      default:
        console.log('[Signaling] Message received:', msg.type);
    }
  }

  // Compatibility helper
  connectWebSocket() {
    return true;
  }

  // Broadcast binary media buffer (SFU Relay / DataChannel Frame Streamer)
  sendBinary(buffer) {
    if (!buffer) return false;
    let sentCount = 0;
    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(buffer);
        sentCount++;
      } catch (e) {}
    }
    this.studentConnections.forEach((conn) => {
      if (conn && conn.open) {
        try {
          conn.send(buffer);
          sentCount++;
        } catch (e) {}
      }
    });
    return sentCount > 0;
  }

  getBufferedAmount() {
    let max = 0;
    if (this.isWsMode && this.ws && typeof this.ws.bufferedAmount === 'number') {
      max = this.ws.bufferedAmount;
    }
    this.studentConnections.forEach((conn) => {
      if (conn && conn.dataChannel && typeof conn.dataChannel.bufferedAmount === 'number') {
        if (conn.dataChannel.bufferedAmount > max) max = conn.dataChannel.bufferedAmount;
      }
    });
    return max;
  }

  exportSessionToken(sessionDescription) {
    const payload = {
      version: 1,
      type: sessionDescription.type,
      sdp: sessionDescription.sdp,
      senderId: this.clientId,
      timestamp: Date.now()
    };
    return SecurityManager.compressSignalToken(payload);
  }
}

// Global exposure
window.SignalingManager = SignalingManager;