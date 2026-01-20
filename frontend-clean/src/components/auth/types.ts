/**
 * Auth Components Type Definitions
 *
 * Strict TypeScript types for all auth-related components.
 * Following best practices:
 * - No `any` types
 * - `unknown` at trust boundaries
 * - Discriminated unions for state machines
 * - Explicit return types for async functions
 */

import type { PasswordStrengthResult } from '../../utils/security';
import type { LucideIcon } from 'lucide-react';

// ==================== Component Props ====================

/**
 * PasswordStrengthMeter props
 */
export interface PasswordStrengthMeterProps {
  strengthData: PasswordStrengthResult | null;
  darkMode: boolean;
  showRequirements?: boolean;
}

/**
 * VerificationCodeInput props
 */
export interface VerificationCodeInputProps {
  email: string;
  onVerify: (code: string) => void | Promise<void>;
  onResend: () => void | Promise<void>;
  onBack?: () => void;
  darkMode?: boolean;
  loading?: boolean;
  error?: string | null;
  expiryMinutes?: number;
}

/**
 * RecoveryPhraseInput props
 */
export interface RecoveryPhraseInputProps {
  value?: string[];
  onChange: (words: string[]) => void;
  onComplete?: (words: string[]) => void;
  disabled?: boolean;
  darkMode?: boolean;
  showWordNumbers?: boolean;
  compact?: boolean;
}

/**
 * RecoveryPhraseSetup props
 */
export interface RecoveryPhraseSetupProps {
  recoveryPhrase: string;
  onConfirm: () => void;
  onSkip?: () => void;
}

/**
 * RecoveryPhraseConfirm props
 */
export interface RecoveryPhraseConfirmProps {
  recoveryPhrase: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * RecoveryModal props
 */
export interface RecoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRecoveryComplete?: (data: RecoveryCompleteData) => void;
}

/**
 * Data passed to onRecoveryComplete callback
 */
export interface RecoveryCompleteData {
  email: string;
  newPassword: string;
  accessToken?: string;
}

/**
 * SessionUnlockModal props
 */
export interface SessionUnlockModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// ==================== Internal State Types ====================

/**
 * Auth form data
 */
export interface AuthFormData {
  email: string;
  password: string;
  confirmPassword: string;
  username: string;
  userType: 'individual' | 'team';
  planCode: string | null;
  billingCycle: 'monthly' | 'yearly';
}

/**
 * Field validation errors
 */
export interface FieldErrors {
  email?: string | null;
  password?: string | null;
  confirmPassword?: string | null;
  username?: string | null;
}

/**
 * Registration step state machine
 */
export type RegistrationStep = 'form' | 'verify';

/**
 * Auth mode (login or register)
 */
export type AuthMode = 'login' | 'register';

/**
 * Session unlock mode
 */
export type UnlockMode = 'password' | 'recovery';

/**
 * Recovery modal step state machine
 */
export type RecoveryStep = 1 | 2 | 3;

// ==================== Bento Grid Types ====================

/**
 * Bento card size variants
 */
export type BentoSize = 'normal' | 'large' | 'tall' | 'wide';

/**
 * Glow color variants for bento cards
 */
export type GlowColor = 'blue' | 'purple' | 'green' | 'cyan' | 'pink' | 'orange' | 'indigo' | 'yellow';

/**
 * BentoGrid container props
 */
export interface BentoGridProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * BentoCard props
 */
export interface BentoCardProps {
  title: string;
  description: string;
  icon: LucideIcon;
  className?: string;
  children?: React.ReactNode;
  background?: React.ReactNode;
  gradient?: string;
  size?: BentoSize;
  glowColor?: GlowColor;
  darkMode?: boolean;
}

/**
 * FloatingOrb background element props
 */
export interface FloatingOrbProps {
  className?: string;
  delay?: number;
  darkMode?: boolean;
}

// ==================== Recovery Info Types ====================

/**
 * KDF parameters from backend
 */
export interface RecoveryKDFParams {
  kdf_salt?: string;
  kdf_algorithm?: string;
  kdf_iterations?: number;
  kdf_memory?: number;
  kdf_iv?: string;
  iv?: string;
}

/**
 * Recovery info from backend
 */
export interface RecoveryInfo {
  recovery_enabled: boolean;
  recovery_encrypted_master_key: string;
  recovery_iv?: string;
  kdf_params?: RecoveryKDFParams;
}

// ==================== Verification Code Types ====================

/**
 * 6-digit verification code as array
 */
export type VerificationCode = [string, string, string, string, string, string];

// ==================== Type Guards ====================

/**
 * Type guard for error with message property
 */
export function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * Extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unexpected error occurred';
}
