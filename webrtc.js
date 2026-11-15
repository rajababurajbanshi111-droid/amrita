// --- webrtc.js ---
/**
 * SMART WEBRTC CLASSROOM - WebRTC Connection Engine
 * High-reliability RTCPeerConnection manager with automatic ICE restart,
 * candidate pair watchdog, dynamic bandwidth control, and zero-server fallback.
 */

class WebRTCManager {
  constructor(options = {}) {
    this.options = Object.assign(
      {
        iceServers: window.SmartClassroomConfig ? window.SmartClassroomConfig.DEFAULT_ICE_SERVERS : [],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      },
      options
    );

    this.peerConnections = new Map(); // peerId -> RTCPeerConnection
    this.dataChannels = new Map();    // peerId -> RTCDataChannel
    this.localStreams = new Map();   // type ('screen'|'cam'|'mic') -> MediaStream
    this.watchdogIntervals = new Map();
    this.connectionStates = new Map(); // peerId -> state string
    this.iceCandidateBuffers = new Map(); // peerId -> RTCIceCandidateInit[] (Trickle ICE buffer)

    // Event hooks
    this.onConnectionStateChange = null;
    this.onIceStateChange = null;
    this.onRemoteTrack = null;
    this.onDataChannelOpen = null;
    this.onDataChannelMessage = null;
    this.onDataChannelClose = null;
    this.onIceCandidate = null;
    this.onError = null;
  }

  /**
   * Updates ICE server configuration (STUN/TURN)
   */
  setIceServers(iceServers) {
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      this.options.iceServers = iceServers;
      console.log('[WebRTC] Updated ICE Servers:', this.options.iceServers);
    }
  }

  /**
   * Creates or retrieves an RTCPeerConnection for a specific peer
   */
  getOrCreateConnection(peerId, isInitiator = false) {
    if (this.peerConnections.has(peerId)) {
      return this.peerConnections.get(peerId);
    }

    const rtcConfig = {
      iceServers: this.options.iceServers,
      iceCandidatePoolSize: 2,
      bundlePolicy: this.options.bundlePolicy,
      rtcpMuxPolicy: this.options.rtcpMuxPolicy
    };

    const pc = new RTCPeerConnection(rtcConfig);
    this.peerConnections.set(peerId, pc);
    this.connectionStates.set(peerId, 'new');

    // Configure transceivers upfront so SDP contains m=video and m=audio lines
    // Teacher/Initiator transmits screen and audio to students (sendonly direction)
    try {
      if (pc.addTransceiver && isInitiator) {
        let hasVideo = false;
        let hasAudio = false;

        // Synchronously bind any active presenter streams (Screen Share / Mic)
        this.localStreams.forEach((stream) => {
          stream.getTracks().forEach((track) => {
            if (track.kind === 'video' && !hasVideo) {
              if ('contentHint' in track) track.contentHint = 'detail';
              const t = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
              try {
                const params = t.sender.getParameters();
                if (params.encodings && params.encodings.length > 0) {
                  params.encodings[0].degradationPreference = 'maintain-resolution';
                  t.sender.setParameters(params).catch(() => {});
                }
              } catch(e) {}
              hasVideo = true;
            } else if (track.kind === 'audio' && !hasAudio) {
              pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
              hasAudio = true;
            }
          });
        });

        // Add empty transceivers as placeholders if screen/mic hasn't started yet
        if (!hasVideo) pc.addTransceiver('video', { direction: 'sendonly' });
        if (!hasAudio) pc.addTransceiver('audio', { direction: 'sendonly' });
      }
    } catch (e) {
      console.warn(`[WebRTC] Transceiver setup note for peer ${peerId}:`, e);
    }

    // Create DataChannel if initiator
    if (isInitiator) {
      this.setupDataChannel(peerId, pc.createDataChannel('classroom-control', { ordered: true }));
    } else {
      pc.ondatachannel = (event) => {
        this.setupDataChannel(peerId, event.channel);
      };
    }

    // ICE Candidate handler (Direct LAN host, srflx, and TURN relay)
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        if (this.onIceCandidate) {
          this.onIceCandidate(peerId, event.candidate);
        }
      }
    };

    // Connection state listeners
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.connectionStates.set(peerId, state);
      console.log(`[WebRTC] Peer ${peerId} connectionState changed to:`, state);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(peerId, state);
      }
      if (state === 'failed') {
        this.attemptIceRestart(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      console.log(`[WebRTC] Peer ${peerId} iceConnectionState changed to:`, iceState);
      if (this.onIceStateChange) {
        this.onIceStateChange(peerId, iceState);
      }
      if (iceState === 'disconnected') {
        this.startDisconnectWatchdog(peerId);
      } else if (iceState === 'connected' || iceState === 'completed') {
        this.clearDisconnectWatchdog(peerId);
      } else if (iceState === 'failed') {
        this.attemptIceRestart(peerId);
      }
    };

    // Remote Track handler
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received remote track (${event.track.kind}) from peer: ${peerId}`);
      if (this.onRemoteTrack) {
        this.onRemoteTrack(peerId, event.streams[0] || new MediaStream([event.track]), event.track);
      }
    };

    return pc;
  }

  /**
   * Configures RTCDataChannel with flow control & message routing
   */
  setupDataChannel(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    // Configure backpressure threshold for high-speed file transfers
    channel.bufferedAmountLowThreshold = window.SmartClassroomConfig
      ? window.SmartClassroomConfig.FILE_TRANSFER.BUFFER_THRESHOLD
      : 65536;

    channel.onopen = () => {
      console.log(`[WebRTC] DataChannel open with peer: ${peerId}`);
      this.dataChannels.set(peerId, channel);
      if (this.onDataChannelOpen) {
        this.onDataChannelOpen(peerId, channel);
      }
    };

    channel.onmessage = (event) => {
      if (this.onDataChannelMessage) {
        this.onDataChannelMessage(peerId, event.data);
      }
    };

    channel.onclose = () => {
      console.log(`[WebRTC] DataChannel closed with peer: ${peerId}`);
      this.dataChannels.delete(peerId);
      if (this.onDataChannelClose) {
        this.onDataChannelClose(peerId);
      }
    };

    channel.onerror = (error) => {
      console.error(`[WebRTC] DataChannel error on peer ${peerId}:`, error);
      if (this.onError) {
        this.onError('datachannel', error, peerId);
      }
    };

    this.dataChannels.set(peerId, channel);
  }

  /**
   * Sends data over a specific peer's DataChannel or broadcasts to all
   */
  sendData(data, targetPeerId = null) {
    if (targetPeerId) {
      const channel = this.dataChannels.get(targetPeerId);
      if (channel && channel.readyState === 'open') {
        channel.send(data);
        return true;
      }
      return false;
    }

    // Broadcast to all active data channels
    let sentCount = 0;
    this.dataChannels.forEach((channel, pid) => {
      if (channel.readyState === 'open') {
        try {
          channel.send(data);
          sentCount++;
        } catch (e) {
          console.warn(`[WebRTC] Failed to send on channel ${pid}:`, e);
        }
      }
    });
    return sentCount > 0;
  }

  /**
   * Checks whether any WebRTC peer is currently in 'connected' state
   */
  hasConnectedPeers() {
    for (const state of this.connectionStates.values()) {
      if (state === 'connected') return true;
    }
    return false;
  }

  /**
   * Generates a WebRTC Offer.
   * Awaits initial candidate collection so host/STUN candidates are baked into the SDP.
   */
  async createOffer(peerId, gatherComplete = false) {
    const pc = this.getOrCreateConnection(peerId, true);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait for initial host candidates (LAN / Wi-Fi / Ethernet local IPs) to bake into SDP
    await this.waitForInitialCandidates(pc, 400);

    if (gatherComplete) {
      await this.waitForIceGathering(pc);
    }

    return pc.localDescription || offer;
  }

  /**
   * Handles an incoming Offer and generates an Answer.
   * Flushes buffered early trickle ICE candidates and bakes collected candidates into answer SDP.
   */
  async handleOfferAndCreateAnswer(peerId, offerSdp, gatherComplete = false) {
    let pc = this.peerConnections.get(peerId);
    if (pc && pc.signalingState !== 'stable') {
      console.log(`[WebRTC] Peer ${peerId} in non-stable state (${pc.signalingState}). Re-creating connection for new offer.`);
      this.closeConnection(peerId);
    }
    pc = this.getOrCreateConnection(peerId, false);

    const desc = new RTCSessionDescription({
      type: offerSdp.type,
      sdp: offerSdp.sdp
    });
    await pc.setRemoteDescription(desc);
    await this.flushCandidateBuffer(peerId);

    // Ensure transceivers on student are recvonly for incoming teacher screen/audio
    try {
      pc.getTransceivers().forEach((t) => {
        if (t.direction !== 'recvonly') {
          t.direction = 'recvonly';
        }
      });
    } catch (e) {}

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Wait for initial host candidates (LAN / Wi-Fi / Ethernet local IPs) to bake into SDP
    await this.waitForInitialCandidates(pc, 400);

    if (gatherComplete) {
      await this.waitForIceGathering(pc);
    }

    return pc.localDescription || answer;
  }

  /**
   * Handles an incoming Answer and flushes buffered candidates
   */
  async handleAnswer(peerId, answerSdp) {
    const pc = this.peerConnections.get(peerId);
    if (!pc) {
      throw new Error(`No RTCPeerConnection found for peerId: ${peerId}`);
    }
    const desc = new RTCSessionDescription({
      type: answerSdp.type,
      sdp: answerSdp.sdp
    });
    await pc.setRemoteDescription(desc);
    await this.flushCandidateBuffer(peerId);
  }

  /**
   * Adds an ICE candidate received via trickle signaling or buffers it if remoteDescription is not set
   */
  async addIceCandidate(peerId, candidate) {
    if (!candidate || (!candidate.candidate && candidate.candidate !== '')) return;
    const pc = this.peerConnections.get(peerId);

    // If PC doesn't exist yet or remoteDescription is not set, buffer candidate!
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
      if (!this.iceCandidateBuffers.has(peerId)) {
        this.iceCandidateBuffers.set(peerId, []);
      }
      this.iceCandidateBuffers.get(peerId).push(candidate);
      return;
    }

    try {
      const iceCand = (candidate instanceof RTCIceCandidate) ? candidate : new RTCIceCandidate(candidate);
      await pc.addIceCandidate(iceCand);
    } catch (e) {
      console.warn(`[WebRTC] Error adding ICE candidate for peer ${peerId}:`, e);
    }
  }

  /**
   * Flushes all buffered trickle ICE candidates after setRemoteDescription succeeds
   */
  async flushCandidateBuffer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (!pc || !pc.remoteDescription) return;

    const buffer = this.iceCandidateBuffers.get(peerId);
    if (buffer && buffer.length > 0) {
      console.log(`[WebRTC] Flushing ${buffer.length} buffered ICE candidates for peer ${peerId}`);
      while (buffer.length > 0) {
        const candidate = buffer.shift();
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn(`[WebRTC] Error applying buffered candidate:`, e);
        }
      }
    }
  }

  /**
   * Awaits first batch of ICE candidates (waits for STUN reflexive/relay or up to maxWaitMs)
   */
  waitForInitialCandidates(pc, maxWaitMs = 1200) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          pc.removeEventListener('icecandidate', onCand);
          resolve();
        }
      };

      const onCand = (e) => {
        if (e.candidate) {
          const type = e.candidate.type;
          if (type === 'host') {
            setTimeout(done, 150);
          } else {
            setTimeout(done, 400);
          }
        }
      };

      pc.addEventListener('icecandidate', onCand);
      const timer = setTimeout(done, maxWaitMs);
    });
  }

  /**
   * Awaits completion of ICE candidate gathering (used for manual zero-server copy-paste)
   */
  waitForIceGathering(pc, timeoutMs = 4000) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }

      let timer = null;
      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', checkState);
      };

      timer = setTimeout(() => {
        console.log('[WebRTC] ICE gathering wait reached timeout. Proceeding with collected candidates.');
        cleanup();
        resolve();
      }, timeoutMs);

      pc.addEventListener('icegatheringstatechange', checkState);
    });
  }

  /**
   * Adds a local media stream to all active peer connections
   */
  addLocalStream(type, stream) {
    this.localStreams.set(type, stream);

    stream.getTracks().forEach((track) => {
      this.peerConnections.forEach((pc, peerId) => {
        try {
          let matched = false;
          if (pc.getTransceivers) {
            const transceivers = pc.getTransceivers();
            for (const t of transceivers) {
              const currentTrack = (t.sender && t.sender.track) || (t.receiver && t.receiver.track);
              const kind = currentTrack ? currentTrack.kind : null;
              if (kind === track.kind || (t.sender && !currentTrack)) {
                if (t.sender) {
                  t.direction = 'sendonly';
                  t.sender.replaceTrack(track).catch((err) => {
                    console.warn(`[WebRTC] replaceTrack warning for peer ${peerId}:`, err);
                  });
                  matched = true;
                  break;
                }
              }
            }
          }

          if (!matched) {
            const senders = pc.getSenders();
            const matchingSender = senders.find((s) => s.track && s.track.kind === track.kind) ||
                                   senders.find((s) => !s.track);
            if (matchingSender) {
              matchingSender.replaceTrack(track).catch((err) => {
                console.warn(`[WebRTC] replaceTrack warning for peer ${peerId}:`, err);
              });
            } else {
              pc.addTrack(track, stream);
            }
          }
        } catch (e) {
          console.warn(`[WebRTC] Could not add track to peer ${peerId}:`, e);
        }
      });
    });
  }

  /**
   * Removes a local stream and stops its tracks
   */
  removeLocalStream(type) {
    const stream = this.localStreams.get(type);
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
        this.peerConnections.forEach((pc) => {
          const senders = pc.getSenders();
          const sender = senders.find((s) => s.track && s.track.id === track.id) ||
                         senders.find((s) => s.track && s.track.kind === track.kind);
          if (sender) {
            try {
              sender.replaceTrack(null).catch(() => {});
            } catch (e) {}
          }
        });
      });
      this.localStreams.delete(type);
    }
  }

  /**
   * Dynamically applies maximum bitrate to outbound video senders
   */
  async setMaxBitrate(maxBitrateBps) {
    const promises = [];
    this.peerConnections.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === 'video') {
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = maxBitrateBps;
            params.encodings[0].degradationPreference = 'maintain-resolution';
            promises.push(sender.setParameters(params).catch((e) => console.warn('[WebRTC] setParameters failed:', e)));
          } catch(e) {}
        }
      });
    });
    await Promise.all(promises);
  }

  /**
   * Watchdog timer for disconnected state: attempts recovery after 5 seconds
   */
  startDisconnectWatchdog(peerId) {
    if (this.watchdogIntervals.has(peerId)) return;
    const timer = setTimeout(() => {
      const pc = this.peerConnections.get(peerId);
      if (pc && pc.iceConnectionState === 'disconnected') {
        console.warn(`[WebRTC] Watchdog triggered for disconnected peer: ${peerId}. Triggering ICE restart.`);
        this.attemptIceRestart(peerId);
      }
    }, 15000);
    this.watchdogIntervals.set(peerId, timer);
  }

  clearDisconnectWatchdog(peerId) {
    if (this.watchdogIntervals.has(peerId)) {
      clearTimeout(this.watchdogIntervals.get(peerId));
      this.watchdogIntervals.delete(peerId);
    }
  }

  /**
   * Attempts an ICE restart on an existing connection
   */
  async attemptIceRestart(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (!pc || pc.signalingState === 'closed') return;
    try {
      console.log(`[WebRTC] Initiating ICE restart negotiation with peer ${peerId}`);
      if (typeof pc.restartIce === 'function') {
        pc.restartIce();
      }
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);

      if (this.onIceRestartRequired) {
        this.onIceRestartRequired(peerId, offer);
      }
    } catch (err) {
      console.error(`[WebRTC] ICE restart failed for peer ${peerId}:`, err);
    }
  }

  /**
   * Cleanly closes connection with a specific peer
   */
  closeConnection(peerId) {
    this.clearDisconnectWatchdog(peerId);

    const channel = this.dataChannels.get(peerId);
    if (channel) {
      try {
        channel.close();
      } catch (e) {}
      this.dataChannels.delete(peerId);
    }

    const pc = this.peerConnections.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch (e) {}
      this.peerConnections.delete(peerId);
    }

    this.connectionStates.delete(peerId);
    this.iceCandidateBuffers.delete(peerId);
    console.log(`[WebRTC] Closed and cleaned resources for peer: ${peerId}`);
  }

  /**
   * Closes all active connections, tracks, and channels
   */
  closeAll() {
    this.peerConnections.forEach((pc, peerId) => {
      this.closeConnection(peerId);
    });
    this.localStreams.forEach((stream, type) => {
      this.removeLocalStream(type);
    });
    this.peerConnections.clear();
    this.dataChannels.clear();
    this.connectionStates.clear();
    this.iceCandidateBuffers.clear();
  }
}

// Global exposure
window.WebRTCManager = WebRTCManager;