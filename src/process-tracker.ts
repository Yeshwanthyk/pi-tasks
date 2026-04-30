/**
 * process-tracker.ts — Background process management for tasks.
 *
 * Tracks spawned child processes, buffers their output, and supports
 * blocking wait and graceful stop (SIGTERM → 5s → SIGKILL).
 */

import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BackgroundProcess } from "./types.js";

export interface ProcessTrackerOptions {
  outputFile?: string;
  stallCheckIntervalMs?: number;
  stallThresholdMs?: number;
  onStall?: (taskId: string, tail: string) => void;
}

export interface ProcessOutput {
  output: string;
  status: BackgroundProcess["status"];
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  command?: string;
  outputFile?: string;
}

const DEFAULT_STALL_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_STALL_THRESHOLD_MS = 45_000;
const STALL_TAIL_CHARS = 1024;
const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split("\n").pop() ?? "";
  return PROMPT_PATTERNS.some(p => p.test(lastLine));
}

export class ProcessTracker {
  private processes = new Map<string, BackgroundProcess>();

  constructor(private defaultOptions: ProcessTrackerOptions = {}) {}

  /** Register a spawned process for a task. */
  track(taskId: string, proc: ChildProcess, command?: string, outputFileOrOptions?: string | ProcessTrackerOptions): void {
    const callOptions = typeof outputFileOrOptions === "string" ? { outputFile: outputFileOrOptions } : outputFileOrOptions;
    const options = { ...this.defaultOptions, ...callOptions };
    const outputFile = options?.outputFile;
    if (outputFile) {
      mkdirSync(dirname(outputFile), { recursive: true });
      writeFileSync(outputFile, "");
    }
    const bp: BackgroundProcess = {
      taskId,
      pid: proc.pid!,
      command,
      outputFile,
      output: [],
      status: "running",
      startedAt: Date.now(),
      proc,
      abortController: new AbortController(),
      waiters: [],
    };

    let lastOutputAt = Date.now();
    let stallNotified = false;

    // Buffer stdout
    const recordOutput = (data: Buffer) => {
      const text = data.toString();
      lastOutputAt = Date.now();
      bp.output.push(text);
      if (bp.outputFile) appendFileSync(bp.outputFile, text);
    };

    proc.stdout?.on("data", recordOutput);

    // Buffer stderr
    proc.stderr?.on("data", recordOutput);

    if (options?.onStall) {
      const checkInterval = options.stallCheckIntervalMs ?? DEFAULT_STALL_CHECK_INTERVAL_MS;
      const threshold = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
      bp.watchdogTimer = setInterval(() => {
        if (bp.status !== "running" || stallNotified) return;
        if (Date.now() - lastOutputAt < threshold) return;
        const tail = bp.output.join("").slice(-STALL_TAIL_CHARS);
        if (!looksLikePrompt(tail)) return;
        stallNotified = true;
        if (bp.watchdogTimer) clearInterval(bp.watchdogTimer);
        options.onStall?.(taskId, tail);
      }, checkInterval);
      bp.watchdogTimer.unref?.();
    }

    // Handle process exit
    proc.on("close", (code, _signal) => {
      if (bp.watchdogTimer) clearInterval(bp.watchdogTimer);
      if (bp.status === "running") {
        bp.status = code === 0 ? "completed" : "error";
      }
      bp.exitCode = code ?? undefined;
      bp.completedAt = Date.now();
      // Notify all waiters
      for (const resolve of bp.waiters) resolve();
      bp.waiters = [];
    });

    proc.on("error", (err) => {
      if (bp.watchdogTimer) clearInterval(bp.watchdogTimer);
      if (bp.status === "running") {
        bp.status = "error";
        const text = `Process error: ${err.message}`;
        bp.output.push(text);
        if (bp.outputFile) appendFileSync(bp.outputFile, text);
        bp.completedAt = Date.now();
        for (const resolve of bp.waiters) resolve();
        bp.waiters = [];
      }
    });

    this.processes.set(taskId, bp);
  }

  /** Get current output and status for a task's process. */
  getOutput(taskId: string): ProcessOutput | undefined {
    const bp = this.processes.get(taskId);
    if (!bp) return undefined;
    return {
      output: bp.output.join(""),
      status: bp.status,
      exitCode: bp.exitCode,
      startedAt: bp.startedAt,
      completedAt: bp.completedAt,
      command: bp.command,
      outputFile: bp.outputFile,
    };
  }

  /** Wait for a task's process to complete, with timeout. */
  waitForCompletion(taskId: string, timeout: number, signal?: AbortSignal): Promise<ProcessOutput | undefined> {
    const bp = this.processes.get(taskId);
    if (!bp) return Promise.resolve(undefined);
    if (bp.status !== "running") return Promise.resolve(this.getOutput(taskId));

    return new Promise<ProcessOutput | undefined>((resolve) => {
      let settled = false;
      const timer = setTimeout(finish, timeout);

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(self.getOutput(taskId));
      }

      const self = this;
      bp.waiters.push(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /** Stop a task's background process. SIGTERM → 5s → SIGKILL. */
  async stop(taskId: string): Promise<boolean> {
    const bp = this.processes.get(taskId);
    if (!bp || bp.status !== "running") return false;

    bp.status = "stopped";
    if (bp.watchdogTimer) clearInterval(bp.watchdogTimer);
    bp.proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { bp.proc.kill("SIGKILL"); } catch { /* already dead */ }
        resolve();
      }, 5000);

      bp.proc.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    bp.completedAt = Date.now();
    for (const resolve of bp.waiters) resolve();
    bp.waiters = [];
    return true;
  }

  /** Get the process record for a task. */
  getProcess(taskId: string): BackgroundProcess | undefined {
    return this.processes.get(taskId);
  }
}
