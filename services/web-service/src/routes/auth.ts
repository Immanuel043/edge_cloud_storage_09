import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { AuthController } from '../controllers/authController';
import { authLimiter } from '../middleware/rateLimit';

export function createAuthRoutes(pgPool: Pool, redisCache: Redis): Router {
  const router = Router();
  const authController = new AuthController(pgPool, redisCache);

  router.post('/login', authLimiter, (req: Request, res: Response) => {
    void authController.login(req, res);
  });
  router.post('/logout', (req: Request, res: Response) => {
    authController.logout(req, res);
  });

  return router;
}
