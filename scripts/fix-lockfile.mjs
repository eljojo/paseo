#!/usr/bin/env node
// Ensure all workspace-local node_modules entries in package-lock.json have
// `resolved` and `integrity` fields. npm omits these for workspace-hoisted
// overrides, but tools like Nix's offline `npm ci` require them.
//
// This script is idempotent — running it on an already-complete lockfile
// is a no-op. Run it after `npm install` when the lockfile changes.
//
// Usage:
//   node scripts/fix-lockfile.mjs
//   node scripts/fix-lockfile.mjs path/to/package-lock.json

import fs from "fs";
import { execSync } from "child_process";

const lockPath = process.argv[2] || "package-lock.json";
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

// Collect workspace package roots (local packages, not from npm)
const workspaceRoots = new Set();
for (const [key, val] of Object.entries(lock.packages || {})) {
  if (val.link) {
    workspaceRoots.add(val.resolved || key);
  }
}

let fixed = 0;

for (const [key, val] of Object.entries(lock.packages || {})) {
  if (
    !key || // root package
    key.startsWith("node_modules/") || // top-level (already has resolved)
    val.link || // workspace link entry
    (val.resolved && val.integrity) || // already complete
    !val.version || // no version to look up
    workspaceRoots.has(key) // workspace package root (local, not on npm)
  )
    continue;

  const pkgName = key.replace(/.*node_modules\//, "");
  const version = val.version;

  try {
    const info = JSON.parse(
      execSync(`npm view ${pkgName}@${version} --json dist`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      })
    );
    if (info.tarball && info.integrity) {
      val.resolved = info.tarball;
      val.integrity = info.integrity;
      fixed++;
    }
  } catch {
    console.error(`Warning: could not fetch info for ${pkgName}@${version}`);
  }
}

fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");

if (fixed > 0) {
  console.log(`Fixed ${fixed} lockfile entries with missing resolved/integrity`);
} else {
  console.log("Lockfile is already complete");
}
