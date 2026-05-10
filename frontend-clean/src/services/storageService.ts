/**
 * Storage Service - Normal Mode File Operations
 *
 * This service handles file/folder metadata operations for normal (non-ZK) mode.
 *
 * For uploads and downloads, use the dedicated services:
 * - Uploads: normalUploadService or zkUploadService
 * - Downloads: normalDownloadService or zkStorageService
 */

import { API_URL } from '../config/constants';
import { sanitizeInput } from '../utils/security';
import { rateLimiter } from '../utils/rateLimiter';
import { requestCache } from '../utils/requestCache';

// ==================== Storage Service ====================

class StorageService {
  constructor() {
    // No longer needs downloadManager - use normalDownloadService instead
  }

  // ==================== FILE/FOLDER LISTING ====================

  async getFiles(_token: string, folderId: string | null = null): Promise<unknown> {
    await rateLimiter.checkLimit();

    const cacheKey = `files-${folderId || 'root'}`;
    return requestCache.dedupe(
      cacheKey,
      async () => {
        const url = `${API_URL}/api/v1/files${folderId ? `?folder_id=${folderId}` : ''}`;
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load files');
        return await response.json();
      },
      { useCache: true, ttl: 3000 }
    );
  }

  async getFolders(_token: string, parentId: string | null = null): Promise<unknown> {
    await rateLimiter.checkLimit();

    const cacheKey = `folders-${parentId || 'root'}`;
    return requestCache.dedupe(
      cacheKey,
      async () => {
        const url = `${API_URL}/api/v1/folders${parentId ? `?parent_id=${parentId}` : ''}`;
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load folders');
        return await response.json();
      },
      { useCache: true, ttl: 3000 }
    );
  }

  // ==================== FILE OPERATIONS ====================

  async deleteFile(_token: string, fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/files/${fileId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to delete file');
    return await response.json();
  }

  async renameFile(_token: string, fileId: string, newName: string): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: sanitizeInput(newName) }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to rename file');
    }
    return await response.json();
  }

  async createFolder(_token: string, name: string, parentId?: string | null): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: sanitizeInput(name), parent_id: parentId }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || 'Failed to create folder');
    }
    return await response.json();
  }

  // ==================== SHARING ====================

  async createShareLink(
    _token: string,
    fileId: string,
    options: { expiresHours?: number; password?: string | null; maxDownloads?: number | null } = {}
  ): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        expires_hours: options.expiresHours || 24,
        password: options.password || null,
        max_downloads: options.maxDownloads || null,
      }),
    });
    if (!response.ok) throw new Error('Failed to create share link');
    return await response.json();
  }

  // ==================== STORAGE STATS ====================

  async getStorageStats(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/storage/stats`, { credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load storage stats');
    return await response.json();
  }

  // ==================== ACTIVITY ====================

  async getActivityLogs(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/activity`, { credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load activity logs');
    return await response.json();
  }

  async getFilePreview(_token: string, fileId: string): Promise<Blob> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/preview`, { credentials: 'include' });
    if (!response.ok) throw new Error('Failed to get preview');
    return await response.blob();
  }

  async getFileActivity(fileId: string, limit: number = 50): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/activity?limit=${limit}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn('File activity endpoint not available yet');
      return [];
    }

    return await response.json();
  }

  // ==================== DEDUPLICATION ====================

  async getDedupAnalytics(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/dedup/analytics`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      console.error('Failed to load dedup analytics:', response.status);
      throw new Error('Failed to load deduplication analytics');
    }

    return await response.json();
  }

  async getDedupSavings(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`${API_URL}/api/v1/dedup/savings`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error('Failed to load deduplication savings');
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Deduplication calculation timed out. Try again later.');
      }
      throw error;
    }
  }

  async optimizeFileDedup(_token: string, fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    if (!fileId) {
      throw new Error('File ID required');
    }

    const response = await fetch(`${API_URL}/api/v1/dedup/optimize/${fileId}`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to optimize file');
    }

    return await response.json();
  }

  async runGarbageCollection(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/dedup/gc`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to run garbage collection');
    }

    return await response.json();
  }

  // ==================== RECENTS & FAVORITES ====================

  async getRecentFiles(days: number = 30): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/recents?days=${days}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn('Recents endpoint not available, using mock data');
      return this.getMockRecentFiles();
    }

    return await response.json();
  }

  async getFavorites(): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/favorites`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn('Favorites endpoint not available');
      return [];
    }

    return await response.json();
  }

  async toggleFavorite(fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/favorite`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to toggle favorite');
    }

    return await response.json();
  }

  // ==================== SHARED WITH ME ====================

  async getSharedWithMe(): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/shared-with-me`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn('Shared with me endpoint not available yet');
      return [];
    }

    return await response.json();
  }

  async removeSharedAccess(shareAccessId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/shared-with-me/${shareAccessId}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to remove shared access');
    }

    return await response.json();
  }

  async getPendingInvitations(): Promise<unknown[]> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/invitations/pending`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to fetch pending invitations');
    }

    return await response.json();
  }

  async acceptInvitation(invitationToken: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/invitations/${invitationToken}/accept`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to accept invitation');
    }

    return await response.json();
  }

  async declineInvitation(invitationToken: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/invitations/${invitationToken}/decline`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to decline invitation');
    }

    return await response.json();
  }

  // ==================== SHARE LINK MANAGEMENT ====================

  async getShareLinks(activeOnly: boolean = false, limit: number = 50, offset: number = 0): Promise<unknown> {
    await rateLimiter.checkLimit();

    const params = new URLSearchParams({
      active_only: String(activeOnly),
      limit: String(limit),
      offset: String(offset),
    });

    const response = await fetch(`${API_URL}/api/v1/share-links?${params}`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to fetch share links');
    }

    return await response.json();
  }

  async getShareLinkDetail(linkId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/share-links/${linkId}`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to fetch share link detail');
    }

    return await response.json();
  }

  async updateShareLink(linkId: string, data: Record<string, unknown>): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/share-links/${linkId}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to update share link');
    }

    return await response.json();
  }

  async revokeShareLink(linkId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/share-links/${linkId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to revoke share link');
    }

    return await response.json();
  }

  async regenerateShareLink(linkId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/share-links/${linkId}/regenerate`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to regenerate share link');
    }

    return await response.json();
  }

  // ==================== SHARE ANALYTICS ====================

  async getShareAnalyticsSummary(): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/share-analytics/summary`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) throw new Error('Failed to fetch share analytics summary');
    return await response.json();
  }

  async getShareAnalyticsTrends(days: number = 30): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/share-analytics/trends?days=${days}`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) throw new Error('Failed to fetch share analytics trends');
    return await response.json();
  }

  async getShareAnalyticsTop(sortBy: string = 'views', limit: number = 10): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/share-analytics/top?sort_by=${sortBy}&limit=${limit}`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) throw new Error('Failed to fetch top shares');
    return await response.json();
  }

  // ==================== TRASH ====================

  async getTrash(): Promise<unknown[]> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/trash`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to fetch trash');
    }

    const data = await response.json();
    if (Array.isArray(data)) {
      return data;
    }

    console.warn('Unexpected trash response format:', data);
    return [];
  }

  async restoreFromTrash(fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/trash/${fileId}/restore`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error as Record<string, string>).detail || 'Failed to restore file');
    }

    requestCache.invalidate(/^files-/);
    requestCache.invalidate(/^folders-/);

    return await response.json();
  }

  async permanentDelete(fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/trash/${fileId}/permanent`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error as Record<string, string>).detail || 'Failed to permanently delete file');
    }

    return await response.json();
  }

  async emptyTrash(): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/trash/empty`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error as Record<string, string>).detail || 'Failed to empty trash');
    }

    return await response.json();
  }

  // ==================== MOCK DATA ====================

  getMockRecentFiles(): unknown[] {
    const now = new Date();
    const mockFiles: unknown[] = [];

    for (let i = 0; i < 20; i++) {
      const daysAgo = Math.floor(Math.random() * 30);
      const date = new Date(now);
      date.setDate(date.getDate() - daysAgo);

      mockFiles.push({
        id: `mock-${i}`,
        name: `Document_${i + 1}.pdf`,
        size: Math.floor(Math.random() * 10000000),
        mime_type: 'application/pdf',
        created_at: date.toISOString(),
        last_accessed: date.toISOString(),
        tier: ['hot', 'warm', 'cold'][Math.floor(Math.random() * 3)],
      });
    }

    return mockFiles;
  }
}

export const storageService = new StorageService();
