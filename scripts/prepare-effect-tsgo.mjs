import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tsc = "./node_modules/.bin/tsc";
const effectTsgo = "./node_modules/.bin/effect-tsgo";
const { version } = JSON.parse(readFileSync("node_modules/@effect/tsgo/package.json", "utf8"));
const marker = `+effect-tsgo.${version}`;

function run(command, args = []) {
  return spawnSync(command, args, { encoding: "utf8" });
}

const before = run(tsc, ["--version"]);
if (before.status === 0 && before.stdout.includes(marker)) {
  process.exit(0);
}

const patched = run(effectTsgo, ["patch"]);
if (patched.status !== 0) {
  throw new Error(patched.stderr || patched.stdout || "effect-tsgo patch failed");
}

const after = run(tsc, ["--version"]);
if (after.status !== 0 || !after.stdout.includes(marker)) {
  throw new Error(after.stderr || `Effect TSGO activation failed: ${after.stdout}`);
}
