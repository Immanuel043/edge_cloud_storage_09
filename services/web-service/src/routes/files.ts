import { Router } from 'express';
import { FileController } from '../controllers/fileController';
import { requireAuth } from '../middleware/auth';

export function createFileRoutes(storageServiceUrl: string): Router {
  const router = Router();
  const fileController = new FileController(storageServiceUrl);

  router.get('/', requireAuth, (req, res) => {
    void fileController.listFiles(req, res);
  });
  router.get('/:fileId/download', requireAuth, (req, res) => {
    void fileController.downloadFile(req as Parameters<typeof fileController.downloadFile>[0], res);
  });
  router.delete('/:fileId', requireAuth, (req, res) => {
    void fileController.deleteFile(req as Parameters<typeof fileController.deleteFile>[0], res);
  });
  router.post('/:fileId/copy', requireAuth, (req, res) => {
    void fileController.copyFile(req as Parameters<typeof fileController.copyFile>[0], res);
  });
  router.get('/:fileId/preview', requireAuth, (req, res) => {
    void fileController.previewFile(req as Parameters<typeof fileController.previewFile>[0], res);
  });

  return router;
}
