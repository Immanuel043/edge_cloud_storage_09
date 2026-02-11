import { Server as SocketIOServer, Socket } from 'socket.io';
import type { IncomingMessage } from 'http';
import type { SessionData } from 'express-session';

interface SocketRequest extends IncomingMessage {
  session?: SessionData & { userId?: string };
}

export function setupWebSocketHandlers(io: SocketIOServer): void {
  io.on('connection', (socket: Socket) => {
    socket.on('join-room', (userId: string) => {
      // Validate that the WebSocket connection belongs to the requesting user
      const req = socket.request as SocketRequest;
      const sessionUserId = req.session?.userId;

      if (!sessionUserId || sessionUserId !== userId) {
        socket.emit('error', { message: 'Unauthorized: session mismatch' });
        return;
      }

      socket.join(`user-${userId}`);
      socket.emit('joined', { room: `user-${userId}` });
    });

    socket.on('disconnect', () => {
      // No-op: cleanup handled by Socket.IO
    });
  });
}
