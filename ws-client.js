// ws-client.js - WebSocket 客户端封装

import WebSocket from 'ws';
import zlib from 'zlib';
import { CONSTANTS } from './game-state.js';

export class WSClient {
  constructor(userId, token, onMessage, onStatus) {
    this.userId = userId;
    this.token = token;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.manualDisconnect = false;
    this.lastSnapshotAt = 0;
    this.watchdogTimer = null;
  }

  connect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }

    this.manualDisconnect = false;
    const url = `wss://grasp-rat-game.h-e.top/ws?user_id=${encodeURIComponent(this.userId)}&token=${encodeURIComponent(this.token)}&compress=`;
    this.onStatus('connecting');

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.lastSnapshotAt = Date.now();
      this.onStatus('ws online');
      this._startWatchdog();
    });

    ws.on('message', async (data) => {
      try {
        const text = await this._inflate(data);
        const msg = JSON.parse(text);
        this.lastSnapshotAt = Date.now();
        this.onMessage(msg);
      } catch (err) {
        this.onStatus('ws decode failed: ' + err.message);
      }
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.onStatus('ws closed');
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.onStatus('ws error: ' + err.message);
      this._scheduleReconnect();
    });
  }

  disconnect() {
    this.manualDisconnect = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) ws.close();
  }

  send(cmd) {
    if (this.ws && this.connected) {
      this.ws.send(cmd);
    }
  }

  sendVel(dx, dy) {
    this.send(`vel ${dx} ${dy}`);
  }

  shoot(targetX, targetY, startX, startY) {
    this.send(`shoot ${Math.round(targetX)} ${Math.round(targetY)} ${Math.round(startX)} ${Math.round(startY)}`);
  }

  teleport(x, y) {
    this.send(`tp ${Math.round(x)} ${Math.round(y)}`);
  }

  chat(msg) {
    this.send(`chat ${msg}`);
  }

  async _inflate(data) {
    if (typeof data === 'string') return data;
    // Node.js ws library delivers binary as Buffer
    const bytes = Buffer.isBuffer(data) ? data : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer || data);

    // Check for custom compression header: GRZ1 + algId
    if (bytes.length >= 5 && bytes[0] === 0x47 && bytes[1] === 0x52 && bytes[2] === 0x5a && bytes[3] === 0x31) {
      const algId = bytes[4];
      const compressed = bytes.slice(5);
      try {
        if (algId === 1) {
          return zlib.gunzipSync(compressed).toString('utf-8');
        } else if (algId === 2) {
          return zlib.inflateSync(compressed).toString('utf-8');
        } else if (algId === 3) {
          return zlib.zstdDecompressSync(compressed).toString('utf-8');
        }
      } catch (e) {
        // fallback to raw text
      }
    }

    return bytes.toString('utf-8');
  }

  _scheduleReconnect() {
    if (this.manualDisconnect || !this.userId || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected && this.userId) {
        this.onStatus('reconnecting...');
        this.connect();
      }
    }, 1200);
  }

  _startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (this.manualDisconnect || !this.connected) return;
      const staleFor = Date.now() - this.lastSnapshotAt;
      if (this.lastSnapshotAt && staleFor > 5000) {
        this.onStatus('ws stale, reconnecting');
        try { this.ws.close(); } catch {}
        this.connected = false;
        this._scheduleReconnect();
      }
    }, 2000);
  }
}
