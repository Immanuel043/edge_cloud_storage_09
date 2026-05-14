/**
 * WebSocket Service
 *
 * Handles real-time WebSocket connections with:
 * - Automatic reconnection with exponential backoff
 * - Heartbeat/ping-pong mechanism
 * - Message queuing when disconnected
 * - Event emitter pattern for subscriptions
 * - Browser notification support
 */

import { API_URL, WS_URL, ZK_WS_URL, ZK_STORAGE } from '../config/constants';

// ==================== Type Definitions ====================

type WebSocketEventType =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'pong'
  | 'reconnect_failed'
  | 'connection'
  | 'notification'
  | 'upload_progress'
  | 'file_update'
  | 'file_uploaded'
  | 'file_deleted'
  | 'storage_update'
  | 'preview_ready'
  | 'message';

type WebSocketEventCallback = (data?: unknown) => void;

interface WebSocketServiceConfig {
  getToken?: (() => string | null | Promise<string | null>) | undefined;
}

interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

interface NotificationMessage extends WebSocketMessage {
  type: 'notification';
  event: string;
  data: Record<string, unknown>;
}


interface DisconnectedEvent {
  code: number;
  reason: string;
}

interface ConnectedEvent {
  timestamp: string;
}

interface ReconnectFailedEvent {
  attempts: number;
}

// ==================== WebSocket Service Class ====================

// Reconnect backoff tuning. The exponent does all the growth — DO NOT also
// double a separate delay field per attempt; that produces 4× growth and
// drives the cap-saturation point absurdly low (seen with a 5 min recovery
// from a Docker Desktop bounce). Schedule produced (no jitter):
// 0.5 s, 1 s, 2 s, 4 s, 8 s, 15 s, 15 s, …
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 15000;
// After this many fast-backoff attempts we degrade to a slow idle tier
// rather than giving up — a backgrounded tab or sleeping laptop should
// always eventually recover without the user reloading the page.
const RECONNECT_FAST_ATTEMPTS = 10;
const RECONNECT_IDLE_MS = 60000;

class WebSocketService {
  private ws: WebSocket | null;
  private reconnectAttempts: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null;
  private listeners: Map<string, Set<WebSocketEventCallback>>;
  public isConnected: boolean; // Made public for access from contexts
  private messageQueue: string[];
  private heartbeatInterval: ReturnType<typeof setInterval> | null;
  private pongTimeout: ReturnType<typeof setTimeout> | null;
  private awaitingPong: boolean;
  private pingIntervalMs: number;
  private pongTimeoutMs: number;
  private connectTimeoutMs: number;
  private connectPromise: Promise<void> | null;
  private connectPromiseResolve: (() => void) | null;
  private connectPromiseReject: ((error: Error) => void) | null;
  private manualClose: boolean;
  private lastToken: string | null;
  private getToken: (() => string | null | Promise<string | null>) | undefined;

  constructor({ getToken }: WebSocketServiceConfig = {}) {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.listeners = new Map();
    this.isConnected = false;
    this.messageQueue = [];
    this.heartbeatInterval = null;
    this.pongTimeout = null;
    this.awaitingPong = false;
    this.pingIntervalMs = 60000;
    this.pongTimeoutMs = 30000;
    this.connectTimeoutMs = 8000;
    this.connectPromise = null;
    this.connectPromiseResolve = null;
    this.connectPromiseReject = null;
    this.manualClose = false; // true when client intentionally closed
    this.lastToken = null;
    this.getToken = getToken; // optional function to retrieve a fresh token for reconnect

    // Listen for ZK mode changes and reconnect to the correct service
    window.addEventListener('zk-mode-changed', () => {
      console.log('[WebSocket] ZK mode changed, reconnecting to correct service...');
      if (this.isConnected) {
        this.disconnect();
        setTimeout(() => this.connect(), 500); // Small delay before reconnecting
      }
    });

    // Network and visibility recovery: a queued backoff timer can be many
    // seconds away when the network or tab comes back. Cancel it and
    // attempt immediately — connect() itself is no-op when already connected.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this._forceImmediateReconnect('network online'));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !this.isConnected) {
          this._forceImmediateReconnect('tab visible');
        }
      });
    }
  }

  private _forceImmediateReconnect(reason: string): void {
    if (this.manualClose) return;
    if (this.isConnected) return;
    console.log(`[WebSocket] ${reason} → forcing immediate reconnect`);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    void this.connect(this.lastToken);
  }

  private _makeWsUrl(_token: string | null): string {
    // Check if user is in ZK mode
    const isZKMode = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';

    // Use ZK WebSocket URL if in ZK mode, otherwise use Normal WebSocket URL
    let base = isZKMode ? ZK_WS_URL : (WS_URL || (API_URL ? API_URL.replace(/^http/, 'ws') : null));
    if (!base) throw new Error('No WS base URL configured (WS_URL or API_URL)');

    // Normalize: remove trailing slashes
    base = base.replace(/\/+$/, '');

    // ZK service uses /ws, Normal service uses /api/v1/ws
    // If base already includes /api/v1, we assume it also contains the path root; append /ws
    // Else append /api/v1/ws for Normal mode, /ws for ZK mode
    const hasApiV1 = /\/api\/v1$/i.test(base);
    const path = hasApiV1 ? '/ws' : (isZKMode ? '/ws' : '/api/v1/ws');

    console.log(`[WebSocket] Connecting to ${isZKMode ? 'ZK' : 'Normal'} service: ${base}${path}`);

    // SECURITY FIX: Don't put token in URL - send it in first message instead
    // Tokens in URLs can leak via browser history, logs, referrer headers
    return `${base}${path}`;
  }

  async connect(token: string | null = null): Promise<void> {
    // Prevent concurrent connects
    if (this.connectPromise) return this.connectPromise;

    // Allow getToken function to override passed token
    if (this.getToken && typeof this.getToken === 'function') {
      try {
        const maybeToken = await this.getToken();
        if (maybeToken) token = maybeToken;
      } catch (err) {
        console.warn('getToken threw error', err);
      }
    }

    this.manualClose = false;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectPromiseResolve = resolve;
      this.connectPromiseReject = reject;

      try {
        const wsUrl = this._makeWsUrl(token);
        this.ws = new WebSocket(wsUrl);

        const timeoutHandle = setTimeout(() => {
          const err = new Error('WebSocket connect timeout');
          console.error(err);
          // cleanup partial ws
          try {
            this.ws?.close();
          } catch (_e) {
            /* ignore */
          }
          this._cleanUpWs();
          this.connectPromiseReject?.(err);
          this.connectPromise = null;
        }, this.connectTimeoutMs);

        this.ws.onopen = () => {
          clearTimeout(timeoutHandle);
          console.info('WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.awaitingPong = false;
          this.lastToken = token;

          // SECURITY FIX: Send auth token in first message (not in URL)
          if (token) {
            this.send({ type: 'auth', token: token });
          }

          this.startHeartbeat();
          this.flushMessageQueue();

          this.emit('connected', { timestamp: new Date().toISOString() } as ConnectedEvent);
          this.connectPromiseResolve?.();
          this.connectPromise = null;
        };

        this.ws.onmessage = (event: MessageEvent) => {
          // Defensive: non-JSON allowed
          let message: unknown = null;
          try {
            message = JSON.parse(event.data as string);
          } catch {
            message = event.data;
          }

          // handle pong
          if (
            message &&
            typeof message === 'object' &&
            (message as WebSocketMessage).type === 'pong'
          ) {
            this.awaitingPong = false;
            if (this.pongTimeout) {
              clearTimeout(this.pongTimeout);
              this.pongTimeout = null;
            }
            this.emit('pong', message);
            return;
          }

          try {
            this.handleMessage(message as WebSocketMessage);
          } catch (err) {
            console.error('Error handling ws message', err);
          }
        };

        this.ws.onerror = (error: Event) => {
          console.error('WebSocket error:', error);
          this.emit('error', error);
        };

        this.ws.onclose = (event: CloseEvent) => {
          clearTimeout(timeoutHandle);
          console.log('WebSocket closed', event.code, event.reason);
          this.isConnected = false;
          this.stopHeartbeat();
          this._cleanUpWs();
          this.emit('disconnected', { code: event.code, reason: event.reason } as DisconnectedEvent);

          // If manually closed (logout), do not attempt reconnect
          if (this.manualClose) {
            return;
          }

          // Close codes 1000 and 1001 -> normal/going away; but still attempt reconnect for resilience
          this.reconnect(token);
        };
      } catch (error) {
        console.error('Failed to initialize WebSocket:', error);
        this.connectPromiseReject?.(error as Error);
        this.connectPromise = null;
      }
    });

    return this.connectPromise;
  }

  private reconnect(prevToken: string | null = null): void {
    if (this.manualClose) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempts += 1;

    // After the fast-backoff budget, fall back to a steady idle retry rather
    // than emitting reconnect_failed and going silent. Keep emitting the
    // event the first time we cross the threshold so any listener can know.
    let delay: number;
    if (this.reconnectAttempts > RECONNECT_FAST_ATTEMPTS) {
      delay = RECONNECT_IDLE_MS;
      if (this.reconnectAttempts === RECONNECT_FAST_ATTEMPTS + 1) {
        console.warn(
          `WebSocket: fast-backoff budget exhausted after ${RECONNECT_FAST_ATTEMPTS} attempts; ` +
          `falling back to ${RECONNECT_IDLE_MS}ms idle retries`,
        );
        this.emit('reconnect_failed', {
          attempts: this.reconnectAttempts,
        } as ReconnectFailedEvent);
      }
    } else {
      // Single-source exponential: exponent does the growth, no second doubling.
      const exp = this.reconnectAttempts - 1;
      const base = Math.min(RECONNECT_BASE_MS * 2 ** exp, RECONNECT_CAP_MS);
      const jitter = Math.random() * 500; // small jitter to avoid thundering herd
      delay = base + jitter;
    }

    console.log(
      `WebSocket reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay)}ms`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // Allow getToken to refresh token if provided
      let token = prevToken ?? this.lastToken;
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
        // onclose will fire and schedule the next attempt; nothing to do here.
      }
    }, delay);
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client disconnect');
      } catch (_e) {
        /* ignore */
      }
    }
    this._cleanUpWs();
    this.isConnected = false;
    this.stopHeartbeat();
    this.emit('disconnected', {
      code: 1000,
      reason: 'client_disconnect',
    } as DisconnectedEvent);
  }

  private _cleanUpWs(): void {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    // do not clear messageQueue — keep queued messages for next connect
    this.connectPromise = null;
    this.connectPromiseResolve = null;
    this.connectPromiseReject = null;
  }

  send(obj: WebSocketMessage | string): void {
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

  private flushMessageQueue(): void {
    while (
      this.messageQueue.length > 0 &&
      this.isConnected &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      const next = this.messageQueue.shift();
      if (!next) continue;

      try {
        this.ws.send(next);
      } catch (err) {
        console.warn('Failed to flush message, re-queueing', err);
        this.messageQueue.unshift(next);
        break;
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (!this.isConnected) return;

      if (this.awaitingPong) {
        console.warn('No pong received -> force reconnect');
        // try force close to trigger reconnect logic
        try {
          this.ws?.close();
        } catch (_e) {
          /* ignore */
        }
        return;
      }

      this.awaitingPong = true;
      this.send({ type: 'ping' });

      // Set a timeout for pong response
      this.pongTimeout = setTimeout(() => {
        if (this.awaitingPong) {
          console.warn('Pong timeout -> force reconnect');
          this.awaitingPong = false;
          try {
            this.ws?.close();
          } catch (_e) {
            /* ignore */
          }
        }
      }, this.pongTimeoutMs);
    }, this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.awaitingPong = false;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private handleMessage(message: WebSocketMessage | unknown): void {
    if (!message) return;
    if (typeof message !== 'object') return;

    const { type } = message as WebSocketMessage;

    switch (type) {
      case 'connection':
        this.emit('connection', message);
        break;
      case 'notification':
        this.handleNotification(message as NotificationMessage);
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

  private handleNotification(message: NotificationMessage): void {
    const { event, data } = message;
    switch (event) {
      case 'file_uploaded':
        this.emit('file_uploaded', data);
        this.showNotification(
          'File Uploaded',
          `${(data as Record<string, string>).file_name || 'File'} uploaded`
        );
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

  private showNotification(title: string, body: string, _level: string = 'info'): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    try {
      if (Notification.permission === 'granted') {
        new Notification(title, { body, tag: 'edge-cloud' });
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
  on(event: WebSocketEventType | string, callback: WebSocketEventCallback): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  off(event: WebSocketEventType | string, callback: WebSocketEventCallback): void {
    const s = this.listeners.get(event);
    if (!s) return;
    s.delete(callback);
    if (s.size === 0) this.listeners.delete(event);
  }

  private emit(event: WebSocketEventType | string, data?: unknown): void {
    const s = this.listeners.get(event);
    if (!s) return;
    for (const cb of Array.from(s)) {
      try {
        cb(data);
      } catch (err) {
        console.error('Listener error', err);
      }
    }
  }

  // Convenience helpers
  subscribeToChannel(channel: string): void {
    this.send({ type: 'subscribe', channel });
  }

  unsubscribeFromChannel(channel: string): void {
    this.send({ type: 'unsubscribe', channel });
  }

  sendUploadProgress(fileId: string, progress: number): void {
    this.send({ type: 'upload_progress', file_id: fileId, progress });
  }

  sendFileOperation(operation: string, fileId: string): void {
    this.send({ type: 'file_operation', operation, file_id: fileId });
  }
}

// Export singleton with optional token getter
// SECURITY FIX: No longer reading from localStorage (using HTTP-only cookies)
export const websocketService = new WebSocketService({
  getToken: () => null, // Token handled by cookies
});

export default websocketService;
