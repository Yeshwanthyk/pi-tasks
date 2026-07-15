import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import type { TaskProject } from "./types.js";

function git(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function sanitizeRemote(remote: string | undefined): string | undefined {
  return remote?.replace(/^(https?:\/\/)[^/@]+@/, "$1");
}

export function resolveProjectIdentity(cwd = process.cwd()): TaskProject {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? resolve(cwd);
  return {
    name: basename(root),
    root,
    remote: sanitizeRemote(git(root, ["config", "--get", "remote.origin.url"])),
    branch: git(root, ["branch", "--show-current"]),
  };
}

export function projectLabel(project: TaskProject | undefined): string {
  return project?.name || "unknown";
}
