import { Request, Response } from 'express';
import axios from 'axios';
import type { ShareRequest } from '../types/api';

const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ShareController {
  constructor(private storageServiceUrl: string) {}

  async shareFile(
    req: Request<{ fileId: string }, unknown, ShareRequest>,
    res: Response
  ): Promise<void> {
    const { fileId } = req.params;
    const { expiresHours, password, maxDownloads } = req.body;
    const userId = req.session?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!FILE_ID_PATTERN.test(fileId)) {
      res.status(400).json({ error: 'Invalid file ID format' });
      return;
    }

    // Validate optional fields
    if (expiresHours !== undefined && (typeof expiresHours !== 'number' || expiresHours <= 0)) {
      res.status(400).json({ error: 'expiresHours must be a positive number' });
      return;
    }

    if (maxDownloads !== undefined && (typeof maxDownloads !== 'number' || maxDownloads <= 0 || !Number.isInteger(maxDownloads))) {
      res.status(400).json({ error: 'maxDownloads must be a positive integer' });
      return;
    }

    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      res.status(400).json({ error: 'password must be a string of at least 8 characters' });
      return;
    }

    try {
      const response = await axios.post(
        `${this.storageServiceUrl}/api/v1/files/${fileId}/share`,
        {
          expires_hours: expiresHours,
          password: password,
          max_downloads: maxDownloads
        },
        {
          headers: { 'X-User-Id': userId },
          timeout: 30000
        }
      );

      res.json(response.data);
    } catch (error) {
      console.error('Share error:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Failed to create share link' });
    }
  }
}
