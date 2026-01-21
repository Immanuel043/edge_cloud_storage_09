import { Router } from 'express';
import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { Producer } from 'kafkajs';
import { UploadController } from '../controllers/uploadController';
import { upload } from '../middleware/upload';
import { requireAuth } from '../middleware/auth';

export function createUploadRoutes(
  storageServiceUrl: string,
  redisCache: Redis,
  io: SocketIOServer,
  kafkaProducer: Producer | null
): Router {
  const router = Router();
  const uploadController = new UploadController(storageServiceUrl, redisCache, io, kafkaProducer);

  router.post('/init', requireAuth, (req, res) => {
    void uploadController.initUpload(req as Parameters<typeof uploadController.initUpload>[0], res);
  });
  router.post('/chunk/:uploadId/:chunkIndex', requireAuth, upload.single('chunk'), (req, res) => {
    void uploadController.uploadChunk(req as Parameters<typeof uploadController.uploadChunk>[0], res);
  });
  router.post('/complete/:uploadId', requireAuth, (req, res) => {
    void uploadController.completeUpload(req as Parameters<typeof uploadController.completeUpload>[0], res);
  });

  return router;
}
