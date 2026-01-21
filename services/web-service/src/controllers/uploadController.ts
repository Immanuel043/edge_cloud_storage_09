import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import FormData from 'form-data';
import axios from 'axios';
import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { Producer } from 'kafkajs';
import type { UploadInitRequest, UploadInitResponse, UploadSession, ErrorResponse } from '../types/api';

export class UploadController {
  constructor(
    private storageServiceUrl: string,
    private redisCache: Redis,
    private io: SocketIOServer,
    private kafkaProducer: Producer | null
  ) {}

  async initUpload(
    req: Request<{}, UploadInitResponse | ErrorResponse, UploadInitRequest>,
    res: Response<UploadInitResponse | ErrorResponse>
  ): Promise<void> {
    const { fileName, fileSize, mimeType } = req.body;
    const userId = req.session?.userId;
    
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    
    const uploadId = randomUUID();
    const chunkSize = 64 * 1024 * 1024; // 64MB
    const totalChunks = Math.ceil(fileSize / chunkSize);
    
    // Store upload session in Redis
    const session: UploadSession = {
      userId,
      fileName,
      fileSize,
      mimeType,
      totalChunks,
      uploadedChunks: [],
      startTime: Date.now()
    };
    
    await this.redisCache.setex(
      `upload:${uploadId}`,
      3600,
      JSON.stringify(session)
    );
    
    // Send real-time notification
    this.io.to(`user-${userId}`).emit('upload-started', {
      uploadId,
      fileName,
      fileSize,
      totalChunks
    });
    
    res.json({
      uploadId,
      chunkSize,
      totalChunks
    });
  }

  async uploadChunk(
    req: Request<{ uploadId: string; chunkIndex: string }>,
    res: Response
  ): Promise<void> {
    const { uploadId, chunkIndex } = req.params;
    const chunk = req.file;
    
    if (!chunk) {
      res.status(400).json({ error: 'No chunk provided' });
      return;
    }
    
    try {
      // Get upload session
      const sessionData = await this.redisCache.get(`upload:${uploadId}`);
      if (!sessionData) {
        res.status(404).json({ error: 'Upload session not found' });
        return;
      }
      
      const session: UploadSession = JSON.parse(sessionData);
      
      // Forward chunk to storage service
      const formData = new FormData();
      formData.append('file', chunk.buffer, {
        filename: `chunk_${chunkIndex}`,
        contentType: 'application/octet-stream'
      });
      
      await axios.post(
        `${this.storageServiceUrl}/api/v1/upload/chunk/${uploadId}`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'chunk-index': chunkIndex
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        }
      );
      
      // Update session
      session.uploadedChunks.push(parseInt(chunkIndex));
      await this.redisCache.setex(
        `upload:${uploadId}`,
        3600,
        JSON.stringify(session)
      );
      
      // Calculate progress
      const progress = (session.uploadedChunks.length / session.totalChunks) * 100;
      
      // Send real-time progress update
      this.io.to(`user-${session.userId}`).emit('upload-progress', {
        uploadId,
        chunkIndex: parseInt(chunkIndex),
        progress,
        chunksUploaded: session.uploadedChunks.length,
        totalChunks: session.totalChunks
      });
      
      // Send to Kafka for analytics
      if (this.kafkaProducer) {
        try {
          await this.kafkaProducer.send({
            topic: 'upload-events',
            messages: [{
              value: JSON.stringify({
                event: 'chunk_uploaded',
                uploadId,
                chunkIndex,
                userId: session.userId,
                timestamp: new Date().toISOString()
              })
            }]
          });
        } catch (error) {
          console.error('Failed to send to Kafka:', error);
        }
      }
      
      res.json({
        success: true,
        chunkIndex: parseInt(chunkIndex),
        progress
      });
      
    } catch (error) {
      console.error('Chunk upload error:', error);
      res.status(500).json({ error: 'Failed to upload chunk' });
    }
  }

  async completeUpload(
    req: Request<{ uploadId: string }>,
    res: Response
  ): Promise<void> {
    const { uploadId } = req.params;
    
    try {
      const sessionData = await this.redisCache.get(`upload:${uploadId}`);
      if (!sessionData) {
        res.status(404).json({ error: 'Upload session not found' });
        return;
      }
      
      const session: UploadSession = JSON.parse(sessionData);
      
      // Verify all chunks uploaded
      if (session.uploadedChunks.length !== session.totalChunks) {
        res.status(400).json({ 
          error: 'Not all chunks uploaded',
          missing: session.totalChunks - session.uploadedChunks.length
        });
        return;
      }
      
      // Finalize with storage service
      const response = await axios.post(
        `${this.storageServiceUrl}/api/v1/upload/complete/${uploadId}`,
        {
          fileName: session.fileName,
          fileSize: session.fileSize,
          mimeType: session.mimeType,
          userId: session.userId
        }
      );
      
      const fileData = response.data;
      
      // Clean up Redis session
      await this.redisCache.del(`upload:${uploadId}`);
      
      // Send completion notification
      this.io.to(`user-${session.userId}`).emit('upload-complete', {
        uploadId,
        fileId: fileData.file_id,
        fileName: session.fileName,
        fileSize: session.fileSize,
        duration: Date.now() - session.startTime
      });
      
      // Send to Kafka
      if (this.kafkaProducer) {
        try {
          await this.kafkaProducer.send({
            topic: 'upload-events',
            messages: [{
              value: JSON.stringify({
                event: 'upload_completed',
                uploadId,
                fileId: fileData.file_id,
                userId: session.userId,
                timestamp: new Date().toISOString()
              })
            }]
          });
        } catch (error) {
          console.error('Failed to send to Kafka:', error);
        }
      }
      
      res.json({
        success: true,
        file: fileData
      });
      
    } catch (error) {
      console.error('Complete upload error:', error);
      res.status(500).json({ error: 'Failed to complete upload' });
    }
  }
}
