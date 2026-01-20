/**
 * Settings Component Type Definitions
 *
 * Strict TypeScript types for settings components.
 * Following best practices:
 * - No `any` types
 * - Proper React types
 *
 * Note: RecoverySettings component has no props, so no prop interfaces needed here.
 * All types are either internal state or come from dependencies.
 */

// ==================== Recovery Phrase Types ====================

/**
 * Recovery phrase data structure
 * Matches the return type of generateRecoveryPhraseData()
 */
export interface RecoveryPhraseData {
  recoveryPhrase: string;
  recoveryEncryptedMasterKey: string;
  recoveryIV: string;
  recoveryPhraseHash: string;
}
