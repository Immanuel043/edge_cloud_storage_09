import { Server as SocketIOServer, Socket } from 'socket.io';

export function setupWebSocketHandlers(io: SocketIOServer): void {
  io.on('connection', (socket: Socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('join-room', (userId: string) => {
      socket.join(`user-${userId}`);
      socket.emit('joined', { room: `user-${userId}` });
    });
    
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });
}
