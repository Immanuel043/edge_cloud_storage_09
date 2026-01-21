import { Request, Response } from 'express';
import axios from 'axios';
import type { ShareRequest } from '../types/api';

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

    try {
      const response = await axios.post(
        `${this.storageServiceUrl}/api/v1/files/${fileId}/share`,
        {
          expires_hours: expiresHours,
          password: password,
          max_downloads: maxDownloads
        },
        {
          headers: {
            'X-User-Id': userId
          }
        }
      );

      res.json(response.data);
    } catch (error) {
      console.error('Share error:', error);
      res.status(500).json({ error: 'Failed to create share link' });
    }
  }
}
