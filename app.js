// --- app.js ---
/**
 * SMART WEBRTC CLASSROOM - Main Application Controller
 * Coordinates Views (Gateway, Teacher Dashboard, Student Screen),
 * WebRTC peer connections, WebSocket signaling, DataChannel routers,
 * screen share broadcasting, chunked file transfer, and live diagnostics.
 */

document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  // --- 1. Subsystems Initialization ---
  const storage = window.storageManager;
  const webrtc = new WebRTCManager();
  const signaling = window.signalingManager || new SignalingManager();
  window.signalingManager = signaling;
  window.signaling = signaling;
  const router = new DataChannelRouter(webrtc, signaling);
  const screenShare = new ScreenShareManager(webrtc, signaling);
  const fileTransfer = new FileTransferManager(webrtc, router, signaling);
  const media = new MediaManager(webrtc);
  const diagnostics = new DiagnosticsEngine(webrtc);
  const classroom = new ClassroomManager(signaling, webrtc, router);
  window.classroom = classroom;
  window.signaling = signaling;
  window.webrtc = webrtc;
  window.router = router;
  const monitoring = new StudentMonitoringEngine(webrtc, router);

  // Whiteboards: Standalone & Screen Annotation Overlay
  const standaloneCanvas = document.getElementById('standaloneWhiteboardCanvas');
  const overlayCanvas = document.getElementById('stageOverlayCanvas');
  const whiteboard = new WhiteboardManager(standaloneCanvas, router);
  const overlayWhiteboard = new WhiteboardManager(overlayCanvas, router);

  // --- 2. Application State ---
  const profile = storage.getUserProfile();
  let currentView = 'landing'; // 'landing' | 'teacher' | 'student'
  let currentTeacherTab = 'overview';
  let isScreenAnnotationActive = false;
  let isHandRaised = false;
  let sessionTimerInterval = null;
  let sessionStartTime = null;
  let p2pSlotCounter = 0;
  const p2pSlots = new Map(); // slotId -> { slotId, status, pc, offerToken }

  // --- 3. DOM Cache ---
  // Views
  const viewLanding = document.getElementById('viewLanding');
  const viewTeacher = document.getElementById('viewTeacher');
  const viewStudent = document.getElementById('viewStudent');
  const studentJoinScreen = document.getElementById('studentJoinScreen');
  const studentClassroomScreen = document.getElementById('studentClassroomScreen');

  // Header Elements
  const headerLogoBtn = document.getElementById('headerLogoBtn');
  const headerBrandTitle = document.getElementById('headerBrandTitle');
  const appModeBadge = document.getElementById('appModeBadge');
  const headerRoomPill = document.getElementById('headerRoomPill');
  const headerRoomCodeText = document.getElementById('headerRoomCodeText');
  const headerCopyCodeBtn = document.getElementById('headerCopyCodeBtn');
  const headerStatusPill = document.getElementById('headerStatusPill');
  const headerStatusDot = document.getElementById('headerStatusDot');
  const headerStatusText = document.getElementById('headerStatusText');
  const headerLatencyPill = document.getElementById('headerLatencyPill');
  const headerLatencyVal = document.getElementById('headerLatencyVal');
  const headerTimerPill = document.getElementById('headerTimerPill');
  const headerTimerText = document.getElementById('headerTimerText');
  const userRoleBadge = document.getElementById('userRoleBadge');
  const headerSettingsBtn = document.getElementById('headerSettingsBtn');
  const headerExitBtn = document.getElementById('headerExitBtn');

  // Teacher Overview Elements
  const teacherBannerCode = document.getElementById('teacherBannerCode');
  const teacherRoomTitle = document.getElementById('teacherRoomTitle');
  const teacherBannerStudentCount = document.getElementById('teacherBannerStudentCount');
  const teacherBannerClassification = document.getElementById('teacherBannerClassification');
  const teacherBannerBitrate = document.getElementById('teacherBannerBitrate');
  const teacherShowQrBtn = document.getElementById('teacherShowQrBtn');
  const teacherCopyInviteLinkBtn = document.getElementById('teacherCopyInviteLinkBtn');
  const teacherQuickShareBtn = document.getElementById('teacherQuickShareBtn');
  const teacherEndSessionBtn = document.getElementById('teacherEndSessionBtn');

  const teacherKpiStudentCount = document.getElementById('teacherKpiStudentCount');
  const teacherKpiBitrate = document.getElementById('teacherKpiBitrate');
  const teacherKpiRtt = document.getElementById('teacherKpiRtt');
  const teacherKpiClassification = document.getElementById('teacherKpiClassification');
  const teacherAddP2PSlotBtn = document.getElementById('teacherAddP2PSlotBtn');
  const teacherP2PSlotsContainer = document.getElementById('teacherP2PSlotsContainer');

  // Teacher Screen Sharing Elements
  const teacherScreenPreview = document.getElementById('teacherScreenPreview');
  const teacherStageEmptyState = document.getElementById('teacherStageEmptyState');
  const teacherStageControls = document.getElementById('teacherStageControls');
  const teacherStartScreenBtn = document.getElementById('teacherStartScreenBtn');
  const teacherPauseShareBtn = document.getElementById('teacherPauseShareBtn');
  const teacherDrawToggleBtn = document.getElementById('teacherDrawToggleBtn');
  const teacherFullscreenBtn = document.getElementById('teacherFullscreenBtn');
  const teacherStopShareBtn = document.getElementById('teacherStopShareBtn');
  const teacherQualitySelect = document.getElementById('teacherQualitySelect');
  const teacherAudioStatusDot = document.getElementById('teacherAudioStatusDot');
  const teacherAudioStatusText = document.getElementById('teacherAudioStatusText');
  const teacherSidebarScreenDot = document.getElementById('teacherSidebarScreenDot');

  // Teacher Roster & Participants Elements
  const pendingApprovalList = document.getElementById('pendingApprovalList');
  const connectedRosterList = document.getElementById('connectedRosterList');
  const rosterCount = document.getElementById('rosterCount');
  const teacherPendingBadge = document.getElementById('teacherPendingBadge');
  const teacherPendingCountBadge = document.getElementById('teacherPendingCountBadge');
  const approveAllBtn = document.getElementById('approveAllBtn');
  const rejectAllBtn = document.getElementById('rejectAllBtn');
  const rosterSearchInput = document.getElementById('rosterSearchInput');

  // Teacher Announcements & Chat
  const teacherAnnouncementInput = document.getElementById('teacherAnnouncementInput');
  const teacherBroadcastBtn = document.getElementById('teacherBroadcastBtn');
  const chatMessageLog = document.getElementById('chatMessageLog');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');
  const chatExportBtn = document.getElementById('chatExportBtn');
  const chatClearBtn = document.getElementById('chatClearBtn');
  const teacherChatBadge = document.getElementById('teacherChatBadge');
  let teacherUnreadChat = 0;

  // File Vault Elements
  const fileDropZone = document.getElementById('fileDropZone');
  const filePickerInput = document.getElementById('filePickerInput');
  const fileTransferList = document.getElementById('fileTransferList');

  // Diagnostics Elements
  const diagClassificationBadge = document.getElementById('diagClassificationBadge');
  const diagPathType = document.getElementById('diagPathType');
  const diagCandidatePair = document.getElementById('diagCandidatePair');
  const diagProtocol = document.getElementById('diagProtocol');
  const diagRtt = document.getElementById('diagRtt');
  const diagOutBitrate = document.getElementById('diagOutBitrate');
  const diagInBitrate = document.getElementById('diagInBitrate');
  const diagPacketLoss = document.getElementById('diagPacketLoss');
  const diagResolution = document.getElementById('diagResolution');
  const diagIceGathering = document.getElementById('diagIceGathering');
  const diagInterruptions = document.getElementById('diagInterruptions');

  // Student Screen Elements
  const studentRoomCodeInput = document.getElementById('studentRoomCodeInput');
  const studentDisplayNameInput = document.getElementById('studentDisplayNameInput');
  const studentRollNumberInput = document.getElementById('studentRollNumberInput');
  const studentSubmitJoinBtn = document.getElementById('studentSubmitJoinBtn');
  const studentWaitingApprovalBox = document.getElementById('studentWaitingApprovalBox');
  const studentAutoJoinForm = document.getElementById('studentAutoJoinForm');
  const studentBackToGatewayBtn = document.getElementById('studentBackToGatewayBtn');

  // URL Query Parameter Handling (e.g. ?room=123456)
  const urlParams = new URLSearchParams(window.location.search);

  // Auto-populate saved Student Name & Roll Number from localStorage, but NEVER restore old Session Code
  if (studentDisplayNameInput && profile && profile.displayName) {
    studentDisplayNameInput.value = profile.displayName;
  }
  if (studentRollNumberInput && profile && profile.rollNo) {
    studentRollNumberInput.value = profile.rollNo;
  }
  if (studentRoomCodeInput && !urlParams.has('room')) {
    studentRoomCodeInput.value = '';
  }

  // Persist Student Name & Roll Number automatically when edited
  if (studentDisplayNameInput) {
    studentDisplayNameInput.addEventListener('input', () => {
      storage.saveUserProfile({ displayName: studentDisplayNameInput.value.trim() });
    });
  }
  if (studentRollNumberInput) {
    studentRollNumberInput.addEventListener('input', () => {
      storage.saveUserProfile({ rollNo: studentRollNumberInput.value.trim() });
    });
  }

  const studentRemoteVideo = document.getElementById('studentRemoteVideo');
  const studentStreamEmptyState = document.getElementById('studentStreamEmptyState');
  const studentHudPathBadge = document.getElementById('studentHudPathBadge');
  const studentHudRes = document.getElementById('studentHudRes');
  const studentHudFps = document.getElementById('studentHudFps');
  const studentHudRtt = document.getElementById('studentHudRtt');
  const studentToggleAudioBtn = document.getElementById('studentToggleAudioBtn');
  const studentFullscreenBtn = document.getElementById('studentFullscreenBtn');
  const studentTogglePanelBtn = document.getElementById('studentTogglePanelBtn');
  const studentClosePanelBtn = document.getElementById('studentClosePanelBtn');
  const studentLeaveClassroomBtn = document.getElementById('studentLeaveClassroomBtn');
  const studentSidePanel = document.getElementById('studentSidePanel');
  const studentReactionsLayer = document.getElementById('studentReactionsLayer');

  const studentChatLog = document.getElementById('studentChatLog');
  const studentChatInput = document.getElementById('studentChatInput');
  const studentChatSendBtn = document.getElementById('studentChatSendBtn');
  const studentPinnedAnnouncement = document.getElementById('studentPinnedAnnouncement');
  const studentPinnedText = document.getElementById('studentPinnedText');
  const studentAnnouncementsList = document.getElementById('studentAnnouncementsList');
  const studentFilesList = document.getElementById('studentFilesList');
  const studentRaiseHandBtn = document.getElementById('studentRaiseHandBtn');
  const studentRaiseHandText = document.getElementById('studentRaiseHandText');

  // Modals
  const createClassroomModal = document.getElementById('createClassroomModal');
  const backendSettingsModal = document.getElementById('backendSettingsModal');
  const qrModal = document.getElementById('qrModal');
  const sessionQrCanvas = document.getElementById('sessionQrCanvas');
  const qrRoomCodeDisplay = document.getElementById('qrRoomCodeDisplay');
  const manualSignalingModal = document.getElementById('manualSignalingModal');
  const fileApprovalModal = document.getElementById('fileApprovalModal');
  const settingsModal = document.getElementById('settingsModal');

  let activeInboundFileId = null;

  // --- 4. Toast Notification System (Throttled & Debounced) ---
  const recentToasts = new Map();
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container || !message) return;

    // Debounce duplicate messages within 3 seconds
    const now = Date.now();
    const last = recentToasts.get(message);
    if (last && (now - last) < 3000) {
      return;
    }
    recentToasts.set(message, now);

    // Limit maximum stacked toasts to 3
    while (container.children.length >= 3) {
      container.removeChild(container.firstChild);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(50px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
        recentToasts.delete(message);
      }, 250);
    }, 3500);
  }

  function openModal(modal) {
    if (modal) modal.classList.add('active');
  }

  function closeModal(modal) {
    if (modal) modal.classList.remove('active');
  }

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal-backdrop').forEach((m) => closeModal(m));
    });
  });

  // --- 5. Navigation & View Routing ---
  function switchView(viewName) {
    // LOCK TEACHER DASHBOARD: Active teacher must never be kicked to student view!
    if (classroom.role === 'teacher' && viewName === 'student') {
      console.warn('[App] Blocked unauthorized attempt to switch active teacher to student view.');
      return;
    }
    currentView = viewName;
    document.querySelectorAll('.app-view').forEach((v) => v.classList.remove('active'));

    if (viewName === 'landing') {
      viewLanding.classList.add('active');
      headerRoomPill.style.display = 'none';
      headerTimerPill.style.display = 'none';
      headerExitBtn.style.display = 'none';
      userRoleBadge.textContent = 'Guest';
      userRoleBadge.className = 'role-badge';
      if (studentRoomCodeInput && (!urlParams || !urlParams.has('room'))) {
        studentRoomCodeInput.value = '';
      }
    } else if (viewName === 'teacher') {
      viewTeacher.classList.add('active');
      headerRoomPill.style.display = 'flex';
      headerTimerPill.style.display = 'flex';
      headerExitBtn.style.display = 'inline-block';
      userRoleBadge.textContent = 'Teacher';
      userRoleBadge.className = 'role-badge teacher';
      switchTeacherTab(currentTeacherTab || 'overview');
    } else if (viewName === 'student') {
      viewStudent.classList.add('active');
      userRoleBadge.textContent = 'Student';
      userRoleBadge.className = 'role-badge';
      if (classroom.isApproved && classroom.isSessionActive) {
        studentJoinScreen.style.display = 'none';
        studentClassroomScreen.style.display = 'flex';
        headerRoomPill.style.display = 'flex';
        headerTimerPill.style.display = 'flex';
        headerExitBtn.style.display = 'inline-block';
      } else {
        studentJoinScreen.style.display = 'flex';
        studentClassroomScreen.style.display = 'none';
        headerRoomPill.style.display = 'none';
        headerTimerPill.style.display = 'none';
        headerExitBtn.style.display = 'none';
        if (studentRoomCodeInput && (!urlParams || !urlParams.has('room'))) {
          studentRoomCodeInput.value = '';
        }
      }
    }
  }

  function switchTeacherTab(tabName) {
    currentTeacherTab = tabName;
    document.querySelectorAll('.teacher-nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-teacher-tab') === tabName);
    });

    document.querySelectorAll('.teacher-section').forEach((sec) => sec.classList.remove('active'));

    const tabMap = {
      overview: 'teacherSectionOverview',
      screen: 'teacherSectionScreen',
      participants: 'teacherSectionParticipants',
      chat: 'teacherSectionChat',
      files: 'teacherSectionFiles',
      diagnostics: 'teacherSectionDiagnostics',
      whiteboard: 'teacherSectionWhiteboard',
      privacy: 'teacherSectionPrivacy',
      help: 'teacherSectionHelp'
    };

    const targetSecId = tabMap[tabName] || 'teacherSectionOverview';
    const targetSec = document.getElementById(targetSecId);
    if (targetSec) targetSec.classList.add('active');

    if (tabName === 'chat') {
      teacherUnreadChat = 0;
      teacherChatBadge.style.display = 'none';
    }
  }

  document.querySelectorAll('[data-teacher-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTeacherTab(btn.getAttribute('data-teacher-tab'));
    });
  });

  // Top header clicks
  headerLogoBtn.addEventListener('click', () => {
    if (classroom.isSessionActive) {
      if (!confirm('Leave current classroom session and return to home?')) return;
      handleExitSession();
      return;
    }
    switchView('landing');
  });
  headerBrandTitle.addEventListener('click', () => {
    if (classroom.isSessionActive) {
      if (!confirm('Leave current classroom session and return to home?')) return;
      handleExitSession();
      return;
    }
    switchView('landing');
  });
  headerExitBtn.addEventListener('click', () => {
    if (confirm('Exit current classroom session and return to gateway?')) {
      handleExitSession();
    }
  });

  document.getElementById('gatewayLaunchTeacherBtn').addEventListener('click', () => {
    if (!classroom.isSessionActive) {
      if (typeof syncTeacherAuthState === 'function') syncTeacherAuthState();
      openModal(createClassroomModal);
    } else {
      switchView('teacher');
    }
  });

  document.getElementById('gatewayLaunchStudentBtn').addEventListener('click', () => {
    switchView('student');
  });

  studentBackToGatewayBtn.addEventListener('click', () => {
    if (studentRoomCodeInput) studentRoomCodeInput.value = '';
    switchView('landing');
  });

  // --- 6. Session Timer Helper ---
  function startSessionTimer() {
    if (sessionTimerInterval) clearInterval(sessionTimerInterval);
    sessionStartTime = Date.now();
    headerTimerPill.style.display = 'flex';

    sessionTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
      const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0');
      const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      headerTimerText.textContent = `${hrs}:${mins}:${secs}`;
    }, 1000);
  }

  function stopSessionTimer() {
    if (sessionTimerInterval) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
    }
    headerTimerText.textContent = '00:00:00';
    headerTimerPill.style.display = 'none';
  }

  // --- Teacher Authentication Subsystem ---
  const tabBtnSignIn = document.getElementById('tabBtnSignIn');
  const tabBtnRegister = document.getElementById('tabBtnRegister');
  const tabBtnDemo = document.getElementById('tabBtnDemo');
  const authPaneSignIn = document.getElementById('authPaneSignIn');
  const authPaneRegister = document.getElementById('authPaneRegister');
  const authPaneDemo = document.getElementById('authPaneDemo');

  const teacherAuthUsername = document.getElementById('teacherAuthUsername');
  const teacherAuthPassword = document.getElementById('teacherAuthPassword');
  const teacherAuthLoginBtn = document.getElementById('teacherAuthLoginBtn');

  const teacherRegisterName = document.getElementById('teacherRegisterName');
  const teacherRegisterUsername = document.getElementById('teacherRegisterUsername');
  const teacherRegisterPassword = document.getElementById('teacherRegisterPassword');
  const teacherAuthRegisterBtn = document.getElementById('teacherAuthRegisterBtn');

  const teacherAuthLoggedInBox = document.getElementById('teacherAuthLoggedInBox');
  const teacherAuthTabsContainer = document.getElementById('teacherAuthTabsContainer');
  const teacherAuthActiveName = document.getElementById('teacherAuthActiveName');
  const teacherAuthActiveUser = document.getElementById('teacherAuthActiveUser');
  const teacherAuthLogoutBtn = document.getElementById('teacherAuthLogoutBtn');

  function syncTeacherAuthState() {
    const savedToken = signaling.getSavedTeacherToken();
    const savedUser = localStorage.getItem('swc_teacher_user');
    const savedName = localStorage.getItem('swc_teacher_name');

    if (savedToken && savedUser && teacherAuthLoggedInBox && teacherAuthTabsContainer) {
      teacherAuthLoggedInBox.style.display = 'flex';
      teacherAuthTabsContainer.style.display = 'none';
      if (teacherAuthActiveUser) teacherAuthActiveUser.textContent = savedUser;
      if (teacherAuthActiveName) teacherAuthActiveName.textContent = savedName || savedUser;
      const teacherNameInput = document.getElementById('createTeacherNameInput');
      if (teacherNameInput && (!teacherNameInput.value || teacherNameInput.value === 'Professor')) {
        teacherNameInput.value = savedName || savedUser;
      }
    } else if (teacherAuthLoggedInBox && teacherAuthTabsContainer) {
      teacherAuthLoggedInBox.style.display = 'none';
      teacherAuthTabsContainer.style.display = 'block';
    }
  }

  function setAuthTab(tab) {
    if (!tabBtnSignIn || !tabBtnRegister || !tabBtnDemo) return;
    tabBtnSignIn.classList.toggle('active', tab === 'signin');
    tabBtnRegister.classList.toggle('active', tab === 'register');
    tabBtnDemo.classList.toggle('active', tab === 'demo');

    tabBtnSignIn.style.color = tab === 'signin' ? 'var(--accent-amber)' : 'var(--text-muted)';
    tabBtnRegister.style.color = tab === 'register' ? 'var(--accent-amber)' : 'var(--text-muted)';
    tabBtnDemo.style.color = tab === 'demo' ? 'var(--accent-amber)' : 'var(--text-muted)';

    if (authPaneSignIn) authPaneSignIn.style.display = tab === 'signin' ? 'block' : 'none';
    if (authPaneRegister) authPaneRegister.style.display = tab === 'register' ? 'block' : 'none';
    if (authPaneDemo) authPaneDemo.style.display = tab === 'demo' ? 'block' : 'none';
  }

  if (tabBtnSignIn) tabBtnSignIn.addEventListener('click', () => setAuthTab('signin'));
  if (tabBtnRegister) tabBtnRegister.addEventListener('click', () => setAuthTab('register'));
  if (tabBtnDemo) tabBtnDemo.addEventListener('click', () => setAuthTab('demo'));

  if (teacherAuthLoginBtn) {
    teacherAuthLoginBtn.addEventListener('click', async () => {
      const username = teacherAuthUsername ? teacherAuthUsername.value.trim() : '';
      const password = teacherAuthPassword ? teacherAuthPassword.value : '';
      if (!username || !password) {
        showToast('Please enter username and password.', 'warning');
        return;
      }
      teacherAuthLoginBtn.disabled = true;
      teacherAuthLoginBtn.textContent = 'Signing in...';
      try {
        const res = await signaling.teacherLogin(username, password);
        if (res && res.success) {
          showToast(`Welcome, ${res.teacher?.displayName || username}!`, 'success');
          syncTeacherAuthState();
        } else {
          showToast(res.error || 'Authentication failed. Check credentials.', 'error');
        }
      } catch (err) {
        showToast(`Login error: ${err.message}`, 'error');
      } finally {
        teacherAuthLoginBtn.disabled = false;
        teacherAuthLoginBtn.textContent = 'Sign In';
      }
    });
  }

  if (teacherAuthRegisterBtn) {
    teacherAuthRegisterBtn.addEventListener('click', async () => {
      const displayName = teacherRegisterName ? teacherRegisterName.value.trim() : '';
      const username = teacherRegisterUsername ? teacherRegisterUsername.value.trim() : '';
      const password = teacherRegisterPassword ? teacherRegisterPassword.value : '';
      if (!displayName || !username || !password) {
        showToast('Please fill in all fields to register.', 'warning');
        return;
      }
      if (password.length < 6) {
        showToast('Password must be at least 6 characters.', 'warning');
        return;
      }
      teacherAuthRegisterBtn.disabled = true;
      teacherAuthRegisterBtn.textContent = 'Creating...';
      try {
        const res = await signaling.teacherRegister(username, password, displayName);
        if (res && res.success) {
          showToast(`Account created for ${displayName}!`, 'success');
          syncTeacherAuthState();
        } else {
          showToast(res.error || 'Registration failed.', 'error');
        }
      } catch (err) {
        showToast(`Registration error: ${err.message}`, 'error');
      } finally {
        teacherAuthRegisterBtn.disabled = false;
        teacherAuthRegisterBtn.textContent = 'Create Account';
      }
    });
  }

  if (teacherAuthLogoutBtn) {
    teacherAuthLogoutBtn.addEventListener('click', () => {
      signaling.clearTeacherAuth();
      showToast('Signed out of teacher account.', 'info');
      syncTeacherAuthState();
    });
  }

  syncTeacherAuthState();

  // --- Backend Settings Subsystem ---
  const settingsBackendUrlInput = document.getElementById('settingsBackendUrlInput');
  const settingsWsUrlDisplay = document.getElementById('settingsWsUrlDisplay');
  const settingsIceCountDisplay = document.getElementById('settingsIceCountDisplay');
  const settingsSaveBackendBtn = document.getElementById('settingsSaveBackendBtn');
  const settingsResetBackendBtn = document.getElementById('settingsResetBackendBtn');

  function refreshBackendSettingsDisplay() {
    if (typeof SmartClassroomConfig !== 'undefined') {
      if (settingsBackendUrlInput) settingsBackendUrlInput.value = SmartClassroomConfig.getBackendUrl();
      if (settingsWsUrlDisplay) settingsWsUrlDisplay.textContent = SmartClassroomConfig.getWebSocketUrl();
      if (settingsIceCountDisplay) {
        const count = SmartClassroomConfig.iceServers.length;
        settingsIceCountDisplay.textContent = `${count} ICE server${count !== 1 ? 's' : ''} active`;
      }
    }
  }

  if (headerSettingsBtn) {
    headerSettingsBtn.style.display = 'inline-flex';
    headerSettingsBtn.addEventListener('click', () => {
      refreshBackendSettingsDisplay();
      openModal(backendSettingsModal);
    });
  }

  if (settingsSaveBackendBtn) {
    settingsSaveBackendBtn.addEventListener('click', async () => {
      const url = settingsBackendUrlInput ? settingsBackendUrlInput.value.trim() : '';
      if (!url) {
        showToast('Please enter a valid backend URL.', 'warning');
        return;
      }
      if (typeof SmartClassroomConfig !== 'undefined') {
        SmartClassroomConfig.setBackendUrl(url);
        refreshBackendSettingsDisplay();
        closeModal(backendSettingsModal);
        showToast(`Backend set to ${url}. Reconnecting signaling...`, 'info');
        await signaling.fetchBackendIceConfig();
        signaling.connectWebSocket();
      }
    });
  }

  if (settingsResetBackendBtn) {
    settingsResetBackendBtn.addEventListener('click', async () => {
      if (typeof SmartClassroomConfig !== 'undefined') {
        SmartClassroomConfig.resetBackendUrl();
        refreshBackendSettingsDisplay();
        showToast('Reset backend URL to default.', 'info');
        await signaling.fetchBackendIceConfig();
        signaling.connectWebSocket();
      }
    });
  }

  // --- 7. Teacher Classroom Actions ---
  document.getElementById('confirmCreateClassroomBtn').addEventListener('click', () => {
    const teacherName = document.getElementById('createTeacherNameInput').value.trim() || 'Professor';
    const qualityPreset = document.getElementById('createQualitySelect').value;

    storage.saveUserProfile({ displayName: teacherName, role: 'teacher', qualityPreset });

    const code = classroom.createClassroom(teacherName);
    closeModal(createClassroomModal);
    switchView('teacher');
    startSessionTimer();

    updateRoomCodeDisplay(code);
    showToast(`Classroom launched! Room Code: ${code}`, 'success');
  });

  // Auto-detect teacher LAN IP for easy student sharing
  let teacherLanUrl = window.location.origin;
  async function detectLanNetwork() {
    try {
      const res = await fetch('/api/discovery');
      if (res.ok) {
        const data = await res.json();
        if (data && data.interfaces && data.interfaces.length > 0) {
          // Prefer Wi-Fi or Ethernet interface over virtual adapters
          const preferred = data.interfaces.find(i => /wi-?fi|ethernet|wlan/i.test(i.name)) 
                         || data.interfaces.find(i => !/vmnet|virtual|protun/i.test(i.name)) 
                         || data.interfaces[0];
          if (preferred && preferred.address) {
            const port = window.location.port || '3000';
            teacherLanUrl = `http://${preferred.address}:${port}`;
            console.log('[LAN] Discovered Teacher LAN URL:', teacherLanUrl);
            const bannerLanUrl = document.getElementById('teacherBannerLanUrl');
            if (bannerLanUrl) {
              bannerLanUrl.textContent = teacherLanUrl;
            }
          }
        }
      }
    } catch (e) {
      // Offline fallback
    }
  }
  detectLanNetwork();

  const bannerLanUrlEl = document.getElementById('teacherBannerLanUrl');
  if (bannerLanUrlEl) {
    bannerLanUrlEl.addEventListener('click', () => {
      const code = classroom.sessionCode || headerRoomCodeText.textContent;
      const url = `${teacherLanUrl}/?room=${code}&role=student`;
      navigator.clipboard.writeText(url).then(() => showToast(`Student Join URL copied: ${url}`, 'success'));
    });
  }

  function updateRoomCodeDisplay(code) {
    headerRoomCodeText.textContent = code;
    teacherBannerCode.querySelector('span').textContent = code;
    qrRoomCodeDisplay.textContent = code;
    teacherRoomTitle.textContent = `Classroom Active (Room: ${code})`;

    // Generate dynamic QR code using LAN URL
    const joinUrl = `${teacherLanUrl}/?room=${code}&role=student`;
    try {
      QRCodeEngine.renderToCanvas(sessionQrCanvas, joinUrl, {
        size: 200,
        darkColor: '#00f0ff',
        lightColor: '#0c101d'
      });
    } catch (e) {
      console.warn('QR render error:', e);
    }
  }

  // Copy code handlers
  function copyRoomCode() {
    const code = classroom.sessionCode || headerRoomCodeText.textContent;
    if (code && code !== '------') {
      navigator.clipboard.writeText(code).then(() => showToast(`Room Code ${code} copied!`, 'success'));
    }
  }
  headerCopyCodeBtn.addEventListener('click', copyRoomCode);
  teacherBannerCode.addEventListener('click', copyRoomCode);

  teacherShowQrBtn.addEventListener('click', () => openModal(qrModal));

  teacherCopyInviteLinkBtn.addEventListener('click', () => {
    const code = classroom.sessionCode || headerRoomCodeText.textContent;
    const url = `${teacherLanUrl}/?room=${code}&role=student`;
    navigator.clipboard.writeText(url).then(() => showToast(`Student invite link copied! (${url})`, 'success'));
  });

  teacherEndSessionBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to conclude the classroom session for all students?')) {
      handleExitSession();
    }
  });

  function handleExitSession() {
    if (screenShare.isSharing) screenShare.stopScreenShare();
    classroom.endSession();
    stopSessionTimer();
    if (studentRoomCodeInput) studentRoomCodeInput.value = '';
    switchView('landing');
    showToast('Classroom session concluded.', 'warning');
  }

  // --- 8. Stage 1: Zero-Server P2P Slot Manager (Teacher Side) ---
  if (teacherAddP2PSlotBtn) {
    teacherAddP2PSlotBtn.addEventListener('click', async () => {
    p2pSlotCounter++;
    const slotId = `student_slot_${p2pSlotCounter}`;

    try {
      showToast(`Generating Zero-Server P2P offer for Student #${p2pSlotCounter}...`, 'info');
      // Wait for complete ICE candidates gathering so token is fully self-contained!
      const offer = await webrtc.createOffer(slotId, true);
      const token = signaling.exportSessionToken(offer);

      const slotObj = {
        slotId: slotId,
        slotNumber: p2pSlotCounter,
        status: 'waiting',
        offerToken: token
      };
      p2pSlots.set(slotId, slotObj);

      renderP2PSlots();
      showToast(`Slot #${p2pSlotCounter} ready! Copy token or scan QR code.`, 'success');
    } catch (err) {
      showToast(`Error creating P2P slot: ${err.message}`, 'error');
    }
  });
  }

  function renderP2PSlots() {
    if (!teacherP2PSlotsContainer) return;
    if (p2pSlots.size === 0) {
      teacherP2PSlotsContainer.innerHTML = `
        <div style="grid-column: 1 / -1; color: var(--text-muted); font-size: 0.82rem; padding: 1rem; text-align: center; border: 1px dashed var(--border-subtle); border-radius: var(--radius-md);">
          No direct P2P slots active. Click <strong>Generate Student Join Token</strong> to invite a student without any server.
        </div>
      `;
      return;
    }

    teacherP2PSlotsContainer.innerHTML = '';
    p2pSlots.forEach((slot) => {
      const card = document.createElement('div');
      card.className = `p2p-slot-card ${slot.status === 'connected' ? 'connected' : ''}`;
      card.id = `card_${slot.slotId}`;

      const statusBadge = slot.status === 'connected'
        ? '<span class="badge-classification badge-lan">🟢 CONNECTED</span>'
        : '<span class="badge-classification badge-pending">WAITING FOR ANSWER</span>';

      card.innerHTML = `
        <div class="slot-header">
          <span class="slot-name">Student Connection #${slot.slotNumber}</span>
          ${statusBadge}
        </div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <button class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.75rem;" data-link-slot="${slot.slotId}">🔗 Copy 1-Click Invite Link</button>
          <button class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.75rem;" data-copy-slot="${slot.slotId}">Copy Token</button>
          <button class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.75rem;" data-qr-slot="${slot.slotId}">Show QR</button>
        </div>
        <div>
          <label style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 0.25rem; display: block;">Paste Student Answer Token:</label>
          <textarea class="token-textarea" style="height: 60px;" placeholder="Paste student SWC1_ answer token here..." data-answer-input="${slot.slotId}"></textarea>
          <button class="btn btn-success" style="margin-top: 0.4rem; padding: 0.35rem 0.75rem; font-size: 0.75rem;" data-connect-slot="${slot.slotId}">
            Complete P2P Connection
          </button>
        </div>
      `;

      // Copy 1-click link
      card.querySelector(`[data-link-slot="${slot.slotId}"]`).addEventListener('click', () => {
        const directLink = `${window.location.origin}${window.location.pathname}?offer=${encodeURIComponent(slot.offerToken)}`;
        navigator.clipboard.writeText(directLink).then(() => showToast(`1-Click Invite Link for Student #${slot.slotNumber} copied! Send to student.`, 'success'));
      });

      // Copy slot offer
      card.querySelector(`[data-copy-slot="${slot.slotId}"]`).addEventListener('click', () => {
        navigator.clipboard.writeText(slot.offerToken).then(() => showToast(`Offer Token for Slot #${slot.slotNumber} copied!`, 'success'));
      });

      // Show slot QR
      card.querySelector(`[data-qr-slot="${slot.slotId}"]`).addEventListener('click', () => {
        QRCodeEngine.renderToCanvas(sessionQrCanvas, slot.offerToken, { size: 220, darkColor: '#00f0ff', lightColor: '#0c101d' });
        qrRoomCodeDisplay.textContent = `Slot #${slot.slotNumber} Token`;
        openModal(qrModal);
      });

      // Connect slot answer
      card.querySelector(`[data-connect-slot="${slot.slotId}"]`).addEventListener('click', async () => {
        const textarea = card.querySelector(`[data-answer-input="${slot.slotId}"]`);
        const ansToken = textarea.value.trim();
        if (!ansToken) return showToast('Paste student answer token first.', 'warning');

        try {
          const parsedAnswer = signaling.importSessionToken(ansToken);
          await webrtc.handleAnswer(slot.slotId, parsedAnswer);
          slot.status = 'connected';
          renderP2PSlots();
          showToast(`Student #${slot.slotNumber} connected peer-to-peer!`, 'success');
        } catch (err) {
          showToast(`Connection failed: ${err.message}`, 'error');
        }
      });

      teacherP2PSlotsContainer.appendChild(card);
    });
  }

  // --- 9. Screen Sharing Workflow ---
  teacherQuickShareBtn.addEventListener('click', () => {
    switchTeacherTab('screen');
    startPresenterScreenShare();
  });

  teacherStartScreenBtn.addEventListener('click', startPresenterScreenShare);

  async function startPresenterScreenShare() {
    const preset = teacherQualitySelect.value || 'balanced';
    try {
      showToast('Launching native screen capture dialog...', 'info');
      const stream = await screenShare.startScreenShare(preset, true);
      teacherScreenPreview.srcObject = stream;
      teacherScreenPreview.play().catch(() => {});
      teacherStageEmptyState.style.display = 'none';
      teacherStageControls.style.display = 'flex';
      teacherSidebarScreenDot.style.display = 'inline-block';

      const hasAudio = !!screenShare.audioTrack;
      teacherAudioStatusDot.className = hasAudio ? 'status-dot active' : 'status-dot';
      teacherAudioStatusText.textContent = hasAudio ? 'Audio: Active' : 'Video Only';

      showToast('Screen broadcasting active to classroom!', 'success');
      if (signaling && signaling.isConnected) {
        signaling.send({ type: 'stream_started', hasAudio: hasAudio });
      }
    } catch (err) {
      console.warn('[App] Screen share launch note:', err);
      if (err.name !== 'NotAllowedError' && (!err.message || !err.message.toLowerCase().includes('cancel'))) {
        showToast(`Screen share notice: ${err.message || 'Please select a screen or window to share.'}`, 'warning');
      } else {
        showToast('Screen share dialog was cancelled.', 'info');
      }
    }
  }

  teacherStopShareBtn.addEventListener('click', () => {
    screenShare.stopScreenShare();
    teacherScreenPreview.srcObject = null;
    teacherStageEmptyState.style.display = 'flex';
    teacherStageControls.style.display = 'none';
    teacherSidebarScreenDot.style.display = 'none';
    showToast('Screen broadcasting stopped.', 'info');
    if (signaling && signaling.isConnected) {
      signaling.send({ type: 'stream_stopped' });
    }
  });

  teacherPauseShareBtn.addEventListener('click', () => {
    const isPaused = screenShare.togglePause();
    teacherPauseShareBtn.classList.toggle('active', isPaused);
    showToast(isPaused ? 'Screen stream paused.' : 'Screen stream resumed.', 'info');
  });

  teacherFullscreenBtn.addEventListener('click', () => {
    const wrapper = document.getElementById('teacherStageWrapper');
    if (!document.fullscreenElement) wrapper.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });

  teacherDrawToggleBtn.addEventListener('click', () => {
    isScreenAnnotationActive = !isScreenAnnotationActive;
    teacherDrawToggleBtn.classList.toggle('active', isScreenAnnotationActive);
    overlayCanvas.classList.toggle('drawing-active', isScreenAnnotationActive);
    if (isScreenAnnotationActive) {
      overlayWhiteboard.resizeCanvas();
      showToast('Laser Pointer & Annotation overlay active.', 'info');
    }
  });

  teacherQualitySelect.addEventListener('change', () => {
    screenShare.switchPreset(teacherQualitySelect.value);
  });

  // --- 10. Unified Student Join Workflow (Session Code Only) ---
  studentSubmitJoinBtn.addEventListener('click', () => {
    let rawCode = studentRoomCodeInput.value || '';
    const code = rawCode.trim().replace(/[^0-9]/g, '');
    const name = studentDisplayNameInput.value.trim() || 'Student';
    const rollNoInput = document.getElementById('studentRollNumberInput');
    const rollNo = (rollNoInput ? rollNoInput.value.trim() : '') || 'N/A';

    if (!code || code.length !== 6) {
      return showToast('Please enter a valid 6-digit session code (e.g. 482913).', 'warning');
    }

    studentRoomCodeInput.value = code;
    storage.saveUserProfile({ displayName: name, rollNo: rollNo, role: 'student' });
    classroom.requestJoin(code, name, rollNo);

    studentAutoJoinForm.style.display = 'none';
    studentWaitingApprovalBox.style.display = 'block';
    showToast(`Connecting to room ${code}... Please wait.`, 'info');
  });

  const studentCancelWaitBtn = document.getElementById('studentCancelWaitBtn');
  if (studentCancelWaitBtn) {
    studentCancelWaitBtn.addEventListener('click', () => {
      studentWaitingApprovalBox.style.display = 'none';
      studentAutoJoinForm.style.display = 'flex';
    });
  }

  const studentEnterStageBtn = document.getElementById('studentEnterStageBtn');
  if (studentEnterStageBtn) {
    studentEnterStageBtn.addEventListener('click', () => {
      classroom.isApproved = true;
      classroom.isSessionActive = true;
      if (studentWaitingApprovalBox) studentWaitingApprovalBox.style.setProperty('display', 'none', 'important');
      if (studentAutoJoinForm) studentAutoJoinForm.style.setProperty('display', 'none', 'important');
      if (studentJoinScreen) studentJoinScreen.style.setProperty('display', 'none', 'important');
      if (studentClassroomScreen) studentClassroomScreen.style.setProperty('display', 'flex', 'important');
      switchView('student');
      startSessionTimer();
      if (signaling.pendingRemoteStream) {
        activateRemoteVideoStream(signaling.pendingRemoteStream);
      } else if (signaling.isWsMode) {
        signaling.sendMessage({
          type: 'request_stream',
          senderId: signaling.clientId,
          roomCode: classroom.sessionCode
        });
        console.log('[App] Sent request_stream to professor via manual stage entry (WS mode)');
      } else if (signaling.teacherConn && signaling.teacherConn.open) {
        try {
          signaling.teacherConn.send({
            type: 'request_stream',
            senderId: signaling.clientId,
            roomCode: classroom.sessionCode
          });
          console.log('[App] Sent request_stream to professor via manual stage entry');
        } catch(e) {}
      }
      showToast('Entered Amrita classroom stage!', 'success');
    });
  }

  // Student Video Engine Controller ('webrtc' | 'sfu' | 'none')
  const studentFallbackCanvas = document.getElementById('studentFallbackCanvas');
  const studentFallbackCtx = studentFallbackCanvas ? studentFallbackCanvas.getContext('2d') : null;
  let currentStreamEngine = 'none';
  let isDecodingSfuFrame = false;
  let sfuFrameCount = 0;
  let lastSfuFpsCalc = Date.now();
  let currentSfuFps = 0;

  function setStreamEngine(engine) {
    if (currentStreamEngine === engine) return;
    currentStreamEngine = engine;
    console.log(`[App] Display engine active: ${engine.toUpperCase()}`);

    if (engine === 'webrtc') {
      studentRemoteVideo.style.setProperty('display', 'block', 'important');
      if (studentFallbackCanvas) studentFallbackCanvas.style.setProperty('display', 'none', 'important');
      if (studentStreamEmptyState) studentStreamEmptyState.style.setProperty('display', 'none', 'important');
      const statusBadge = document.getElementById('studentWebRtcBadge');
      if (statusBadge) {
        statusBadge.textContent = 'WebRTC P2P Direct';
        statusBadge.className = 'status-indicator connected';
      }
    } else if (engine === 'sfu') {
      studentRemoteVideo.style.setProperty('display', 'none', 'important');
      if (studentFallbackCanvas) studentFallbackCanvas.style.setProperty('display', 'block', 'important');
      if (studentStreamEmptyState) studentStreamEmptyState.style.setProperty('display', 'none', 'important');
      const statusBadge = document.getElementById('studentWebRtcBadge');
      if (statusBadge) {
        statusBadge.textContent = 'SFU Relay Live';
        statusBadge.className = 'status-indicator connected';
      }
    }
  }

  webrtc.onRemoteTrack = (peerId, stream, track) => {
    // PROTECT TEACHER: Teacher broadcasts only, never switches to student screen
    if (classroom.role === 'teacher') {
      console.log('[App] Teacher received remote track (ignoring for student display):', track.kind);
      return;
    }

    console.log('[App] Remote track received:', track.kind, 'from presenter:', peerId);
    if (stream && stream.getTracks().length > 0) {
      studentRemoteVideo.srcObject = stream;
    } else {
      if (!studentRemoteVideo.srcObject) {
        studentRemoteVideo.srcObject = new MediaStream();
      }
      const existing = studentRemoteVideo.srcObject.getTracks().find((t) => t.kind === track.kind);
      if (existing) {
        studentRemoteVideo.srcObject.removeTrack(existing);
      }
      studentRemoteVideo.srcObject.addTrack(track);
    }

    if (classroom.isApproved) {
      classroom.isSessionActive = true;
      if (classroom.sessionCode) {
        updateRoomCodeDisplay(classroom.sessionCode);
      }
      if (currentView !== 'student' || studentClassroomScreen.style.display === 'none') {
        switchView('student');
        startSessionTimer();
      }
    }

    if (track.kind === 'video') {
      setStreamEngine('webrtc');

      // CRITICAL FIX: Hide empty state so it doesn't cover the video!
      const emptyState = document.getElementById('studentStreamEmptyState');
      if (emptyState) emptyState.style.setProperty('display', 'none', 'important');
      studentRemoteVideo.style.setProperty('display', 'block', 'important');

      studentRemoteVideo.muted = true;
      const play = () => {
        studentRemoteVideo.play().catch(() => {});
      };
      play();
      track.onunmute = () => {
        setStreamEngine('webrtc');
        if (emptyState) emptyState.style.setProperty('display', 'none', 'important');
        play();
      };
      showToast('Amrita Live Screen Stream is active!', 'success');
    }
  };

  // WebRTC Video Stall Watcher (Only fallback to SFU if running companion Node SFU server, never in serverless mode)
  studentRemoteVideo.addEventListener('waiting', () => {
    if (signaling && signaling.isMqttMode) return;
    setTimeout(() => {
      if (studentRemoteVideo.readyState < 2 && currentStreamEngine === 'webrtc' && !(signaling && signaling.isMqttMode)) {
        console.warn('[App] WebRTC stream stalled. Falling back to SFU relay.');
        setStreamEngine('sfu');
      }
    }, 4000);
  });

  // Classroom SFU Binary Media Receiver (High Efficiency Fallback Across Any Firewall/NAT)
  signaling.onBinaryMedia = async (data) => {
    // Only student view renders the incoming binary media
    if (classroom.role === 'teacher') return;

    // LAN / P2P CONGESTION SHIELD:
    // If WebRTC is live and playing, SKIP decoding completely!
    // This saves 100% of GPU/CPU decoding and eliminates screen freezing on LAN!
    const isWebRtcLive = studentRemoteVideo.srcObject && 
                         studentRemoteVideo.srcObject.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled) &&
                         !studentRemoteVideo.paused &&
                         studentRemoteVideo.readyState >= 2;

    if (isWebRtcLive) {
      if (currentStreamEngine !== 'webrtc') {
        setStreamEngine('webrtc');
      }
      return; // Do not waste CPU decoding duplicate frames when WebRTC is live!
    }

    // Drop frame if previous is still decoding to prevent queue accumulation
    if (isDecodingSfuFrame) return;
    isDecodingSfuFrame = true;

    try {
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/jpeg' });
      const imgBitmap = await createImageBitmap(blob);

      if (studentFallbackCanvas && studentFallbackCtx) {
        if (studentFallbackCanvas.width !== imgBitmap.width || studentFallbackCanvas.height !== imgBitmap.height) {
          studentFallbackCanvas.width = imgBitmap.width;
          studentFallbackCanvas.height = imgBitmap.height;
        }
        studentFallbackCtx.drawImage(imgBitmap, 0, 0);
        imgBitmap.close();

        setStreamEngine('sfu');

        // Calculate incoming SFU FPS
        sfuFrameCount++;
        const now = Date.now();
        if (now - lastSfuFpsCalc >= 1000) {
          currentSfuFps = sfuFrameCount;
          sfuFrameCount = 0;
          lastSfuFpsCalc = now;
        }

        const resHud = document.getElementById('studentHudResolution');
        const fpsHud = document.getElementById('studentHudFps');
        if (resHud) resHud.textContent = `${studentFallbackCanvas.width}x${studentFallbackCanvas.height}`;
        if (fpsHud) fpsHud.textContent = `${currentSfuFps} FPS (SFU)`;
      }
    } catch (e) {
      console.warn('[App] SFU frame decode error:', e);
    } finally {
      isDecodingSfuFrame = false;
    }
  };

  // Mobile tap-to-resume listener
  studentRemoteVideo.addEventListener('click', () => {
    if (studentRemoteVideo.paused) {
      studentRemoteVideo.play().catch(() => {});
    }
  });

  // Student Audio & Fullscreen Controls
  studentToggleAudioBtn.addEventListener('click', () => {
    studentRemoteVideo.muted = !studentRemoteVideo.muted;
    studentToggleAudioBtn.classList.toggle('active', !studentRemoteVideo.muted);
    showToast(studentRemoteVideo.muted ? 'Audio Muted' : 'Audio Unmuted', 'info');
  });

  studentFullscreenBtn.addEventListener('click', () => {
    const vp = document.getElementById('studentVideoViewport');
    if (!document.fullscreenElement) vp.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });

  studentTogglePanelBtn.addEventListener('click', toggleStudentPanel);
  studentClosePanelBtn.addEventListener('click', toggleStudentPanel);

  function toggleStudentPanel() {
    studentSidePanel.classList.toggle('collapsed');
  }

  studentLeaveClassroomBtn.addEventListener('click', () => {
    if (confirm('Leave classroom and return to gateway?')) {
      handleExitSession();
    }
  });

  // Student Side Panel Sub-Tabs
  document.querySelectorAll('[data-student-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-student-tab');
      document.querySelectorAll('[data-student-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      document.getElementById('studentTabSectionChat').style.display = tab === 'chat' ? 'flex' : 'none';
      document.getElementById('studentTabSectionAnnouncements').style.display = tab === 'announcements' ? 'flex' : 'none';
      document.getElementById('studentTabSectionFiles').style.display = tab === 'files' ? 'flex' : 'none';
    });
  });

  // Student Raise Hand
  studentRaiseHandBtn.addEventListener('click', () => {
    isHandRaised = !isHandRaised;
    studentRaiseHandBtn.classList.toggle('raised', isHandRaised);
    studentRaiseHandText.textContent = isHandRaised ? 'Hand Raised ✋' : 'Raise Hand';

    const myName = storage.getUserProfile().displayName || 'Student';
    router.broadcastRaiseHand(isHandRaised, myName, signaling.clientId);
    showToast(isHandRaised ? '✋ You raised your hand.' : 'Hand lowered.', 'info');
  });

  // Quick Emoji Reactions
  document.querySelectorAll('.emoji-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const emoji = btn.getAttribute('data-emoji');
      const myName = storage.getUserProfile().displayName || 'Student';
      router.broadcastReaction(emoji, myName);
      spawnFloatingEmoji(emoji);
    });
  });

  function spawnFloatingEmoji(emoji) {
    let layer = document.getElementById('globalFloatingReactionsLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'globalFloatingReactionsLayer';
      document.body.appendChild(layer);
    }
    const el = document.createElement('div');
    el.className = 'amrita-floating-emoji';
    el.textContent = emoji;
    el.style.left = `${20 + Math.random() * 60}%`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2300);
  }

  // --- 11. WebSocket Automatic Signaling Routing (Mode B) ---
  classroom.onSessionStarted = (confirmedCode) => {
    updateRoomCodeDisplay(confirmedCode);
  };


  // Helper: Activates remote screen presentation stream with robust play & empty state hiding
  window.activateRemoteVideoStream = activateRemoteVideoStream;
  window.deactivateRemoteVideoStream = deactivateRemoteVideoStream;

  let hasShownAutoplayNotice = false;
  function activateRemoteVideoStream(stream) {
    const studentVideo = document.getElementById('studentRemoteVideo');
    const emptyState = document.getElementById('studentStreamEmptyState');
    const canvas = document.getElementById('studentFallbackCanvas');
    if (!stream) return;

    // Attach dynamic listener for video track arrival (in case audio track arrived first)
    if (typeof stream.addEventListener === 'function') {
      stream.onaddtrack = () => {
        console.log('[Video] Track added dynamically to stream:', stream.getTracks().map(t => t.kind));
        activateRemoteVideoStream(stream);
      };
    }

    const videoTracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
    if (videoTracks.length === 0) {
      console.log('[Video] Stream has no video tracks yet. Waiting for track...');
      if (studentVideo && studentVideo.srcObject !== stream) {
        studentVideo.srcObject = stream;
      }
      return;
    }

    // Video tracks are present!
    if (emptyState) emptyState.style.setProperty('display', 'none', 'important');
    if (canvas) canvas.style.setProperty('display', 'none', 'important');

    if (studentVideo) {
      studentVideo.style.setProperty('display', 'block', 'important');

      studentVideo.muted = true;
      studentVideo.defaultMuted = true;
      studentVideo.playsInline = true;
      studentVideo.setAttribute('muted', '');
      studentVideo.setAttribute('playsinline', '');

      // CRITICAL: Only assign srcObject and call play if stream has changed to prevent AbortError
      if (studentVideo.srcObject !== stream) {
        studentVideo.srcObject = stream;
        const p = studentVideo.play();
        if (p !== undefined) {
          p.then(() => {
            console.log('[Video] Live presentation playback started successfully.');
          }).catch((err) => {
            console.warn('[Video] Playback pending or blocked:', err);
            if (!hasShownAutoplayNotice && err && err.name === 'NotAllowedError') {
              hasShownAutoplayNotice = true;
              showToast('Click anywhere on the presentation stage to enable live audio & video!', 'info');
              const enablePlay = () => {
                studentVideo.play().catch(() => {});
                document.removeEventListener('click', enablePlay);
              };
              document.addEventListener('click', enablePlay, { once: true });
            }
          });
        }
      } else if (studentVideo.paused) {
        studentVideo.play().catch(() => {});
      }
    }
    if (typeof setStreamEngine === 'function') {
      setStreamEngine('webrtc');
    }
  }

  // Helper: Deactivates remote screen presentation stream cleanly
  function deactivateRemoteVideoStream() {
    const studentVideo = document.getElementById('studentRemoteVideo');
    const emptyState = document.getElementById('studentStreamEmptyState');
    if (studentVideo) {
      studentVideo.srcObject = null;
      studentVideo.style.setProperty('display', 'none', 'important');
    }
    if (emptyState) {
      emptyState.style.setProperty('display', 'flex', 'important');
    }
  }

  // Student receives join approval from professor
  signaling.onJoinApproved = (msg) => {
    if (classroom.role === 'teacher') return;

    console.log('[App] Join approved by professor:', msg);
    classroom.isApproved = true;
    classroom.isSessionActive = true;
    classroom.sessionCode = msg.roomCode;
    updateRoomCodeDisplay(msg.roomCode);

    // Stop join ping loop
    if (signaling.studentJoinInterval) {
      clearInterval(signaling.studentJoinInterval);
      signaling.studentJoinInterval = null;
    }

    // Force hide waiting approval box and join form
    if (studentWaitingApprovalBox) {
      studentWaitingApprovalBox.style.setProperty('display', 'none', 'important');
    }
    if (studentAutoJoinForm) {
      studentAutoJoinForm.style.setProperty('display', 'none', 'important');
    }
    if (studentJoinScreen) {
      studentJoinScreen.style.setProperty('display', 'none', 'important');
    }
    if (studentClassroomScreen) {
      studentClassroomScreen.style.setProperty('display', 'flex', 'important');
    }

    switchView('student');
    startSessionTimer();
    showToast('🎓 Professor approved your admission! Welcome to Amrita Live Stage.', 'success');

    // Immediately activate remote video stream if stream is already received or buffered!
    if (signaling.pendingRemoteStream) {
      activateRemoteVideoStream(signaling.pendingRemoteStream);
    } else if (studentRemoteVideo && studentRemoteVideo.srcObject) {
      activateRemoteVideoStream(studentRemoteVideo.srcObject);
    } else if (signaling.isWsMode) {
      signaling.sendMessage({
        type: 'request_stream',
        senderId: signaling.clientId,
        roomCode: classroom.sessionCode
      });
      console.log('[App] Sent request_stream to professor on admission approval (WS mode)');
    } else if (signaling.teacherConn && signaling.teacherConn.open) {
      // Request active presentation call from professor in case professor started presenting before approval
      try {
        signaling.teacherConn.send({
          type: 'request_stream',
          senderId: signaling.clientId,
          roomCode: classroom.sessionCode
        });
        console.log('[App] Sent request_stream to professor on admission approval');
      } catch(e) {}
    }
  };

  // Student receives join rejection
  signaling.onJoinRejected = (msg) => {
    if (classroom.role === 'teacher') return;
    classroom.isApproved = false;
    classroom.isSessionActive = false;
    studentWaitingApprovalBox.style.display = 'none';
    studentAutoJoinForm.style.display = 'flex';
    showToast(msg.reason || 'Professor declined admission request.', 'error');
  };

  // Student receives kick command from professor -> Broadcast terminates immediately!
  signaling.onStudentKicked = (msg) => {
    if (classroom.role === 'teacher') return;
    console.warn('[App] Student was kicked by professor:', msg);

    classroom.isApproved = false;
    classroom.isSessionActive = false;
    classroom.sessionCode = null;

    // Immediately stop video stream and tracks
    if (studentRemoteVideo) {
      if (studentRemoteVideo.srcObject) {
        studentRemoteVideo.srcObject.getTracks().forEach(t => t.stop());
      }
      studentRemoteVideo.srcObject = null;
      studentRemoteVideo.style.setProperty('display', 'none', 'important');
    }
    if (studentFallbackCanvas) {
      studentFallbackCanvas.style.setProperty('display', 'none', 'important');
      if (studentFallbackCtx) studentFallbackCtx.clearRect(0, 0, studentFallbackCanvas.width, studentFallbackCanvas.height);
    }
    const emptyState = document.getElementById('studentStreamEmptyState');
    if (emptyState) emptyState.style.setProperty('display', 'flex', 'important');

    // Switch view back to gateway
    switchView('landing');
    showToast(msg.reason || 'You have been removed from the classroom by the professor.', 'warning');
  };

  // Classroom terminated by host
  signaling.onRoomTerminated = () => {
    if (classroom.role === 'student') {
      showToast('Classroom session concluded by the teacher.', 'warning');
      setTimeout(() => {
        handleExitSession();
      }, 1500);
    }
  };

  // When Teacher approves student -> Teacher initiates offer to student
  // --- Real Attendance Tracking & CSV Export Engine ---
  const sessionAttendance = new Map(); // studentId -> { id, name, rollNo, joinTime, status }

  function updateAttendanceRecord(student, status = 'Present') {
    if (!student || !student.id) return;
    const existing = sessionAttendance.get(student.id);
    const joinTime = existing ? existing.joinTime : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    sessionAttendance.set(student.id, {
      id: student.id,
      name: student.name || 'Student',
      rollNo: student.rollNo || (student.clientInfo && student.clientInfo.rollNo) || 'N/A',
      joinTime: joinTime,
      status: status
    });
    renderAttendanceTable();
  }

  function renderAttendanceTable() {
    const tbody = document.getElementById('attendanceTableBody');
    const badge = document.getElementById('attendancePresentCountBadge');
    const filterInput = document.getElementById('attendanceRangeFilter');
    const filter = filterInput ? filterInput.value.trim().toLowerCase() : '';

    if (!tbody) return;
    const records = Array.from(sessionAttendance.values());
    const presentCount = records.filter(r => r.status === 'Present').length;
    if (badge) badge.textContent = `${presentCount} Present`;

    const filtered = filter ? records.filter(r => (r.rollNo && r.rollNo.toLowerCase().includes(filter)) || (r.name && r.name.toLowerCase().includes(filter))) : records;

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="padding: 1.25rem; text-align: center; color: var(--text-muted);">' + 
        (records.length === 0 ? 'No attendance records recorded for this session yet.' : 'No matching records for filter "' + filter + '".') + '</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    filtered.forEach((r, idx) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border-subtle)';
      const isPresent = r.status === 'Present';
      tr.innerHTML = `
        <td style="padding: 0.65rem 0.85rem; font-family: var(--font-mono); font-size: 0.8rem;">#${idx + 1}</td>
        <td style="padding: 0.65rem 0.85rem; font-family: var(--font-mono); font-size: 0.82rem; font-weight: 600; color: #FFA6D8;">${r.rollNo}</td>
        <td style="padding: 0.65rem 0.85rem; font-size: 0.85rem; font-weight: 500;">${r.name}</td>
        <td style="padding: 0.65rem 0.85rem; font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-muted);">${r.joinTime}</td>
        <td style="padding: 0.65rem 0.85rem;">
          <span style="font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 999px; font-weight: 600; background: ${isPresent ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${isPresent ? 'var(--accent-green)' : 'var(--accent-crimson)'}; border: 1px solid ${isPresent ? 'var(--accent-green)' : 'var(--accent-crimson)'};">
            ${r.status}
          </span>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function exportAttendanceCSV() {
    const records = Array.from(sessionAttendance.values());
    if (records.length === 0) {
      if (typeof showToast === 'function') showToast('No attendance records to export yet.', 'warning');
      return;
    }
    const headers = ['Serial No', 'Roll Number', 'Student Name', 'Join Time', 'Status', 'Room Code', 'Timestamp'];
    const rows = records.map((r, i) => [
      i + 1,
      `"${(r.rollNo || '').replace(/"/g, '""')}"`,
      `"${(r.name || '').replace(/"/g, '""')}"`,
      `"${r.joinTime}"`,
      `"${r.status}"`,
      `"${classroom.sessionCode || 'N/A'}"`,
      `"${new Date().toISOString()}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(e => e.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Amrita_Classroom_${classroom.sessionCode || 'Session'}_Attendance_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof showToast === 'function') showToast('Attendance CSV exported successfully!', 'success');
  }

  const btnExportCsv = document.getElementById('btnExportAttendanceCsv');
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', exportAttendanceCSV);
  }

  const attendanceFilter = document.getElementById('attendanceRangeFilter');
  if (attendanceFilter) {
    attendanceFilter.addEventListener('input', renderAttendanceTable);
  }

  classroom.onStudentApproved = (student) => {
    showToast(`Admitted student "${student.name}".`, 'success');
    updateAttendanceRecord(student, 'Present');
    renderPendingApprovals();
    renderConnectedRoster();
  };

  classroom.onStudentJoinRequested = (student) => {
    showToast(`🎓 Student "${student.name}" requesting admission.`, 'info');
    renderPendingApprovals();

    const autoApprove = document.getElementById('teacherAutoApproveCheck');
    if (autoApprove && autoApprove.checked) {
      classroom.approveStudent(student.id);
      return;
    }

    // Prominent Floating Admission Alert for Teacher (Visible across ANY active tab!)
    showTeacherAdmissionPrompt(student);
  };

  function showTeacherAdmissionPrompt(student) {
    let alertBox = document.getElementById('teacherFloatingAdmissionAlert');
    if (!alertBox) {
      alertBox = document.createElement('div');
      alertBox.id = 'teacherFloatingAdmissionAlert';
      alertBox.className = 'teacher-admission-alert';
      document.body.appendChild(alertBox);
    }
    alertBox.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.75rem;">
        <span style="font-size: 1.5rem;">🎓</span>
        <div>
          <div style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: #FFA6D8; font-weight: 700;">Amrita Admission Request</div>
          <div style="font-size: 0.95rem; font-weight: 700; color: #FFFFFF;">${SecurityManager.escapeHTML(student.name)} <span style="font-size: 0.78rem; color: #FFA6D8; font-family: var(--font-mono); font-weight: normal;">(${SecurityManager.escapeHTML(student.rollNo || 'N/A')})</span></div>
        </div>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center;">
        <button class="admission-btn-admit" id="btnAlertAdmit">✓ Admit Student</button>
        <button class="admission-btn-decline" id="btnAlertDecline">✕ Decline</button>
      </div>
    `;
    alertBox.style.display = 'flex';

    document.getElementById('btnAlertAdmit').onclick = () => {
      classroom.approveStudent(student.id);
      alertBox.style.display = 'none';
      showToast(`Admitted student "${student.name}"`, 'success');
      renderPendingApprovals();
      renderConnectedRoster();
    };

    document.getElementById('btnAlertDecline').onclick = () => {
      classroom.rejectStudent(student.id, 'Professor declined admission request.');
      alertBox.style.display = 'none';
      showToast(`Declined admission for "${student.name}"`, 'warning');
    };
  }

  classroom.onStudentLeft = (studentId, isKicked = false) => {
    if (studentId) {
      sessionAttendance.forEach((rec, key) => {
        if (rec.id === studentId) rec.status = isKicked ? 'Removed' : 'Disconnected';
      });
      renderAttendanceTable();
    }
    renderConnectedRoster();
    renderPendingApprovals();
  };

  // Teacher handles incoming Trickle Answer from student
  signaling.onSignalAnswer = async (msg) => {
    try {
      console.log('[Signaling] Received signal_answer from:', msg.senderId);
      await webrtc.handleAnswer(msg.senderId, msg.payload);
      showToast('Remote answer applied. WebRTC connected!', 'success');
    } catch (err) {
      console.warn('Error applying signal_answer:', err);
    }
  };

  // Student handles incoming Offer from Teacher
  signaling.onSignalOffer = async (msg) => {
    try {
      console.log('[Signaling] Received signal_offer from peer:', msg.senderId);
      const answer = await webrtc.handleOfferAndCreateAnswer(msg.senderId, msg.payload, false);
      signaling.send({
        type: 'signal_answer',
        recipientId: msg.senderId,
        payload: answer
      });

      // PROTECT TEACHER & RESPECT ADMISSION GUARD: Do NOT switch view until explicitly approved
      if (classroom.role !== 'teacher' && classroom.isApproved) {
        classroom.isSessionActive = true;
        if (classroom.sessionCode) {
          updateRoomCodeDisplay(classroom.sessionCode);
        }
        switchView('student');
        startSessionTimer();
      }
    } catch (err) {
      console.error('Error handling signal_offer:', err);
    }
  };

  // Trickle ICE Candidate Exchange
  signaling.onSignalCandidate = async (msg) => {
    try {
      await webrtc.addIceCandidate(msg.senderId, msg.payload);
    } catch (err) {
      console.warn('Error adding trickle candidate:', err);
    }
  };

  webrtc.onIceCandidate = (peerId, candidate) => {
    if (signaling && signaling.isConnected) {
      signaling.send({
        type: 'signal_candidate',
        recipientId: peerId,
        payload: candidate
      });
    }
  };

  // ICE Restart Negotiation handler
  webrtc.onIceRestartRequired = (peerId, offer) => {
    if (signaling && signaling.isConnected) {
      console.log(`[Signaling] Sending ICE restart offer to peer: ${peerId}`);
      signaling.send({
        type: 'signal_offer',
        recipientId: peerId,
        payload: offer
      });
    }
  };

  // WebRTC Connection State Listener (Strict Admission Guard - No premature join!)
  webrtc.onConnectionStateChange = (peerId, state) => {
    console.log(`[WebRTC] Peer ${peerId} state:`, state);
  };

  webrtc.onIceStateChange = (peerId, iceState) => {
    console.log(`[WebRTC] Peer ${peerId} ICE state:`, iceState);
  };

  // Render Roster & Pending Lists
  function renderPendingApprovals() {
    const list = pendingApprovalList;
    if (!list) return;

    const pending = Array.from(classroom.pendingApprovals.values());
    teacherPendingBadge.textContent = pending.length;
    teacherPendingCountBadge.textContent = pending.length;
    teacherPendingBadge.style.display = pending.length > 0 ? 'inline-block' : 'none';

    if (pending.length === 0) {
      list.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem;">No students currently waiting for admission.</div>';
      return;
    }

    list.innerHTML = '';
    pending.forEach((st) => {
      const item = document.createElement('div');
      item.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 0.65rem 0.85rem; display: flex; align-items: center; justify-content: space-between;';
      item.innerHTML = `
        <div>
          <div style="font-weight: 600; font-size: 0.85rem;">${st.name} <span style="font-size: 0.72rem; color: #FFA6D8; font-family: var(--font-mono); margin-left: 0.35rem;">[${st.rollNo || 'N/A'}]</span></div>
          <div style="font-size: 0.7rem; color: var(--text-muted); font-family: var(--font-mono);">${st.clientInfo.screenRes || 'Desktop Client'}</div>
        </div>
        <div style="display: flex; gap: 0.4rem;">
          <button class="btn btn-success" style="padding: 0.25rem 0.6rem; font-size: 0.72rem;" data-approve="${st.id}">Approve</button>
          <button class="btn btn-danger" style="padding: 0.25rem 0.6rem; font-size: 0.72rem;" data-reject="${st.id}">Reject</button>
        </div>
      `;
      item.querySelector('[data-approve]').addEventListener('click', () => {
        classroom.approveStudent(st.id);
        const alertBox = document.getElementById('teacherFloatingAdmissionAlert');
        if (alertBox) alertBox.style.display = 'none';
        showToast(`Admitted student "${st.name}"`, 'success');
        renderPendingApprovals();
        renderConnectedRoster();
      });
      item.querySelector('[data-reject]').addEventListener('click', () => classroom.rejectStudent(st.id));
      list.appendChild(item);
    });
  }

  function renderConnectedRoster() {
    const list = connectedRosterList;
    if (!list) return;

    const students = Array.from(classroom.connectedStudents.values());
    rosterCount.textContent = students.length;
    teacherBannerStudentCount.textContent = `${students.length} / 100`;
    teacherKpiStudentCount.innerHTML = `${students.length} <span style="font-size: 1rem; color: var(--text-muted);">/ 100</span>`;

    if (students.length === 0) {
      list.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem;">No students currently connected.</div>';
      return;
    }

    list.innerHTML = '';
    students.forEach((st) => {
      const item = document.createElement('div');
      item.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 0.65rem 0.85rem; display: flex; align-items: center; justify-content: space-between;';
      item.innerHTML = `
        <div>
          <div style="font-weight: 600; font-size: 0.85rem; display: flex; align-items: center; gap: 0.4rem;">
            <span>${st.name}</span> <span style="font-size: 0.72rem; color: #FFA6D8; font-family: var(--font-mono);">[${st.rollNo || 'N/A'}]</span>
            <span id="rosterHand_${st.id}" style="display: none; font-size: 0.8rem;">✋</span>
          </div>
          <div style="font-size: 0.7rem; color: var(--accent-green); font-family: var(--font-mono);">Connected (P2P / SFU)</div>
        </div>
        <button class="btn btn-danger" style="padding: 0.2rem 0.5rem; font-size: 0.7rem;" data-kick="${st.id}">Remove</button>
      `;
      item.querySelector('[data-kick]').addEventListener('click', () => classroom.kickStudent(st.id));
      list.appendChild(item);
    });
  }

  approveAllBtn.addEventListener('click', () => classroom.approveAllPending());
  rejectAllBtn.addEventListener('click', () => classroom.rejectAllPending());

  // --- 12. Chat & Announcements (Dual-Path WebRTC DataChannel + Real-Time Signaling) ---
  const seenMessageIds = new Set();
  function appendChatMessage(msg, isSelf = false) {
    if (!msg) return;
    if (msg.id && seenMessageIds.has(msg.id)) return;
    if (msg.id) seenMessageIds.add(msg.id);

    const tBox = chatMessageLog;
    const sBox = studentChatLog;

    const row = document.createElement('div');
    row.style.cssText = `display: flex; flex-direction: column; align-items: ${isSelf ? 'flex-end' : 'flex-start'};`;

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size: 0.72rem; color: var(--text-muted); margin-bottom: 0.2rem;';
    const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.textContent = `${msg.sender} (${msg.role || 'student'}) • ${timeStr}`;

    const isTeacher = msg.role === 'teacher';
    const bubble = document.createElement('div');
    bubble.style.cssText = `max-width: 80%; padding: 0.55rem 0.85rem; border-radius: var(--radius-sm); font-size: 0.84rem; line-height: 1.4; word-break: break-word; background: ${
      isTeacher
        ? 'linear-gradient(135deg, rgba(0, 240, 255, 0.2), rgba(0, 112, 243, 0.25))'
        : isSelf ? 'rgba(0, 240, 255, 0.15)' : 'var(--bg-surface-elevated)'
    }; border: 1px solid ${isTeacher ? 'var(--accent-cyan)' : isSelf ? 'rgba(0, 240, 255, 0.4)' : 'var(--border-subtle)'}; color: var(--text-primary);`;
    bubble.textContent = msg.text;

    row.appendChild(meta);
    row.appendChild(bubble);

    if (tBox) { tBox.appendChild(row.cloneNode(true)); tBox.scrollTop = tBox.scrollHeight; }
    if (sBox) { sBox.appendChild(row); sBox.scrollTop = sBox.scrollHeight; }

    storage.saveChatMessage(msg);
  }

  function sendChatFromTeacher() {
    const text = chatInput.value.trim();
    if (!text) return;
    const name = storage.getUserProfile().displayName || 'Professor';
    const payload = router.broadcastChat(text, name, 'teacher');
    appendChatMessage(payload, true);
    chatInput.value = '';
  }

  function sendChatFromStudent() {
    const text = studentChatInput.value.trim();
    if (!text) return;
    const name = storage.getUserProfile().displayName || 'Student';
    const payload = router.broadcastChat(text, name, 'student');
    appendChatMessage(payload, true);
    studentChatInput.value = '';
  }

  chatSendBtn.addEventListener('click', sendChatFromTeacher);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatFromTeacher(); });
  studentChatSendBtn.addEventListener('click', sendChatFromStudent);
  studentChatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatFromStudent(); });

  // Dual-Channel Chat Hook (Receives from WebRTC DataChannel & Signaling Fallback)
  router.onChatMessage = (peerId, payload) => handleIncomingChat(payload);
  signaling.onChatMessage = (msg) => {
    if (msg.senderId !== signaling.clientId && msg.payload) {
      handleIncomingChat(msg.payload);
    }
  };

  function handleIncomingChat(payload) {
    appendChatMessage(payload, false);
    if (currentView === 'teacher' && currentTeacherTab !== 'chat') {
      teacherUnreadChat++;
      teacherChatBadge.style.display = 'inline-block';
      teacherChatBadge.textContent = teacherUnreadChat;
    }
  }

  // Announcements (Dual-Channel Delivery)
  teacherBroadcastBtn.addEventListener('click', () => {
    const text = teacherAnnouncementInput.value.trim();
    if (!text) return;
    router.broadcastAnnouncement('Teacher Announcement', text, 'urgent');
    showToast(`Broadcasted: ${text}`, 'success');
    teacherAnnouncementInput.value = '';
  });

  const seenAnnouncementIds = new Set();
  function handleIncomingAnnouncement(ann) {
    if (!ann || !ann.text) return;
    if (ann.id && seenAnnouncementIds.has(ann.id)) return;
    if (ann.id) seenAnnouncementIds.add(ann.id);

    studentPinnedAnnouncement.style.display = 'block';
    studentPinnedText.textContent = ann.text;

    const item = document.createElement('div');
    item.style.cssText = 'background: rgba(0, 240, 255, 0.08); border: 1px solid var(--border-active); border-radius: var(--radius-sm); padding: 0.65rem 0.85rem;';
    item.innerHTML = `
      <div style="font-weight: 700; color: var(--accent-cyan); font-size: 0.82rem;">${ann.title || 'Teacher Announcement'}</div>
      <div style="font-size: 0.84rem; margin-top: 0.2rem;">${ann.text}</div>
    `;
    studentAnnouncementsList.prepend(item);
    showToast(`📢 Announcement: ${ann.text}`, 'info');
  }

  router.onAnnouncement = (peerId, ann) => handleIncomingAnnouncement(ann);
  signaling.onAnnouncement = (msg) => handleIncomingAnnouncement(msg.payload || msg);

  // Raise Hand Handlers (Dual-Channel Delivery)
  function handleIncomingRaiseHand(payload) {
    if (!payload) return;
    const handBadge = document.getElementById(`rosterHand_${payload.studentId}`);
    if (handBadge) {
      handBadge.style.display = payload.isRaised ? 'inline' : 'none';
    }
    if (payload.isRaised) {
      showToast(`✋ ${payload.studentName} raised their hand!`, 'info');
    }
  }

  router.onRaiseHand = (peerId, payload) => handleIncomingRaiseHand(payload);
  signaling.onRaiseHand = (msg) => handleIncomingRaiseHand(msg.payload || msg);

  // Quick Reactions / Floating Emojis (Dual-Channel Delivery)
  const seenReactionIds = new Set();
  function handleIncomingReaction(payload) {
    if (!payload || !payload.emoji) return;
    if (payload.id && seenReactionIds.has(payload.id)) return;
    if (payload.id) {
      seenReactionIds.add(payload.id);
      setTimeout(() => seenReactionIds.delete(payload.id), 2500);
    }
    spawnFloatingEmoji(payload.emoji);
  }

  router.onReaction = (peerId, payload) => handleIncomingReaction(payload);
  signaling.onReaction = (msg) => handleIncomingReaction(msg.payload || msg);

  // Stream Status Broadcast Handler
  signaling.onStreamStarted = () => {
    if (classroom.role !== 'teacher') {
      showToast('Presenter started screen sharing!', 'info');
      if (signaling.pendingRemoteStream) {
        activateRemoteVideoStream(signaling.pendingRemoteStream);
      } else if (signaling.isWsMode) {
        signaling.sendMessage({
          type: 'request_stream',
          senderId: signaling.clientId,
          roomCode: classroom.sessionCode
        });
        console.log('[App] Sent request_stream to professor via manual stage entry (WS mode)');
      } else if (signaling.teacherConn && signaling.teacherConn.open) {
        try {
          signaling.teacherConn.send({
            type: 'request_stream',
            senderId: signaling.clientId,
            roomCode: classroom.sessionCode
          });
          console.log('[App] Sent request_stream to professor');
        } catch(e) {}
      }
    }
  };

  chatExportBtn.addEventListener('click', async () => {
    const history = await storage.getChatHistory(classroom.sessionCode || 'p2p');
    const textContent = history.map((m) => `[${new Date(m.timestamp).toISOString()}] ${m.sender}: ${m.text}`).join('\n');
    const blob = new Blob([textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat_transcript_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  chatClearBtn.addEventListener('click', async () => {
    await storage.clearChatHistory(classroom.sessionCode || 'p2p');
    chatMessageLog.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem; text-align: center;">Chat history cleared.</div>';
    studentChatLog.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem; text-align: center;">Chat history cleared.</div>';
    showToast('Chat history cleared locally.', 'info');
  });

  // --- 13. File Transfer System ---
  fileDropZone.addEventListener('click', () => filePickerInput.click());
  fileDropZone.addEventListener('dragover', (e) => { e.preventDefault(); fileDropZone.classList.add('dragover'); });
  fileDropZone.addEventListener('dragleave', () => fileDropZone.classList.remove('dragover'));
  fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropZone.classList.remove('dragover');
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });
  filePickerInput.addEventListener('change', (e) => {
    if (e.target.files) handleFiles(e.target.files);
  });

  async function handleFiles(files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        showToast(`Calculating SHA-256 for "${file.name}"...`, 'info');
        const meta = await fileTransfer.sendFile(file);
        renderTransferCard(meta, 'outbound');
        showToast(`Sent file offer for "${meta.name}".`, 'success');
      } catch (err) {
        showToast(`File error: ${err.message}`, 'error');
      }
    }
  }

  function renderTransferCard(meta, direction) {
    const card = document.createElement('div');
    card.className = 'transfer-item-card';
    card.id = `transfer_${meta.fileId}`;
    const sizeMb = (meta.size / (1024 * 1024)).toFixed(2);

    card.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.35rem;">
        <div>
          <div style="font-weight: 600; font-size: 0.85rem;">${meta.name}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono);">${sizeMb} MB • SHA-256 verified</div>
        </div>
        <span class="badge-classification badge-pending" id="status_${meta.fileId}">TRANSFERRING</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="prog_${meta.fileId}" style="width: 0%;"></div>
      </div>
    `;
    fileTransferList.appendChild(card);
  }

  let activeInboundFileMeta = null;

  fileTransfer.onTransferProgress = (fileId, direction, percent, speedKbps) => {
    const bar = document.getElementById(`prog_${fileId}`);
    if (bar) bar.style.width = `${percent}%`;
    const status = document.getElementById(`status_${fileId}`);
    if (status && percent < 100) {
      status.textContent = `${percent}% (${speedKbps || 0} KB/s)`;
    }
  };

  fileTransfer.onTransferComplete = (fileId, direction, fileData, hashMatched, meta) => {
    const status = document.getElementById(`status_${fileId}`);
    if (status) {
      status.className = 'badge-classification badge-lan';
      status.textContent = hashMatched ? 'COMPLETED (HASH MATCHED)' : 'COMPLETED';
    }

    const fileName = (meta && meta.name) || (activeInboundFileMeta && activeInboundFileMeta.name) || 'download';
    const fileSizeKb = meta && meta.size ? (meta.size / 1024).toFixed(1) : '0';

    showToast(`File "${fileName}" completed! Integrity verified.`, 'success');

    // If student received file, trigger immediate download and populate Files tab
    if (direction === 'inbound') {
      const blob = fileData instanceof Blob ? fileData : new Blob([fileData]);
      const url = URL.createObjectURL(blob);

      // Trigger automatic browser download
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 100);

      // Populate into student Files section
      const emptyNotice = studentFilesList.querySelector('div');
      if (emptyNotice && emptyNotice.textContent.includes('No files received')) {
        emptyNotice.remove();
      }

      const row = document.createElement('div');
      row.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 0.65rem 0.85rem; display: flex; align-items: center; justify-content: space-between;';
      row.innerHTML = `
        <div>
          <div style="font-weight: 600; font-size: 0.82rem; color: var(--accent-cyan);">${fileName}</div>
          <div style="font-size: 0.72rem; color: var(--accent-green); font-family: var(--font-mono);">${fileSizeKb} KB • SHA-256 Verified</div>
        </div>
        <a href="${url}" download="${fileName}" class="btn btn-success" style="padding: 0.25rem 0.65rem; font-size: 0.72rem; text-decoration: none;">Download Again</a>
      `;
      studentFilesList.appendChild(row);

      // Automatically switch side panel to Files tab
      const filesTabBtn = document.querySelector('[data-student-tab="files"]');
      if (filesTabBtn) filesTabBtn.click();
      const panel = document.getElementById('studentClassroomPanel');
      if (panel && panel.classList.contains('collapsed')) {
        panel.classList.remove('collapsed');
      }
    }
  };

  fileTransfer.onTransferCancelled = (fileId, direction, reason) => {
    const status = document.getElementById(`status_${fileId}`);
    if (status) {
      status.className = 'badge-classification badge-direct';
      status.style.color = 'var(--accent-crimson)';
      status.textContent = 'DECLINED BY STUDENT';
    }
    showToast(`File transfer was declined: ${reason}`, 'warning');
  };

  fileTransfer.onIncomingFileOffer = (peerId, meta) => {
    activeInboundFileId = meta.fileId;
    activeInboundFileMeta = meta;
    document.getElementById('fileOfferSenderName').textContent = meta.senderName || 'Presenter';
    document.getElementById('fileOfferFileName').textContent = meta.name;
    document.getElementById('fileOfferFileSize').textContent = `${(meta.size / 1024).toFixed(1)} KB`;
    document.getElementById('fileOfferFileHash').textContent = meta.hash;
    openModal(fileApprovalModal);
  };

  document.getElementById('fileAcceptBtn').addEventListener('click', () => {
    if (activeInboundFileId) {
      fileTransfer.acceptFile(activeInboundFileId);
      closeModal(fileApprovalModal);
      const fileName = activeInboundFileMeta ? activeInboundFileMeta.name : 'file';
      showToast(`Accepted "${fileName}". Downloading chunks...`, 'info');

      // Switch student tab to Files so they can see progress
      const filesTabBtn = document.querySelector('[data-student-tab="files"]');
      if (filesTabBtn) filesTabBtn.click();
    }
  });

  document.getElementById('fileRejectBtn').addEventListener('click', () => {
    if (activeInboundFileId) {
      fileTransfer.rejectFile(activeInboundFileId);
      closeModal(fileApprovalModal);
      const fileName = activeInboundFileMeta ? activeInboundFileMeta.name : 'file';
      showToast(`Declined file "${fileName}".`, 'warning');
      activeInboundFileId = null;
      activeInboundFileMeta = null;
    }
  });

  // --- 14. Real-Time WebRTC Diagnostics Engine ---
  diagnostics.onMetricsUpdated = (peerId, m) => {
    // Header updates
    if (m.iceConnectionState === 'connected' || m.iceConnectionState === 'completed') {
      headerStatusDot.className = 'status-dot active';
      headerStatusText.textContent = m.classification.label;
      headerLatencyPill.style.display = 'flex';
      headerLatencyVal.textContent = `${m.rttMs}ms`;
    } else if (classroom.isApproved && (currentStreamEngine === 'sfu' || (signaling.teacherConn && signaling.teacherConn.open))) {
      headerStatusDot.className = 'status-dot active';
      headerStatusText.textContent = currentStreamEngine === 'sfu' ? 'DataChannel Relay' : 'Classroom Connected';
      headerLatencyPill.style.display = 'none';
    } else if (m.iceConnectionState === 'failed') {
      headerStatusDot.className = 'status-dot error';
      headerStatusText.textContent = 'Failed';
      headerLatencyPill.style.display = 'none';
    } else {
      headerStatusDot.className = 'status-dot';
      headerStatusText.textContent = 'Disconnected';
      headerLatencyPill.style.display = 'none';
    }

    // Teacher KPI Cards
    teacherKpiBitrate.innerHTML = `${m.outgoingBitrateKbps} <span style="font-size: 1rem; color: var(--text-muted);">kbps</span>`;
    teacherKpiRtt.innerHTML = `${m.rttMs} <span style="font-size: 1rem; color: var(--text-muted);">ms</span>`;
    teacherKpiClassification.textContent = m.classification.label;
    teacherBannerBitrate.textContent = `${m.outgoingBitrateKbps} kbps`;
    teacherBannerClassification.className = `badge-classification ${m.classification.badgeClass || 'badge-pending'}`;
    teacherBannerClassification.textContent = m.classification.code || 'PENDING';

    // Student Stage HUD
    if (currentStreamEngine === 'sfu') {
      studentHudPathBadge.textContent = 'DataChannel Relay';
      studentHudPathBadge.className = 'badge-classification badge-lan';
    } else if (m.classification && m.classification.label && (m.iceConnectionState === 'connected' || m.iceConnectionState === 'completed')) {
      studentHudPathBadge.textContent = m.classification.label;
      studentHudPathBadge.className = `badge-classification ${m.classification.badgeClass || 'badge-pending'}`;
    }
    if (m.frameWidth > 0) studentHudRes.textContent = `${m.frameWidth}x${m.frameHeight}`;
    if (m.framesPerSecond > 0) studentHudFps.textContent = `${m.framesPerSecond} FPS`;
    if (m.rttMs > 0) studentHudRtt.textContent = `${m.rttMs}ms`;

    // Teacher Diagnostics Table
    diagClassificationBadge.className = `badge-classification ${m.classification.badgeClass || 'badge-pending'}`;
    diagClassificationBadge.textContent = m.classification.code || 'DISCONNECTED';
    diagPathType.textContent = m.classification.label;
    diagCandidatePair.textContent = `${m.localCandidateType} (${m.localAddress}) ↔ ${m.remoteCandidateType} (${m.remoteAddress})`;
    diagProtocol.textContent = `${m.localProtocol} / ${m.remoteProtocol}`;
    diagRtt.textContent = `${m.rttMs} ms`;
    diagOutBitrate.textContent = `${m.outgoingBitrateKbps} kbps`;
    diagInBitrate.textContent = `${m.incomingBitrateKbps} kbps`;
    diagPacketLoss.textContent = `${m.packetLossPercent}% (${m.packetsLost} packets)`;
    diagResolution.textContent = `${m.frameWidth} × ${m.frameHeight} @ ${m.framesPerSecond} FPS`;
    diagIceGathering.textContent = m.iceGatheringState;
    diagInterruptions.textContent = m.interruptionCount;
  };

  diagnostics.startDiagnostics();

  // --- 15. Settings & Local Storage Audit ---
  signaling.onError = (errMsg) => {
    console.error('[Signaling Server Error]', errMsg);
    showToast(`Server: ${errMsg}`, 'error');
  };

  document.getElementById('privacyWipeAllBtn').addEventListener('click', async () => {
    if (confirm('Wipe all local classroom data, chat records, and stored credentials?')) {
      await storage.wipeAllLocalData();
      showToast('Local classroom data wiped cleanly.', 'success');
      setTimeout(() => location.reload(), 800);
    }
  });

  // Whiteboard tools
  document.getElementById('wbToolPen').addEventListener('click', () => whiteboard.setTool('pen'));
  document.getElementById('wbToolHighlighter').addEventListener('click', () => whiteboard.setTool('highlighter'));
  document.getElementById('wbToolLaser').addEventListener('click', () => whiteboard.setTool('laser'));
  document.getElementById('wbToolEraser').addEventListener('click', () => whiteboard.setTool('eraser'));
  document.getElementById('wbClearBtn').addEventListener('click', () => whiteboard.clearCanvas(true));
  document.getElementById('wbColorPicker').addEventListener('input', (e) => whiteboard.setColor(e.target.value));
  document.getElementById('wbLineWidth').addEventListener('input', (e) => whiteboard.setLineWidth(parseInt(e.target.value, 10)));

  // --- 16. Auto-Discovery & Initial Bootstrapping ---
  signaling.onServerStatusChange = (isOnline) => {
    if (isOnline) {
      appModeBadge.textContent = 'Signaling Connected';
      appModeBadge.style.color = 'var(--accent-green)';
      appModeBadge.style.borderColor = 'var(--accent-green)';
      showToast('Connected to Classroom Signaling', 'success');
    } else {
      appModeBadge.textContent = 'Signaling Offline';
      appModeBadge.style.color = 'var(--accent-amber)';
      appModeBadge.style.borderColor = 'var(--accent-amber)';
    }
  };

  // Dynamically initialize ICE configuration from backend, then connect WebSocket
  signaling.fetchBackendIceConfig().finally(() => {
    signaling.connectWebSocket();
  });

  // Multi-Monitor Responsive Auto-Adjustment Listener
  let monitorResizeTimeout = null;
  window.addEventListener('resize', () => {
    clearTimeout(monitorResizeTimeout);
    monitorResizeTimeout = setTimeout(() => {
      if (typeof whiteboard !== 'undefined' && whiteboard) whiteboard.resizeCanvas();
      if (typeof overlayWhiteboard !== 'undefined' && overlayWhiteboard) overlayWhiteboard.resizeCanvas();
    }, 150);
  });

  // Automatic Gateway hub redirect
  if (urlParams.has('hub')) {
    const hub = urlParams.get('hub');
    const room = urlParams.get('room') || '';
    window.location.href = `http://${hub}/?room=${encodeURIComponent(room)}`;
    return;
  }

  if (urlParams.has('room')) {
    const roomParam = urlParams.get('room');
    studentRoomCodeInput.value = roomParam;
    if (urlParams.has('name')) {
      studentDisplayNameInput.value = urlParams.get('name');
    }
    switchView('student');
    showToast(`Joining Room ${roomParam}. Entering classroom...`, 'info');
    setTimeout(() => {
      studentSubmitJoinBtn.click();
    }, 500);
  }

  console.log('[App] SMART WEBRTC CLASSROOM initialized successfully.');
});