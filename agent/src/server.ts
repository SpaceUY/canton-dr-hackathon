import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";

const DATA_DIR = process.env.CUSTODY_DATA_DIR ?? "/canton/custody";

type Kind = "blob" | "share" | "identity-share";

const FILE_NAME: Record<Kind, string> = {
  blob: "blob.enc",
  share: "share.bin",
  "identity-share": "identity-share.bin",
};

function fileFor(policyId: string, kind: Kind): string {
  return join(DATA_DIR, policyId, FILE_NAME[kind]);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Custodian side of distribute/recover (plan step 4): stores whatever an
// owner's agent pushes for a given policy, and serves it back on request.
// No auth, no TLS — matches the rest of this hackathon scaffold, not
// something to run as-is outside a trusted demo network.
export function startServer(port: number): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res);
  });

  server.listen(port, () => {
    console.log(`agent server listening on :${port}, data dir ${DATA_DIR}`);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Real filesystem mtime of the blob this custodian actually holds — not a
  // separately tracked "last distributed at" record (nothing writes one),
  // so this is exactly the moment distribute() last overwrote this file,
  // no more and no less honest than that.
  const metaMatch = req.url?.match(/^\/custody\/([^/]+)\/blob\/meta$/);
  if (metaMatch) {
    const policyId = metaMatch[1] as string;
    try {
      const info = await stat(fileFor(policyId, "blob"));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ blobMtime: info.mtime.toISOString() }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.writeHead(404).end("not found");
        return;
      }
      console.error("agent server request failed:", err);
      res.writeHead(500).end("internal error");
    }
    return;
  }

  const match = req.url?.match(/^\/custody\/([^/]+)\/(blob|share|identity-share)$/);
  if (!match) {
    res.writeHead(404).end("not found");
    return;
  }
  const policyId = match[1] as string;
  const kind = match[2] as Kind;
  const filePath = fileFor(policyId, kind);

  try {
    if (req.method === "PUT") {
      const body = await readBody(req);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, body);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET") {
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
      return;
    }
    res.writeHead(405).end("method not allowed");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.writeHead(404).end("not found");
      return;
    }
    console.error("agent server request failed:", err);
    res.writeHead(500).end("internal error");
  }
}
