// --- signaling.js ---
/**
 * SMART WEBRTC CLASSROOM - Universal Dual-Mode Hybrid Signaling Engine
 * 
 * Transport Architecture:
 * 1. Serverless Cloud Mode (Default for GitHub Pages & HTTPS hosting):
 *    Direct, zero-configuration WebRTC signaling over PeerJS Cloud (0.peerjs.com:443)
 *    on standard HTTPS/WSS Port 443 (universal firewall bypass). Supports all
 *    cross-browser connections (Chrome, Edge, Firefox, Safari) and establishes
 *    direct LAN peer-to-peer media paths when devices share the same router.
 * 
 * 2. Local LAN WebSocket Server Mode (Automatic for Offline Intranet):
 *    Direct high-speed WebSocket on port 3000 (/ws) with local companion
 *    server for completely air-gapped classrooms without internet access.
 * 
 * 3. Local Same-Origin Fast-Path:
 *    BroadcastChannel for zero-latency instant messaging during local tab testing.
 */

class SignalingManager {
  constructor() {
    this.peer = null;
    this.ws = null;
    this.serverUrl = '0.peerjs.com:443';
    this.isConnected = false;
    this.isWsMode = false;
    this.isMqttMode = false;
    this.isChannelMode = false;

    // Session Identifiers
    this.role = 'student'; // 'teacher' | 'student'
    this.currentRoomCode = null;
    this.teacherName = 'Professor';
    this.studentName = 'Student';
    this.studentRollNo = 'N/A';
    this.teacherToken = null;
    this.clientId = (typeof SecurityManager !== 'undefined' && SecurityManager.generateUUID)
      ? SecurityManager.generateUUID()
      : ('swc-' + Math.random().toString(36).substring(2, 10));

    // PeerJS Connection State
    this.studentConnections = new Map(); // studentId -> DataConnection
    this.mediaCalls = new Map();         // studentId -> MediaConnection
    this.teacherConn = null;             // DataConnection to teacher
    this.activeStream = null;            // Active screen share stream (if teacher)
    this.pendingRemoteStream = null;     // Remote screen stream buffered for student

    // Robust Admission & Delivery Tracking
    this.approvedStudents = new Set();      // studentIds approved by teacher
    this.acknowledgedStudents = new Set();  // studentIds that confirmed receipt of approval
    this.studentJoinInterval = null;        // Periodic ping while waiting for admission
    this.approvalRetryTimers = new Map();   // studentId -> timer
    this.teacherIdRetryCount = 0;
    this.sendQueue = [];
    this.localBroadcast = null;
    this.heartbeatInterval = null;

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
    this.onGrantScreenShare = null;
    this.onRevokeScreenShare = null;
    this.onStudentStreamStarted = null;
    this.onStudentStreamStopped = null;
    this.onStudentStreamReceived = null;
    this.onError = null;
  }

  // =========================================================================
  // WebRTC & ICE Configuration
  // =========================================================================

  getPeerConfig() {
    const configIceServers = (window.SmartClassroomConfig && window.SmartClassroomConfig.DEFAULT_ICE_SERVERS)
      ? window.SmartClassroomConfig.DEFAULT_ICE_SERVERS
      : [];

    return {
      debug: 1,
      config: {
        iceServers: configIceServers.length > 0 ? configIceServers : [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: 'stun:stun.services.mozilla.com:3478' },
          {
            urls: [
              'turn:standard.relay.metered.ca:80',
              'turn:standard.relay.metered.ca:443',
              'turn:standard.relay.metered.ca:443?transport=tcp'
            ],
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ],
        sdpSemantics: 'unified-plan',
        iceCandidatePoolSize: 4
      }
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

  // =========================================================================
  // Heartbeat & Connection Health
  // =========================================================================

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

  updateBroadcastChannel() {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        const chanName = `amrita_room_${this.currentRoomCode || 'lobby'}`;
        if (this.localBroadcast && this.localBroadcast.name !== chanName) {
          try { this.localBroadcast.close(); } catch(e) {}
          this.localBroadcast = null;
        }
        if (!this.localBroadcast) {
          this.localBroadcast = new BroadcastChannel(chanName);
          this.localBroadcast.onmessage = (event) => {
            if (event && event.data) {
              this.handleIncomingMessage(event.data);
            }
          };
        }
      }
    } catch(e) {}
  }

  // =========================================================================
  // Local LAN WebSocket Detection (Mode 2)
  // =========================================================================

  tryConnectLocalWebSocket(onSuccess, onFallback) {
    if (typeof window === 'undefined' || !window.location || !window.location.host || window.location.protocol === 'file:' || window.location.hostname.endsWith('github.io')) {
      return onFallback();
    }
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/ws`;
    let opened = false;
    let ws = null;
    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
    } catch(e) {
      return onFallback();
    }

    const timer = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch(e) {}
        onFallback();
      }
    }, 1500);

    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      this.ws = ws;
      this.isWsMode = true;
      this.isConnected = true;
      console.log('[Signaling] Connected to local LAN WebSocket server:', wsUrl);
      if (this.onServerStatusChange) this.onServerStatusChange(true, 'Local LAN SFU (Port 3000)');
      this.startHeartbeat();
      onSuccess();
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
      } catch(e) {
        console.warn('[Signaling] Malformed message from LAN server:', e);
      }
    };

    ws.onerror = () => {
      if (!opened) {
        clearTimeout(timer);
        onFallback();
      }
    };

    ws.onclose = () => {
      if (this.isWsMode) {
        console.warn('[Signaling] LAN WebSocket connection closed.');
        this.isConnected = false;
        if (this.onServerStatusChange) this.onServerStatusChange(false, 'Disconnected');
      }
    };
  }

  // =========================================================================
  // Main Bootstrap / WebSocket Connect (Mode 1 & 2 Auto-Selection)
  // =========================================================================

  connectWebSocket(onSuccess = null, onFallback = null) {
    this.updateBroadcastChannel();

    this.tryConnectLocalWebSocket(
      () => {
        if (onSuccess) onSuccess();
      },
      () => {
        // Fallback to PeerJS Cloud for static / GitHub Pages hosting
        this.isWsMode = false;
        if (!this.peer || this.peer.destroyed) {
          try {
            this.peer = new Peer(this.getPeerConfig());
            this.peer.on('open', (id) => {
              this.clientId = id;
              this.isConnected = true;
              this.startHeartbeat();
              console.log('[Signaling] Connected to Cloud Signaling (Port 443). Peer ID:', id);
              if (this.onServerStatusChange) {
                this.onServerStatusChange(true, 'Signaling Online (Port 443)');
              }
              if (onSuccess) onSuccess();
            });

            this.peer.on('error', (err) => {
              console.warn('[Signaling] Lobby PeerJS error:', err.type, err.message);
              if (onFallback) onFallback();
            });
          } catch(e) {
            if (onFallback) onFallback();
          }
        } else if (this.peer.open) {
          this.isConnected = true;
          if (this.onServerStatusChange) {
            this.onServerStatusChange(true, 'Signaling Online (Port 443)');
          }
          if (onSuccess) onSuccess();
        }
      }
    );
    return true;
  }

  // =========================================================================
  // Teacher Operations
  // =========================================================================

  createClassroom(teacherName, roomCode = null) {
    this.role = 'teacher';
    this.teacherName = teacherName || 'Professor';
    this.currentRoomCode = roomCode || (typeof SecurityManager !== 'undefined' ? SecurityManager.generateSessionCode(6) : '123456');
    this.teacherIdRetryCount = 0;
    this.updateBroadcastChannel();

    this.tryConnectLocalWebSocket(
      () => {
        // LAN WebSocket Server Mode
        console.log('[Signaling] Registering classroom with LAN server:', this.currentRoomCode);
        this.ws.send(JSON.stringify({
          type: 'room_create',
          teacherName: this.teacherName,
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
        // PeerJS Serverless Mode (Port 443)
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
      this.peer = null;
    }

    try {
      this.peer = new Peer(teacherPeerId, this.getPeerConfig());

      this.peer.on('open', (id) => {
        console.log('[Signaling] Teacher PeerJS session active with ID:', id);
        this.isConnected = true;
        this.startHeartbeat();
        if (this.onServerStatusChange) this.onServerStatusChange(true, 'Signaling Online (Port 443)');
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

        const handleJoinAttempt = (studentName, rollNo) => {
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
            rollNo: rollNo || 'N/A',
            roomCode: this.currentRoomCode
          }, conn.peer);
        };

        if (conn.metadata && conn.metadata.studentName) {
          handleJoinAttempt(conn.metadata.studentName, conn.metadata.rollNo);
        }

        conn.on('open', () => {
          console.log('[Signaling] Data channel opened with student:', conn.peer);
          this.studentConnections.set(conn.peer, conn);
          if (conn.peerConnection && window.webrtc) {
            window.webrtc.peerConnections.set(conn.peer, conn.peerConnection);
          }
          if (conn.dataChannel) {
            conn.dataChannel.binaryType = 'arraybuffer';
            if (window.webrtc) {
              window.webrtc.dataChannels.set(conn.peer, conn.dataChannel);
            }
          }
          if (this.approvedStudents.has(conn.peer)) {
            this.sendApprovalToStudent(conn.peer);
            if (this.activeStream) {
              this.dispatchCallToStudent(conn.peer);
            }
          }
        });

        conn.on('data', (data) => {
          // Binary packet handling for high-speed file transfer
          if (data instanceof ArrayBuffer || data instanceof Blob || (data && data.byteLength !== undefined)) {
            const buf = data instanceof Blob ? data : (data instanceof ArrayBuffer ? data : (data.buffer || data));
            if (window.fileTransfer && typeof window.fileTransfer.handleBinaryChunk === 'function') {
              window.fileTransfer.handleBinaryChunk(conn.peer, buf);
            }
            return;
          }
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
          this.approvedStudents.delete(conn.peer);
          this.acknowledgedStudents.delete(conn.peer);
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

      // Handle student presentation stream call to teacher
      this.peer.on('call', (call) => {
        console.log('[Signaling] Incoming presentation call from student:', call.peer);
        call.answer();

        call.on('stream', (studentStream) => {
          console.log('[Signaling] Received live presentation stream from student:', call.peer);
          this.activeStream = studentStream;
          if (this.onStudentStreamReceived) {
            this.onStudentStreamReceived(call.peer, studentStream);
          }

          // Broadcast student's stream to ALL OTHER admitted students
          this.studentConnections.forEach((conn, studentId) => {
            if (studentId !== call.peer && this.approvedStudents.has(studentId)) {
              this.dispatchCallToStudent(studentId);
            }
          });

          this.send({
            type: 'stream_started',
            hasAudio: studentStream.getAudioTracks().length > 0,
            presenterId: call.peer
          });
        });

        call.on('close', () => {
          console.log('[Signaling] Student presentation call closed:', call.peer);
          this.stopStream();
          if (this.onStudentStreamStopped) {
            this.onStudentStreamStopped(call.peer);
          }
        });

        call.on('error', (err) => {
          console.warn('[Signaling] Student call error:', call.peer, err);
        });
      });

      this.peer.on('error', (err) => {
        console.warn('[Signaling] PeerJS Teacher error:', err.type, err.message);
        if (err.type === 'unavailable-id') {
          this.teacherIdRetryCount++;
          if (this.teacherIdRetryCount <= 3) {
            console.warn(`[Signaling] Teacher ID busy. Retrying in 1.5s (attempt ${this.teacherIdRetryCount}/3)...`);
            setTimeout(() => {
              if (this.role === 'teacher') this.initPeerJsTeacher();
            }, 1500);
          } else {
            console.warn('[Signaling] Generating new room code due to persistent collision...');
            this.currentRoomCode = (typeof SecurityManager !== 'undefined' ? SecurityManager.generateSessionCode(6) : '654321');
            if (typeof updateRoomCodeDisplay === 'function') updateRoomCodeDisplay(this.currentRoomCode);
            this.initPeerJsTeacher();
          }
        }
      });

      this.peer.on('disconnected', () => {
        console.log('[Signaling] Teacher disconnected from signaling cloud. Reconnecting...');
        if (this.peer && !this.peer.destroyed) {
          try { this.peer.reconnect(); } catch(e) {}
        }
      });
    } catch (e) {
      console.error('[Signaling] Failed to initialize PeerJS Teacher:', e);
    }
  }

  // =========================================================================
  // Student Operations
  // =========================================================================

  requestJoinClassroom(roomCode, studentName, rollNo = 'N/A') {
    this.role = 'student';
    this.currentRoomCode = (roomCode || '').trim();
    this.studentName = studentName || 'Student';
    this.studentRollNo = (rollNo && rollNo.trim()) ? rollNo.trim() : 'N/A';
    this.updateBroadcastChannel();

    this.tryConnectLocalWebSocket(
      () => {
        // LAN WebSocket Server Mode
        console.log('[Signaling] Sending student join request via LAN server...');
        this.ws.send(JSON.stringify({
          type: 'room_join_request',
          roomCode: this.currentRoomCode,
          studentName: this.studentName,
          clientInfo: {
            rollNo: this.studentRollNo,
            userAgent: navigator.userAgent,
            screenRes: window.screen.width + 'x' + window.screen.height
          }
        }));
      },
      () => {
        // PeerJS Serverless Mode (Port 443)
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

    if (this.peer && !this.peer.destroyed && this.peer.open) {
      this.connectStudentToTeacher();
      return;
    }

    if (this.peer && !this.peer.destroyed) {
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }

    try {
      this.peer = new Peer(this.getPeerConfig());

      this.peer.on('open', (myId) => {
        console.log('[Signaling] Student PeerJS ready with ID:', myId);
        this.clientId = myId;
        this.isConnected = true;
        this.startHeartbeat();
        if (this.onServerStatusChange) this.onServerStatusChange(true, 'Signaling Online (Port 443)');
        this.connectStudentToTeacher();
      });

      this.peer.on('error', (err) => {
        console.warn('[Signaling] PeerJS Student error:', err.type, err.message);
        if (err.type === 'peer-unavailable') {
          if (typeof showToast === 'function') {
            showToast('Room ' + this.currentRoomCode + ' not found. Ensure professor is broadcasting.', 'warning');
          }
        }
      });

      this.setupStudentCallHandler();
    } catch (e) {
      console.error('[Signaling] Failed to initialize Student PeerJS:', e);
    }
  }

  connectStudentToTeacher() {
    if (!this.peer || this.peer.destroyed || !this.peer.open) return;

    const teacherPeerId = 'smartclass-room-' + this.currentRoomCode + '-teacher';
    console.log('[Signaling] Connecting student to teacher:', teacherPeerId);

    const conn = this.peer.connect(teacherPeerId, {
      serialization: 'json',
      metadata: { studentName: this.studentName, rollNo: this.studentRollNo }
    });

    this.teacherConn = conn;

    const sendJoinPing = () => {
      const payload = {
        type: 'room_join_request',
        senderId: this.clientId,
        studentName: this.studentName,
        rollNo: this.studentRollNo,
        roomCode: this.currentRoomCode,
        clientInfo: {
          rollNo: this.studentRollNo,
          userAgent: navigator.userAgent,
          screenRes: window.screen.width + 'x' + window.screen.height
        }
      };

      if (conn && conn.open) {
        try {
          conn.send(payload);
          console.log('[Signaling] Sent join request ping to professor over DataConnection');
        } catch(e) {}
      }

      // Also deliver via local BroadcastChannel for same-browser testing
      if (this.localBroadcast) {
        try { this.localBroadcast.postMessage(payload); } catch(e) {}
      }
    };

    conn.on('open', () => {
      console.log('[Signaling] Data channel connected to professor! Sending join request...');
      if (conn.peerConnection && window.webrtc) {
        window.webrtc.peerConnections.set(teacherPeerId, conn.peerConnection);
      }
      if (conn.dataChannel) {
        conn.dataChannel.binaryType = 'arraybuffer';
        if (window.webrtc) {
          window.webrtc.dataChannels.set(teacherPeerId, conn.dataChannel);
        }
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
        const buf = data instanceof Blob ? data : (data instanceof ArrayBuffer ? data : (data.buffer || data));
        if (window.fileTransfer && typeof window.fileTransfer.handleBinaryChunk === 'function') {
          window.fileTransfer.handleBinaryChunk(teacherPeerId, buf);
        } else if (typeof this.onBinaryMedia === 'function') {
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
  }

  setupStudentCallHandler() {
    if (!this.peer) return;

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
  }

  // =========================================================================
  // Admission Management
  // =========================================================================

  sendApprovalToStudent(studentId) {
    const payload = {
      type: 'room_join_approved',
      roomCode: this.currentRoomCode,
      teacherId: this.clientId,
      recipientId: studentId,
      timestamp: Date.now()
    };

    // Deliver via BroadcastChannel for same-origin tabs
    if (this.localBroadcast) {
      try { this.localBroadcast.postMessage(payload); } catch(e) {}
    }

    const conn = this.studentConnections.get(studentId);
    if (!conn) return;

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

  approveStudent(studentId) {
    this.approvedStudents.add(studentId);
    console.log('[Signaling] Approving student:', studentId);

    // If running in LAN WebSocket mode:
    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({
          type: 'room_approve_student',
          studentId: studentId
        }));
        console.log('[Signaling] Delivered room_approve_student to LAN server for student:', studentId);
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

  rejectStudent(studentId, reason = 'Professor declined admission request.') {
    this.approvedStudents.delete(studentId);
    this.acknowledgedStudents.delete(studentId);

    const payload = {
      type: 'room_join_rejected',
      reason: reason,
      recipientId: studentId
    };

    if (this.localBroadcast) {
      try { this.localBroadcast.postMessage(payload); } catch(e) {}
    }

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
        conn.send(payload);
        setTimeout(() => {
          try { conn.close(); } catch(e) {}
        }, 400);
      } catch(e) {}
    }
    this.studentConnections.delete(studentId);
    return true;
  }

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

    const payload = {
      type: 'student_kicked',
      reason: reason,
      recipientId: studentId
    };

    if (this.localBroadcast) {
      try { this.localBroadcast.postMessage(payload); } catch(e) {}
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
        conn.send(payload);
        setTimeout(() => {
          try { conn.close(); } catch(e) {}
        }, 400);
      } catch(e) {}
    }
    this.studentConnections.delete(studentId);
    return true;
  }

  terminateClassroom() {
    console.log('[Signaling] Terminating classroom session...');
    this.send({ type: 'room_terminated' });
    this.stopStream();
    this.studentConnections.forEach((conn) => {
      try { conn.close(); } catch(e) {}
    });
    this.studentConnections.clear();
    this.approvedStudents.clear();
    this.acknowledgedStudents.clear();
    if (this.peer && !this.peer.destroyed) {
      try { this.peer.destroy(); } catch(e) {}
    }
    return true;
  }

  // =========================================================================
  // Screen Presentation Broadcasting
  // =========================================================================

  broadcastStream(stream) {
    this.activeStream = stream;

    if (this.peer) {
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

  stopStream() {
    this.activeStream = null;
    this.mediaCalls.forEach((call) => {
      try { call.close(); } catch (e) {}
    });
    this.mediaCalls.clear();
    this.send({ type: 'stream_stopped' });
  }

  grantStudentScreenShare(studentId) {
    console.log('[Signaling] Granting screen share to student:', studentId);
    return this.send({
      type: 'grant_screen_share',
      recipientId: studentId,
      studentId: studentId
    });
  }

  revokeStudentScreenShare(studentId) {
    console.log('[Signaling] Revoking screen share from student:', studentId);
    this.stopStream();
    return this.send({
      type: 'revoke_screen_share',
      recipientId: studentId,
      studentId: studentId
    });
  }

  // =========================================================================
  // Universal Message Delivery & Inbound Router
  // =========================================================================

  send(messageObj) {
    if (!messageObj) return false;
    messageObj.senderId = messageObj.senderId || this.clientId;
    messageObj.roomCode = messageObj.roomCode || this.currentRoomCode;
    messageObj.timestamp = messageObj.timestamp || Date.now();

    // 1. Deliver to any local same-origin browser tabs
    if (this.localBroadcast) {
      try { this.localBroadcast.postMessage(messageObj); } catch (e) {}
    }

    // 2. Deliver via LAN WebSocket if in local mode
    if (this.isWsMode && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(messageObj));
        return true;
      } catch(e) {}
    }

    // 3. Deliver via Student -> Teacher DataConnection
    if (this.role === 'student') {
      if (this.teacherConn && this.teacherConn.open) {
        this.teacherConn.send(messageObj);
        return true;
      }
      return false;
    }

    // 4. Deliver via Teacher -> Specific Student
    if (messageObj.recipientId) {
      const conn = this.studentConnections.get(messageObj.recipientId);
      if (conn && conn.open) {
        conn.send(messageObj);
        return true;
      }
      return false;
    }

    // 5. Deliver via Teacher -> Broadcast to all Students
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

  handleIncomingMessage(msg, fromPeer = null) {
    if (!msg || !msg.type) return;

    // Relay messages across peers if teacher
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

      case 'room_join_ack':
        console.log('[Signaling] Student confirmed admission ACK:', fromPeer || msg.studentId);
        this.acknowledgedStudents.add(fromPeer || msg.studentId);
        if (this.activeStream && this.peer) {
          this.dispatchCallToStudent(fromPeer || msg.studentId);
        }
        break;

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

      case 'request_stream':
        const reqStudentId = fromPeer || msg.senderId;
        if (this.role === 'teacher' && this.activeStream && this.peer) {
          console.log('[Signaling] Student requested stream presentation call. Dispatching to:', reqStudentId);
          this.dispatchCallToStudent(reqStudentId);
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

      case 'file_control':
        if (this.onFileControl) this.onFileControl(msg);
        break;

      case 'grant_screen_share':
        if (this.onGrantScreenShare) this.onGrantScreenShare(msg);
        break;

      case 'revoke_screen_share':
        if (this.onRevokeScreenShare) this.onRevokeScreenShare(msg);
        break;

      case 'student_stream_started':
        if (this.onStudentStreamStarted) this.onStudentStreamStarted(msg);
        break;

      case 'student_stream_stopped':
        if (this.onStudentStreamStopped) this.onStudentStreamStopped(msg);
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

  // =========================================================================
  // Media Streaming & Binary Buffers
  // =========================================================================

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

  // =========================================================================
  // Manual P2P Session Token Exporters
  // =========================================================================

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
      : btoa(JSON.stringify(payload));
  }

  importSessionToken(token) {
    if (!token) return null;
    try {
      if (typeof SecurityManager !== 'undefined' && SecurityManager.decompressSignalToken) {
        return SecurityManager.decompressSignalToken(token);
      }
      return JSON.parse(atob(token));
    } catch (e) {
      console.warn('[Signaling] Token decompression failed, trying raw JSON:', e);
      try {
        return JSON.parse(token);
      } catch (err) {
        return null;
      }
    }
  }

  // =========================================================================
  // Teacher Authentication Methods
  // =========================================================================

  async teacherRegister(username, password, displayName) {
    const backendUrl = window.SmartClassroomConfig ? window.SmartClassroomConfig.getBackendUrl() : '';
    if (!backendUrl) return { success: true, teacher: { username, displayName } };
    try {
      const resp = await fetch(`${backendUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName })
      });
      return await resp.json();
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
    try {
      sessionStorage.removeItem('swc_teacher_token');
      localStorage.removeItem('swc_teacher_user');
      localStorage.removeItem('swc_teacher_name');
    } catch (e) {}
  }

  sanitizeUrl(url) {
    if (!url) return '';
    let clean = url.trim();
    if (!clean.startsWith('ws://') && !clean.startsWith('wss://') && !clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + clean;
    }
    return clean;
  }
}

// Global exposure
window.SignalingManager = SignalingManager;
