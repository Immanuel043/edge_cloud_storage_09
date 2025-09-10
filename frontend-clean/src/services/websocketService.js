// services/websocketService.js
import { API_URL, WS_URL, ENDPOINTS } from '../config/constants';

class WebSocketService {
  constructor({ getToken } = {}) {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.listeners = new Map();
    this.isConnected = false;
    this.messageQueue = [];
    this.heartbeatInterval = null;
    this.awaitingPong = false;
    this.pingIntervalMs = 30000;
    this.connectTimeoutMs = 15000;
    this.connectPromise = null;
    this.connectPromiseResolve = null;
    this.connectPromiseReject = null;
    this.manualClose = false; // true when client intentionally closed
    this.getToken = getToken; // optional function to retrieve a fresh token for reconnect
  }

  _makeWsUrl(token) {
  // Prefer explicit WS_URL; fall back to API_URL transformed to ws
  let base = (typeof WS_URL !== 'undefined' && WS_URL) ? WS_URL : (API_URL ? API_URL.replace(/^http/, 'ws') : null);
  if (!base) throw new Error('No WS base URL configured (WS_URL or API_URL)');

  // Normalize: remove trailing slashes
  base = base.replace(/\/+$/, '');

  // If base already includes /api/v1, we assume it also contains the path root; append /ws
  // Else append /api/v1/ws
  const hasApiV1 = /\/api\/v1$/i.test(base);
  const path = hasApiV1 ? '/ws' : '/api/v1/ws';

  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}${path}${tokenQuery}`;
}

  connect(token = null) {
    // Prevent concurrent connects
    if (this.connectPromise) return this.connectPromise;

    // Allow getToken function to override passed token
    if (this.getToken && typeof this.getToken === 'function') {
      try {
        const maybeToken = this.getToken();
        if (maybeToken) token = maybeToken;
      } catch (err) {
        console.warn('getToken threw error', err);
      }
    }

    this.manualClose = false;

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectPromiseResolve = resolve;
      this.connectPromiseReject = reject;

      try {
        const wsUrl = this._makeWsUrl(token);
        this.ws = new WebSocket(wsUrl);

        const timeoutHandle = setTimeout(() => {
          const err = new Error('WebSocket connect timeout');
          console.error(err);
          // cleanup partial ws
          try { this.ws.close(); } catch (e) {}
          this._cleanUpWs();
          this.connectPromiseReject?.(err);
          this.connectPromise = null;
        }, this.connectTimeoutMs);

        this.ws.onopen = () => {
          clearTimeout(timeoutHandle);
          console.info('WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          this.awaitingPong = false;

          this.startHeartbeat();
          this.flushMessageQueue();

          this.emit('connected', { timestamp: new Date().toISOString() });
          this.connectPromiseResolve();
          this.connectPromise = null;
        };

        this.ws.onmessage = (event) => {
          // Defensive: non-JSON allowed
          let message = null;
          try {
            message = JSON.parse(event.data);
          } catch {
            message = event.data;
          }

          // handle pong
          if (message && message.type === 'pong') {
            this.awaitingPong = false;
            this.emit('pong', message);
            return;
          }

          try {
            this.handleMessage(message);
          } catch (err) {
            console.error('Error handling ws message', err);
          }
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          this.emit('error', error);
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeoutHandle);
          console.log('WebSocket closed', event.code, event.reason);
          this.isConnected = false;
          this.stopHeartbeat();
          this._cleanUpWs();
          this.emit('disconnected', { code: event.code, reason: event.reason });

          // If manually closed (logout), do not attempt reconnect
          if (this.manualClose) {
            return;
          }

          // Close codes 1000 and 1001 -> normal/going away; but still attempt reconnect for resilience
          this.reconnect(token);
        };
      } catch (error) {
        console.error('Failed to initialize WebSocket:', error);
        this.connectPromiseReject?.(error);
        this.connectPromise = null;
      }
    });

    return this.connectPromise;
  }

  reconnect(prevToken = null) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      this.emit('reconnect_failed', { attempts: this.reconnectAttempts });
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(this.reconnectDelay * 2 ** (this.reconnectAttempts - 1), 30000);
    console.log(`WebSocket reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

    setTimeout(async () => {
      // Allow getToken to refresh token if provided
      let token = prevToken;
      if (this.getToken) {
        try {
          const maybe = await this.getToken();
          if (maybe) token = maybe;
        } catch (err) {
          console.warn('getToken during reconnect failed', err);
        }
      }

      try {
        await this.connect(token);
      } catch (err) {
        console.error('Reconnect failed:', err);
        // Will try again in next scheduled reconnect if allowed
      }
    }, delay);

    // cap reconnect delay growth (no unbounded growth)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  disconnect() {
    this.manualClose = true;
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client disconnect');
      } catch (e) { /* ignore */ }
    }
    this._cleanUpWs();
    this.isConnected = false;
    this.stopHeartbeat();
    this.emit('disconnected', { code: 1000, reason: 'client_disconnect' });
  }

  _cleanUpWs() {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
      } catch {}
      this.ws = null;
    }
    // do not clear messageQueue — keep queued messages for next connect
    this.connectPromise = null;
    this.connectPromiseResolve = null;
    this.connectPromiseReject = null;
  }

  send(obj) {
    const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(payload);
      } catch (err) {
        console.warn('Send failed, queueing message', err);
        this.messageQueue.push(payload);
      }
    } else {
      this.messageQueue.push(payload);
      console.debug('WebSocket not open — queued message');
    }
  }

  flushMessageQueue() {
    while (this.messageQueue.length > 0 && this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const next = this.messageQueue.shift();
      try {
        this.ws.send(next);
      } catch (err) {
        console.warn('Failed to flush message, re-queueing', err);
        this.messageQueue.unshift(next);
        break;
      }
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (!this.isConnected) return;
      if (this.awaitingPong) {
        console.warn('No pong received -> force reconnect');
        // try force close to trigger reconnect logic
        try { this.ws.close(); } catch (e) {}
        return;
      }
      this.awaitingPong = true;
      this.send({ type: 'ping' });
    }, this.pingIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.awaitingPong = false;
    }
  }

  handleMessage(message) {
    if (!message) return;
    const { type } = message;

    switch (type) {
      case 'connection':
        this.emit('connection', message);
        break;
      case 'notification':
        this.handleNotification(message);
        break;
      case 'upload_progress':
        this.emit('upload_progress', message);
        break;
      case 'file_update':
        this.emit('file_update', message);
        break;
      default:
        // Emit raw message to listeners keyed by type, and also emit 'message' generic event
        if (type) this.emit(type, message);
        this.emit('message', message);
    }
  }

  handleNotification(message) {
    const { event, data } = message;
    switch (event) {
      case 'file_uploaded':
        this.emit('file_uploaded', data);
        this.showNotification('File Uploaded', `${data.file_name} uploaded`);
        break;
      case 'file_deleted':
        this.emit('file_deleted', data);
        break;
      case 'storage_update':
        this.emit('storage_update', data);
        break;
      default:
        this.emit('notification', message);
    }
  }

  showNotification(title, body, level = 'info') {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    try {
      if (Notification.permission === 'granted') {
        new Notification(title, { body, tag: 'edge-cloud', renotify: true });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') {
            new Notification(title, { body });
          }
        });
      }
    } catch (err) {
      console.warn('Notification failed', err);
    }
  }

  // Event emitter
  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const s = this.listeners.get(event);
    if (!s) return;
    s.delete(callback);
    if (s.size === 0) this.listeners.delete(event);
  }

  emit(event, data) {
    const s = this.listeners.get(event);
    if (!s) return;
    for (const cb of Array.from(s)) {
      try { cb(data); } catch (err) { console.error('Listener error', err); }
    }
  }

  // Convenience helpers
  subscribeToChannel(channel) {
    this.send({ type: 'subscribe', channel });
  }
  unsubscribeFromChannel(channel) {
    this.send({ type: 'unsubscribe', channel });
  }
  sendUploadProgress(fileId, progress) {
    this.send({ type: 'upload_progress', file_id: fileId, progress });
  }
  sendFileOperation(operation, fileId) {
    this.send({ type: 'file_operation', operation, file_id: fileId });
  }
}

// Export singleton with optional token getter
// If you have refresh tokens or async token retrieval, pass { getToken: async () => ... }
export const websocketService = new WebSocketService({
  getToken: () => localStorage.getItem('token') || null
});
