
/**
 * SMART WEBRTC CLASSROOM - WebRTC & Network Configuration
 * Production configuration for GitHub Pages & Hosted Node.js Backend.
 * Supports dynamic STUN/TURN traversal, local LAN priority, and adaptive screen presets.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SmartClassroomConfig = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Production Render Backend
  const DEFAULT_BACKEND_URL = 'https://smart-webrtc-classroom.onrender.com';

  const config = {
    DEFAULT_BACKEND_URL,

    /**
     * Resolves the active backend URL:
     * 1. Manual override from localStorage.
     * 2. Local Node.js server when running locally.
     * 3. Render backend for GitHub Pages and production.
     */
    getBackendUrl: function () {
      if (typeof window === 'undefined') {
        return DEFAULT_BACKEND_URL;
      }

      try {
        const stored = localStorage.getItem('swc_backend_url');

        if (stored && stored.trim()) {
          return stored.trim().replace(/\/+$/, '');
        }
      } catch (e) {}

      if (window.location && window.location.hostname) {
        const host = window.location.hostname.toLowerCase();

        const isLocal =
          host === 'localhost' ||
          host === '127.0.0.1' ||
          host.startsWith('192.168.') ||
          host.startsWith('10.') ||
          host.endsWith('.local');

        // Local Node.js server
        if (isLocal && window.location.port) {
          return `${window.location.protocol}//${window.location.host}`;
        }

        // GitHub Pages and other hosted production websites
        return DEFAULT_BACKEND_URL;
      }

      return DEFAULT_BACKEND_URL;
    },

    /**
     * Resolves the active WebSocket signaling URL.
     * HTTPS automatically becomes WSS.
     */
    getWebSocketUrl: function () {
      const httpUrl = this.getBackendUrl();

      if (!httpUrl || !httpUrl.trim()) {
        return null;
      }

      const wsProto = httpUrl.startsWith('https:') ? 'wss:' : 'ws:';

      const cleanHost = httpUrl
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');

      return `${wsProto}//${cleanHost}/ws`;
    },

    setBackendUrl: function (url) {
      if (!url) return;

      try {
        localStorage.setItem(
          'swc_backend_url',
          url.trim().replace(/\/+$/, '')
        );
      } catch (e) {}
    },

    resetBackendUrl: function () {
      try {
        localStorage.removeItem('swc_backend_url');
      } catch (e) {}
    },

    // High-Reliability STUN Servers (Zero Auth, Instant Cross-Network Traversal)
    DEFAULT_ICE_SERVERS: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ],

    updateIceServersFromBackend: function (servers) {
      if (Array.isArray(servers) && servers.length > 0) {
        this.DEFAULT_ICE_SERVERS = servers;
        console.log(
          '[Config] Dynamic ICE servers updated from backend:',
          servers
        );
      }
    },

    // Timeouts and Watchdogs (Milliseconds)
    TIMEOUTS: {
      ICE_GATHERING_TIMEOUT: 2500,
      CANDIDATE_PAIR_TIMEOUT: 8000,
      WATCHDOG_INTERVAL: 2000,
      RECONNECT_DELAY_INITIAL: 1000,
      RECONNECT_DELAY_MAX: 15000,
      HEARTBEAT_INTERVAL: 15000,
      APPROVAL_TIMEOUT: 90000
    },

    // File Transfer Configuration
    FILE_TRANSFER: {
      CHUNK_SIZE: 16384,
      BUFFER_THRESHOLD: 65536,
      MAX_FILE_SIZE_BYTES: 500 * 1024 * 1024,
      HASH_ALGORITHM: 'SHA-256'
    },

    // Screen Share Quality Presets
    SCREEN_PRESETS: {
      low: {
        label: 'Low Bandwidth (720p 15 FPS - 800 kbps)',
        width: 1280,
        height: 720,
        frameRate: 15,
        maxBitrate: 800000
      },
      balanced: {
        label: 'Balanced (1080p 30 FPS - 2.5 Mbps)',
        width: 1920,
        height: 1080,
        frameRate: 30,
        maxBitrate: 2500000
      },
      high: {
        label: 'High Quality (1080p 60 FPS - 5.0 Mbps)',
        width: 1920,
        height: 1080,
        frameRate: 60,
        maxBitrate: 5000000
      },
      max: {
        label: 'Max Detail (4K 60 FPS - 10.0 Mbps Gigabit LAN)',
        width: 3840,
        height: 2160,
        frameRate: 60,
        maxBitrate: 10000000
      }
    },

    // Connection Classification Labels
    CONNECTION_TYPES: {
      DIRECT_LAN: {
        code: 'DIRECT_LAN',
        label: 'Direct Local LAN Route',
        badgeClass: 'badge-lan',
        description:
          'Both peers communicate directly over the local network switch/Wi-Fi (lowest latency, zero internet data).'
      },
      DIRECT_P2P: {
        code: 'DIRECT_P2P',
        label: 'Direct Internet P2P',
        badgeClass: 'badge-direct',
        description: 'Direct peer connection negotiated via STUN NAT traversal.'
      },
      STUN_ASSISTED: {
        code: 'STUN_ASSISTED',
        label: 'STUN Assisted P2P',
        badgeClass: 'badge-stun',
        description: 'Public reflexive candidates connected peer-to-peer across separate networks.'
      },
      TURN_RELAY: {
        code: 'TURN_RELAY',
        label: 'TURN Encrypted Relay',
        badgeClass: 'badge-turn',
        description:
          'Direct routing blocked by strict firewall/symmetric NAT; media is securely relayed via TURN.'
      },
      PENDING: {
        code: 'PENDING',
        label: 'Connecting WebRTC...',
        badgeClass: 'badge-pending',
        description:
          'Negotiating ICE candidates and establishing peer connection.'
      },
      FAILED: {
        code: 'FAILED',
        label: 'Connection Failed',
        badgeClass: 'badge-failed',
        description:
          'Could not establish media channel. Please check network/firewall permissions.'
      }
    }
  };

  return config;
});
