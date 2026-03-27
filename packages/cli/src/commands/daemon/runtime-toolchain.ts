import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export interface NodePathFromPidResult {
  nodePath: string | null;
  error?: string;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveNodePathFromPidUnix(pid: number): NodePathFromPidResult {
  const result = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return { nodePath: null, error: `ps failed: ${normalizeError(result.error)}` };
  }

  if ((result.status ?? 1) !== 0) {
    const details = result.stderr?.trim();
    return {
      nodePath: null,
      error: details ? `ps failed: ${details}` : `ps exited with code ${result.status ?? 1}`,
    };
  }

  const resolved = result.stdout.trim();
  return resolved ? { nodePath: resolved } : { nodePath: null, error: "ps returned an empty command path" };
}

function resolveNodePathFromPidWindows(pid: number): NodePathFromPidResult {
  const result = spawnSync(
    "wmic",
    ["process", "where", `ProcessId=${pid}`, "get", "ExecutablePath", "/VALUE"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  if (result.error) {
    return { nodePath: null, error: `wmic failed: ${normalizeError(result.error)}` };
  }

  if ((result.status ?? 1) !== 0) {
    const details = result.stderr?.trim();
    return {
      nodePath: null,
      error: details ? `wmic failed: ${details}` : `wmic exited with code ${result.status ?? 1}`,
    };
  }

  // wmic output format: "ExecutablePath=C:\path\to\node.exe\r\n"
  const match = result.stdout.match(/ExecutablePath=(.+)/);
  const resolved = match?.[1]?.trim();
  return resolved ? { nodePath: resolved } : { nodePath: null, error: "wmic returned no executable path" };
}

export function resolveNodePathFromPid(pid: number): NodePathFromPidResult {
  return platform() === "win32"
    ? resolveNodePathFromPidWindows(pid)
    : resolveNodePathFromPidUnix(pid);
}
