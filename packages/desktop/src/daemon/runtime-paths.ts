import { existsSync, readFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { app } from "electron";

const CLI_PACKAGE_NAME = "@getpaseo/cli";
const SERVER_PACKAGE_NAME = "@getpaseo/server";
const CLI_BIN_ENTRY = `${CLI_PACKAGE_NAME}/bin/paseo`;
const IGNORED_GUI_LAUNCH_ARG_PREFIX = "-psn_";

type PackageInfo = {
  root: string;
};

export type NodeEntrypointSpec = {
  entryPath: string;
  execArgv: string[];
};

const esmRequire = createRequire(__filename);

function findPackageRootFromResolvedPath(input: {
  resolvedPath: string;
  packageName: string;
}): PackageInfo {
  let currentDir = path.dirname(input.resolvedPath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
          name?: string;
        };
        if (pkg.name === input.packageName) {
          return {
            root: currentDir,
          };
        }
      } catch {
        // Ignore malformed package metadata while walking up.
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  throw new Error(`Unable to resolve ${input.packageName} package root`);
}

function resolveServerPackageInfo(): PackageInfo {
  const serverExportPath = esmRequire.resolve(SERVER_PACKAGE_NAME);
  return findPackageRootFromResolvedPath({
    resolvedPath: serverExportPath,
    packageName: SERVER_PACKAGE_NAME,
  });
}

function resolveCliPackageInfo(): PackageInfo {
  const cliBinPath = esmRequire.resolve(CLI_BIN_ENTRY);
  return findPackageRootFromResolvedPath({
    resolvedPath: cliBinPath,
    packageName: CLI_PACKAGE_NAME,
  });
}

function resolvePackagedAsarPath(): string {
  return path.join(process.resourcesPath, "app.asar");
}

function assertPathExists(input: { label: string; filePath: string }): string {
  if (!existsSync(input.filePath)) {
    throw new Error(`${input.label} is missing at ${input.filePath}`);
  }

  return input.filePath;
}

export function parseCliPassthroughArgsFromArgv(argv: string[]): string[] | null {
  const startIndex = process.defaultApp ? 2 : 1;
  const effective = argv
    .slice(startIndex)
    .filter(
      (arg) =>
        !arg.startsWith(IGNORED_GUI_LAUNCH_ARG_PREFIX) &&
        !arg.startsWith("--"),
    );

  return effective.length > 0 ? effective : null;
}

export function resolveDaemonRunnerEntrypoint(): NodeEntrypointSpec {
  if (app.isPackaged) {
    return {
      entryPath: assertPathExists({
        label: "Bundled daemon runner",
        filePath: path.join(
          resolvePackagedAsarPath(),
          "node_modules",
          "@getpaseo",
          "server",
          "dist",
          "scripts",
          "daemon-runner.js",
        ),
      }),
      execArgv: [],
    };
  }

  const serverPackage = resolveServerPackageInfo();
  const distRunner = path.join(serverPackage.root, "dist", "scripts", "daemon-runner.js");
  if (existsSync(distRunner)) {
    return {
      entryPath: distRunner,
      execArgv: [],
    };
  }

  return {
    entryPath: assertPathExists({
      label: "Daemon runner source",
      filePath: path.join(serverPackage.root, "scripts", "daemon-runner.ts"),
    }),
    execArgv: ["--import", "tsx"],
  };
}

export function resolveCliEntrypoint(): NodeEntrypointSpec {
  if (app.isPackaged) {
    return {
      entryPath: assertPathExists({
        label: "Bundled CLI entrypoint",
        filePath: path.join(
          resolvePackagedAsarPath(),
          "node_modules",
          "@getpaseo",
          "cli",
          "dist",
          "index.js",
        ),
      }),
      execArgv: [],
    };
  }

  const cliPackage = resolveCliPackageInfo();
  const distEntry = path.join(cliPackage.root, "dist", "index.js");
  if (existsSync(distEntry)) {
    return {
      entryPath: distEntry,
      execArgv: [],
    };
  }

  return {
    entryPath: assertPathExists({
      label: "CLI source entrypoint",
      filePath: path.join(cliPackage.root, "src", "index.ts"),
    }),
    execArgv: ["--import", "tsx"],
  };
}

export function createElectronNodeEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function spawnCliProcess(args: string[]): SpawnSyncReturns<Buffer> {
  const cli = resolveCliEntrypoint();

  return spawnSync(process.execPath, [...cli.execArgv, cli.entryPath, ...args], {
    env: createElectronNodeEnv(process.env),
    stdio: "inherit",
  });
}

export function runCliPassthroughCommand(args: string[]): number {
  const result = spawnCliProcess(args);
  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number") {
    return result.status;
  }

  return result.signal ? 1 : 0;
}
