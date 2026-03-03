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

class WebSocketService {
  private ws: WebSocket | null;
  private reconnectAttempts: number;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
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
  private getToken: (() => string | null | Promise<string | null>) | undefined;

  constructor({ getToken }: WebSocketServiceConfig = {}) {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.listeners = new Map();
    this.isConnected = false;
    this.messageQueue = [];
    this.heartbeatInterval = null;
    this.pongTimeout = null;
    this.awaitingPong = false;
    this.pingIntervalMs = 60000;
    this.pongTimeoutMs = 30000;
    this.connectTimeoutMs = 30000;
    this.connectPromise = null;
    this.connectPromiseResolve = null;
    this.connectPromiseReject = null;
    this.manualClose = false; // true when client intentionally closed
    this.getToken = getToken; // optional function to retrieve a fresh token for reconnect

    // Listen for ZK mode changes and reconnect to the correct service
    window.addEventListener('zk-mode-changed', () => {
      console.log('[WebSocket] ZK mode changed, reconnecting to correct service...');
      if (this.isConnected) {
        this.disconnect();
        setTimeout(() => this.connect(), 500); // Small delay before reconnecting
      }
    });
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
          this.reconnectDelay = 1000;
          this.awaitingPong = false;

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
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      this.emit('reconnect_failed', { attempts: this.reconnectAttempts } as ReconnectFailedEvent);
      return;
    }

    this.reconnectAttempts += 1;

    // PERFORMANCE FIX: Add jitter to prevent thundering herd problem
    const jitter = Math.random() * 1000; // 0-1000ms random jitter
    const baseDelay = this.reconnectDelay * 2 ** (this.reconnectAttempts - 1);
    const delay = Math.min(baseDelay + jitter, 30000);

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

  disconnect(): void {
    this.manualClose = true;
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
