declare module 'argon2-browser' {
  export interface Argon2Options {
    pass: string | Uint8Array;
    salt: Uint8Array;
    time: number;
    mem: number;
    parallelism: number;
    hashLen: number;
    type: number;
  }

  export interface Argon2Result {
    hash: ArrayBuffer;
    hashHex: string;
    encoded: string;
  }

  export const ArgonType: {
    Argon2d: number;
    Argon2i: number;
    Argon2id: number;
  };

  export function hash(options: Argon2Options): Promise<Argon2Result>;

  const argon2: {
    hash: (options: Argon2Options) => Promise<Argon2Result>;
    ArgonType: typeof ArgonType;
  };

  export default argon2;
}
