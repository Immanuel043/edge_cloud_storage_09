import { Request } from 'express';
import { SessionData } from 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    user?: {
      id: string;
      email: string;
      username: string;
      user_type: string;
    };
  }
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      user?: {
        id: string;
        email: string;
        username: string;
        user_type: string;
      };
    }
  }
}

export {};
