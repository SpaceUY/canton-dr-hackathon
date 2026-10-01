import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { split, combine } from "shamir-secret-sharing";
import { encryptFile, decryptFile } from "./crypto.js";
import { computeKeyFingerprint } from "./externalParty.js";

const dir = await mkdtemp(join(tmpdir(), "smoke-"));
try {
  const plaintextPath = join(dir, "plain.txt");
  const encryptedPath = join(dir, "enc.bin");
  const decryptedPath = join(dir, "decrypted.txt");

  const original = "hello canton-dr, k=2 n=3";
  await writeFile(plaintextPath, original);

  const key = await encryptFile(plaintextPath, encryptedPath);
  const shares = await split(key, 3, 2);

  // Reconstruct from shares[0] and shares[2] (skip shares[1]) — proves any
  // 2-of-3 combo works, not just adjacent ones.
  const s0 = shares[0];
  const s2 = shares[2];
  if (!s0 || !s2) throw new Error("expected 3 shares");
  const reconstructedKey = await combine([s0, s2]);

  await decryptFile(encryptedPath, decryptedPath, reconstructedKey);
  const roundTripped = await readFile(decryptedPath, "utf8");

  if (roundTripped !== original) {
    throw new Error(`mismatch: got "${roundTripped}", want "${original}"`);
  }
  console.log("SMOKE_OK: encrypt -> split -> combine(2-of-3, skipping share 1) -> decrypt round-tripped correctly");
} finally {
  await rm(dir, { recursive: true, force: true });
}

// Same scheme for the owner's identity key (distributeIdentity.ts /
// recoverIdentity.ts): split the raw PKCS8 DER, rebuild from a different
// 2-of-3 pair, and check the rebuilt key is the same Canton identity - the
// fingerprint embedded in the party id - not just "some bytes came back".
{
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyDer = new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }));
  const expected = computeKeyFingerprint(createPublicKey(privateKey));

  const shares = await split(keyDer, 3, 2);
  const s1 = shares[1];
  const s2 = shares[2];
  if (!s1 || !s2) throw new Error("expected 3 identity shares");
  const rebuilt = createPrivateKey({ key: Buffer.from(await combine([s1, s2])), format: "der", type: "pkcs8" });
  const actual = computeKeyFingerprint(createPublicKey(rebuilt));
  if (actual !== expected) {
    throw new Error(`identity fingerprint mismatch: got ${actual}, want ${expected}`);
  }

  // Below the threshold there must be nothing to recover.
  let single: Uint8Array | undefined;
  try {
    single = await combine([s1]);
  } catch {
    single = undefined;
  }
  if (single !== undefined && Buffer.from(single).equals(Buffer.from(keyDer))) {
    throw new Error("a single identity share reconstructed the key - threshold not enforced");
  }
  console.log("SMOKE_OK: identity key split -> combine(2-of-3, skipping share 0) -> same fingerprint; 1 share is not enough");
}
