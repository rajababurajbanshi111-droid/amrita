/**
 * SMART WEBRTC CLASSROOM - Security & Storage Utilities
 * Token Compression, Cryptographic Sessions, Input Sanitization & Local Persistence
 */

// --- storage.js ---
/**
 * SMART WEBRTC CLASSROOM - Local Storage & IndexedDB Module
 * Provides robust offline storage for user preferences, room history, chat archives,
 * and transfer audit logs with zero external cloud dependencies.
 */

class StorageManager {
  constructor() {
    this.dbName = 'SmartClassroomDB';
    this.dbVersion = 1;
    this.db = null;
    this.initIndexedDBPromise = this.initIndexedDB();
  }

  /**
   * Initializes IndexedDB with stores for chat, transfers, and session logs
   */
  async initIndexedDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        console.warn('[Storage] IndexedDB not supported by this browser. Falling back to memory.');
        resolve(null);
        return;
      }

      const request = window.indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        // Chats Store
        if (!db.objectStoreNames.contains('chats')) {
          const chatStore = db.createObjectStore('chats', { keyPath: 'id', autoIncrement: true });
          chatStore.createIndex('roomCode', 'roomCode', { unique: false });
          chatStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        // File Transfers Store
        if (!db.objectStoreNames.contains('transfers')) {
          const transferStore = db.createObjectStore('transfers', { keyPath: 'id' });
          transferStore.createIndex('roomCode', 'roomCode', { unique: false });
          transferStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        // Diagnostics & Audit Log Store
        if (!db.objectStoreNames.contains('audit_logs')) {
          const logStore = db.createObjectStore('audit_logs', { keyPath: 'id', autoIncrement: true });
          logStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('[Storage] IndexedDB successfully initialized.');
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('[Storage] IndexedDB open error:', event.target.error);
        resolve(null);
      };
    });
  }

  // --- LocalStorage User Preferences ---

  getPreference(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(`swc_${key}`);
      return item !== null ? JSON.parse(item) : defaultValue;
    } catch (e) {
      console.warn(`[Storage] Failed to read preference ${key}:`, e);
      return defaultValue;
    }
  }

  setPreference(key, value) {
    try {
      localStorage.setItem(`swc_${key}`, JSON.stringify(value));
    } catch (e) {
      console.warn(`[Storage] Failed to save preference ${key}:`, e);
    }
  }

  removePreference(key) {
    try {
      localStorage.removeItem(`swc_${key}`);
    } catch (e) {
      console.warn(`[Storage] Failed to remove preference ${key}:`, e);
    }
  }

  // Common User Preferences (Name & Roll Number persist across sessions; Session code is never saved)
  getUserProfile() {
    return {
      displayName: this.getPreference('displayName', ''),
      rollNo: this.getPreference('rollNo', ''),
      role: this.getPreference('role', 'student'), // 'teacher' | 'student' | 'standalone'
      qualityPreset: this.getPreference('qualityPreset', 'balanced'),
      turnServers: this.getPreference('turnServers', [])
    };
  }

  saveUserProfile(profile) {
    if (profile.displayName !== undefined) this.setPreference('displayName', profile.displayName);
    if (profile.rollNo !== undefined) this.setPreference('rollNo', profile.rollNo);
    if (profile.role) this.setPreference('role', profile.role);
    if (profile.qualityPreset) this.setPreference('qualityPreset', profile.qualityPreset);
    if (profile.turnServers) this.setPreference('turnServers', profile.turnServers);
  }

  // --- IndexedDB Operations ---

  async saveChatMessage(message) {
    await this.initIndexedDBPromise;
    if (!this.db) return;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('chats', 'readwrite');
        const store = tx.objectStore('chats');
        store.add({
          roomCode: message.roomCode || 'p2p',
          sender: message.sender,
          senderRole: message.senderRole || 'student',
          text: message.text,
          timestamp: message.timestamp || Date.now()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async getChatHistory(roomCode = 'p2p') {
    await this.initIndexedDBPromise;
    if (!this.db) return [];
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('chats', 'readonly');
        const store = tx.objectStore('chats');
        const index = store.index('roomCode');
        const request = index.getAll(roomCode);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      } catch (e) {
        resolve([]);
      }
    });
  }

  async clearChatHistory(roomCode = null) {
    await this.initIndexedDBPromise;
    if (!this.db) return;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('chats', 'readwrite');
        const store = tx.objectStore('chats');
        if (!roomCode) {
          store.clear();
        } else {
          const index = store.index('roomCode');
          const req = index.openCursor(roomCode);
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async logTransferRecord(record) {
    await this.initIndexedDBPromise;
    if (!this.db) return;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('transfers', 'readwrite');
        tx.objectStore('transfers').put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async getTransferRecords() {
    await this.initIndexedDBPromise;
    if (!this.db) return [];
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('transfers', 'readonly');
        const req = tx.objectStore('transfers').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) {
        resolve([]);
      }
    });
  }

  async logAuditEvent(action, details) {
    await this.initIndexedDBPromise;
    if (!this.db) return;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('audit_logs', 'readwrite');
        tx.objectStore('audit_logs').add({
          action,
          details,
          timestamp: Date.now()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  /**
   * Complete Local Privacy Wipe: cleans all chats, files, logs, and storage keys
   */
  async wipeAllLocalData() {
    await this.initIndexedDBPromise;
    if (this.db) {
      try {
        const tx = this.db.transaction(['chats', 'transfers', 'audit_logs'], 'readwrite');
        tx.objectStore('chats').clear();
        tx.objectStore('transfers').clear();
        tx.objectStore('audit_logs').clear();
      } catch (e) {
        console.error('[Storage] Error clearing IndexedDB stores:', e);
      }
    }
    // Remove local storage keys
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('swc_')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
    console.log('[Storage] All local classroom data wiped cleanly.');
  }
}

// Global singleton instance
window.storageManager = new StorageManager();

// --- security.js ---
/**
 * SMART WEBRTC CLASSROOM - Security & Cryptographic Utilities Module
 * Implements CSPRNG session codes, Web Crypto SHA-256 hashing, safe filename sanitization,
 * XSS escaping, and compact signaling token compression.
 */

class SecurityManager {
  /**
   * Generates a cryptographically secure 6-digit classroom session code
   */
  static generateSessionCode(length = 6) {
    const chars = '0123456789';
    const randomBytes = new Uint8Array(length);
    window.crypto.getRandomValues(randomBytes);
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars[randomBytes[i] % chars.length];
    }
    return code;
  }

  /**
   * Generates a cryptographically secure UUID v4 string
   */
  static generateUUID() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    const buf = new Uint8Array(16);
    window.crypto.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * Computes SHA-256 hash of an ArrayBuffer using native Web Crypto API
   * @param {ArrayBuffer} buffer
   * @returns {Promise<string>} Hex representation of SHA-256 digest
   */
  static async computeSHA256(buffer) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Web Crypto API (subtle.digest) is not available in this browser environment.');
    }
    const digestBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(digestBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Sanitizes filenames to prevent directory traversal, control characters,
   * null bytes, and malicious script execution.
   */
  static sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') return 'unnamed_file';
    // Remove null bytes and path traversal patterns
    let clean = filename
      .replace(/\0/g, '')
      .replace(/\.\.+[/\\]/g, '')
      .replace(/[/\\]/g, '_')
      .trim();

    // Remove forbidden control characters
    clean = clean.replace(/[\x00-\x1f\x80-\x9f<>:"|?*]/g, '_');

    // Limit length to 120 characters
    if (clean.length > 120) {
      const extIndex = clean.lastIndexOf('.');
      if (extIndex > -1 && extIndex > clean.length - 10) {
        const ext = clean.substring(extIndex);
        clean = clean.substring(0, 110) + ext;
      } else {
        clean = clean.substring(0, 120);
      }
    }

    return clean || 'downloaded_file';
  }

  /**
   * Escapes untrusted text to safely prevent Cross-Site Scripting (XSS)
   */
  static escapeHTML(str) {
    if (str === null || str === undefined) return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return String(str).replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * Compresses an SDP or candidate object into a compact, URL-safe Base64 token
   * @param {object} data
   * @returns {string} Compact signaling token
   */
  static compressSignalToken(data) {
    try {
      const json = JSON.stringify(data);
      // Encode to UTF-8 bytes then Base64
      const utf8Bytes = new TextEncoder().encode(json);
      let binary = '';
      for (let i = 0; i < utf8Bytes.byteLength; i++) {
        binary += String.fromCharCode(utf8Bytes[i]);
      }
      const base64 = btoa(binary);
      // Prefix with SWC token marker
      return 'SWC1_' + base64;
    } catch (e) {
      console.error('[Security] Signal token compression failed:', e);
      throw new Error('Failed to encode signaling package: ' + e.message);
    }
  }

  /**
   * Decompresses a compact signaling token back into an SDP/candidate object
   * @param {string} token
   * @returns {object} Decompressed signaling data
   */
  static decompressSignalToken(token) {
    try {
      let raw = token.trim();
      if (raw.startsWith('SWC1_')) {
        raw = raw.substring(5);
      }
      const binary = atob(raw);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const json = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(json);
      return parsed;
    } catch (e) {
      // Try raw JSON parse if user pasted raw JSON
      try {
        return JSON.parse(token);
      } catch (jsonErr) {
        throw new Error('Invalid signaling token format. Ensure the entire token was copied correctly.');
      }
    }
  }

  /**
   * Encodes an ArrayBuffer into a Base64 string for universal firewall transport
   */
  static arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Decodes a Base64 string back into an ArrayBuffer
   */
  static base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

// Global exposure
window.SecurityManager = SecurityManager;