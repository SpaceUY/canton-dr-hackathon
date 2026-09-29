import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANTON_BIN = process.env.CANTON_BIN ?? "/canton/bin/canton";
const REMOTE_CONFIG =
  process.env.CANTON_REMOTE_CONFIG ??
  "/canton/user-config/bootstrap-remote.conf,/canton/user-config/features.conf";

// backup.ts/restore.ts/checkCommitment.ts interpolate console names (e.g.
// "participant1") as bare Scala identifiers, not quoted string literals, so
// a value containing `;` or other Scala syntax would run as arbitrary code
// with full console admin rights. Every caller that does this must validate
// through here first — real console names are always plain identifiers.
export function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a plain identifier (got '${value}')`);
  }
}

// Repair commands (export_acs/import_acs) only exist in the Scala console,
// not the Ledger JSON API — so every operation here means writing a small
// .canton script and running it as a subprocess, then reading back stdout.
export async function runCantonScript(scriptBody: string): Promise<string> {
  const scriptPath = join(tmpdir(), `agent-${randomUUID()}.canton`);
  await writeFile(scriptPath, scriptBody, "utf8");

  try {
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(CANTON_BIN, ["run", scriptPath, "-c", REMOTE_CONFIG, "--no-tty"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          // Not `stderr || stdout`: canton always prints a harmless
          // JAVA_HOME warning to stderr, so that made stderr non-empty on
          // every run and silently discarded stdout — which is where the
          // actual Scala compile/runtime error normally shows up. Include
          // both, always.
          reject(new Error(`canton run exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }
      });
    });
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}
