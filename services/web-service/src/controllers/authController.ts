import { Request, Response } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import type { LoginRequest, LoginResponse, ErrorResponse } from '../types/api';

export class AuthController {
  constructor(
    private pgPool: Pool,
    private redisCache: Redis
  ) {}

  async login(req: Request<{}, LoginResponse | ErrorResponse, LoginRequest>, res: Response<LoginResponse | ErrorResponse>): Promise<void> {
    const { email, password: _password } = req.body;
    
    try {
      const result = await this.pgPool.query(
        'SELECT id, email, username, user_type FROM users WHERE email = $1',
        [email]
      );
      
      if (result.rows.length === 0) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      
      const user = result.rows[0];
      
      // Store session
      if (req.session) {
        req.session.userId = user.id;
        req.session.user = {
          id: user.id,
          email: user.email,
          username: user.username,
          user_type: user.user_type
        };
      }
      
      // Cache user data
      await this.redisCache.setex(`user:${user.id}`, 3600, JSON.stringify(user));
      
      res.json({ 
        success: true, 
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          userType: user.user_type
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  logout(req: Request, res: Response<{ success: boolean } | ErrorResponse>): void {
    req.session?.destroy((err) => {
      if (err) {
        res.status(500).json({ error: 'Failed to logout' });
        return;
      }
      res.json({ success: true });
    });
  }
}
