// --- monitoring.js ---
/**
 * SMART WEBRTC CLASSROOM - Privacy-Centric Student Monitoring Engine
 * Provides explicit opt-in screen monitoring for classroom proctoring with
 * visible indicator badges, low-frame-rate canvas snapshots, and zero stealth capture.
 */

class StudentMonitoringEngine {
  constructor(webrtcManager, router) {
    this.webrtcManager = webrtcManager;
    this.router = router;

    this.isStudentConsented = false;
    this.studentCaptureStream = null;
    this.snapshotCanvas = document.createElement('canvas');
    this.snapshotCtx = this.snapshotCanvas.getContext('2d');
    this.snapshotInterval = null;

    // Teacher's view of student thumbnails: studentId -> { canvas/img, name, lastUpdate }
    this.studentThumbnails = new Map();

    // Callbacks
    this.onConsentStateChange = null;   // (isConsented)
    this.onThumbnailUpdated = null;      // (studentId, dataUrl, studentName)
    this.onStudentStoppedSharing = null; // (studentId)

    this.init();
  }

  init() {
    if (!this.router) return;

    // Listen for incoming frame data on router
    if (this.webrtcManager) {
      const origMsgHandler = this.webrtcManager.onDataChannelMessage;
      this.webrtcManager.onDataChannelMessage = (peerId, data) => {
        if (typeof data === 'string' && data.startsWith('{"type":"monitor_frame"')) {
          try {
            const parsed = JSON.parse(data);
            if (this.onThumbnailUpdated) {
              this.onThumbnailUpdated(peerId, parsed.dataUrl, parsed.studentName);
            }
          } catch (e) {}
          return;
        }
        if (origMsgHandler) origMsgHandler(peerId, data);
      };
    }
  }

  /**
   * Student explicitly grants consent to share thumbnail with teacher
   */
  async grantMonitoringConsent(studentName = 'Student') {
    if (this.isStudentConsented) return true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Screen capture not supported in this browser.');
    }

    try {
      console.log('[Monitoring] Prompting student for explicit monitoring screen capture...');
      // Low-resource screen capture
      this.studentCaptureStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 480 }, height: { max: 270 }, frameRate: { max: 3 } },
        audio: false
      });

      const track = this.studentCaptureStream.getVideoTracks()[0];
      track.onended = () => {
        this.revokeMonitoringConsent();
      };

      const video = document.createElement('video');
      video.srcObject = this.studentCaptureStream;
      video.muted = true;
      await video.play();

      this.snapshotCanvas.width = 320;
      this.snapshotCanvas.height = 180;

      this.isStudentConsented = true;

      // Send 1 low-res snapshot every 2 seconds over DataChannel (negligible bandwidth: ~15 KB/sec)
      this.snapshotInterval = setInterval(() => {
        if (!this.isStudentConsented || !video.videoWidth) return;

        this.snapshotCtx.drawImage(video, 0, 0, 320, 180);
        const dataUrl = this.snapshotCanvas.toDataURL('image/jpeg', 0.45);

        const framePacket = {
          type: 'monitor_frame',
          studentName: studentName,
          dataUrl: dataUrl,
          timestamp: Date.now()
        };

        if (this.webrtcManager) {
          this.webrtcManager.sendData(JSON.stringify(framePacket));
        }
      }, 2000);

      if (this.onConsentStateChange) {
        this.onConsentStateChange(true);
      }

      console.log('[Monitoring] Student opt-in active. Low-res snapshots streaming.');
      return true;
    } catch (err) {
      console.warn('[Monitoring] Student declined or error:', err);
      this.revokeMonitoringConsent();
      return false;
    }
  }

  /**
   * Student revokes consent at any time
   */
  revokeMonitoringConsent() {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
    if (this.studentCaptureStream) {
      this.studentCaptureStream.getTracks().forEach((t) => t.stop());
      this.studentCaptureStream = null;
    }
    this.isStudentConsented = false;

    if (this.onConsentStateChange) {
      this.onConsentStateChange(false);
    }

    console.log('[Monitoring] Student monitoring stopped.');
  }
}

// Global exposure
window.StudentMonitoringEngine = StudentMonitoringEngine;