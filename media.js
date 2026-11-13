// --- media.js ---
/**
 * SMART WEBRTC CLASSROOM - Audio & Video Peripheral Media Engine
 * Manages webcam, microphone, device enumeration, live audio level analysis,
 * and track state synchronization with the WebRTC manager.
 */

class MediaManager {
  constructor(webrtcManager) {
    this.webrtcManager = webrtcManager;
    this.audioStream = null;
    this.videoStream = null;
    this.isAudioMuted = true;
    this.isVideoEnabled = false;

    // Web Audio API VU meter
    this.audioContext = null;
    this.analyser = null;
    this.vuInterval = null;

    // Callbacks
    this.onAudioLevel = null; // (level: 0 to 100)
    this.onDeviceListUpdated = null;
    this.onAudioStateChange = null;
    this.onVideoStateChange = null;
  }

  /**
   * Enumerates available cameras, microphones, and audio output devices
   */
  async enumerateDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      console.warn('[Media] Device enumeration not supported.');
      return { audioInputs: [], videoInputs: [], audioOutputs: [] };
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');
      const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');

      if (this.onDeviceListUpdated) {
        this.onDeviceListUpdated({ audioInputs, videoInputs, audioOutputs });
      }

      return { audioInputs, videoInputs, audioOutputs };
    } catch (e) {
      console.warn('[Media] Failed to enumerate devices:', e);
      return { audioInputs: [], videoInputs: [], audioOutputs: [] };
    }
  }

  /**
   * Toggles microphone on or off
   */
  async toggleMicrophone(deviceId = null) {
    if (this.audioStream) {
      // Toggle existing track mute state
      const track = this.audioStream.getAudioTracks()[0];
      if (track) {
        track.enabled = !track.enabled;
        this.isAudioMuted = !track.enabled;
        if (this.isAudioMuted) {
          this.stopAudioAnalysis();
        } else {
          this.startAudioAnalysis(this.audioStream);
        }
        if (this.onAudioStateChange) {
          this.onAudioStateChange(!this.isAudioMuted);
        }
        return !this.isAudioMuted;
      }
    }

    // Acquire new audio stream
    try {
      const constraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false
      };
      this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.isAudioMuted = false;

      if (this.webrtcManager) {
        this.webrtcManager.addLocalStream('mic', this.audioStream);
      }

      this.startAudioAnalysis(this.audioStream);

      if (this.onAudioStateChange) {
        this.onAudioStateChange(true);
      }
      return true;
    } catch (err) {
      console.error('[Media] Failed to access microphone:', err);
      this.isAudioMuted = true;
      if (this.onAudioStateChange) {
        this.onAudioStateChange(false);
      }
      throw err;
    }
  }

  /**
   * Toggles webcam video on or off
   */
  async toggleCamera(deviceId = null) {
    if (this.videoStream) {
      // Stop existing camera stream
      this.videoStream.getTracks().forEach((t) => t.stop());
      if (this.webrtcManager) {
        this.webrtcManager.removeLocalStream('cam');
      }
      this.videoStream = null;
      this.isVideoEnabled = false;
      if (this.onVideoStateChange) {
        this.onVideoStateChange(false, null);
      }
      return false;
    }

    // Acquire new camera stream
    try {
      const constraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
          : { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      };
      this.videoStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.isVideoEnabled = true;

      if (this.webrtcManager) {
        this.webrtcManager.addLocalStream('cam', this.videoStream);
      }

      if (this.onVideoStateChange) {
        this.onVideoStateChange(true, this.videoStream);
      }
      return true;
    } catch (err) {
      console.error('[Media] Failed to access webcam:', err);
      this.isVideoEnabled = false;
      if (this.onVideoStateChange) {
        this.onVideoStateChange(false, null);
      }
      throw err;
    }
  }

  /**
   * Initializes real-time AudioContext analysis for live audio volume bar
   */
  startAudioAnalysis(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }

      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      source.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      this.stopAudioAnalysis();
      this.vuInterval = setInterval(() => {
        if (!this.analyser || this.isAudioMuted) {
          if (this.onAudioLevel) this.onAudioLevel(0);
          return;
        }

        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const normalized = Math.min(100, Math.round((average / 128) * 100));

        if (this.onAudioLevel) {
          this.onAudioLevel(normalized);
        }
      }, 100);
    } catch (e) {
      console.warn('[Media] Audio analysis setup error:', e);
    }
  }

  stopAudioAnalysis() {
    if (this.vuInterval) {
      clearInterval(this.vuInterval);
      this.vuInterval = null;
    }
    if (this.onAudioLevel) {
      this.onAudioLevel(0);
    }
  }

  cleanup() {
    this.stopAudioAnalysis();
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((t) => t.stop());
      this.audioStream = null;
    }
    if (this.videoStream) {
      this.videoStream.getTracks().forEach((t) => t.stop());
      this.videoStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {}
    }
    this.isAudioMuted = true;
    this.isVideoEnabled = false;
  }
}

// Global exposure
window.MediaManager = MediaManager;