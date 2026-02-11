import { Request, Response } from 'express';
import axios, { AxiosResponse } from 'axios';

const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FileController {
  constructor(private storageServiceUrl: string) {}

  async listFiles(req: Request, res: Response): Promise<void> {
    const userId = req.session?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      const response = await axios.get(
        `${this.storageServiceUrl}/api/v1/files`,
        {
          headers: { 'X-User-Id': userId },
          timeout: 30000
        }
      );

      res.json(response.data);
    } catch (error) {
      console.error('List files error:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Failed to list files' });
    }
  }

  async downloadFile(req: Request<{ fileId: string }>, res: Response): Promise<void> {
    const { fileId } = req.params;
    const userId = req.session?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!FILE_ID_PATTERN.test(fileId)) {
      res.status(400).json({ error: 'Invalid file ID format' });
      return;
    }

    try {
      const response: AxiosResponse = await axios.get(
        `${this.storageServiceUrl}/api/v1/files/${fileId}/download`,
        {
          responseType: 'stream',
          headers: { 'X-User-Id': userId },
          timeout: 120000
        }
      );

      // Forward headers
      res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }
      if (response.headers['content-disposition']) {
        res.setHeader('Content-Disposition', response.headers['content-disposition']);
      }

      // Stream to client
      response.data.pipe(res);
    } catch (error) {
      console.error('Download error:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Failed to download file' });
    }
  }

  async deleteFile(req: Request<{ fileId: string }>, res: Response): Promise<void> {
    const { fileId } = req.params;
    const userId = req.session?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!FILE_ID_PATTERN.test(fileId)) {
      res.status(400).json({ error: 'Invalid file ID format' });
      return;
    }

    try {
      const response = await axios.delete(
        `${this.storageServiceUrl}/api/v1/files/${fileId}`,
        {
          headers: { 'X-User-Id': userId },
          timeout: 30000
        }
      );

      res.json(response.data);
    } catch (error) {
      console.error('Delete error:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Failed to delete file' });
    }
  }

  async copyFile(req: Request<{ fileId: string }>, res: Response): Promise<void> {
    const { fileId } = req.params;
    const userId = req.session?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!FILE_ID_PATTERN.test(fileId)) {
      res.status(400).json({ error: 'Invalid file ID format' });
      return;
    }

    try {
      const response = await axios.post(
        `${this.storageServiceUrl}/api/v1/files/${fileId}/copy`,
        {},
        {
          headers: { 'X-User-Id': userId },
          timeout: 30000
        }
      );

      res.json(response.data);
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: { detail?: string } } };
      const status = axiosError.response?.status || 500;
      // Log detailed error server-side, return generic message to client
      console.error('Copy file error:', axiosError.response?.data?.detail || (error instanceof Error ? error.message : error));
      res.status(status).json({ error: 'Failed to copy file' });
    }
  }

  async previewFile(req: Request<{ fileId: string }, unknown, unknown, { size?: string }>, res: Response): Promise<void> {
    const { fileId } = req.params;
    const { size } = req.query;
    const userId = req.session?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!FILE_ID_PATTERN.test(fileId)) {
      res.status(400).json({ error: 'Invalid file ID format' });
      return;
    }

    try {
      const response = await axios.get(
        `${this.storageServiceUrl}/api/v1/files/${fileId}/preview`,
        {
          params: { size },
          headers: { 'X-User-Id': userId },
          responseType: 'arraybuffer',
          timeout: 30000
        }
      );

      // Forward the image response
      res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', response.headers['cache-control'] || 'public, max-age=2592000');
      if (response.headers['x-cache']) {
        res.set('X-Cache', response.headers['x-cache']);
      }
      res.send(response.data);
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number } };
      const status = axiosError.response?.status || 500;
      console.error('Preview error:', error instanceof Error ? error.message : error);

      if (status === 404) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      res.status(status).json({ error: 'Failed to load preview' });
    }
  }
}
