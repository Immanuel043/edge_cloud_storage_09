/**
 * Zero-Knowledge Crypto Web Worker
 *
 * Runs Argon2id and chunk encryption/decryption off the main thread
 * to prevent UI blocking during heavy crypto operations.
 *
 * Message Format:
 * { id: string, type: string, payload: Object }
 *
 * Response Format:
 * { id: string, result?: any, error?: string }
 */

// Worker-specific type definitions
interface CryptoModule {
  hkdf: (hash: (data: Uint8Array) => Uint8Array, ikm: Uint8Array, salt: Uint8Array | undefined, info: Uint8Array, length: number) => Uint8Array;
  gcm: (key: Uint8Array, iv: Uint8Array, aad?: Uint8Array) => { encrypt: (data: Uint8Array) => Uint8Array; decrypt: (data: Uint8Array) => Uint8Array };
  sha256: (data: Uint8Array) => Uint8Array;
  utf8ToBytes: (str: string) => Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}

interface Argon2Module {
  hash: (options: Argon2Options) => Promise<Argon2Result>;
  ArgonType: {
    Argon2id: number;
  };
}

interface Argon2Options {
  pass: string;
  salt: Uint8Array;
  time: number;
  mem: number;
  parallelism: number;
  hashLen: number;
  type: number;
}

interface Argon2Result {
  hash: ArrayBuffer;
  hashHex: string;
}

interface DeriveKeyOptions {
  iterations?: number;
  parallelism?: number;
}

interface WorkerMessage {
  id: string;
  type: 'deriveKey' | 'deriveKeyHKDF' | 'encryptChunk' | 'decryptChunk' | 'ping';
  payload: {
    password?: string;
    salt?: ArrayBuffer;
    options?: DeriveKeyOptions;
    masterKey?: ArrayBuffer;
    label?: string;
    chunk?: ArrayBuffer;
    fileKey?: ArrayBuffer;
    fileId?: string;
    chunkIndex?: number;
  };
}

interface WorkerResponse {
  id?: string;
  type?: string;
  result?: Uint8Array | string;
  error?: string;
}

// Worker-specific imports will be loaded dynamically
let cryptoModule: CryptoModule | null = null;
let argon2Module: Argon2Module | null = null;

/**
 * Initialize crypto modules
 */
async function initModules(): Promise<void> {
  if (cryptoModule && argon2Module) return;

  // Dynamic imports for worker context
  const [noble, argon2] = await Promise.all([
    import('@noble/hashes/hkdf.js'),
    import('argon2-browser'),
  ]);

  // Import additional modules
  const [ciphers, sha2, utils] = await Promise.all([
    import('@noble/ciphers/aes.js'),
    import('@noble/hashes/sha2.js'),
    import('@noble/hashes/utils.js'),
  ]);

  cryptoModule = {
    hkdf: noble.hkdf as any, // Type mismatch with CHash vs function
    gcm: ciphers.gcm,
    sha256: sha2.sha256,
    utf8ToBytes: utils.utf8ToBytes,
    randomBytes: (await import('@noble/ciphers/utils.js')).randomBytes,
  };

  argon2Module = (argon2 as { default?: Argon2Module }).default ?? (argon2 as unknown as Argon2Module);
}

/**
 * Derive key using Argon2id with memory fallback
 */
async function deriveKeyArgon2id(
  password: string,
  salt: ArrayBuffer,
  options: DeriveKeyOptions = {}
): Promise<Uint8Array> {
  await initModules();

  if (!argon2Module) {
    throw new Error('Argon2 module not initialized');
  }

  const memoryLevels = [65536, 32768, 16384]; // 64MB, 32MB, 16MB

  for (const memory of memoryLevels) {
    try {
      const result = await argon2Module.hash({
        pass: password,
        salt: new Uint8Array(salt),
        time: options.iterations ?? 3,
        mem: memory,
        parallelism: options.parallelism ?? 4,
        hashLen: 32,
        type: argon2Module.ArgonType.Argon2id,
      });

      return new Uint8Array(result.hash);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      const isMemoryError =
        errorMessage.includes('memory') ||
        errorMessage.includes('allocation');

      if (!isMemoryError || memory === 16384) {
        throw error;
      }
      // Continue to next memory level
    }
  }

  throw new Error('Argon2id failed at all memory levels');
}

/**
 * Derive a key using HKDF-SHA256
 */
function deriveKeyHKDF(masterKey: Uint8Array, label: string): Uint8Array {
  if (!cryptoModule) {
    throw new Error('Crypto module not initialized');
  }

  const info = cryptoModule.utf8ToBytes(label);
  return cryptoModule.hkdf(cryptoModule.sha256, masterKey, undefined, info, 32);
}

/**
 * Encrypt a chunk with AAD
 */
function encryptChunk(
  chunkData: ArrayBuffer,
  fileKey: Uint8Array,
  fileId: string,
  chunkIndex: number
): Uint8Array {
  if (!cryptoModule) {
    throw new Error('Crypto module not initialized');
  }

  // Derive chunk-specific key
  const chunkKey = deriveKeyHKDF(fileKey, `chunk:${chunkIndex}`);

  // Generate IV
  const iv = cryptoModule.randomBytes(12);

  // AAD for integrity
  const aad = cryptoModule.utf8ToBytes(`file:${fileId}:chunk:${chunkIndex}`);

  // Encrypt
  const cipher = cryptoModule.gcm(chunkKey, iv, aad);
  const encrypted = cipher.encrypt(new Uint8Array(chunkData));

  // Format: VERSION (1) + IV (12) + ciphertext + tag (16)
  const result = new Uint8Array(1 + 12 + encrypted.length);
  result[0] = 0x02; // Version 2
  result.set(iv, 1);
  result.set(encrypted, 13);

  return result;
}

/**
 * Decrypt a chunk with AAD verification
 */
function decryptChunk(
  encryptedChunk: ArrayBuffer,
  fileKey: Uint8Array,
  fileId: string,
  chunkIndex: number
): Uint8Array {
  if (!cryptoModule) {
    throw new Error('Crypto module not initialized');
  }

  const data = new Uint8Array(encryptedChunk);

  // Verify version
  if (data[0] !== 0x02) {
    throw new Error(`Unknown encryption version: ${data[0]}`);
  }

  // Extract components
  const iv = data.slice(1, 13);
  const ciphertext = data.slice(13);

  // Derive chunk-specific key
  const chunkKey = deriveKeyHKDF(fileKey, `chunk:${chunkIndex}`);

  // Reconstruct AAD
  const aad = cryptoModule.utf8ToBytes(`file:${fileId}:chunk:${chunkIndex}`);

  // Decrypt
  const cipher = cryptoModule.gcm(chunkKey, iv, aad);
  return cipher.decrypt(ciphertext);
}

/**
 * Handle incoming messages
 */
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { id, type, payload } = event.data;

  try {
    await initModules();

    let result: Uint8Array | string | undefined;
    let transfer: Transferable[] = [];

    switch (type) {
      case 'deriveKey': {
        if (!payload.password || !payload.salt) {
          throw new Error('Missing password or salt');
        }
        result = await deriveKeyArgon2id(
          payload.password,
          payload.salt,
          payload.options
        );
        transfer = [result.buffer];
        break;
      }

      case 'deriveKeyHKDF': {
        if (!payload.masterKey || !payload.label) {
          throw new Error('Missing masterKey or label');
        }
        result = deriveKeyHKDF(
          new Uint8Array(payload.masterKey),
          payload.label
        );
        transfer = [result.buffer];
        break;
      }

      case 'encryptChunk': {
        if (!payload.chunk || !payload.fileKey || !payload.fileId || payload.chunkIndex === undefined) {
          throw new Error('Missing required encryption parameters');
        }
        result = encryptChunk(
          payload.chunk,
          new Uint8Array(payload.fileKey),
          payload.fileId,
          payload.chunkIndex
        );
        transfer = [result.buffer];
        break;
      }

      case 'decryptChunk': {
        if (!payload.chunk || !payload.fileKey || !payload.fileId || payload.chunkIndex === undefined) {
          throw new Error('Missing required decryption parameters');
        }
        result = decryptChunk(
          payload.chunk,
          new Uint8Array(payload.fileKey),
          payload.fileId,
          payload.chunkIndex
        );
        transfer = [result.buffer];
        break;
      }

      case 'ping': {
        result = 'pong';
        break;
      }

      default:
        throw new Error(`Unknown operation type: ${type}`);
    }

    // Transfer ArrayBuffers for efficiency
    self.postMessage({ id, result } as WorkerResponse, { transfer });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error in worker';
    self.postMessage({
      id,
      error: errorMessage,
    } as WorkerResponse);
  }
};

// Signal worker is ready
self.postMessage({ type: 'ready' } as WorkerResponse);
