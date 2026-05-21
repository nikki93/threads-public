import express from 'express';
import { appendFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { watch } from 'chokidar';
import {
  archiveThreadConvo,
  createThread,
  DEFAULT_CONVO_ID,
  deleteThread,
  ensureSeedThreads,
  listThreadFiles,
  migrateArchivedLayout,
  setThreadConvo,
  threadHasChildren,
  THREADS_DIR,
  updateThread,
  getThreadById,
} from './thread-store.js';
import {
  attachPtyServer,
  ensureConvoPty,
  killConvoPty,
  killThreadPty,
  liveConvoKeys,
  listLiveConvos,
  liveThreadIds,
  writeConvoPtyInput,
} from './pty-server.js';
import { decorateGoalAutoPrompt, isAgentKind } from './agent-kinds.js';
import { ensurePreviewRunning } from './preview-server.js';
import { readClaudeSessionActivity } from './claude-jsonl.js';
import { readWorkingState, readWorkingStateProgress } from './working-state.js';
import type { ConvoState, ThreadRecord } from '../_types';

//
// App State
//

const app = express();
const eventClients = new Set<express.Response>();
const ACTIVITY_LOG_PATH = join(process.cwd(), 'activity.jsonl');
const PTY_CWD = process.env.THREADS_PTY_CWD ?? process.cwd();

app.use(express.json({ limit: '2mb' }));

//
// Thread Snapshots
//

function convoIsWorking(convo: ConvoState, convoAlive: boolean): boolean {
  if (!convoAlive) return false;
  if (!convo.session_id) return false;
  return readWorkingState(convo.session_id) === 'working';
}

function enrichThread(
  thread: ThreadRecord,
  liveIds: Set<string>,
  liveConvos: Set<string>
): ThreadRecord {
  const ptyAlive = liveIds.has(thread.id);
  const claude = thread.agents.claude;
  const activity = readClaudeSessionActivity({
    cwd: PTY_CWD,
    sessionId: claude?.session_id,
    ptyAlive,
  });
  const enrichedConvos: Record<string, ConvoState> = {};
  for (const [convoId, convo] of Object.entries(thread.convos)) {
    const convoAlive = liveConvos.has(`${thread.id}:${convoId}`);
    enrichedConvos[convoId] = {
      ...convo,
      isWorking: convoIsWorking(convo, convoAlive),
      progress: readWorkingStateProgress(thread.id, convoId),
    };
  }
  return {
    ...thread,
    hasLivePty: ptyAlive,
    isWorking: activity.isWorking,
    latestBlurb: activity.latestBlurb,
    convos: enrichedConvos,
  };
}

//
// Event Stream
//

function emitThreadsChanged(): void {
  for (const res of eventClients) res.write(`data: ${JSON.stringify({ kind: 'threads' })}\n\n`);
}

//
// Activity Log
//

function localIsoNow(date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (value: number, length = 2) => String(Math.abs(value)).padStart(length, '0');
  const offsetHours = Math.trunc(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(offsetHours)}:${pad(offsetMinutes)}`,
  ].join('');
}

function appendActivity(body: unknown): void {
  const events = Array.isArray((body as { events?: unknown })?.events)
    ? (body as { events: Array<Record<string, unknown>> }).events
    : [];
  if (events.length === 0) return;
  mkdirSync(dirname(ACTIVITY_LOG_PATH), { recursive: true });
  const lines = events
    .map((event) =>
      JSON.stringify({
        ...event,
        serverTs: localIsoNow(),
      })
    )
    .join('\n');
  appendFileSync(ACTIVITY_LOG_PATH, `${lines}\n`, 'utf8');
}

//
// Routes
//

app.get('/api/threads', async (_req, res) => {
  const [liveIds, liveConvos] = await Promise.all([liveThreadIds(), liveConvoKeys()]);
  res.json(listThreadFiles().map((thread) => enrichThread(thread, liveIds, liveConvos)));
});

app.post('/api/threads', (req, res) => {
  const thread = createThread({
    title: typeof req.body?.title === 'string' ? req.body.title : 'new thread',
    parentId: typeof req.body?.parentId === 'string' ? req.body.parentId : undefined,
    note: typeof req.body?.note === 'string' ? req.body.note : '',
  });
  emitThreadsChanged();
  res.json(enrichThread(thread, new Set(), new Set()));
});

app.patch('/api/threads/:id', (req, res) => {
  const thread = updateThread(req.params.id, {
    note: typeof req.body?.note === 'string' ? req.body.note : undefined,
    archived: typeof req.body?.archived === 'boolean' ? req.body.archived : undefined,
    notify: typeof req.body?.notify === 'boolean' ? req.body.notify : undefined,
    preview:
      req.body?.preview === null || typeof req.body?.preview === 'object'
        ? req.body.preview
        : undefined,
    previewOpen: typeof req.body?.previewOpen === 'boolean' ? req.body.previewOpen : undefined,
    order:
      req.body?.order === null
        ? null
        : typeof req.body?.order === 'number' && Number.isFinite(req.body.order)
          ? req.body.order
          : undefined,
  });
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  emitThreadsChanged();
  res.json(enrichThread(thread, new Set(), new Set()));
});

// delete a thread's .md file outright. refuses on has-children (no cascade
// in this pass). kills the thread's pty first; the watcher's unlink event
// broadcasts the removal to clients.
app.delete('/api/threads/:id', async (req, res) => {
  const thread = getThreadById(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  if (threadHasChildren(thread.id)) return res.status(409).json({ error: 'thread has children' });
  await killThreadPty(thread.id);
  const removed = deleteThread(thread.id);
  if (!removed) return res.status(404).json({ error: 'thread not found' });
  emitThreadsChanged();
  res.json({ ok: true });
});

app.post('/api/threads/:id/terminal', async (req, res) => {
  const thread = getThreadById(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  const cols = Number(req.body?.cols);
  const rows = Number(req.body?.rows);
  const size =
    Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0
      ? { cols, rows }
      : undefined;
  const convoIdRaw = typeof req.body?.convoId === 'string' ? req.body.convoId : DEFAULT_CONVO_ID;
  const kindRaw = req.body?.kind;
  const kind = isAgentKind(kindRaw) ? kindRaw : undefined;
  try {
    const result = await ensureConvoPty({
      thread,
      convoId: convoIdRaw || DEFAULT_CONVO_ID,
      kind,
      size,
    });
    emitThreadsChanged();
    res.json({
      token: result.token,
      convoId: result.convoId,
      kind: result.kind,
      thread: enrichThread(
        getThreadById(req.params.id) ?? thread,
        new Set([thread.id]),
        new Set([`${thread.id}:${result.convoId}`])
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

// kill a specific convo's pty and archive it. archived non-default convos
// stay in frontmatter (recoverable) but vanish from the active sidebar
// list. the default convo's pty is killed but the convo itself stays
// non-archived so reopening the thread spawns a fresh default.
app.delete('/api/threads/:id/convos/:convoId', async (req, res) => {
  const thread = getThreadById(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  const { convoId } = req.params;
  await killConvoPty(thread.id, convoId);
  if (convoId !== DEFAULT_CONVO_ID) archiveThreadConvo(thread.id, convoId);
  emitThreadsChanged();
  res.json({ ok: true });
});

// write input to a specific convo's pty. analogous to /api/threads/:id/input
// but per-convo. used by the api watcher's per-convo nudge in the future;
// today only the default convo receives auto_prompt nudges.
app.post('/api/threads/:id/convos/:convoId/input', async (req, res) => {
  const thread = getThreadById(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  if (!data) return res.status(400).json({ error: 'data required' });
  const ok = await writeConvoPtyInput(thread.id, req.params.convoId, data);
  if (!ok) return res.status(404).json({ error: 'no live convo' });
  res.json({ ok: true });
});

app.post('/api/threads/:id/preview', async (req, res) => {
  const thread = getThreadById(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  if (thread.preview?.url) {
    return res.json({
      url: thread.preview.url,
      label: thread.preview.label ?? 'preview',
    });
  }
  if (!thread.preview?.command || typeof thread.preview.port !== 'number') {
    return res.status(404).json({ error: 'no preview configured' });
  }
  // accept `cwd` (canonical) or `workingDirectory` (alias agents have written).
  // relative paths resolve against the PTY cwd.
  const rawCwd =
    thread.preview.cwd ??
    (thread.preview as { workingDirectory?: string }).workingDirectory ??
    null;
  const resolvedCwd = rawCwd ? (isAbsolute(rawCwd) ? rawCwd : join(PTY_CWD, rawCwd)) : PTY_CWD;
  const result = await ensurePreviewRunning({
    cwd: resolvedCwd,
    command: thread.preview.command,
    port: thread.preview.port,
  });
  if ('error' in result) return res.status(503).json(result);
  res.json({ url: result.url, label: thread.preview.label ?? 'preview' });
});

app.get('/api/events', (req, res) => {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();
  eventClients.add(res);
  req.on('close', () => eventClients.delete(res));
});

app.post('/api/activity', (req, res) => {
  appendActivity(req.body);
  res.json({ ok: true });
});

//
// Paste Image
//
// the terminal pane uploads a pasted image here; we write it to a tmp file and
// return the path so the agent can be handed a filesystem reference (claude
// code reads images from disk).

const pasteImageExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
const maxPasteImageBytes = 16_000_000;

app.post('/api/paste-image', express.json({ limit: '25mb' }), async (req, res): Promise<void> => {
  const body = req.body as { mimeType?: unknown; base64?: unknown } | null;
  const mimeRaw = body?.mimeType;
  const dataRaw = body?.base64;
  if (typeof mimeRaw !== 'string' || typeof dataRaw !== 'string') {
    res.status(400).json({ error: 'mimeType and base64 are required' });
    return;
  }
  const mimeType = mimeRaw.toLowerCase().split(';')[0]?.trim() ?? '';
  const ext = pasteImageExtensions[mimeType];
  if (!ext) {
    res.status(400).json({ error: `unsupported image type: ${mimeRaw}` });
    return;
  }
  const buffer = Buffer.from(dataRaw, 'base64');
  if (buffer.length === 0) {
    res.status(400).json({ error: 'pasted image is empty' });
    return;
  }
  if (buffer.length > maxPasteImageBytes) {
    res.status(413).json({ error: 'pasted image is too large' });
    return;
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..*$/, '');
  const id = randomUUID().replaceAll('-', '').slice(0, 8);
  const path = resolve(tmpdir(), `threads-paste-${stamp}-${id}.${ext}`);
  try {
    await writeFile(path, buffer);
    res.status(201).json({ path, bytes: buffer.length, mimeType });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'could not save pasted image';
    res.status(500).json({ error: message });
  }
});

//
// Boot
//

migrateArchivedLayout();
ensureSeedThreads();

//
// Filesystem-as-API watcher
//
// the thread directory IS the threads api. agents drive the system by writing,
// editing, and deleting .md files:
// - new file with `auto_prompt` and no live PTY    → spawn fresh, seed prompt as first user turn
// - existing file's `auto_prompt` changes, PTY alive → write prompt to existing PTY as input
// - file is deleted                                 → kill the orphan PTY
//
// dedup is in-memory: lastFiredPrompt[threadId] = the last auto_prompt value we
// acted on. boot-seeded from existing files that already have a claude session
// id so a server restart doesn't re-fire stale prompts. fresh threads with no
// session id fire on the first sweep (the intended startup spawn).

// dedup is keyed per (thread, convo): `${threadId}:${convoId}` → last auto_prompt
// value fired. boot-seeded from existing convo entries that already have a
// session id so a server restart doesn't re-fire stale prompts.
const lastFiredPrompt = new Map<string, string>();

function convoDedupKey(threadId: string, convoId: string): string {
  return `${threadId}:${convoId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeRequiredConvoPtyInput(
  threadId: string,
  convoId: string,
  data: string
): Promise<void> {
  const ok = await writeConvoPtyInput(threadId, convoId, data);
  if (!ok) throw new Error(`failed to write PTY input for ${threadId}:${convoId}`);
}

let autoPromptSweepRunning = false;
let autoPromptSweepQueued = false;
let orphanedPtySweepRunning = false;
let orphanedPtySweepQueued = false;
let autoPromptTimer: ReturnType<typeof setTimeout> | null = null;
let orphanedPtyTimer: ReturnType<typeof setTimeout> | null = null;

async function submitAutoPromptInput(args: {
  threadId: string;
  convoId: string;
  kind: 'claude' | 'codex';
  autoPrompt: string;
  sessionId?: string;
}): Promise<void> {
  const { threadId, convoId, autoPrompt } = args;
  const delivered = decorateGoalAutoPrompt(autoPrompt);
  await writeRequiredConvoPtyInput(threadId, convoId, delivered);
  await delay(60);
  await writeRequiredConvoPtyInput(threadId, convoId, '\r');
}

async function applyAutoPromptForConvo(args: {
  thread: ThreadRecord;
  convoId: string;
  kind: 'claude' | 'codex';
  autoPrompt: string;
  liveKey: boolean;
  sessionId?: string;
}): Promise<void> {
  const { thread, convoId, kind, autoPrompt, liveKey, sessionId } = args;
  const key = convoDedupKey(thread.id, convoId);
  if (lastFiredPrompt.get(key) === autoPrompt) return;
  const previousPrompt = lastFiredPrompt.get(key);
  lastFiredPrompt.set(key, autoPrompt);
  try {
    if (liveKey) {
      // running agent: deliver the prompt as new user input, then submit.
      // claude-code's Ink TUI treats a single bulk write as paste — a trailing
      // \r in that burst becomes a literal newline in the input box, not a
      // submit. splitting the text and the \r across two writes makes the
      // second one register as the Return keypress.
      await submitAutoPromptInput({
        threadId: thread.id,
        convoId,
        kind,
        autoPrompt,
        sessionId,
      });
    } else {
      // no PTY: spawn fresh. both kinds receive auto_prompt embedded in their
      // launch seed (claude via --append-system-prompt + initial prompt arg;
      // codex via protocol+autoPrompt concat in the seed). nothing to submit
      // here.
      await ensureConvoPty({ thread, convoId, kind });
    }
    emitThreadsChanged();
  } catch (error) {
    if (previousPrompt === undefined) lastFiredPrompt.delete(key);
    else lastFiredPrompt.set(key, previousPrompt);
    console.error(`auto-prompt failed for ${thread.slug}:${convoId}:`, error);
  }
}

async function sweepAutoPrompts(): Promise<void> {
  const live = await listLiveConvos();
  const liveKeys = new Set(live.map((s) => convoDedupKey(s.threadId, s.convoId)));
  for (const thread of listThreadFiles()) {
    for (const [convoId, convo] of Object.entries(thread.convos)) {
      if (convo.archived) continue;
      // per-convo auto_prompt wins. thread.autoPrompt seeds the default convo
      // for back-compat with threads that pre-date convos.
      const autoPrompt =
        convo.auto_prompt ?? (convoId === DEFAULT_CONVO_ID ? thread.autoPrompt : undefined);
      if (!autoPrompt) continue;
      await applyAutoPromptForConvo({
        thread,
        convoId,
        kind: convo.kind,
        autoPrompt,
        liveKey: liveKeys.has(convoDedupKey(thread.id, convoId)),
        sessionId: convo.session_id,
      });
    }
  }
}

async function sweepOrphanedPtys(): Promise<void> {
  const liveIds = await liveThreadIds();
  const fileIds = new Set(listThreadFiles().map((t) => t.id));
  for (const threadId of liveIds) {
    if (fileIds.has(threadId)) continue;
    await killThreadPty(threadId);
    // drop dedup entries for this thread's convos too so a future thread
    // file reincarnation fires fresh.
    for (const key of [...lastFiredPrompt.keys()]) {
      if (key.startsWith(`${threadId}:`)) lastFiredPrompt.delete(key);
    }
  }
}

function requestAutoPromptSweep(): void {
  if (autoPromptSweepRunning) {
    autoPromptSweepQueued = true;
    return;
  }
  autoPromptSweepRunning = true;
  void sweepAutoPrompts().finally(() => {
    autoPromptSweepRunning = false;
    if (!autoPromptSweepQueued) return;
    autoPromptSweepQueued = false;
    requestAutoPromptSweep();
  });
}

function requestOrphanedPtySweep(): void {
  if (orphanedPtySweepRunning) {
    orphanedPtySweepQueued = true;
    return;
  }
  orphanedPtySweepRunning = true;
  void sweepOrphanedPtys().finally(() => {
    orphanedPtySweepRunning = false;
    if (!orphanedPtySweepQueued) return;
    orphanedPtySweepQueued = false;
    requestOrphanedPtySweep();
  });
}

function scheduleAutoPromptSweep(): void {
  if (autoPromptTimer) clearTimeout(autoPromptTimer);
  autoPromptTimer = setTimeout(() => {
    autoPromptTimer = null;
    requestAutoPromptSweep();
  }, 80);
}

function scheduleOrphanedPtySweep(): void {
  if (orphanedPtyTimer) clearTimeout(orphanedPtyTimer);
  orphanedPtyTimer = setTimeout(() => {
    orphanedPtyTimer = null;
    requestOrphanedPtySweep();
  }, 80);
}

// seed dedup map so restart doesn't re-fire prompts on convos that have
// already been launched at least once (heuristic: convo has a session id).
for (const thread of listThreadFiles()) {
  for (const [convoId, convo] of Object.entries(thread.convos)) {
    if (convo.archived) continue;
    const autoPrompt =
      convo.auto_prompt ?? (convoId === DEFAULT_CONVO_ID ? thread.autoPrompt : undefined);
    if (autoPrompt && convo.session_id) {
      lastFiredPrompt.set(convoDedupKey(thread.id, convoId), autoPrompt);
    }
  }
}

// debounce the whole-list broadcast for file-watcher bursts (git add/commit can
// fire many events in a few hundred ms; each one would otherwise rebuild the
// sidebar and trash its scroll/focus state). 300ms quiet window after the most
// recent file event, 1.5s hard cap so a long burst still flushes.
let fileEventEmitTimer: ReturnType<typeof setTimeout> | null = null;
let fileEventEmitDeadline: number | null = null;

function scheduleFileEventEmit(): void {
  const now = Date.now();
  if (fileEventEmitDeadline === null) fileEventEmitDeadline = now + 1500;
  const delay = Math.max(0, Math.min(300, fileEventEmitDeadline - now));
  if (fileEventEmitTimer) clearTimeout(fileEventEmitTimer);
  fileEventEmitTimer = setTimeout(() => {
    fileEventEmitTimer = null;
    fileEventEmitDeadline = null;
    emitThreadsChanged();
  }, delay);
}

watch(THREADS_DIR, { ignoreInitial: true }).on('all', (event) => {
  scheduleFileEventEmit();
  if (event === 'add' || event === 'change') scheduleAutoPromptSweep();
  if (event === 'unlink') scheduleOrphanedPtySweep();
});

requestAutoPromptSweep();

//
// Activity pulse
//
// Recompute isWorking for every live convo by reading its working-state file,
// and emit threads-changed only when at least one transitioned. Hook writes
// happen outside our control (no fs event), so this poll is the cheapest
// correct signal. Only emitting on change keeps a hidden browser tab — which
// may have its sse handlers throttled or dropped — from missing the moment
// claude finishes: when the tab returns, the queued change event still
// arrives. Keyed per `${threadId}:${convoId}` so non-default convos drive
// their own ConvoRow indicators independently.

const lastIsWorkingByConvo = new Map<string, boolean>();
const lastProgressByConvo = new Map<string, number>();
const ACTIVITY_PULSE_MS = 2_000;

async function activityPulse(): Promise<void> {
  const liveConvos = await liveConvoKeys();
  if (liveConvos.size === 0 && lastIsWorkingByConvo.size === 0) return;
  let changed = false;
  // clear out convos that no longer have a live PTY (so a future re-launch
  // emits the working transition again).
  for (const key of [...lastIsWorkingByConvo.keys()]) {
    if (!liveConvos.has(key)) {
      lastIsWorkingByConvo.delete(key);
      lastProgressByConvo.delete(key);
      changed = true;
    }
  }
  for (const key of liveConvos) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    const threadId = key.slice(0, sep);
    const convoId = key.slice(sep + 1);
    const thread = getThreadById(threadId);
    if (!thread) continue;
    const convo = thread.convos[convoId];
    if (!convo) continue;
    const isWorking = convoIsWorking(convo, true);
    // for the default claude convo, also fold in the claude-jsonl interrupt
    // override so a cancelled turn flips back to idle even when the Stop
    // hook didn't fire (matches enrichThread's thread.isWorking).
    let effective = isWorking;
    if (convoId === DEFAULT_CONVO_ID && convo.kind === 'claude') {
      const activity = readClaudeSessionActivity({
        cwd: PTY_CWD,
        sessionId: convo.session_id,
        ptyAlive: true,
      });
      effective = activity.isWorking;
    }
    const progress = readWorkingStateProgress(threadId, convoId);
    const prevProgress = lastProgressByConvo.get(key) ?? 0;
    if (progress !== prevProgress) {
      lastProgressByConvo.set(key, progress);
      changed = true;
    }
    const prev = lastIsWorkingByConvo.get(key);
    if (prev === effective) continue;
    lastIsWorkingByConvo.set(key, effective);
    // first observation: emit only if working (so a new-but-idle convo
    // doesn't trigger noise). subsequent transitions always emit.
    if (prev !== undefined || effective) changed = true;
  }
  if (changed) emitThreadsChanged();
}

setInterval(() => void activityPulse(), ACTIVITY_PULSE_MS);

//
// Codex session-id sync
//
// Codex assigns the session id post-spawn. The supervisor discovers it and
// stores it on its in-memory session record but doesn't write to disk. We
// poll /api/pty/sessions periodically and persist any newly-discovered ids
// into the convo frontmatter so the next launch resumes via `codex resume`.
//

const lastSyncedConvoSessionId = new Map<string, string>();

async function syncConvoSessionIds(): Promise<void> {
  const live = await listLiveConvos();
  for (const summary of live) {
    if (!summary.sessionId) continue;
    const key = `${summary.threadId}:${summary.convoId}`;
    if (lastSyncedConvoSessionId.get(key) === summary.sessionId) continue;
    const thread = getThreadById(summary.threadId);
    if (!thread) continue;
    const existing = thread.convos[summary.convoId]?.session_id;
    if (existing === summary.sessionId) {
      lastSyncedConvoSessionId.set(key, summary.sessionId);
      continue;
    }
    setThreadConvo(summary.threadId, summary.convoId, {
      kind: summary.kind,
      session_id: summary.sessionId,
      ...(summary.ptyHandle ? { pty_handle: summary.ptyHandle } : {}),
    });
    lastSyncedConvoSessionId.set(key, summary.sessionId);
    emitThreadsChanged();
  }
}

setInterval(() => void syncConvoSessionIds(), 1_500);

const port = Number(process.env.THREADS_API_PORT ?? 5314);
const server = createServer(app);
attachPtyServer(server);
server.listen(port, '127.0.0.1', () => {
  console.log(`threads api on http://127.0.0.1:${port}`);
});
