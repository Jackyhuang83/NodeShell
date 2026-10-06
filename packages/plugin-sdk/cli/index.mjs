#!/usr/bin/env node
/**
 * First-party plugin helper used by NodeShell's bundled plugins.
 *
 * Run from a plugin directory (npm run build inside plugins/<id>/ does).
 */

import process from "node:process";
import { applyPatches, build } from "./commands/build.mjs";
import { readManifest } from "./lib/plugin-dir.mjs";
import { validate } from "./commands/validate.mjs";
import { test } from "./commands/test.mjs";

const COMMANDS = {
  build,
  patch: async ({ cwd }) => applyPatches(cwd, readManifest(cwd).id),
  validate,
  test,
};

const [command, ...args] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  console.log(
    [
      "Usage: termix-plugin <command>",
      "",
      "  build      Bundle the plugin into dist/",
      "  patch      Apply the plugin's dependency patches (build does this too)",
      "  validate   Check manifest.json and the files it names",
      "  test       Run the plugin's vitest suite",
    ].join("\n"),
  );
  process.exit(command ? 0 : 1);
}

const run = COMMANDS[command];
if (!run) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

try {
  await run({ cwd: process.cwd(), args });
} catch (error) {
  console.error(error?.message ?? error);
  process.exit(1);
}
