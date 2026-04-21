import React, { useState } from 'react';
import {
  Shield,
  Copy,
  Check,
  AlertTriangle,
  Download,
  Eye,
  EyeOff,
  Printer,
} from 'lucide-react';
import type { RecoveryPhraseSetupProps } from './types';
import { getErrorMessage } from './types';
import {
  Banner,
  Button,
  Checkbox,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * RecoveryPhraseSetup — the one-time reveal screen for the BIP39 phrase.
 * The user must copy/download/print it and explicitly acknowledge storage
 * before proceeding.
 */
const RecoveryPhraseSetup: React.FC<RecoveryPhraseSetupProps> = ({
  recoveryPhrase,
  onConfirm,
  onSkip,
}) => {
  const [copied, setCopied] = useState<boolean>(false);
  const [showPhrase, setShowPhrase] = useState<boolean>(false);
  const [acknowledged, setAcknowledged] = useState<boolean>(false);

  const words = recoveryPhrase.split(' ');

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(recoveryPhrase);
      setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
      }, 60000);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err: unknown) {
      console.error('Failed to copy:', getErrorMessage(err));
    }
  };

  const handleDownload = (): void => {
    const content = `ZERO-KNOWLEDGE RECOVERY PHRASE
=================================

IMPORTANT: Store this recovery phrase in a safe place.
This is the ONLY way to recover your account if you forget your password.

Recovery Phrase (24 words):
${recoveryPhrase}

Generated: ${new Date().toISOString()}

SECURITY WARNINGS:
- Never share this phrase with anyone
- Store it offline in a secure location
- Do not store it digitally (screenshots, cloud storage, etc.)
- Anyone with this phrase can access your encrypted files

=================================
Edge Cloud Storage - Zero-Knowledge Encryption
`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'edge-cloud-recovery-phrase.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrint = (): void => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Please allow pop-ups to print your recovery phrase.');
      return;
    }

    const date = new Date().toLocaleString();
    const wordsHtml = words
      .map(
        (word, index) => `<div class="word"><span class="num">${index + 1}.</span> ${word}</div>`
      )
      .join('');

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Recovery Phrase - Edge Cloud Storage</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            padding: 40px;
            max-width: 800px;
            margin: 0 auto;
          }
          .header { text-align: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid #333; }
          .header h1 { font-size: 24px; margin-bottom: 8px; }
          .header p { color: #666; font-size: 14px; }
          .warning { background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 16px; margin-bottom: 30px; }
          .warning h2 { color: #856404; font-size: 16px; margin-bottom: 8px; }
          .warning p { color: #856404; font-size: 13px; }
          .words-container { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 30px; }
          .word { border: 1px solid #ddd; border-radius: 6px; padding: 12px; font-family: 'Courier New', monospace; font-size: 14px; }
          .word .num { color: #999; margin-right: 8px; }
          .security-notes { background: #f8f9fa; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
          .security-notes h3 { font-size: 14px; margin-bottom: 10px; }
          .security-notes ul { font-size: 12px; color: #666; padding-left: 20px; }
          .security-notes li { margin-bottom: 4px; }
          .footer { text-align: center; color: #999; font-size: 12px; padding-top: 20px; border-top: 1px solid #ddd; }
          @media print {
            body { padding: 20px; }
            .warning { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Zero-Knowledge Recovery Phrase</h1>
          <p>Edge Cloud Storage - Generated: ${date}</p>
        </div>
        <div class="warning">
          <h2>CRITICAL: Keep This Document Safe</h2>
          <p>This recovery phrase is the ONLY way to recover your account if you forget your password.
          Store it in a secure location. We cannot help you recover it.</p>
        </div>
        <div class="words-container">${wordsHtml}</div>
        <div class="security-notes">
          <h3>Security Guidelines:</h3>
          <ul>
            <li>Never share this phrase with anyone</li>
            <li>Store this document in a secure, offline location</li>
            <li>Consider storing copies in multiple secure locations</li>
            <li>Do not take photos or store digitally</li>
            <li>Anyone with this phrase can access your encrypted files</li>
          </ul>
        </div>
        <div class="footer">
          <p>Edge Cloud Storage - Zero-Knowledge Encryption</p>
        </div>
      </body>
      </html>
    `);

    printWindow.document.close();
    setTimeout(() => {
      printWindow.print();
    }, 250);
  };

  const handleContinue = (): void => {
    if (!acknowledged) {
      alert('Please acknowledge that you have saved your recovery phrase.');
      return;
    }
    onConfirm();
  };

  return (
    <Modal open onClose={onSkip ?? (() => {})} size="lg">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent text-white">
            <Shield size={20} />
          </div>
          <div>
            <h2 className="text-h2 font-bold text-fg">Save your recovery phrase</h2>
            <p className="text-body-sm text-fg-muted">This is shown only once — store it safely</p>
          </div>
        </div>
      </ModalHeader>

      <ModalBody>
        <div className="space-y-4">
          <Banner variant="warning" icon={<AlertTriangle />} title="Critical: save this recovery phrase">
            This is the ONLY way to recover your account if you forget your password.
          </Banner>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-body-sm font-medium text-fg">24-word recovery phrase</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowPhrase(!showPhrase)}
                leftIcon={showPhrase ? <EyeOff size={14} /> : <Eye size={14} />}
              >
                {showPhrase ? 'Hide' : 'Show'}
              </Button>
            </div>

            <div className="rounded-xl border-2 border-border bg-surface-muted p-4">
              {showPhrase ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {words.map((word, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-border bg-surface p-2 text-center"
                    >
                      <span className="block text-[10px] text-fg-subtle">{index + 1}</span>
                      <span className="font-mono text-body-sm font-medium text-fg">{word}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center">
                  <Eye className="mx-auto mb-2 text-fg-subtle" size={36} />
                  <p className="text-body-sm text-fg-muted">
                    Click &quot;Show&quot; to reveal your recovery phrase
                  </p>
                </div>
              )}
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleCopy()}
                disabled={!showPhrase}
                leftIcon={copied ? <Check size={16} /> : <Copy size={16} />}
              >
                {copied ? 'Copied!' : 'Copy'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDownload}
                disabled={!showPhrase}
                leftIcon={<Download size={16} />}
              >
                Download
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handlePrint}
                disabled={!showPhrase}
                leftIcon={<Printer size={16} />}
              >
                Print
              </Button>
            </div>
          </div>

          <div
            className={cn(
              'rounded-xl border-2 p-3 transition-colors',
              acknowledged
                ? 'border-success/50 bg-success/10'
                : 'border-border bg-surface-muted'
            )}
          >
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5"
              />
              <div className="flex-1">
                <p className="text-body-sm font-medium text-fg">
                  I have safely stored my recovery phrase
                </p>
                <p className="mt-0.5 text-caption text-fg-muted">
                  I understand that losing this phrase means permanent loss of access to my
                  encrypted files.
                </p>
              </div>
            </label>
          </div>
        </div>
      </ModalBody>

      <ModalFooter>
        {onSkip && (
          <Button variant="secondary" onClick={onSkip}>
            Skip for now
          </Button>
        )}
        <Button variant="primary" onClick={handleContinue} disabled={!acknowledged}>
          Continue
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default RecoveryPhraseSetup;
