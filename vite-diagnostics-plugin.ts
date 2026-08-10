import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const ENDPOINT = "/__anytogether/diagnostics";
const MAX_BODY_BYTES = 2_000_000;

function getBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Diagnostic payload is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function diagnostics(): Plugin {
  return {
    name: "anytogether-dev-diagnostics",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(ENDPOINT, async (request, response, next) => {
        if (request.method !== "POST") {
          next();
          return;
        }

        try {
          const incoming = JSON.parse(await getBody(request)) as Record<string, unknown>;
          const runId = String(incoming.runId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
          const directory = resolve(server.config.root, ".notes", "build-codex", "manual-diagnostics");
          const filePath = resolve(directory, `${runId}.json`);
          await mkdir(directory, { recursive: true });

          let existing: Record<string, unknown> = {};
          try {
            existing = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
          } catch {}

          await writeFile(filePath, `${JSON.stringify({ ...existing, ...incoming, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
          response.statusCode = 204;
          response.end();
        } catch {
          response.statusCode = 400;
          response.end("Invalid diagnostic payload");
        }
      });
    }
  };
}
