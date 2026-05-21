import { spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { request as createHttpRequest, type IncomingMessage, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import type * as types from '../_types';
import type { ConvoKind, ThreadRecord } from '../_types';
import { DEFAULT_CONVO_ID, getThreadById, setThreadConvo } from './thread-store.js';

//
// Supervisor Config
//

const SUPERVISOR_START_TIMEOUT_MS = 5_000;
const SUPERVISOR_HEALTH_TIMEOUT_MS = 750;
const SUPERVISOR_SOCKET_PATH =
  process.env.THREADS_PTY_SOCKET ??
  join(tmpdir(), `threads-${process.getuid?.() ?? 'unknown'}`, 'pty-supervisor.sock');

type SupervisorSessionSummary = {
  threadId: string;
  convoId: string;
  kind: ConvoKind;
  sessionId: string | null;
  ptyHandle: string;
};

//
// Node PTY Install Repair
//

function repairNodePtySpawnHelper(): void {
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    try {
      chmodSync(
        join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds', arch, 'spawn-helper'),
        0o755
      );
    } catch {
      /* missing helper for this platform is fine */
    }
  }
}

//
// Supervisor Process
//

async function supervisorIsReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = createHttpRequest(
      {
        socketPath: SUPERVISOR_SOCKET_PATH,
        path: '/api/health',
        method: 'GET',
        timeout: SUPERVISOR_HEALTH_TIMEOUT_MS,
        headers: { host: 'threads-pty-supervisor' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Singleton in-flight boot promise. Without this, concurrent supervisorRequest
// callers (heartbeat tick + chokidar sweep + ws upgrade) all see "unreachable"
// at the same moment, each spawn their own supervisor, and each new supervisor
// unlinks the socket and rebinds — orphaning the previous supervisor (which
// still holds live PTYs). The boot promise serializes boots so only one
// supervisor ever exists.
let supervisorBootPromise: Promise<void> | null = null;

async function bootSupervisorOnce(): Promise<void> {
  console.log(`[pty-server] booting supervisor at ${SUPERVISOR_SOCKET_PATH}`);
  repairNodePtySpawnHelper();
  mkdirSync(dirname(SUPERVISOR_SOCKET_PATH), { recursive: true });
  const logDir = join(homedir(), 'Library', 'Logs');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'threads-pty-supervisor.log');
  let logFd: number | null = null;
  try {
    logFd = openSync(logPath, 'a');
    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const child = spawn(tsxBin, ['src/server/pty-supervisor.ts'], {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, THREADS_PTY_SOCKET: SUPERVISOR_SOCKET_PATH },
      stdio: ['ignore', logFd, logFd],
    });
    console.log(`[pty-server] spawned supervisor pid=${child.pid}`);
    child.unref();
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
  const deadline = Date.now() + SUPERVISOR_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await supervisorIsReachable()) {
      console.log(`[pty-server] supervisor is reachable`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`PTY supervisor did not start at ${SUPERVISOR_SOCKET_PATH}`);
}

async function ensurePtySupervisor(): Promise<void> {
  if (await supervisorIsReachable()) return;
  if (supervisorBootPromise) {
    console.log(`[pty-server] supervisor boot already in flight — awaiting`);
    return supervisorBootPromise;
  }
  supervisorBootPromise = bootSupervisorOnce().finally(() => {
    supervisorBootPromise = null;
  });
  return supervisorBootPromise;
}

//
// Supervisor HTTP
//

async function supervisorRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { ensure?: boolean } = {}
): Promise<T> {
  if (options.ensure !== false) {
    await ensurePtySupervisor();
  } else if (!(await supervisorIsReachable())) {
    throw new Error('PTY supervisor is not running');
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = createHttpRequest(
      {
        socketPath: SUPERVISOR_SOCKET_PATH,
        path,
        method,
        headers: {
          host: 'threads-pty-supervisor',
          accept: 'application/json',
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(text || `supervisor ${res.statusCode}`));
            return;
          }
          resolve((text ? JSON.parse(text) : {}) as T);
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

//
// Public Api
//

export const ensureConvoPty: typeof types.ensureConvoPty = async (args: {
  thread: ThreadRecord;
  convoId?: string;
  kind?: ConvoKind;
  size?: { cols: number; rows: number };
}): Promise<{
  token: string;
  ptyHandle: string;
  sessionId: string;
  convoId: string;
  kind: ConvoKind;
}> => {
  const convoId = args.convoId ?? DEFAULT_CONVO_ID;
  const explicitKind = args.kind;
  const existing = args.thread.convos?.[convoId];
  const kind: ConvoKind = existing?.kind ?? explicitKind ?? 'claude';
  let parentClaudeSessionId: string | undefined;
  if (kind === 'claude' && args.thread.forkParent && args.thread.parentId) {
    const parent = getThreadById(args.thread.parentId);
    parentClaudeSessionId = parent?.agents.claude?.session_id;
  }
  const result = await supervisorRequest<{
    token: string;
    ptyHandle: string;
    sessionId: string;
    convoId: string;
    kind: ConvoKind;
  }>('POST', '/api/pty/ensure', {
    thread: args.thread,
    convoId,
    kind,
    parentClaudeSessionId,
    cols: args.size?.cols,
    rows: args.size?.rows,
  });
  // persist what the supervisor decided into the thread frontmatter. for the
  // default convo this also mirrors back to agents.claude/agents.shell so the
  // legacy read path stays warm.
  setThreadConvo(args.thread.id, result.convoId, {
    kind: result.kind,
    ...(result.ptyHandle ? { pty_handle: result.ptyHandle } : {}),
    ...(result.sessionId ? { session_id: result.sessionId } : {}),
  });
  return result;
};

// back-compat wrapper for the single-convo callsites that still exist (the
// /api/threads/:id/terminal route, the auto_prompt sweep). always targets the
// default convo.
export const ensureThreadPty: typeof types.ensureThreadPty = async (
  thread: ThreadRecord,
  size?: { cols: number; rows: number }
): Promise<{ token: string; ptyHandle: string; sessionId: string }> => {
  const result = await ensureConvoPty({ thread, size });
  return {
    token: result.token,
    ptyHandle: result.ptyHandle,
    sessionId: result.sessionId,
  };
};

export const listLiveConvos: typeof types.listLiveConvos = async (): Promise<
  SupervisorSessionSummary[]
> => {
  try {
    const result = await supervisorRequest<{
      sessions: SupervisorSessionSummary[];
    }>('GET', '/api/pty/sessions', undefined, { ensure: false });
    return result.sessions;
  } catch {
    return [];
  }
};

export const liveConvoKeys: typeof types.liveConvoKeys = async (): Promise<Set<string>> => {
  const list = await listLiveConvos();
  return new Set(list.map((s) => `${s.threadId}:${s.convoId}`));
};

export const liveThreadIds: typeof types.liveThreadIds = async (): Promise<Set<string>> => {
  const list = await listLiveConvos();
  return new Set(list.map((session) => session.threadId));
};

export const isThreadPtyAlive: typeof types.isThreadPtyAlive = async (
  threadId: string
): Promise<boolean> => (await liveThreadIds()).has(threadId);

export const killConvoPty: typeof types.killConvoPty = async (
  threadId: string,
  convoId: string
): Promise<boolean> => {
  try {
    const result = await supervisorRequest<{ killed: boolean }>(
      'DELETE',
      `/api/pty/sessions/${threadId}/${convoId}`,
      undefined,
      { ensure: false }
    );
    return !!result.killed;
  } catch {
    return false;
  }
};

export const killThreadPty: typeof types.killThreadPty = async (
  threadId: string
): Promise<boolean> => {
  try {
    const result = await supervisorRequest<{ killed: boolean }>(
      'DELETE',
      `/api/pty/sessions/${threadId}`,
      undefined,
      { ensure: false }
    );
    return !!result.killed;
  } catch {
    return false;
  }
};

export const writeConvoPtyInput: typeof types.writeConvoPtyInput = async (
  threadId: string,
  convoId: string,
  data: string
): Promise<boolean> => {
  if (!data) return false;
  try {
    await supervisorRequest(
      'POST',
      `/api/pty/sessions/${threadId}/${convoId}/input`,
      { data },
      { ensure: false }
    );
    return true;
  } catch {
    return false;
  }
};

export const writeThreadPtyInput: typeof types.writeThreadPtyInput = async (
  threadId: string,
  data: string
): Promise<boolean> => writeConvoPtyInput(threadId, DEFAULT_CONVO_ID, data);

//
// WebSocket Proxy
//

function serializeUpgradeRequest(request: IncomingMessage): string {
  const lines = [`GET ${request.url ?? '/'} HTTP/1.1`, 'Host: threads-pty-supervisor'];
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === 'host' || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function proxyWebSocketToSupervisor(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const upstream = createConnection(SUPERVISOR_SOCKET_PATH);
  const requestBytes = serializeUpgradeRequest(request);
  upstream.on('connect', () => {
    upstream.write(requestBytes);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

export const attachPtyServer: typeof types.attachPtyServer = (server: Server): void => {
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://threads');
    if (!url.pathname.startsWith('/api/pty/')) return;
    void ensurePtySupervisor()
      .then(() => proxyWebSocketToSupervisor(request, socket, head))
      .catch(() => socket.destroy());
  });
};
