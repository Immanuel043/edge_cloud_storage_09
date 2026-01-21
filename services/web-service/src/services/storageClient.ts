import axios, { AxiosInstance } from 'axios';

export class StorageClient {
  private client: AxiosInstance;

  constructor(baseUrl: string) {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
    });
  }

  async getFiles(userId: string): Promise<unknown> {
    const response = await this.client.get('/api/v1/files', {
      headers: {
        'X-User-Id': userId
      }
    });
    return response.data;
  }

  async downloadFile(fileId: string, userId: string): Promise<unknown> {
    const response = await this.client.get(`/api/v1/files/${fileId}/download`, {
      responseType: 'stream',
      headers: {
        'X-User-Id': userId
      }
    });
    return response;
  }

  async deleteFile(fileId: string, userId: string): Promise<unknown> {
    const response = await this.client.delete(`/api/v1/files/${fileId}`, {
      headers: {
        'X-User-Id': userId
      }
    });
    return response.data;
  }

  async shareFile(
    fileId: string,
    userId: string,
    options: { expires_hours?: number; password?: string; max_downloads?: number }
  ): Promise<unknown> {
    const response = await this.client.post(
      `/api/v1/files/${fileId}/share`,
      options,
      {
        headers: {
          'X-User-Id': userId
        }
      }
    );
    return response.data;
  }

  async copyFile(fileId: string, userId: string): Promise<unknown> {
    const response = await this.client.post(
      `/api/v1/files/${fileId}/copy`,
      {},
      {
        headers: {
          'X-User-Id': userId
        }
      }
    );
    return response.data;
  }

  async getPreview(fileId: string, userId: string, size?: string): Promise<unknown> {
    const response = await this.client.get(
      `/api/v1/files/${fileId}/preview`,
      {
        params: { size },
        headers: {
          'X-User-Id': userId
        },
        responseType: 'arraybuffer'
      }
    );
    return response;
  }
}
