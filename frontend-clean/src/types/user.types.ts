/**
 * User and Authentication Types
 */

export interface User {
  id: string;
  email: string;
  username: string;
  planType: 'free' | 'basic' | 'pro' | 'team';
  storageQuota: number;
  storageUsed: number;
  createdAt: string; // ISO datetime
  zkEnabled?: boolean;
}

export interface AuthResponse {
  accessToken: string;
  tokenType: 'bearer';
  user: User;
}

export interface ZKAuthResponse extends AuthResponse {
  encryptedMasterKey: string;  // Base64
  kdfSalt: string;  // Hex
  kdfParams: KDFParams;
}

export interface KDFParams {
  algorithm: 'pbkdf2' | 'argon2id';
  iterations?: number;
  memory?: number;  // Argon2id only (in KB)
  parallelism?: number;  // Argon2id only
}

export interface ZKData {
  encryptedMasterKey: string;
  masterKeyIv: string;
  kdfSalt: string;
  kdfParams: KDFParams;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterCredentials extends LoginCredentials {
  username: string;
  userType?: string;
  planCode?: string;
}
