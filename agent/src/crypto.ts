import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Encrypts `inputPath` under a freshly generated key and writes
// [iv][authTag][ciphertext] to `outputPath`. Returns the key — nothing here
// persists it; the caller is responsible for splitting it with Shamir.
export async function encryptFile(inputPath: string, outputPath: string): Promise<Uint8Array> {
  const key = randomBytes(KEY_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const plaintext = await readFile(inputPath);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  await writeFile(outputPath, Buffer.concat([iv, authTag, ciphertext]));
  // shamir-secret-sharing checks `secret.constructor === Uint8Array` — a
  // Node Buffer (constructor === Buffer) fails that even though it's a
  // Uint8Array subclass, so return a plain one.
  return new Uint8Array(key);
}

export async function decryptFile(
  inputPath: string,
  outputPath: string,
  key: Uint8Array,
): Promise<void> {
  const data = await readFile(inputPath);
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  await writeFile(outputPath, plaintext);
}
