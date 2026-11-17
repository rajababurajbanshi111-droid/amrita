// --- data-channel.js ---
/**
 * SMART WEBRTC CLASSROOM - DataChannel Protocol Router
 * Dispatches and multiplexes chat, whiteboard strokes, remote pointer events,
 * and classroom control packets across RTCDataChannels.
 */

class DataChannelRouter {
  constructor(webrtcManager, signalingManager = null) {
    this.webrtcManager = webrtcManager;
    this.signalingManager = signalingManager;

    // Listeners for incoming payloads
    this.onChatMessage = null;
    this.onWhiteboardStroke = null;
    this.onWhiteboardClear = null;
    this.onPointerMove = null;
    this.onAnnouncement = null;
    this.onPermissionUpdate = null;
    this.onFileControlMessage = null;
    this.onRaiseHand = null;
    this.onReaction = null;

    this.init();
  }

  init() {
    if (!this.webrtcManager) return;

    this.webrtcManager.onDataChannelMessage = (peerId, data) => {
      this.routeIncomingData(peerId, data);
    };
  }

  /**
   * Routes incoming ArrayBuffer or String message
   */
  routeIncomingData(peerId, data) {
    // If binary data, delegate directly to File Transfer engine
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      if (this.onFileControlMessage) {
        this.onFileControlMessage(peerId, data);
      }
      return;
    }

    try {
      const packet = JSON.parse(data);
      if (!packet || !packet.type) return;

      switch (packet.type) {
        case 'chat':
          if (window.classroom && window.classroom.permissions && window.classroom.permissions.allowChat === false && packet.payload && packet.payload.senderRole === 'student') {
            console.warn('[DataChannel] Dropping incoming student chat packet because chat is disabled by professor.');
            return;
          }
          if (this.onChatMessage) {
            this.onChatMessage(peerId, packet.payload);
          }
          break;

        case 'whiteboard_stroke':
          if (this.onWhiteboardStroke) {
            this.onWhiteboardStroke(peerId, packet.payload);
          }
          break;

        case 'whiteboard_clear':
          if (this.onWhiteboardClear) {
            this.onWhiteboardClear(peerId);
          }
          break;

        case 'pointer_move':
          if (this.onPointerMove) {
            this.onPointerMove(peerId, packet.payload);
          }
          break;

        case 'announcement':
          if (this.onAnnouncement) {
            this.onAnnouncement(peerId, packet.payload);
          }
          break;

        case 'permission_update':
          if (this.onPermissionUpdate) {
            this.onPermissionUpdate(peerId, packet.payload);
          }
          break;

        case 'raise_hand':
          if (this.onRaiseHand) {
            this.onRaiseHand(peerId, packet.payload);
          }
          break;

        case 'reaction':
          if (this.onReaction) {
            this.onReaction(peerId, packet.payload);
          }
          break;

        case 'file_offer':
        case 'file_accept':
        case 'file_reject':
        case 'file_cancel':
        case 'file_complete':
          if (this.onFileControlMessage) {
            this.onFileControlMessage(peerId, packet);
          }
          break;

        default:
          console.log(`[DataRouter] Unknown packet type from ${peerId}:`, packet.type);
      }
    } catch (e) {
      console.warn('[DataRouter] Non-JSON text payload received:', data);
    }
  }

  /**
   * Broadcasts a chat message
   */
  broadcastChat(text, senderName, senderRole = 'student') {
    const packet = {
      type: 'chat',
      payload: {
        id: SecurityManager.generateUUID(),
        text: text,
        sender: senderName,
        role: senderRole,
        timestamp: Date.now()
      }
    };
    if (this.webrtcManager) {
      this.webrtcManager.sendData(JSON.stringify(packet));
    }
    if (this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'chat_message',
        payload: packet.payload
      });
    }
    return packet.payload;
  }

  /**
   * Broadcasts whiteboard drawing stroke
   */
  broadcastWhiteboardStroke(strokeData) {
    const packet = {
      type: 'whiteboard_stroke',
      payload: strokeData
    };
    if (this.webrtcManager) {
      this.webrtcManager.sendData(JSON.stringify(packet));
    }
    if (this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'wb_stroke',
        payload: strokeData
      });
    }
  }

  /**
   * Broadcasts whiteboard clear command
   */
  broadcastWhiteboardClear() {
    const packet = { type: 'whiteboard_clear' };
    if (this.webrtcManager) {
      this.webrtcManager.sendData(JSON.stringify(packet));
    }
    if (this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({ type: 'wb_clear' });
    }
  }

  /**
   * Broadcasts remote pointer / laser pointer coordinates
   */
  broadcastPointer(xPercent, yPercent, isLaser = false, color = '#00f0ff') {
    const packet = {
      type: 'pointer_move',
      payload: {
        x: xPercent,
        y: yPercent,
        isLaser: isLaser,
        color: color,
        timestamp: Date.now()
      }
    };
    if (this.webrtcManager) {
      this.webrtcManager.sendData(JSON.stringify(packet));
    }
  }

  /**
   * Broadcasts teacher announcement banner
   */
  broadcastAnnouncement(title, text, priority = 'normal') {
    const packet = {
      type: 'announcement',
      payload: {
        id: SecurityManager.generateUUID(),
        title: title,
        text: text,
        priority: priority,
        timestamp: Date.now()
      }
    };
    if (this.webrtcManager) {
      this.webrtcManager.sendData(JSON.stringify(packet));
    }
    if (this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'announcement',
        payload: packet.payload
      });
    }
    return packet.payload;
  }

  /**
   * Broadcasts classroom permission updates
   */
  broadcastPermissions(permissions) {
    const packet = {
      type: 'permission_update',
      payload: permissions
    };
    if (this.webrtcManager) {
      this.webrtcManager.sendData(JSON.stringify(packet));
    }
    if (this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'permission_change',
        permissions: permissions
      });
    }
  }

  /**
   * Broadcasts student hand raise toggle
   */
  broadcastRaiseHand(isRaised, studentName, studentId) {
    const packet = {
      type: 'raise_hand',
      payload: {
        id: SecurityManager.generateUUID(),
        studentId: studentId,
        studentName: studentName,
        isRaised: isRaised,
        timestamp: Date.now()
      }
    };
    if (this.webrtcManager) {
      this.webrtcManager.sendData(JSON.stringify(packet));
    }
    if (this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'raise_hand',
        payload: packet.payload
      });
    }
    return packet.payload;
  }

  /**
   * Broadcasts quick emoji reaction
   */
  broadcastReaction(emoji, studentName) {
    const packet = {
      type: 'reaction',
      payload: {
        id: SecurityManager.generateUUID(),
        emoji: emoji,
        sender: studentName,
        timestamp: Date.now()
      }
    };
    if (this.webrtcManager) {
      this.webrtcManager.sendData(JSON.stringify(packet));
    }
    if (this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'reaction',
        payload: packet.payload
      });
    }
    return packet.payload;
  }
}

// Global exposure
window.DataChannelRouter = DataChannelRouter;