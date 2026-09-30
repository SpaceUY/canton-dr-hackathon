import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { split, combine } from "shamir-secret-sharing";
import { encryptFile, decryptFile } from "./crypto.js";

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
