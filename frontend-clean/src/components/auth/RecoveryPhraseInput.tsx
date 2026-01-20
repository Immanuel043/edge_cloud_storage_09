import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Check, AlertCircle } from 'lucide-react';
// Import BIP39 English wordlist from @scure/bip39 (ESM-native)
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import type { RecoveryPhraseInputProps } from './types';

/**
 * Default empty array for 24 words
 */
const DEFAULT_WORDS: string[] = Array(24).fill('');

/**
 * RecoveryPhraseInput - Word-by-word entry component with BIP39 autocomplete
 *
 * Features:
 * - 24 individual input fields in 4x6 grid
 * - BIP39 autocomplete dropdown (max 5 suggestions)
 * - Real-time validation with visual indicators
 * - Smart paste support (auto-splits full phrases)
 * - Keyboard navigation (Tab/Enter advances, arrow keys for dropdown)
 * - Accessibility support (ARIA labels, focus indicators)
 */
const RecoveryPhraseInput: React.FC<RecoveryPhraseInputProps> = ({
  value = DEFAULT_WORDS,
  onChange,
  onComplete,
  disabled = false,
  darkMode = false,
  showWordNumbers = true,
  compact = false,
}) => {
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState<number>(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Memoize the wordlist
  const bip39Words = useMemo(() => englishWordlist, []);

  /**
   * Check if a word is valid BIP39
   */
  const isValidWord = useCallback(
    (word: string): boolean => {
      if (!word) return false;
      return bip39Words.includes(word.toLowerCase().trim());
    },
    [bip39Words]
  );

  /**
   * Get autocomplete suggestions
   */
  const getSuggestions = useCallback(
    (input: string): string[] => {
      if (!input || input.length < 1) return [];
      const lowercaseInput = input.toLowerCase().trim();
      return bip39Words.filter((word) => word.startsWith(lowercaseInput)).slice(0, 5);
    },
    [bip39Words]
  );

  // Update suggestions when focused input changes
  useEffect(() => {
    const currentWord = value[focusedIndex];
    if (focusedIndex >= 0 && currentWord) {
      setSuggestions(getSuggestions(currentWord));
      setHighlightedSuggestion(0);
    } else {
      setSuggestions([]);
    }
  }, [focusedIndex, value, getSuggestions]);

  // Check if all words are valid and call onComplete
  useEffect(() => {
    const allValid = value.every((word) => isValidWord(word));
    const allFilled = value.every((word) => word && word.trim().length > 0);
    if (allValid && allFilled && onComplete) {
      onComplete(value.map((w) => w.toLowerCase().trim()));
    }
  }, [value, isValidWord, onComplete]);

  /**
   * Handle input change
   */
  const handleInputChange = (index: number, newValue: string): void => {
    const newWords = [...value];
    newWords[index] = newValue;
    onChange(newWords);
  };

  /**
   * Handle paste - detect full phrase and split
   */
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>, index: number): void => {
    const pasted = e.clipboardData.getData('text');
    const words = pasted.trim().split(/\s+/);

    if (words.length > 1) {
      e.preventDefault();
      const newValue = [...value];
      words.forEach((word, i) => {
        if (index + i < 24) {
          newValue[index + i] = word.toLowerCase().trim();
        }
      });
      onChange(newValue);

      // Focus the next empty field or the last filled field
      const nextEmptyIndex = newValue.findIndex(
        (w, i) => i >= index && (!w || w.trim() === '')
      );
      const focusIndex = nextEmptyIndex >= 0 ? nextEmptyIndex : Math.min(index + words.length, 23);
      setTimeout(() => {
        inputRefs.current[focusIndex]?.focus();
      }, 0);
    }
  };

  /**
   * Handle suggestion selection
   */
  const selectSuggestion = (index: number, suggestion: string): void => {
    handleInputChange(index, suggestion);
    setSuggestions([]);

    // Move to next field
    if (index < 23) {
      setTimeout(() => {
        inputRefs.current[index + 1]?.focus();
      }, 0);
    }
  };

  /**
   * Handle keyboard navigation
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number): void => {
    switch (e.key) {
      case 'ArrowDown':
        if (suggestions.length > 0) {
          e.preventDefault();
          setHighlightedSuggestion((prev) => Math.min(prev + 1, suggestions.length - 1));
        }
        break;
      case 'ArrowUp':
        if (suggestions.length > 0) {
          e.preventDefault();
          setHighlightedSuggestion((prev) => Math.max(prev - 1, 0));
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (suggestions.length > 0) {
          selectSuggestion(index, suggestions[highlightedSuggestion] ?? '');
        } else if (isValidWord(value[index] ?? '') && index < 23) {
          inputRefs.current[index + 1]?.focus();
        }
        break;
      case 'Tab':
        if (suggestions.length > 0 && !e.shiftKey) {
          e.preventDefault();
          selectSuggestion(index, suggestions[highlightedSuggestion] ?? '');
        }
        break;
      case 'Backspace':
        if (!value[index] && index > 0) {
          e.preventDefault();
          inputRefs.current[index - 1]?.focus();
        }
        break;
      case ' ':
        // Space acts like Tab when word is valid
        if (isValidWord(value[index] ?? '') && index < 23) {
          e.preventDefault();
          inputRefs.current[index + 1]?.focus();
        }
        break;
      default:
        break;
    }
  };

  // Styles based on theme
  const baseInputClass =
    'w-full px-2 py-1.5 text-sm rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500';

  const getInputClass = (word: string): string => {
    const isValid = isValidWord(word);
    const hasValue = word && word.trim().length > 0;

    if (darkMode) {
      if (hasValue && isValid) return `${baseInputClass} border-green-500 bg-gray-800 text-white`;
      if (hasValue && !isValid) return `${baseInputClass} border-red-400 bg-gray-800 text-white`;
      return `${baseInputClass} border-gray-600 bg-gray-800 text-white placeholder-gray-500`;
    } else {
      if (hasValue && isValid) return `${baseInputClass} border-green-500 bg-white text-gray-900`;
      if (hasValue && !isValid) return `${baseInputClass} border-red-400 bg-white text-gray-900`;
      return `${baseInputClass} border-gray-300 bg-white text-gray-900 placeholder-gray-400`;
    }
  };

  const dropdownClass = darkMode
    ? 'absolute z-20 w-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg max-h-32 overflow-y-auto'
    : 'absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-32 overflow-y-auto';

  const getSuggestionClass = (isHighlighted: boolean): string => {
    if (darkMode) {
      return `w-full px-2 py-1 text-left text-sm cursor-pointer ${
        isHighlighted ? 'bg-blue-600 text-white' : 'text-gray-200 hover:bg-gray-700'
      }`;
    }
    return `w-full px-2 py-1 text-left text-sm cursor-pointer ${
      isHighlighted ? 'bg-blue-100 text-blue-900' : 'text-gray-700 hover:bg-blue-50'
    }`;
  };

  // Grid configuration
  const gridCols = compact ? 'grid-cols-6' : 'grid-cols-4';
  const gap = compact ? 'gap-1.5' : 'gap-2';

  return (
    <div className="recovery-phrase-input">
      <div className={`grid ${gridCols} ${gap}`}>
        {Array(24)
          .fill(null)
          .map((_, index) => {
            const word = value[index] ?? '';
            const isValid = isValidWord(word);
            const hasValue = word.trim().length > 0;
            const isFocused = focusedIndex === index;
            const showSuggestions = isFocused && suggestions.length > 0;

            return (
              <div key={index} className="relative pt-4">
                {/* Word number label - positioned above input */}
                {showWordNumbers && (
                  <span
                    className={`absolute top-0 left-1 text-xs font-medium ${
                      darkMode ? 'text-gray-400' : 'text-gray-500'
                    }`}
                  >
                    {index + 1}.
                  </span>
                )}

                {/* Input field */}
                <div className="relative">
                  <input
                    ref={(el) => {
                      inputRefs.current[index] = el;
                    }}
                    type="text"
                    value={word}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      handleInputChange(index, e.target.value)
                    }
                    onFocus={() => setFocusedIndex(index)}
                    onBlur={() => {
                      // Delay hiding suggestions to allow click
                      setTimeout(() => {
                        if (focusedIndex === index) {
                          setSuggestions([]);
                        }
                      }, 150);
                    }}
                    onPaste={(e: React.ClipboardEvent<HTMLInputElement>) => handlePaste(e, index)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => handleKeyDown(e, index)}
                    disabled={disabled}
                    className={getInputClass(word)}
                    placeholder=""
                    aria-label={`Recovery phrase word ${index + 1}`}
                    aria-describedby={
                      hasValue ? (isValid ? `word-${index}-valid` : `word-${index}-invalid`) : undefined
                    }
                    aria-invalid={hasValue && !isValid}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                  />

                  {/* Validation indicator */}
                  {hasValue && (
                    <span
                      className="absolute right-2 top-1/2 -translate-y-1/2"
                      id={isValid ? `word-${index}-valid` : `word-${index}-invalid`}
                    >
                      {isValid ? (
                        <Check className="w-3.5 h-3.5 text-green-500" aria-label="Valid word" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 text-red-400" aria-label="Invalid word" />
                      )}
                    </span>
                  )}

                  {/* Autocomplete dropdown */}
                  {showSuggestions && (
                    <div className={dropdownClass} role="listbox" aria-label="Word suggestions">
                      {suggestions.map((suggestion, i) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => selectSuggestion(index, suggestion)}
                          onMouseEnter={() => setHighlightedSuggestion(i)}
                          className={getSuggestionClass(highlightedSuggestion === i)}
                          role="option"
                          aria-selected={highlightedSuggestion === i}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      {/* Progress indicator */}
      <div className={`mt-3 text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        <div className="flex items-center justify-between">
          <span>{value.filter((w) => isValidWord(w)).length} of 24 words entered</span>
          {value.some((w) => w && !isValidWord(w)) && (
            <span className="text-red-500 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              Some words are invalid
            </span>
          )}
        </div>
        {/* Progress bar */}
        <div className={`mt-1 h-1 rounded-full ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
          <div
            className="h-full bg-green-500 rounded-full transition-all duration-300"
            style={{ width: `${(value.filter((w) => isValidWord(w)).length / 24) * 100}%` }}
          />
        </div>
      </div>

      {/* Keyboard hint */}
      <p className={`mt-2 text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
        Tip: Press Tab or Space to move to next word. Paste your full phrase to auto-fill all
        fields.
      </p>
    </div>
  );
};

export default RecoveryPhraseInput;
