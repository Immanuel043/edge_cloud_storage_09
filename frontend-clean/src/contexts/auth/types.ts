/**
 * Shared types for Auth Context (ZK and Normal modes)
 */

export interface User {
  id: string;
  email: string;
  username: string;
  user_type: string;
  created_at: string;
  zk_enabled?: boolean;
  [key: string]: unknown;
}

export interface AuthResponse {
  access_token?: string;
  user?: User;
  token_type?: string;
  message?: string;
}

export interface LoginResponse extends AuthResponse {
  encrypted_master_key?: string;
  kdf_iv?: string;
  recovery_enabled?: boolean;
  kdf_salt?: string;
  kdf_algorithm?: 'pbkdf2' | 'argon2id';
  kdf_iterations?: number;
  kdf_memory?: number;
}

export interface ZKData {
  kdfSalt: string;
  kdfAlgorithm: 'pbkdf2' | 'argon2id';
  kdfIterations: number;
  kdfMemory?: number;
  encryptedMasterKey: string;
  masterKeyIV: string;
}

export interface RecoveryPhraseResult {
  recoveryPhrase: string;
  success: boolean;
}

export interface RecoveryAccountResponse {
  user: User;
  recovery_enabled: boolean;
}

export interface ZKStatusResponse {
  zk_enabled: boolean;
  recovery_enabled: boolean;
}

export interface NormalAuthContextValue {
  // User
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;
  token: string | null;

  // Methods
  login: (email: string, password: string) => Promise<LoginResponse>;
  register: (
    email: string,
    password: string,
    username: string,
    userType: string,
    planCode?: string
  ) => Promise<LoginResponse>;
  logout: () => Promise<void>;

  // Internal
  refreshSessionToken: () => Promise<string | null>;
}

export interface ZKAuthContextValue {
  // User
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;

  // ZK-specific
  zkEnabled: boolean;
  zkSessionUnlocked: boolean;
  zkRecoveryEnabled: boolean;
  zkData: ZKData | null;

  // Methods
  registerZK: (
    email: string,
    password: string,
    username: string,
    userType?: string,
    planCode?: string
  ) => Promise<LoginResponse>;
  loginZK: (email: string, password: string) => Promise<LoginResponse>;
  unlockSession: (password: string) => Promise<boolean>;
  lockSession: () => void;
  setupRecoveryPhrase: (skipSessionCheck?: boolean) => Promise<RecoveryPhraseResult>;
  verifyRecoveryPhrase: (recoveryPhrase: string) => Promise<boolean>;
  recoverAccount: (email: string, recoveryPhrase: string) => Promise<RecoveryAccountResponse>;
  checkZKStatus: () => Promise<ZKStatusResponse | null>;
  logout: () => Promise<void>;

  // Session management
  showUnlockModal: boolean;
  setShowUnlockModal: (show: boolean) => void;

  // Rate limiting
  unlockAttempts: number;
  lockoutUntil: number | null;
}

// Combined interface for router context
export interface AuthContextValue {
  // User (shared)
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;
  token: string | null;

  // ZK state
  zkEnabled: boolean;
  zkSessionUnlocked: boolean;
  zkRecoveryEnabled: boolean;

  // Unified methods (delegates to current mode's context)
  login: (email: string, password: string) => Promise<LoginResponse>;
  register: (
    email: string,
    password: string,
    username: string,
    userType: string,
    planCode?: string
  ) => Promise<LoginResponse>;
  logout: () => Promise<void>;

  // Mode-specific login/register methods (allow explicit mode selection during auth)
  loginZK?: (email: string, password: string) => Promise<LoginResponse>;
  registerZK?: (
    email: string,
    password: string,
    username: string,
    userType?: string,
    planCode?: string
  ) => Promise<LoginResponse>;

  // ZK-specific methods (available when zkEnabled)
  unlockSession?: (password: string) => Promise<boolean>;
  lockSession?: () => void;
  setupRecoveryPhrase?: (skipSessionCheck?: boolean) => Promise<RecoveryPhraseResult>;
  verifyRecoveryPhrase?: (recoveryPhrase: string) => Promise<boolean>;
  recoverAccount?: (email: string, recoveryPhrase: string) => Promise<RecoveryAccountResponse>;
  checkZKStatus?: () => Promise<ZKStatusResponse | null>;
  showUnlockModal?: boolean;
  setShowUnlockModal?: (show: boolean) => void;

  // Normal-specific methods (available when !zkEnabled)
  refreshSessionToken?: () => Promise<string | null>;
}
