import React, { useState, useEffect } from 'react';
import { Shield, Check, AlertCircle } from 'lucide-react';
import type { RecoveryPhraseConfirmProps } from './types';
import {
  Banner,
  Button,
  FormField,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@/components/ui';

interface UserInputs {
  [position: number]: string;
}

/**
 * RecoveryPhraseConfirm — verification modal that asks the user to type back
 * four random words from their recovery phrase, then shows a success state
 * before advancing.
 */
const RecoveryPhraseConfirm: React.FC<RecoveryPhraseConfirmProps> = ({
  recoveryPhrase,
  onConfirm,
  onCancel,
}) => {
  const [selectedWords, setSelectedWords] = useState<number[]>([]);
  const [userInputs, setUserInputs] = useState<UserInputs>({});
  const [error, setError] = useState<string>('');
  const [verified, setVerified] = useState<boolean>(false);

  const words = recoveryPhrase.split(' ');

  useEffect(() => {
    const positions: number[] = [];
    while (positions.length < 4) {
      const random = Math.floor(Math.random() * 24);
      if (!positions.includes(random)) {
        positions.push(random);
      }
    }
    setSelectedWords(positions.sort((a, b) => a - b));
  }, [recoveryPhrase]);

  const handleInputChange = (position: number, value: string): void => {
    setUserInputs((prev) => ({
      ...prev,
      [position]: value.trim().toLowerCase(),
    }));
    setError('');
  };

  const handleVerify = (): void => {
    const allCorrect = selectedWords.every((position) => {
      const userWord = (userInputs[position] ?? '').toLowerCase();
      const correctWord = (words[position] ?? '').toLowerCase();
      return userWord === correctWord;
    });

    if (allCorrect) {
      setVerified(true);
      setError('');
      setTimeout(() => {
        onConfirm();
      }, 1000);
    } else {
      setError('Some words are incorrect. Please check your recovery phrase and try again.');
    }
  };

  const isComplete = selectedWords.every((position) => userInputs[position]?.trim());

  return (
    <Modal open onClose={onCancel} size="md">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-xl text-white ${
              verified
                ? 'bg-gradient-to-br from-success to-success/80'
                : 'bg-gradient-to-br from-primary to-accent'
            }`}
          >
            {verified ? <Check size={24} /> : <Shield size={24} />}
          </div>
          <div>
            <h2 className="text-h2 font-bold text-fg">
              {verified ? 'Verified!' : 'Verify recovery phrase'}
            </h2>
            <p className="text-body-sm text-fg-muted">
              {verified
                ? 'Your recovery phrase is confirmed'
                : 'Enter the requested words to confirm'}
            </p>
          </div>
        </div>
      </ModalHeader>

      <ModalBody>
        {!verified && (
          <div className="space-y-4">
            <Banner variant="info" icon={<AlertCircle />}>
              To verify you&apos;ve saved your recovery phrase, please enter the words at the
              positions indicated below.
            </Banner>

            {error && <Banner variant="danger">{error}</Banner>}

            {selectedWords.map((position) => (
              <FormField key={position} label={`Word #${position + 1}`}>
                <Input
                  type="text"
                  placeholder={`Enter word #${position + 1}`}
                  value={userInputs[position] ?? ''}
                  onChange={(e) => handleInputChange(position, e.target.value)}
                  className="font-mono"
                />
              </FormField>
            ))}
          </div>
        )}

        {verified && (
          <div className="py-8 text-center">
            <div className="mb-4 inline-flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-success to-success/80 text-white">
              <Check size={40} />
            </div>
            <p className="text-h3 font-semibold text-fg">Recovery phrase verified!</p>
            <p className="mt-2 text-body-sm text-fg-muted">
              Your account is now secured with zero-knowledge encryption.
            </p>
          </div>
        )}
      </ModalBody>

      {!verified && (
        <ModalFooter>
          <Button variant="secondary" onClick={onCancel}>
            Go back
          </Button>
          <Button variant="primary" onClick={handleVerify} disabled={!isComplete}>
            Verify
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
};

export default RecoveryPhraseConfirm;
