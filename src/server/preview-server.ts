import { spawn, type ChildProcess } from 'node:child_process';
import type * as types from '../_types';

//
// Process State
//

const tailnetHost = process.env.THREADS_PUBLIC_HOST ?? '127.0.0.1';

type RunningPreview = {
  proc: ChildProcess;
  fingerprint: string;
};

const running = new Map<number, RunningPreview>();

//
// Probe
//

async function isServing(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://${tailnetHost}:${port}/`, {
      signal: controller.signal,
      redirect: 'manual',
    });
    return response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

//
// Spawn
//

function spawnPreview(cwd: string, command: string): ChildProcess {
  const env = { ...process.env };
  return spawn('/bin/zsh', ['-l', '-c', command], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function previewFingerprint(cwd: string, command: string, port: number): string {
  return JSON.stringify({ cwd, command, port });
}

function drainPreviewOutput(proc: ChildProcess, port: number): void {
  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd();
    if (text) console.log(`[preview:${port}] ${text}`);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd();
    if (text) console.error(`[preview:${port}] ${text}`);
  });
}

function stopPreview(port: number, preview: RunningPreview): void {
  running.delete(port);
  if (!preview.proc.killed && preview.proc.exitCode === null) preview.proc.kill('SIGTERM');
}

//
// Public Api
//

export const ensurePreviewRunning: typeof types.ensurePreviewRunning = async (args: {
  cwd: string;
  command: string;
  port: number;
  timeoutMs?: number;
}): Promise<{ url: string } | { error: string }> => {
  const timeoutMs = args.timeoutMs ?? 20_000;
  const url = `http://${tailnetHost}:${args.port}/`;
  const fingerprint = previewFingerprint(args.cwd, args.command, args.port);
  const current = running.get(args.port);
  const replacedRunningPreview = !!current && current.fingerprint !== fingerprint;
  if (current && current.fingerprint !== fingerprint) stopPreview(args.port, current);
  const alreadyServing = await isServing(args.port);
  if (alreadyServing) {
    if (replacedRunningPreview) {
      return {
        error: `preview port ${args.port} is still serving a previous config`,
      };
    }
    return { url };
  }
  if (!running.has(args.port)) {
    const proc = spawnPreview(args.cwd, args.command);
    drainPreviewOutput(proc, args.port);
    running.set(args.port, { proc, fingerprint });
    proc.on('close', () => {
      if (running.get(args.port)?.proc === proc) running.delete(args.port);
    });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isServing(args.port)) return { url };
  }
  return { error: `preview did not come up on port ${args.port}` };
};
