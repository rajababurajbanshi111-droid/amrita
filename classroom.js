// --- classroom.js ---
/**
 * SMART WEBRTC CLASSROOM - Classroom Session & Access Control Manager
 * Handles teacher session creation, cryptographic session tokens, student approval queue,
 * participant rosters, classroom permissions, and session termination.
 */

class ClassroomManager {
  constructor(signalingManager, webrtcManager, router) {
    this.signalingManager = signalingManager;
    this.webrtcManager = webrtcManager;
    this.router = router;

    this.role = 'student'; // 'teacher' | 'student' | 'standalone'
    this.sessionCode = null;
    this.teacherName = 'Teacher';
    this.isSessionActive = false;

    // Student rosters and queues
    this.connectedStudents = new Map(); // studentId -> { id, name, joinedAt, ip, peerConnection }
    this.pendingApprovals = new Map();  // studentId -> { id, name, timestamp, clientInfo }

    // Classroom permissions
    this.permissions = {
      allowChat: true,
      allowFileTransfer: true,
      allowStudentScreenShare: false,
      allowStudentAudio: false
    };

    // Callbacks
    this.onStudentJoinRequested = null; // (student) => update UI approval queue
    this.onStudentApproved = null;       // (student) => update UI roster
    this.onStudentRejected = null;       // (studentId) => update UI
    this.onStudentLeft = null;           // (studentId) => update UI
    this.onSessionStarted = null;        // (sessionCode) => update UI
    this.onSessionEnded = null;          // () => update UI
    this.onPermissionsChanged = null;    // (permissions) => update UI

    this.init();
  }

  init() {
    if (!this.signalingManager) return;

    // Hook signaling events
    this.signalingManager.onRoomCreated = (msg) => {
      this.sessionCode = msg.roomCode;
      this.isSessionActive = true;
      if (this.onSessionStarted) {
        this.onSessionStarted(this.sessionCode);
      }
    };

    this.signalingManager.onJoinRequest = (msg) => {
      if (this.role !== 'teacher') return;
      const student = {
        id: msg.senderId,
        name: SecurityManager.escapeHTML(msg.studentName || 'Student'),
        rollNo: SecurityManager.escapeHTML(msg.rollNo || (msg.clientInfo && msg.clientInfo.rollNo) || 'N/A'),
        timestamp: Date.now(),
        clientInfo: msg.clientInfo || {}
      };
      this.pendingApprovals.set(student.id, student);
      if (this.onStudentJoinRequested) {
        this.onStudentJoinRequested(student);
      }
    };

    this.signalingManager.onJoinApproved = (msg) => {
      this.isSessionActive = true;
      this.sessionCode = msg.roomCode;
      console.log(`[Classroom] Joined classroom ${this.sessionCode} successfully.`);
    };

    this.signalingManager.onJoinRejected = (msg) => {
      this.isSessionActive = false;
      this.sessionCode = null;
      console.warn('[Classroom] Join request rejected:', msg.reason);
      if (this.onStudentRejected) {
        this.onStudentRejected(msg.reason || 'Teacher declined access.');
      }
    };

    this.signalingManager.onStudentLeft = (msg) => {
      const studentId = typeof msg === 'string' ? msg : (msg && (msg.studentId || msg.senderId));
      if (!studentId) return;
      this.connectedStudents.delete(studentId);
      this.pendingApprovals.delete(studentId);
      if (this.approvedStudentIds) this.approvedStudentIds.delete(studentId);
      if (this.webrtcManager) {
        try { this.webrtcManager.closeConnection(studentId); } catch (e) {}
      }
      if (this.onStudentLeft) {
        this.onStudentLeft(studentId);
      }
    };
  }

  /**
   * Teacher creates a new classroom session
   */
  createClassroom(teacherName = 'Teacher') {
    this.role = 'teacher';
    this.teacherName = teacherName;
    this.sessionCode = SecurityManager.generateSessionCode(6);
    this.connectedStudents.clear();
    this.pendingApprovals.clear();
    this.isSessionActive = true;

    // Always inform signalingManager of teacher role and room code
    if (this.signalingManager) {
      this.signalingManager.role = 'teacher';
      this.signalingManager.teacherName = teacherName;
      this.signalingManager.currentRoomCode = this.sessionCode;
      this.signalingManager.createClassroom(teacherName, this.sessionCode);
    }

    if (this.onSessionStarted) {
      this.onSessionStarted(this.sessionCode);
    }

    return this.sessionCode;
  }

  /**
   * Student requests to join a classroom
   */
  requestJoin(roomCode, studentName, rollNo = 'N/A') {
    this.role = 'student';
    this.sessionCode = roomCode.trim();
    this.studentRollNo = rollNo;

    if (this.signalingManager) {
      this.signalingManager.requestJoinClassroom(this.sessionCode, studentName, rollNo);
    }
  }

  /**
   * Teacher approves a pending student
   */
  approveStudent(studentId) {
    const student = this.pendingApprovals.get(studentId);
    if (student) {
      this.pendingApprovals.delete(studentId);
      student.joinedAt = Date.now();
      this.connectedStudents.set(studentId, student);
    }
    if (!this.approvedStudentIds) this.approvedStudentIds = new Set();
    this.approvedStudentIds.add(studentId);

    if (this.signalingManager) {
      this.signalingManager.approveStudent(studentId);
    }

    if (this.onStudentApproved && student) {
      this.onStudentApproved(student);
    }

    console.log('[Classroom] Approved student admission:', studentId);
    return true;
  }

  /**
   * Teacher approves all pending students at once
   */
  approveAllPending() {
    const ids = Array.from(this.pendingApprovals.keys());
    ids.forEach((id) => this.approveStudent(id));
  }

  /**
   * Teacher rejects a pending student
   */
  rejectStudent(studentId, reason = 'Professor declined admission request.') {
    this.pendingApprovals.delete(studentId);
    if (this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.rejectStudent(studentId, reason);
    }
    if (typeof renderPendingApprovals === 'function') {
      renderPendingApprovals();
    }
  }

  /**
   * Teacher rejects all pending students
   */
  rejectAllPending() {
    const ids = Array.from(this.pendingApprovals.keys());
    ids.forEach((id) => this.rejectStudent(id));
  }

  /**
   * Teacher removes/kicks an active student
   */
  kickStudent(studentId) {
    this.connectedStudents.delete(studentId);
    if (this.signalingManager) {
      this.signalingManager.kickStudent(studentId, 'You have been removed from the classroom by the professor.');
    }
    if (this.webrtcManager) {
      this.webrtcManager.closeConnection(studentId);
    }
    if (this.onStudentLeft) {
      this.onStudentLeft(studentId, true);
    }
    if (typeof showToast === 'function') {
      showToast('Student removed from classroom session.', 'info');
    }
    if (typeof renderConnectedRoster === 'function') {
      renderConnectedRoster();
    }
  }

  /**
   * Updates permission switches
   */
  updatePermission(key, value) {
    if (this.permissions[key] !== undefined) {
      this.permissions[key] = !!value;
      if (this.router) {
        this.router.broadcastPermissions(this.permissions);
      }
      if (this.onPermissionsChanged) {
        this.onPermissionsChanged(this.permissions);
      }
    }
  }

  /**
   * Ends the entire classroom session cleanly
   */
  endSession() {
    this.isSessionActive = false;
    if (this.router) {
      this.router.broadcastAnnouncement('Session Ended', 'The teacher has ended this classroom session.', 'urgent');
    }
    if (this.signalingManager && this.signalingManager.isConnected) {
      if (typeof this.signalingManager.terminateClassroom === 'function') {
        this.signalingManager.terminateClassroom();
      } else {
        this.signalingManager.send({
          type: 'room_terminate',
          roomCode: this.sessionCode
        });
      }
    }
    if (this.webrtcManager) {
      this.webrtcManager.closeAll();
    }
    this.connectedStudents.clear();
    this.pendingApprovals.clear();
    this.sessionCode = null;

    if (this.onSessionEnded) {
      this.onSessionEnded();
    }
  }
}

// Global exposure
window.ClassroomManager = ClassroomManager;