import express from 'express';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { ITerminalAddon as HeadlessTerminalAddon } from '@xterm/headless';
import type { ConvoState, ThreadRecord } from '../_types';
import {
  buildAgentLaunch,
  discoverCodexSessionId,
  findExistingSession,
  installCodexHooks,
  initSessionState,
  isAgentKind,
  type AgentKind,
  type AgentLaunchMode,
} from './agent-kinds.js';
import { threadTerminalEnv } from './terminal-context.js';
import { DEFAULT_CONVO_ID, listThreadFiles } from './thread-store.js';
import { clearWorkingState, workingStateProgressPath } from './working-state.js';

function convoSessionKey(threadId: string, convoId: string): string {
  return `${threadId}:${convoId}`;
}

//
// Session State
//

type PtySession = {
  threadId: string;
  convoId: string;
  kind: AgentKind;
  pty: IPty;
  screen: HeadlessTerminal;
  serializeAddon: SerializeAddon;
  renderQueue: Promise<unknown>;
  clients: Set<WebSocket>;
  ptyHandle: string;
  sessionId: string;
  cols: number;
  rows: number;
};

type TokenInfo = {
  threadId: string;
  convoId: string;
};

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const SCREEN_SCROLLBACK = 1000;
const PTY_CWD = process.env.THREADS_PTY_CWD ?? process.cwd();

function clampSize(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(2, Math.min(1000, Math.floor(n)));
}

// keyed by convoSessionKey(threadId, convoId). a thread may have many convos
// running concurrently; the convoId disambiguates.
const sessions = new Map<string, PtySession>();
const tokens = new Map<string, TokenInfo>();

// remember which working directories we've already installed codex hooks
// into, so concurrent codex spawns in the same dir don't fight over the
// hooks.json file.
const codexHooksInstalled = new Set<string>();

function ensureCodexHooksFor(workingDirectory: string): void {
  if (codexHooksInstalled.has(workingDirectory)) return;
  try {
    installCodexHooks(workingDirectory);
    codexHooksInstalled.add(workingDirectory);
  } catch (error) {
    console.error('[supervisor] failed to install codex hooks for', workingDirectory, error);
  }
}

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
    } catch (_error) {
      void _error;
      /* missing helper for this platform is fine */
    }
  }
}

//
// Protocol Text
//

function ancestorChain(thread: ThreadRecord): ThreadRecord[] {
  if (!thread.parentId) return [];
  const byId = new Map(listThreadFiles().map((t) => [t.id, t]));
  const chain: ThreadRecord[] = [];
  const seen = new Set<string>([thread.id]);
  let cursor = byId.get(thread.parentId);
  while (cursor && !seen.has(cursor.id)) {
    chain.push(cursor);
    seen.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  // walked child -> parent; flip so outermost ancestor is first.
  chain.reverse();
  return chain;
}

function protocolText(args: { thread: ThreadRecord; convoId: string; convo: ConvoState }): string {
  const { thread, convoId, convo } = args;
  const path = join(process.cwd(), 'threads-protocol.md');
  const rawBase = existsSync(path)
    ? readFileSync(path, 'utf8')
    : 'You are participating in Threads.';
  // tokens substituted at launch so reminders in the protocol can inline the
  // current thread's note path directly instead of saying "see the Current
  // thread block below".
  const base = rawBase.replaceAll('{{noteFile}}', thread.filePath);
  const parts: string[] = [
    base.trim(),
    '',
    'Current thread:',
    `- id: ${thread.id}`,
    `- title: ${thread.title}`,
    `- file: ${thread.filePath}`,
    '',
    'Current convo:',
    `- id: ${convoId}`,
    `- name: ${convo.name ?? convoId}`,
    `- kind: ${convo.kind}`,
  ];
  // inline ancestor + current thread note contents. paths-only didn't work --
  // the agent skipped the suggested Reads on first turn and answered without
  // ancestor context. inlining puts the contents in front of the model
  // immediately; the trailing instruction tells the agent to re-Read these
  // same paths during the session so live edits land (only Read-tracked
  // files get change notifications from claude-code).
  const chain = [...ancestorChain(thread), thread];
  for (const node of chain) {
    let body: string;
    try {
      body = readFileSync(node.filePath, 'utf8');
    } catch (error) {
      body = `(failed to read: ${error instanceof Error ? error.message : String(error)})`;
    }
    parts.push('', `== Thread note: ${node.filePath} ==`, body.trimEnd());
  }
  parts.push(
    '',
    `IMPORTANT: The thread-note contents above are a snapshot from PTY spawn time. Re-read these paths periodically during the session with the Read tool so live edits land — only files the harness has tracked via Read get change notifications. Re-Read at minimum before any non-trivial action that depends on thread state. Your OWN note is ${thread.filePath}; the others are ancestor context.`,
    '',
    'IMPORTANT: The threads directory contains an `archived/` subdirectory holding archived thread notes. Ignore it by default — do not list, read, or grep inside `archived/` as part of routine exploration of the threads tree. Archived material is not active context, and including it wastes time and produces confused conclusions. Only look inside `archived/` if the current task explicitly involves an archived thread (the user names it or asks for archived material).'
  );
  return parts.join('\n');
}

//
// Launch Mode Resolution
//

function resolveLaunchMode(args: {
  kind: AgentKind;
  thread: ThreadRecord;
  convo: ConvoState;
  parentClaudeSessionId?: string;
}): { mode: AgentLaunchMode; resumed: boolean } {
  const stored = args.convo.session_id;
  const existing = findExistingSession({
    kind: args.kind,
    workingDirectory: PTY_CWD,
    sessionId: stored,
  });
  if (existing) {
    return {
      mode: { kind: 'resume', parentSessionId: existing },
      resumed: true,
    };
  }
  // fork only applies to the default claude convo on a fork_parent thread,
  // matching the previous single-convo behavior.
  if (args.kind === 'claude' && args.thread.forkParent && args.parentClaudeSessionId && !stored) {
    return {
      mode: {
        kind: 'fork',
        sessionId: randomUUID(),
        parentSessionId: args.parentClaudeSessionId,
      },
      resumed: false,
    };
  }
  // codex assigns its own session id on fresh; pass undefined so
  // buildCodexLaunch knows not to pin one. claude always pins via
  // --session-id, so generate one up front.
  const sessionId = args.kind === 'claude' ? randomUUID() : undefined;
  return { mode: { kind: 'fresh', sessionId }, resumed: false };
}

//
// PTY Lifecycle
//

function broadcast(session: PtySession, body: unknown): void {
  const payload = JSON.stringify(body);
  for (const client of session.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

// `screen.write` is async; serialize after a chain of writes by waiting until
// the renderQueue stops growing.
function queueScreenOperation(session: PtySession, op: () => Promise<void> | void): void {
  session.renderQueue = session.renderQueue
    .catch(() => undefined)
    .then(op)
    .catch((error) => {
      console.error('[supervisor] screen render failed', error);
    });
}

function queueScreenWrite(session: PtySession, data: string): void {
  queueScreenOperation(
    session,
    () => new Promise<void>((done) => session.screen.write(data, done))
  );
}

function queueScreenResize(session: PtySession, cols: number, rows: number): void {
  queueScreenOperation(session, () => {
    session.screen.resize(cols, rows);
  });
}

async function waitForStableScreen(session: PtySession): Promise<void> {
  while (true) {
    const current = session.renderQueue;
    await current.catch(() => undefined);
    if (session.renderQueue === current) return;
  }
}

function serializedScreen(session: PtySession): string {
  return session.serializeAddon.serialize({ scrollback: SCREEN_SCROLLBACK });
}

function spawnConvoPty(args: {
  thread: ThreadRecord;
  convoId: string;
  convo: ConvoState;
  parentClaudeSessionId?: string;
  size?: { cols: number; rows: number };
}): PtySession {
  const { thread, convoId, convo } = args;
  if (!existsSync(PTY_CWD)) {
    throw new Error(`working directory does not exist: ${PTY_CWD}`);
  }
  const kind: AgentKind = convo.kind;
  if (kind === 'codex') ensureCodexHooksFor(PTY_CWD);
  const ptyHandle = convo.pty_handle || randomUUID();
  const { mode, resumed } = resolveLaunchMode({
    kind,
    thread,
    convo,
    parentClaudeSessionId: args.parentClaudeSessionId,
  });
  if (convo.session_id && !resumed) {
    console.warn(`[supervisor] stale ${kind} session for ${thread.id}:${convoId}; starting fresh`);
  }
  // per-convo auto_prompt wins; fall back to thread.autoPrompt for the
  // default convo so legacy thread-level auto_prompt behavior keeps working.
  const autoPrompt =
    convo.auto_prompt ?? (convoId === DEFAULT_CONVO_ID ? thread.autoPrompt : undefined);
  const launch = buildAgentLaunch({
    kind,
    thread,
    mode,
    protocolText: protocolText({ thread, convoId, convo }),
    autoPrompt,
  });
  // sessionId is known up front for claude; for codex fresh launches we'll
  // discover it after spawn via discoverCodexSessionId.
  const knownSessionId = launch.sessionId ?? '';
  if (knownSessionId) initSessionState(knownSessionId);
  console.log(
    `[supervisor] spawn ${thread.id}:${convoId} kind=${kind} mode=${mode.kind} sessionId=${knownSessionId || '(pending)'}`
  );
  const spawnAtMs = Date.now();
  const cols = clampSize(args.size?.cols, DEFAULT_COLS);
  const rows = clampSize(args.size?.rows, DEFAULT_ROWS);
  const env = threadTerminalEnv(thread);
  // Progress file is keyed by (threadId, convoId) so it's available before
  // sessionId is known -- codex fresh launches don't have a session id until
  // discoverCodexSessionId resolves post-spawn.
  env.THREADS_PROGRESS_FILE = workingStateProgressPath(thread.id, convoId);
  const pty = ptySpawn('/bin/zsh', ['-l', '-c', launch.command], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: PTY_CWD,
    env,
  });
  const screen = new HeadlessTerminal({
    allowProposedApi: true,
    cols,
    rows,
    convertEol: false,
    scrollback: SCREEN_SCROLLBACK,
  });
  const serializeAddon = new SerializeAddon();
  screen.loadAddon(serializeAddon as unknown as HeadlessTerminalAddon);
  const session: PtySession = {
    threadId: thread.id,
    convoId,
    kind,
    pty,
    screen,
    serializeAddon,
    renderQueue: Promise.resolve(),
    clients: new Set(),
    ptyHandle,
    sessionId: knownSessionId,
    cols,
    rows,
  };
  const key = convoSessionKey(thread.id, convoId);
  sessions.set(key, session);
  pty.onData((data) => {
    queueScreenWrite(session, data);
    broadcast(session, { kind: 'data', data });
  });
  pty.onExit(({ exitCode }) => {
    broadcast(session, { kind: 'exit', exitCode });
    for (const client of session.clients) client.close();
    sessions.delete(key);
    clearWorkingState({
      sessionId: session.sessionId || undefined,
      threadId: session.threadId,
      convoId: session.convoId,
    });
  });
  // codex fresh: discover session id from ~/.codex/sessions/YYYY/MM/DD/
  // post-spawn. update the convo frontmatter on success so a future restart
  // resumes the same session. claude pins via --session-id, so this branch
  // only runs for codex fresh.
  if (kind === 'codex' && mode.kind === 'fresh') {
    void (async () => {
      const discovered = await discoverCodexSessionId({
        afterMs: spawnAtMs,
        cwd: PTY_CWD,
      });
      if (!discovered) {
        console.warn(
          `[supervisor] codex session-id discovery timed out for ${thread.id}:${convoId}`
        );
        return;
      }
      const live = sessions.get(key);
      if (!live) return;
      live.sessionId = discovered;
      initSessionState(discovered);
      // propagate to api so it can persist to frontmatter. supervisor doesn't
      // talk to thread-store directly (it would race with the api watcher);
      // emit a side-channel message that the api watcher picks up via a tiny
      // callback. for now, log and rely on the api to call /api/pty/sessions
      // and write back when it sees the field populated.
      console.log(`[supervisor] codex session discovered ${thread.id}:${convoId} = ${discovered}`);
    })();
  }
  return session;
}

function ensureSession(args: {
  thread: ThreadRecord;
  convoId: string;
  convo: ConvoState;
  parentClaudeSessionId?: string;
  size?: { cols: number; rows: number };
}): PtySession {
  const key = convoSessionKey(args.thread.id, args.convoId);
  const existing = sessions.get(key);
  if (existing) {
    if (args.size) resizeSession(existing, args.size.cols, args.size.rows);
    return existing;
  }
  return spawnConvoPty(args);
}

function resizeSession(session: PtySession, cols: number, rows: number): void {
  const c = clampSize(cols, session.cols);
  const r = clampSize(rows, session.rows);
  if (c === session.cols && r === session.rows) return;
  session.cols = c;
  session.rows = r;
  try {
    session.pty.resize(c, r);
  } catch (_error) {
    void _error;
    /* pty may have already exited */
  }
  queueScreenResize(session, c, r);
}

//
// HTTP
//

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/pty/sessions', (_req, res) => {
  res.json({
    sessions: Array.from(sessions.values()).map((session) => ({
      threadId: session.threadId,
      convoId: session.convoId,
      kind: session.kind,
      sessionId: session.sessionId || null,
      ptyHandle: session.ptyHandle,
    })),
  });
});

app.post('/api/pty/ensure', (req, res) => {
  const thread = req.body?.thread as ThreadRecord | undefined;
  const parentClaudeSessionId =
    typeof req.body?.parentClaudeSessionId === 'string'
      ? req.body.parentClaudeSessionId
      : undefined;
  if (!thread?.id) return res.status(400).json({ error: 'thread is required' });
  const convoIdRaw = typeof req.body?.convoId === 'string' ? req.body.convoId : DEFAULT_CONVO_ID;
  const convoId = convoIdRaw || DEFAULT_CONVO_ID;
  const explicitKind = req.body?.kind;
  const convoFromThread = thread.convos?.[convoId];
  const kindCandidate =
    convoFromThread?.kind ?? (isAgentKind(explicitKind) ? explicitKind : 'claude');
  const kind: AgentKind = isAgentKind(kindCandidate) ? kindCandidate : 'claude';
  const convo: ConvoState = convoFromThread ?? { kind };
  const colsRaw = Number(req.body?.cols);
  const rowsRaw = Number(req.body?.rows);
  const size =
    Number.isFinite(colsRaw) && Number.isFinite(rowsRaw) && colsRaw > 0 && rowsRaw > 0
      ? { cols: colsRaw, rows: rowsRaw }
      : undefined;
  try {
    const session = ensureSession({
      thread,
      convoId,
      convo,
      parentClaudeSessionId,
      size,
    });
    const token = randomUUID();
    tokens.set(token, { threadId: thread.id, convoId });
    setTimeout(() => tokens.delete(token), 60_000);
    res.json({
      token,
      ptyHandle: session.ptyHandle,
      sessionId: session.sessionId,
      kind: session.kind,
      convoId: session.convoId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

// kill a single convo's pty. the api invokes this when the user closes a tab
// or removes a convo from the thread frontmatter.
app.delete('/api/pty/sessions/:threadId/:convoId', (req, res) => {
  const session = sessions.get(convoSessionKey(req.params.threadId, req.params.convoId));
  if (!session) return res.json({ killed: false });
  session.pty.kill();
  res.json({ killed: true });
});

// kill every convo's pty for a thread. used when the thread .md file is
// deleted (the watcher calls this; we then cleanly orphan all the convo
// ptys before the thread record disappears).
app.delete('/api/pty/sessions/:threadId', (req, res) => {
  let killed = 0;
  for (const session of sessions.values()) {
    if (session.threadId !== req.params.threadId) continue;
    session.pty.kill();
    killed += 1;
  }
  res.json({ killed: killed > 0, count: killed });
});

app.post('/api/pty/sessions/:threadId/:convoId/input', (req, res) => {
  const session = sessions.get(convoSessionKey(req.params.threadId, req.params.convoId));
  if (!session) return res.status(404).json({ error: 'no session' });
  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  if (!data) return res.status(400).json({ error: 'data required' });
  session.pty.write(data);
  res.json({ ok: true });
});

// back-compat: writing to a thread (no convoId) targets the default convo.
// the api file-watcher's auto_prompt deliverer still uses this path.
app.post('/api/pty/sessions/:threadId/input', (req, res) => {
  const session = sessions.get(convoSessionKey(req.params.threadId, DEFAULT_CONVO_ID));
  if (!session) return res.status(404).json({ error: 'no session' });
  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  if (!data) return res.status(400).json({ error: 'data required' });
  session.pty.write(data);
  res.json({ ok: true });
});

//
// WebSocket
//

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://threads-pty-supervisor');
  const match = url.pathname.match(/^\/api\/pty\/([^/]+)$/);
  if (!match) return;
  const token = match[1]!;
  const info = tokens.get(token);
  const session = info ? sessions.get(convoSessionKey(info.threadId, info.convoId)) : null;
  if (!session) {
    socket.destroy();
    return;
  }
  tokens.delete(token);
  const colsRaw = Number(url.searchParams.get('cols'));
  const rowsRaw = Number(url.searchParams.get('rows'));
  if (Number.isFinite(colsRaw) && Number.isFinite(rowsRaw) && colsRaw > 0 && rowsRaw > 0) {
    resizeSession(session, colsRaw, rowsRaw);
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachClient(ws, session));
});

function attachClient(ws: WebSocket, session: PtySession): void {
  ws.send(JSON.stringify({ kind: 'size', cols: session.cols, rows: session.rows }));
  void (async () => {
    try {
      await waitForStableScreen(session);
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ kind: 'replay', data: serializedScreen(session) }));
    } catch (error) {
      console.error('[supervisor] replay failed', error);
    } finally {
      if (ws.readyState === ws.OPEN) session.clients.add(ws);
    }
  })();
  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_error) {
      void _error;
      return;
    }
    if (msg.kind === 'input' && typeof msg.data === 'string') {
      session.pty.write(msg.data);
    } else if (msg.kind === 'resize') {
      resizeSession(session, Number(msg.cols), Number(msg.rows));
    }
  });
  ws.on('close', () => {
    session.clients.delete(ws);
  });
}

//
// Boot
//

const socketPath = process.env.THREADS_PTY_SOCKET;
if (!socketPath) throw new Error('THREADS_PTY_SOCKET is required');

const pidPath = join(dirname(socketPath), 'supervisor.pid');

repairNodePtySpawnHelper();
mkdirSync(dirname(socketPath), { recursive: true });
if (existsSync(socketPath)) unlinkSync(socketPath);
writeFileSync(pidPath, String(process.pid), 'utf8');

// pre-install codex hooks for every known thread working directory at boot.
// idempotent; covers the case where a thread spawns its first codex convo
// before any hook write would otherwise happen.
try {
  ensureCodexHooksFor(PTY_CWD);
} catch (error) {
  console.error('[supervisor] boot-time codex hooks install failed', error);
}

function cleanupOnExit(): void {
  try {
    if (readFileSync(pidPath, 'utf8').trim() === String(process.pid)) unlinkSync(pidPath);
  } catch (_error) {
    void _error;
    /* pidfile may already be gone */
  }
}
process.on('exit', cleanupOnExit);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    cleanupOnExit();
    process.exit(0);
  });
}

server.listen(socketPath, () => {
  try {
    chmodSync(socketPath, 0o600);
  } catch (_error) {
    void _error;
    /* socket chmod is best-effort */
  }
  console.log(`threads pty supervisor listening on ${socketPath} (pid ${process.pid})`);
});
