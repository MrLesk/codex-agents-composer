import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

interface JsonRpcMessage {
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

const INIT_REQUEST_ID = "init-1";
const DEFAULT_TIMEOUT_MS = 20_000;

function buildCodexPathEnv(codexBin?: string): string | undefined {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const existingPaths = (process.env.PATH || "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const nextPaths = [...existingPaths];
  const seen = new Set(existingPaths);
  const homeDir = os.homedir();

  const extras =
    process.platform === "win32"
      ? [
          process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps")
            : null,
          homeDir ? path.join(homeDir, ".cargo", "bin") : null,
          homeDir ? path.join(homeDir, "scoop", "shims") : null,
          process.env.PROGRAMDATA
            ? path.join(process.env.PROGRAMDATA, "chocolatey", "bin")
            : null,
        ]
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
          "/opt/local/bin",
          "/run/current-system/sw/bin",
          homeDir ? path.join(homeDir, ".local", "bin") : null,
          homeDir ? path.join(homeDir, ".local", "share", "mise", "shims") : null,
          homeDir ? path.join(homeDir, ".cargo", "bin") : null,
          homeDir ? path.join(homeDir, ".bun", "bin") : null,
        ];

  if (homeDir && process.platform !== "win32") {
    const nvmRoot = path.join(homeDir, ".nvm", "versions", "node");
    try {
      for (const entry of readdirSync(nvmRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        extras.push(path.join(nvmRoot, entry.name, "bin"));
      }
    } catch {
      // Ignore missing nvm installs.
    }
  }

  if (codexBin) {
    const parentDir = path.dirname(codexBin);
    extras.push(parentDir);
  }

  for (const candidate of extras) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    nextPaths.push(candidate);
  }

  return nextPaths.length > 0 ? nextPaths.join(delimiter) : undefined;
}

function resolveCodexBin(): string {
  const explicit = process.env.CODEX_BIN?.trim();
  if (explicit) {
    return explicit;
  }

  return process.platform === "win32" ? "codex.cmd" : "codex";
}

export async function callCodexAppServer<T>(
  method: string,
  params: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const codexBin = resolveCodexBin();
    const child = spawn(codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: buildCodexPathEnv(codexBin) || process.env.PATH,
      },
    });

    const rl = createInterface({ input: child.stdout });

    const requestId = "req-1";
    const stderrChunks: string[] = [];
    let settled = false;
    let initDone = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      child.kill("SIGTERM");
      fn();
    };

    const timer = setTimeout(() => {
      const stderr = stderrChunks.join("").trim();
      done(() => {
        reject(
          new Error(
            stderr
              ? `codex app-server timed out: ${stderr}`
              : "codex app-server timed out",
          ),
        );
      });
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });

    child.on("error", (error) => {
      done(() => reject(error));
    });

    child.on("exit", (code) => {
      if (settled) return;
      const stderr = stderrChunks.join("").trim();
      done(() => {
        reject(
          new Error(
            stderr || `codex app-server exited before responding (code ${code})`,
          ),
        );
      });
    });

    rl.on("line", (line: string) => {
      if (!line.trim()) return;

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }

      if (!msg.id) return;

      if (msg.id === INIT_REQUEST_ID) {
        if (msg.error) {
          const errorMessage = msg.error.message ?? "unknown error";
          done(() => {
            reject(new Error(`initialize failed: ${errorMessage}`));
          });
          return;
        }

        initDone = true;
        const requestPayload = JSON.stringify({
          id: requestId,
          method,
          params,
        });
        child.stdin.write(`${requestPayload}\n`);
        return;
      }

      if (msg.id !== requestId) return;

      if (!initDone) {
        done(() => reject(new Error("received response before initialize")));
        return;
      }

      if (msg.error) {
        const errorMessage = msg.error.message ?? "app-server request failed";
        done(() => {
          reject(new Error(errorMessage));
        });
        return;
      }

      done(() => resolve(msg.result as T));
    });

    const initPayload = JSON.stringify({
      id: INIT_REQUEST_ID,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-agents-composer",
          version: "0.1.0",
        },
        capabilities: {},
        protocolVersion: 2,
      },
    });

    child.stdin.write(`${initPayload}\n`);
  });
}
