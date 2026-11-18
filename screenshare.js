/**
 * SMART WEBRTC CLASSROOM - Screen Share & Media Capture Manager
 * Controls DisplayMedia capture, dynamic bitrate scaling, system audio,
 * and SFU JPEG binary fallback frame streamer.
 */

class ScreenShareManager {
  constructor(webrtcManager, signalingManager = null) {
    this.webrtcManager = webrtcManager;
    this.signalingManager = signalingManager;
    this.activeStream = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.isSharing = false;
    this.isPaused = false;
    this.currentPreset = 'balanced';

    // SFU Canvas Frame Relay
    this.sfuRelayInterval = null;
    this.relayVideoEl = null;
    this.relayCanvas = null;
    this.relayCtx = null;

    // Callbacks
    this.onShareStarted = null;
    this.onShareStopped = null;
    this.onAudioCaptured = null;
    this.onError = null;
  }

  /**
   * Starts screen capture with multi-tier adaptive fallbacks (guarantees prompt launch on any monitor/OS)
   */
  async startScreenShare(presetKey = 'balanced', captureAudio = true) {
    if (this.activeStream) {
      const liveTracks = this.activeStream.getTracks().filter(t => t.readyState === 'live');
      if (liveTracks.length > 0) {
        console.warn('[ScreenShare] Already active. Stop first before restarting.');
        return this.activeStream;
      }
    }
    this.cleanup();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Screen capture (getDisplayMedia) is not supported in this browser or insecure context (HTTPS/localhost required).');
    }

    this.currentPreset = presetKey;
    const preset = (window.SmartClassroomConfig && window.SmartClassroomConfig.SCREEN_PRESETS && window.SmartClassroomConfig.SCREEN_PRESETS[presetKey])
      ? window.SmartClassroomConfig.SCREEN_PRESETS[presetKey]
      : { width: 1920, height: 1080, frameRate: 30, maxBitrate: 2500000 };

    let stream = null;

    // Strategy 1: Request with ideal resolution and standard audio flag
    try {
      console.log('[ScreenShare] Tier 1: Requesting display media with ideal constraints...');
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate }
        },
        audio: !!captureAudio
      });
    } catch (err1) {
      console.warn('[ScreenShare] Tier 1 capture failed or audio disallowed on selected source, attempting video-only fallback:', err1);
      // Strategy 2: Video-only capture with ideal constraints (works when Window is selected or OS blocks display audio)
      try {
        console.log('[ScreenShare] Tier 2: Requesting video-only display media...');
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: preset.width },
            height: { ideal: preset.height },
            frameRate: { ideal: preset.frameRate }
          },
          audio: false
        });
      } catch (err2) {
        console.warn('[ScreenShare] Tier 2 capture failed, attempting bare video fallback:', err2);
        // Strategy 3: Pure bare video constraints (universal compatibility across all browsers/OS)
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        });
      }
    }

    try {
      this.activeStream = stream;
      this.videoTrack = this.activeStream.getVideoTracks()[0];
      this.audioTrack = this.activeStream.getAudioTracks()[0] || null;

      // Lock crystal-clear detail and eliminate resolution fluctuation
      if (this.videoTrack && 'contentHint' in this.videoTrack) {
        this.videoTrack.contentHint = 'detail';
      }

      // Handle user clicking native browser "Stop sharing" bar
      this.videoTrack.onended = () => {
        console.log('[ScreenShare] Native capture stopped by user.');
        this.stopScreenShare();
      };

      this.isSharing = true;
      this.isPaused = false;

      // Broadcast screen presentation via PeerJS Signaling Manager
      if (this.signalingManager && typeof this.signalingManager.broadcastStream === 'function') {
        this.signalingManager.broadcastStream(this.activeStream);
      }

      // Register stream with WebRTC manager (only for WebSocket LAN SFU mode; PeerJS handles media via peer.call)
      if (this.webrtcManager && this.signalingManager && this.signalingManager.isWsMode) {
        try {
          this.webrtcManager.addLocalStream('screen', this.activeStream);
          await this.webrtcManager.setMaxBitrate(preset.maxBitrate);
        } catch(e) {}
      }

      // Also launch SFU binary media streamer so students on any network receive live presentation
      this.startSfuRelayStream();

      const hasAudio = !!this.audioTrack;
      console.log(`[ScreenShare] Active. Resolution: ${preset.width}x${preset.height} @ ${preset.frameRate}fps. Audio captured: ${hasAudio}`);

      if (this.onShareStarted) {
        this.onShareStarted(this.activeStream, {
          preset: presetKey,
          hasAudio: hasAudio,
          track: this.videoTrack
        });
      }

      return this.activeStream;
    } catch (err) {
      console.error('[ScreenShare] Error finalizing screen share:', err);
      this.cleanup();
      if (this.onError) {
        this.onError(err);
      }
      throw err;
    }
  }

  /**
   * Dynamically alters video quality preset during an active stream
   */
  async switchPreset(presetKey) {
    if (!this.isSharing || !this.videoTrack) return;
    this.currentPreset = presetKey;
    const preset = window.SmartClassroomConfig ? window.SmartClassroomConfig.SCREEN_PRESETS[presetKey] : null;
    if (!preset) return;

    try {
      await this.videoTrack.applyConstraints({
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
        frameRate: { ideal: preset.frameRate, max: preset.frameRate }
      });
      if (this.webrtcManager) {
        await this.webrtcManager.setMaxBitrate(preset.maxBitrate);
      }
      console.log(`[ScreenShare] Switched to quality preset: ${preset.label}`);
    } catch (e) {
      console.warn('[ScreenShare] Could not apply all constraint updates:', e);
    }
  }

  /**
   * Pauses or resumes the video track
   */
  togglePause() {
    if (!this.videoTrack) return false;
    this.videoTrack.enabled = !this.videoTrack.enabled;
    this.isPaused = !this.videoTrack.enabled;
    console.log(`[ScreenShare] Stream paused state: ${this.isPaused}`);
    return this.isPaused;
  }

  /**
   * Cleanly terminates screen capture and notifies peers
   */
  stopScreenShare() {
    if (!this.isSharing && !this.activeStream) return;

    if (this.webrtcManager) {
      this.webrtcManager.removeLocalStream('screen');
    }
    if (this.signalingManager && typeof this.signalingManager.stopStream === 'function') {
      this.signalingManager.stopStream();
    }

    this.cleanup();

    if (this.onShareStopped) {
      this.onShareStopped();
    }
  }

  cleanup() {
    this.stopSfuRelayStream();
    if (this.activeStream) {
      this.activeStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
    }
    this.activeStream = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.isSharing = false;
    this.isPaused = false;
  }

  /**
   * SFU Relay Engine: Captures screen frames and streams them as binary blobs
   * over WebSocket or DataChannels so all students see the screen even across firewalls / NAT.
   */
  startSfuRelayStream(streamToRelay = null) {
    const targetStream = streamToRelay || this.activeStream;
    if (!this.signalingManager || !targetStream) return;
    this.stopSfuRelayStream();

    try {
      // Ensure target stream video track is active
      const vTrack = targetStream.getVideoTracks ? targetStream.getVideoTracks()[0] : null;
      if (!vTrack || vTrack.readyState === 'ended') {
        console.warn('[ScreenShare] Target stream has no live video track for SFU relay.');
        return;
      }

      const previewEl = document.getElementById('teacherScreenPreview');

      // Create a dedicated off-stage video element with non-zero dimensions
      // (ensures Chromium video decoder is NEVER suspended or throttled by compositor)
      this.relayVideoEl = document.createElement('video');
      this.relayVideoEl.muted = true;
      this.relayVideoEl.defaultMuted = true;
      this.relayVideoEl.playsInline = true;
      this.relayVideoEl.setAttribute('muted', '');
      this.relayVideoEl.setAttribute('playsinline', '');
      this.relayVideoEl.style.cssText = 'position:fixed;bottom:0;right:0;width:320px;height:180px;opacity:0.01;pointer-events:none;z-index:-99999;';
      if (typeof document !== 'undefined' && document.body) {
        document.body.appendChild(this.relayVideoEl);
      }
      this.relayVideoEl.srcObject = targetStream;
      this.relayVideoEl.play().catch(() => {});

      this.relayCanvas = document.createElement('canvas');
      this.relayCtx = this.relayCanvas.getContext('2d', { alpha: false });

      let isProcessingFrame = false;
      let lastSfuSentTime = 0;

    // Stream frames at ~30 FPS (every 33ms) with dynamic backpressure flow control
    const pushFrame = () => {
      if (!this.activeStream && !streamToRelay) return;
      if (this.isPaused && !streamToRelay) return;
      if (!this.signalingManager || !this.signalingManager.isConnected) return;

      // BACKPRESSURE CHECK: If socket/datachannel buffer has > 1 MB pending, skip this frame
      if (typeof this.signalingManager.getBufferedAmount === 'function' && this.signalingManager.getBufferedAmount() > 1024 * 1024) {
        return;
      }

      if (isProcessingFrame) return; // Drop frame if previous is still compressing
      isProcessingFrame = true;

      // Select the active, rendered video source:
      // Prefer previewEl if currently playing targetStream, otherwise use relayVideoEl
      const videoSource = (previewEl && previewEl.srcObject === targetStream && previewEl.readyState >= 2 && previewEl.videoWidth > 0)
        ? previewEl
        : (this.relayVideoEl && this.relayVideoEl.readyState >= 2 && this.relayVideoEl.videoWidth > 0 ? this.relayVideoEl : null);

      if (!videoSource) {
        isProcessingFrame = false;
        return;
      }

      const vw = videoSource.videoWidth;
      const vh = videoSource.videoHeight;
      if (!vw || !vh) {
        isProcessingFrame = false;
        return;
      }

      // Adaptive HD Resolution: 1080p on Local LAN (Port 3000 WebSocket), 720p HD on PeerJS Cloud
      // (720p at 0.70 quality produces ~35 KB frames, perfectly below WebRTC DataChannel 64 KB MTU!)
      const isLan = this.signalingManager && this.signalingManager.isWsMode;
      const maxW = isLan ? 1920 : 1280;
      const scale = vw > maxW ? maxW / vw : 1;
      const targetW = Math.round(vw * scale);
      const targetH = Math.round(vh * scale);

      if (this.relayCanvas.width !== targetW || this.relayCanvas.height !== targetH) {
        this.relayCanvas.width = targetW;
        this.relayCanvas.height = targetH;
      }

      this.relayCtx.drawImage(videoSource, 0, 0, targetW, targetH);

      const jpegQuality = isLan ? 0.75 : 0.70;
      this.relayCanvas.toBlob((blob) => {
        if (blob && (this.isSharing || streamToRelay) && this.signalingManager) {
          blob.arrayBuffer().then((buffer) => {
            this.signalingManager.sendBinary(buffer);
            lastSfuSentTime = Date.now();
          }).catch(() => {}).finally(() => {
            isProcessingFrame = false;
          });
        } else {
          isProcessingFrame = false;
        }
      }, 'image/jpeg', jpegQuality);
    };

    this.sendInstantSnapshot = () => pushFrame();
    this.sfuRelayInterval = setInterval(pushFrame, 33);
    // Immediately emit first frame
    setTimeout(pushFrame, 50);

      console.log('[ScreenShare] SFU Binary Frame Streamer active with universal flow control.');
    } catch (e) {
      console.warn('[ScreenShare] Could not start SFU frame streamer:', e);
    }
  }

  stopSfuRelayStream() {
    if (this.sfuRelayInterval) {
      clearInterval(this.sfuRelayInterval);
      this.sfuRelayInterval = null;
    }
    if (this.relayVideoEl) {
      try {
        this.relayVideoEl.pause();
        this.relayVideoEl.srcObject = null;
        if (this.relayVideoEl.parentNode) {
          this.relayVideoEl.parentNode.removeChild(this.relayVideoEl);
        }
      } catch (e) {}
      this.relayVideoEl = null;
    }
    this.relayCanvas = null;
    this.relayCtx = null;
  }
}

// Global exposure
window.ScreenShareManager = ScreenShareManager;