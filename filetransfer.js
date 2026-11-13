// --- file-transfer.js ---
/**
 * SMART WEBRTC CLASSROOM - Secure P2P File Transfer Engine
 * High-performance chunked file transfer with backpressure flow control,
 * memory-efficient File.slice(), SHA-256 verification, and receiver consent.
 */

class FileTransferManager {
  constructor(webrtcManager, router, signalingManager = null) {
    this.webrtcManager = webrtcManager;
    this.router = router;
    this.signalingManager = signalingManager;

    this.chunkSize = window.SmartClassroomConfig ? window.SmartClassroomConfig.FILE_TRANSFER.CHUNK_SIZE : 16384;
    this.bufferThreshold = window.SmartClassroomConfig ? window.SmartClassroomConfig.FILE_TRANSFER.BUFFER_THRESHOLD : 65536;

    // Active transfers
    this.outgoingTransfers = new Map(); // fileId -> { file, progress, cancelled, startTime, ... }
    this.incomingTransfers = new Map(); // fileId -> { meta, chunks, receivedBytes, startTime, ... }

    // Event hooks
    this.onIncomingFileOffer = null; // (peerId, meta) => prompt receiver
    this.onTransferProgress = null;  // (fileId, direction, percent, speedKbps, etaSec)
    this.onTransferComplete = null;  // (fileId, direction, fileData/blob, hashMatched)
    this.onTransferCancelled = null; // (fileId, direction, reason)
    this.onTransferError = null;     // (fileId, direction, error)

    this.init();
  }

  init() {
    if (this.router) {
      this.router.onFileControlMessage = (peerId, data) => {
        if (data instanceof ArrayBuffer) {
          this.handleBinaryChunk(peerId, data);
        } else {
          this.handleControlPacket(peerId, data);
        }
      };
    }

    if (this.signalingManager) {
      this.signalingManager.onFileControl = (msg) => {
        if (msg.payload) {
          this.handleControlPacket(msg.senderId, msg.payload);
        }
      };
    }
  }

  /**
   * Initiates sending a file to a peer or all peers
   */
  async sendFile(file, targetPeerId = null) {
    if (!file) throw new Error('No file provided for transfer.');

    const fileId = SecurityManager.generateUUID();
    const cleanName = SecurityManager.sanitizeFilename(file.name);

    // Compute SHA-256 hash using native Web Crypto
    console.log(`[FileTransfer] Computing SHA-256 for "${cleanName}" (${file.size} bytes)...`);
    const fileBuffer = await file.arrayBuffer();
    const hash = await SecurityManager.computeSHA256(fileBuffer);
    console.log(`[FileTransfer] SHA-256 computed: ${hash}`);

    const metadata = {
      fileId: fileId,
      name: cleanName,
      size: file.size,
      type: file.type || 'application/octet-stream',
      hash: hash,
      totalChunks: Math.ceil(file.size / this.chunkSize),
      senderName: window.storageManager ? window.storageManager.getUserProfile().displayName : 'Sender',
      timestamp: Date.now()
    };

    const transferState = {
      fileId: fileId,
      file: file,
      meta: metadata,
      targetPeerId: targetPeerId,
      status: 'pending_approval',
      cancelled: false,
      startTime: 0,
      bytesSent: 0,
      totalChunks: metadata.totalChunks,
      currentChunkIndex: 0
    };

    this.outgoingTransfers.set(fileId, transferState);

    // Send file offer to receiver(s)
    const offerPacket = {
      type: 'file_offer',
      payload: metadata
    };

    let sent = false;
    if (this.webrtcManager) {
      sent = targetPeerId
        ? this.webrtcManager.sendData(JSON.stringify(offerPacket), targetPeerId)
        : this.webrtcManager.sendData(JSON.stringify(offerPacket));
    }

    if (!sent && this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'file_control',
        recipientId: targetPeerId,
        payload: offerPacket
      });
      sent = true;
    }

    if (!sent) {
      this.outgoingTransfers.delete(fileId);
      throw new Error('No active connection available to transfer file.');
    }

    return metadata;
  }

  /**
   * Handles control packets (offer, accept, reject, cancel)
   */
  handleControlPacket(peerId, packet) {
    switch (packet.type) {
      case 'file_offer':
        this.handleIncomingOffer(peerId, packet.payload);
        break;

      case 'file_accept':
        this.startChunkStreaming(packet.fileId, peerId);
        break;

      case 'file_reject':
        this.handleTransferRejected(packet.fileId, peerId, packet.reason);
        break;

      case 'file_cancel':
        this.handleTransferCancelled(packet.fileId, 'inbound', 'Cancelled by sender');
        break;

      case 'file_complete':
        this.verifyAndFinalizeIncoming(packet.fileId);
        break;
    }
  }

  /**
   * Handles incoming file offer from a peer
   */
  handleIncomingOffer(peerId, meta) {
    meta.name = SecurityManager.sanitizeFilename(meta.name);
    console.log(`[FileTransfer] Inbound file offer from ${peerId}: "${meta.name}" (${meta.size} bytes)`);

    this.incomingTransfers.set(meta.fileId, {
      fileId: meta.fileId,
      peerId: peerId,
      meta: meta,
      status: 'pending_consent',
      chunks: [],
      receivedBytes: 0,
      startTime: 0,
      cancelled: false
    });

    if (this.onIncomingFileOffer) {
      this.onIncomingFileOffer(peerId, meta);
    }
  }

  /**
   * Receiver accepts the file transfer
   */
  acceptIncomingFile(fileId) {
    const transfer = this.incomingTransfers.get(fileId);
    if (!transfer) return false;

    transfer.status = 'transferring';
    transfer.startTime = Date.now();

    const acceptPacket = {
      type: 'file_accept',
      fileId: fileId
    };

    let sent = false;
    if (this.webrtcManager) {
      sent = this.webrtcManager.sendData(JSON.stringify(acceptPacket), transfer.peerId);
    }
    if (!sent && this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'file_control',
        recipientId: transfer.peerId,
        payload: acceptPacket
      });
      sent = true;
    }
    return sent;
  }

  // Dual-naming alias for UI handlers
  acceptFile(fileId) {
    return this.acceptIncomingFile(fileId);
  }

  /**
   * Receiver rejects the file transfer
   */
  rejectIncomingFile(fileId, reason = 'Receiver declined file') {
    const transfer = this.incomingTransfers.get(fileId);
    if (!transfer) return false;

    const rejectPacket = {
      type: 'file_reject',
      fileId: fileId,
      reason: reason
    };

    let sent = false;
    if (this.webrtcManager) {
      sent = this.webrtcManager.sendData(JSON.stringify(rejectPacket), transfer.peerId);
    }
    if (!sent && this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'file_control',
        recipientId: transfer.peerId,
        payload: rejectPacket
      });
      sent = true;
    }
    this.incomingTransfers.delete(fileId);
    return sent;
  }

  // Dual-naming alias for UI handlers
  rejectFile(fileId, reason = 'Receiver declined file') {
    return this.rejectIncomingFile(fileId, reason);
  }

  /**
   * Sender streams chunks with backpressure flow control
   */
  async startChunkStreaming(fileId, targetPeerId) {
    const transfer = this.outgoingTransfers.get(fileId);
    if (!transfer || transfer.cancelled) return;

    transfer.status = 'transferring';
    transfer.startTime = Date.now();
    console.log(`[FileTransfer] Streaming chunks for file: ${transfer.meta.name} to ${targetPeerId}`);

    const file = transfer.file;
    const channel = this.webrtcManager.dataChannels.get(targetPeerId);

    if (!channel || channel.readyState !== 'open') {
      this.handleTransferError(fileId, 'outbound', 'DataChannel disconnected during transfer.');
      return;
    }

    const totalChunks = transfer.totalChunks;
    let chunkIndex = 0;

    // Helper: wait for buffer to drain when backpressure occurs
    const waitForBufferDrain = () => {
      return new Promise((resolve) => {
        channel.onbufferedamountlow = () => {
          channel.onbufferedamountlow = null;
          resolve();
        };
      });
    };

    while (chunkIndex < totalChunks) {
      if (transfer.cancelled) {
        console.log(`[FileTransfer] Transfer cancelled: ${fileId}`);
        return;
      }

      // Check DataChannel backpressure
      if (channel.bufferedAmount > this.bufferThreshold) {
        await waitForBufferDrain();
      }

      const start = chunkIndex * this.chunkSize;
      const end = Math.min(start + this.chunkSize, file.size);
      const sliceBlob = file.slice(start, end);
      const chunkBuffer = await sliceBlob.arrayBuffer();

      // Header: 16 bytes UUID header + 4 bytes chunkIndex uint32 + raw chunk data
      const headerLength = 36 + 4; // 36 char string + 4 bytes uint32
      const packetBuffer = new ArrayBuffer(headerLength + chunkBuffer.byteLength);
      const headerView = new DataView(packetBuffer);
      const uint8View = new Uint8Array(packetBuffer);

      // Write UUID as ASCII
      for (let i = 0; i < 36; i++) {
        uint8View[i] = fileId.charCodeAt(i);
      }
      // Write chunk index
      headerView.setUint32(36, chunkIndex, false);
      // Copy chunk payload
      uint8View.set(new Uint8Array(chunkBuffer), headerLength);

      try {
        channel.send(packetBuffer);
      } catch (err) {
        console.error('[FileTransfer] Error sending chunk packet:', err);
        this.handleTransferError(fileId, 'outbound', err.message);
        return;
      }

      transfer.bytesSent += chunkBuffer.byteLength;
      chunkIndex++;
      transfer.currentChunkIndex = chunkIndex;

      // Update progress metrics
      const elapsedSec = (Date.now() - transfer.startTime) / 1000;
      const speedBps = elapsedSec > 0 ? transfer.bytesSent / elapsedSec : 0;
      const percent = Math.round((chunkIndex / totalChunks) * 100);
      const remainingBytes = file.size - transfer.bytesSent;
      const etaSec = speedBps > 0 ? Math.round(remainingBytes / speedBps) : 0;

      if (this.onTransferProgress) {
        this.onTransferProgress(fileId, 'outbound', percent, Math.round(speedBps / 1024), etaSec);
      }
    }

    // Notify receiver that all chunks have been sent
    console.log(`[FileTransfer] All chunks dispatched for: ${transfer.meta.name}. Sending completion token.`);
    const completePacket = {
      type: 'file_complete',
      fileId: fileId
    };
    let sentComplete = false;
    if (this.webrtcManager) {
      sentComplete = this.webrtcManager.sendData(JSON.stringify(completePacket), targetPeerId);
    }
    if (!sentComplete && this.signalingManager && this.signalingManager.isConnected) {
      this.signalingManager.send({
        type: 'file_control',
        recipientId: targetPeerId,
        payload: completePacket
      });
    }

    transfer.status = 'completed';
    if (this.onTransferComplete) {
      this.onTransferComplete(fileId, 'outbound', null, true, transfer.meta);
    }
  }

  /**
   * Handles incoming binary chunk packet from DataChannel
   */
  handleBinaryChunk(peerId, arrayBuffer) {
    if (arrayBuffer.byteLength < 40) return; // Min header length

    const uint8View = new Uint8Array(arrayBuffer);
    const headerView = new DataView(arrayBuffer);

    // Extract 36-char fileId
    let fileId = '';
    for (let i = 0; i < 36; i++) {
      fileId += String.fromCharCode(uint8View[i]);
    }

    const chunkIndex = headerView.getUint32(36, false);
    const payload = arrayBuffer.slice(40);

    const transfer = this.incomingTransfers.get(fileId);
    if (!transfer || transfer.cancelled) return;

    transfer.chunks[chunkIndex] = payload;
    transfer.receivedBytes += payload.byteLength;

    const totalChunks = transfer.meta.totalChunks;
    const elapsedSec = (Date.now() - transfer.startTime) / 1000;
    const speedBps = elapsedSec > 0 ? transfer.receivedBytes / elapsedSec : 0;
    const percent = Math.min(100, Math.round((transfer.receivedBytes / transfer.meta.size) * 100));
    const remainingBytes = Math.max(0, transfer.meta.size - transfer.receivedBytes);
    const etaSec = speedBps > 0 ? Math.round(remainingBytes / speedBps) : 0;

    if (this.onTransferProgress) {
      this.onTransferProgress(fileId, 'inbound', percent, Math.round(speedBps / 1024), etaSec);
    }
  }

  /**
   * Reassembles chunks, verifies SHA-256 hash, and generates download Blob
   */
  async verifyAndFinalizeIncoming(fileId) {
    const transfer = this.incomingTransfers.get(fileId);
    if (!transfer) return;

    console.log(`[FileTransfer] Finalizing inbound file: ${transfer.meta.name}. Assembling ${transfer.chunks.length} chunks...`);

    const blob = new Blob(transfer.chunks, { type: transfer.meta.type });
    const fullBuffer = await blob.arrayBuffer();

    console.log('[FileTransfer] Verifying SHA-256 integrity...');
    const computedHash = await SecurityManager.computeSHA256(fullBuffer);
    const hashMatched = computedHash.toLowerCase() === transfer.meta.hash.toLowerCase();

    console.log(`[FileTransfer] Hash check: Received = ${transfer.meta.hash}, Computed = ${computedHash}. Match: ${hashMatched}`);

    transfer.status = hashMatched ? 'completed' : 'corrupted';
    transfer.downloadBlob = blob;
    transfer.hashMatched = hashMatched;

    // Log to local storage records
    if (window.storageManager) {
      window.storageManager.logTransferRecord({
        id: fileId,
        name: transfer.meta.name,
        size: transfer.meta.size,
        hash: transfer.meta.hash,
        hashMatched: hashMatched,
        senderName: transfer.meta.senderName,
        timestamp: Date.now()
      });
    }

    if (this.onTransferComplete) {
      this.onTransferComplete(fileId, 'inbound', blob, hashMatched, transfer.meta);
    }
  }

  /**
   * Triggers browser download for completed received file
   */
  downloadReceivedFile(fileId) {
    const transfer = this.incomingTransfers.get(fileId);
    if (!transfer || !transfer.downloadBlob) {
      console.warn(`[FileTransfer] No download ready for fileId: ${fileId}`);
      return false;
    }

    const url = URL.createObjectURL(transfer.downloadBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = transfer.meta.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }

  /**
   * Cancels an ongoing transfer
   */
  cancelTransfer(fileId, direction = 'outbound') {
    if (direction === 'outbound') {
      const transfer = this.outgoingTransfers.get(fileId);
      if (transfer) {
        transfer.cancelled = true;
        this.outgoingTransfers.delete(fileId);
        const cancelPacket = { type: 'file_cancel', fileId: fileId };
        this.webrtcManager.sendData(JSON.stringify(cancelPacket));
        if (this.onTransferCancelled) this.onTransferCancelled(fileId, 'outbound', 'Cancelled by user');
      }
    } else {
      const transfer = this.incomingTransfers.get(fileId);
      if (transfer) {
        transfer.cancelled = true;
        this.incomingTransfers.delete(fileId);
        if (this.onTransferCancelled) this.onTransferCancelled(fileId, 'inbound', 'Cancelled by user');
      }
    }
  }

  handleTransferRejected(fileId, peerId, reason) {
    this.outgoingTransfers.delete(fileId);
    if (this.onTransferCancelled) {
      this.onTransferCancelled(fileId, 'outbound', reason || 'Receiver rejected transfer.');
    }
  }

  handleTransferCancelled(fileId, direction, reason) {
    if (direction === 'inbound') {
      this.incomingTransfers.delete(fileId);
    } else {
      this.outgoingTransfers.delete(fileId);
    }
    if (this.onTransferCancelled) {
      this.onTransferCancelled(fileId, direction, reason);
    }
  }

  handleTransferError(fileId, direction, errorMsg) {
    if (this.onTransferError) {
      this.onTransferError(fileId, direction, errorMsg);
    }
  }
}

// Global exposure
window.FileTransferManager = FileTransferManager;