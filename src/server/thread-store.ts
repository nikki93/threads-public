import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import yaml from 'js-yaml';
import type * as types from '../_types';
import type {
  AgentState,
  ConvoState,
  ThreadCreateInput,
  ThreadFrontmatter,
  ThreadPatchInput,
  ThreadRecord,
} from '../_types';

export const DEFAULT_CONVO_ID = 'default';
import { deriveThreadTitle } from '../thread-title.js';

//
// Paths
//

export const THREADS_DIR: typeof types.THREADS_DIR =
  process.env.THREADS_DIR ?? join(process.cwd(), 'threads');

// archived threads live in this subdirectory of THREADS_DIR. the directory
// itself is the primary "is archived?" signal so agents listing the threads
// dir don't trip over archived material; the `archived: true` frontmatter is
// kept in parallel so the existing field-based filtering still works.
const ARCHIVED_SUBDIR = 'archived';

//
// Types
//

type ParsedThread = {
  frontmatter: ThreadFrontmatter;
  note: string;
};

//
// Directory
//

export const ensureThreadsDir: typeof types.ensureThreadsDir = (): void => {
  mkdirSync(THREADS_DIR, { recursive: true });
  mkdirSync(join(THREADS_DIR, ARCHIVED_SUBDIR), { recursive: true });
};

//
// Frontmatter
//

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'thread';
}

function splitFrontmatter(raw: string): ParsedThread {
  if (!raw.startsWith('---\n')) {
    return {
      frontmatter: {
        id: randomUUID(),
        title: 'untitled',
      },
      note: raw,
    };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) throw new Error('frontmatter is not closed');
  const data = yaml.load(raw.slice(4, end).trim()) as Partial<ThreadFrontmatter> | null;
  const note = raw.slice(end + 4).replace(/^\n/, '');
  return {
    frontmatter: normalizeFrontmatter(data ?? {}),
    note,
  };
}

function normalizeFrontmatter(data: Partial<ThreadFrontmatter>): ThreadFrontmatter {
  return {
    id: data.id || randomUUID(),
    title: (data.title || 'untitled').toLowerCase(),
    parent_id: data.parent_id || undefined,
    agents: data.agents ?? {},
    convos: normalizeConvos(data.convos, data.agents),
    preview: data.preview,
    preview_open: data.preview_open === true ? true : undefined,
    archived: data.archived || undefined,
    notify: data.notify || undefined,
    auto_prompt:
      typeof data.auto_prompt === 'string' && data.auto_prompt.trim()
        ? data.auto_prompt
        : undefined,
    fork_parent: data.fork_parent || undefined,
    order: typeof data.order === 'number' && Number.isFinite(data.order) ? data.order : undefined,
  };
}

// back-compat: when the file has no `convos` map, synthesize a default convo
// from the legacy `agents.claude.session_id` slot. older threads on disk
// predate the convos primitive; the in-memory shape always exposes the
// default convo so api/ui code can ignore the legacy path.
function normalizeConvos(
  convos: Record<string, ConvoState> | undefined,
  agents: Record<string, AgentState> | undefined
): Record<string, ConvoState> {
  const out: Record<string, ConvoState> = {};
  if (convos) {
    for (const [convoId, state] of Object.entries(convos)) {
      if (!state || typeof state !== 'object') continue;
      const kind = state.kind === 'codex' ? 'codex' : 'claude';
      out[convoId] = {
        kind,
        ...(typeof state.name === 'string' && state.name ? { name: state.name } : {}),
        ...(typeof state.session_id === 'string' && state.session_id
          ? { session_id: state.session_id }
          : {}),
        ...(typeof state.pty_handle === 'string' && state.pty_handle
          ? { pty_handle: state.pty_handle }
          : {}),
        ...(state.archived === true ? { archived: true } : {}),
        ...(typeof state.auto_prompt === 'string' && state.auto_prompt.trim()
          ? { auto_prompt: state.auto_prompt }
          : {}),
      };
    }
  }
  const claude = agents?.claude;
  const shell = agents?.shell;
  const existing = out[DEFAULT_CONVO_ID];
  if (!existing) {
    out[DEFAULT_CONVO_ID] = {
      kind: 'claude',
      ...(claude?.session_id ? { session_id: claude.session_id } : {}),
      ...(shell?.pty_handle ? { pty_handle: shell.pty_handle } : {}),
    };
  } else if (existing.kind === 'claude') {
    // fold legacy agents.claude / agents.shell into the default convo when the
    // map exists but the slots aren't set yet (e.g. setThreadAgent ran between
    // a thread created before convos and one updated after).
    if (!existing.session_id && claude?.session_id) existing.session_id = claude.session_id;
    if (!existing.pty_handle && shell?.pty_handle) existing.pty_handle = shell.pty_handle;
  }
  return out;
}

function renderThread(frontmatter: ThreadFrontmatter, note: string): string {
  const cleanFrontmatter: ThreadFrontmatter = {
    id: frontmatter.id,
    title: frontmatter.title.toLowerCase(),
    ...(frontmatter.parent_id ? { parent_id: frontmatter.parent_id } : {}),
    ...(frontmatter.agents && Object.keys(frontmatter.agents).length
      ? { agents: frontmatter.agents }
      : {}),
    ...(frontmatter.convos && Object.keys(frontmatter.convos).length
      ? { convos: frontmatter.convos }
      : {}),
    ...(frontmatter.preview ? { preview: frontmatter.preview } : {}),
    ...(frontmatter.preview_open ? { preview_open: true } : {}),
    ...(frontmatter.archived ? { archived: true } : {}),
    ...(frontmatter.notify ? { notify: true } : {}),
    ...(frontmatter.auto_prompt ? { auto_prompt: frontmatter.auto_prompt } : {}),
    ...(frontmatter.fork_parent ? { fork_parent: true } : {}),
    ...(typeof frontmatter.order === 'number' ? { order: frontmatter.order } : {}),
  };
  return `---\n${yaml.dump(cleanFrontmatter, { lineWidth: 1000 }).trim()}\n---\n${note.replace(/^\n+/, '')}`;
}

//
// File Paths
//

function readThreadPath(path: string): ThreadRecord {
  const raw = readFileSync(path, 'utf8');
  const parsed = splitFrontmatter(raw);
  const stats = statSync(path);
  const fileName = basename(path);
  const slug = fileName.replace(/\.md$/, '');
  const depth = slug.split('__').length - 1;
  return {
    id: parsed.frontmatter.id,
    slug,
    fileName,
    filePath: path,
    title: deriveThreadTitle(parsed.note, parsed.frontmatter.title),
    parentId: parsed.frontmatter.parent_id,
    note: parsed.note,
    archived: parsed.frontmatter.archived === true,
    notify: parsed.frontmatter.notify === true,
    depth,
    mtimeMs: stats.mtimeMs,
    agents: parsed.frontmatter.agents ?? {},
    convos: parsed.frontmatter.convos ?? {},
    preview: parsed.frontmatter.preview,
    previewOpen: parsed.frontmatter.preview_open === true,
    hasLivePty: false,
    isWorking: false,
    autoPrompt:
      typeof parsed.frontmatter.auto_prompt === 'string' && parsed.frontmatter.auto_prompt.trim()
        ? parsed.frontmatter.auto_prompt
        : undefined,
    forkParent: parsed.frontmatter.fork_parent === true,
    order:
      typeof parsed.frontmatter.order === 'number' && Number.isFinite(parsed.frontmatter.order)
        ? parsed.frontmatter.order
        : undefined,
  };
}

function writeThreadPath(path: string, frontmatter: ThreadFrontmatter, note: string): void {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, renderThread(frontmatter, note), 'utf8');
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort temp cleanup */
    }
    throw error;
  }
}

function activeFilePathForSlug(slug: string): string {
  return join(THREADS_DIR, `${slug}.md`);
}

function archivedFilePathForSlug(slug: string): string {
  return join(THREADS_DIR, ARCHIVED_SUBDIR, `${slug}.md`);
}

function filePathForSlug(slug: string, archived: boolean): string {
  return archived ? archivedFilePathForSlug(slug) : activeFilePathForSlug(slug);
}

function compareThreadSlugs(a: string, b: string): number {
  const left = a.split('__');
  const right = b.split('__');
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const cmp = left[index]!.localeCompare(right[index]!);
    if (cmp !== 0) return cmp;
  }
  return left.length - right.length;
}

function uniqueSlug(base: string): string {
  let slug = base;
  let suffix = 2;
  while (existsSync(activeFilePathForSlug(slug)) || existsSync(archivedFilePathForSlug(slug))) {
    slug = `${base}--${suffix}`;
    suffix += 1;
  }
  return slug;
}

function parentSlug(parentId?: string): string | null {
  if (!parentId) return null;
  return getThreadById(parentId)?.slug ?? null;
}

//
// Public Store
//

export const listThreadFiles: typeof types.listThreadFiles = (): ThreadRecord[] => {
  ensureThreadsDir();
  const paths: string[] = [];
  for (const file of readdirSync(THREADS_DIR)) {
    if (file.endsWith('.md')) paths.push(join(THREADS_DIR, file));
  }
  const archivedDir = join(THREADS_DIR, ARCHIVED_SUBDIR);
  if (existsSync(archivedDir)) {
    for (const file of readdirSync(archivedDir)) {
      if (file.endsWith('.md')) paths.push(join(archivedDir, file));
    }
  }
  return paths
    .map((path) => {
      try {
        return readThreadPath(path);
      } catch (error) {
        console.error(`[threads] failed to read ${path}:`, error);
        return null;
      }
    })
    .filter((thread): thread is ThreadRecord => thread !== null)
    .sort((a, b) => compareThreadSlugs(a.slug, b.slug));
};

export const getThreadById: typeof types.getThreadById = (id: string): ThreadRecord | null =>
  listThreadFiles().find((thread) => thread.id === id) ?? null;

export const createThread: typeof types.createThread = (input: ThreadCreateInput): ThreadRecord => {
  ensureThreadsDir();
  const parent = parentSlug(input.parentId);
  const base = parent ? `${parent}__${slugifyTitle(input.title)}` : slugifyTitle(input.title);
  const slug = uniqueSlug(base);
  const frontmatter = normalizeFrontmatter({
    id: randomUUID(),
    title: input.title,
    parent_id: input.parentId,
  });
  const note = input.note ?? `# ${input.title}\n`;
  const path = filePathForSlug(slug, false);
  writeThreadPath(
    path,
    normalizeFrontmatter({
      ...frontmatter,
      title: deriveThreadTitle(note, input.title),
    }),
    note
  );
  return readThreadPath(path);
};

export const updateThread: typeof types.updateThread = (
  id: string,
  patch: ThreadPatchInput
): ThreadRecord | null => {
  const current = getThreadById(id);
  if (!current) return null;
  const parsed = splitFrontmatter(readFileSync(current.filePath, 'utf8'));
  const incomingNote = patch.note;
  const note = incomingNote === undefined ? parsed.note : incomingNote;
  const frontmatter = normalizeFrontmatter({
    ...parsed.frontmatter,
    title: deriveThreadTitle(note, parsed.frontmatter.title),
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    ...(patch.notify !== undefined ? { notify: patch.notify } : {}),
    ...(patch.preview !== undefined ? { preview: patch.preview ?? undefined } : {}),
    ...(patch.previewOpen !== undefined
      ? { preview_open: patch.previewOpen ? true : undefined }
      : {}),
    ...(patch.order !== undefined ? { order: patch.order ?? undefined } : {}),
  });
  const targetPath = filePathForSlug(current.slug, frontmatter.archived === true);
  writeThreadPath(targetPath, frontmatter, note);
  if (targetPath !== current.filePath && existsSync(current.filePath)) {
    unlinkSync(current.filePath);
  }
  // archive cascade: when flipping a thread to archived, also archive all
  // descendants (identified by `<slug>__` prefix). spec asks for cascade on
  // archive only -- unarchive does not cascade.
  if (patch.archived === true) {
    const prefix = `${current.slug}__`;
    for (const descendant of listThreadFiles()) {
      if (!descendant.slug.startsWith(prefix)) continue;
      if (descendant.archived) continue;
      const descParsed = splitFrontmatter(readFileSync(descendant.filePath, 'utf8'));
      const descFrontmatter = normalizeFrontmatter({
        ...descParsed.frontmatter,
        archived: true,
      });
      const descTarget = filePathForSlug(descendant.slug, true);
      writeThreadPath(descTarget, descFrontmatter, descParsed.note);
      if (descTarget !== descendant.filePath && existsSync(descendant.filePath)) {
        unlinkSync(descendant.filePath);
      }
    }
  }
  return readThreadPath(targetPath);
};

export const setThreadAgent: typeof types.setThreadAgent = (
  id: string,
  runner: string,
  patch: AgentState
): ThreadRecord | null => {
  const current = getThreadById(id);
  if (!current) return null;
  const parsed = splitFrontmatter(readFileSync(current.filePath, 'utf8'));
  const agents = parsed.frontmatter.agents ?? {};
  agents[runner] = { ...(agents[runner] ?? {}), ...patch };
  writeThreadPath(
    current.filePath,
    normalizeFrontmatter({ ...parsed.frontmatter, agents }),
    parsed.note
  );
  return readThreadPath(current.filePath);
};

export const setThreadConvo: typeof types.setThreadConvo = (
  id: string,
  convoId: string,
  patch: Partial<ConvoState>
): ThreadRecord | null => {
  const current = getThreadById(id);
  if (!current) return null;
  const parsed = splitFrontmatter(readFileSync(current.filePath, 'utf8'));
  const convos = normalizeConvos(parsed.frontmatter.convos, parsed.frontmatter.agents);
  const existing = convos[convoId] ?? { kind: 'claude' as const };
  const merged: ConvoState = {
    ...existing,
    ...patch,
    kind: patch.kind ?? existing.kind,
  };
  convos[convoId] = merged;
  // mirror the default convo's session_id back into the legacy
  // agents.claude slot so anything still reading the old shape (and the
  // resume-detection path in the supervisor for kind=claude) stays in sync.
  const agents = { ...(parsed.frontmatter.agents ?? {}) };
  if (convoId === DEFAULT_CONVO_ID && merged.kind === 'claude' && merged.session_id) {
    agents.claude = { ...(agents.claude ?? {}), session_id: merged.session_id };
  }
  if (convoId === DEFAULT_CONVO_ID && merged.pty_handle) {
    agents.shell = { ...(agents.shell ?? {}), pty_handle: merged.pty_handle };
  }
  writeThreadPath(
    current.filePath,
    normalizeFrontmatter({ ...parsed.frontmatter, agents, convos }),
    parsed.note
  );
  return readThreadPath(current.filePath);
};

export const removeThreadConvo: typeof types.removeThreadConvo = (
  id: string,
  convoId: string
): ThreadRecord | null => {
  if (convoId === DEFAULT_CONVO_ID) return getThreadById(id);
  const current = getThreadById(id);
  if (!current) return null;
  const parsed = splitFrontmatter(readFileSync(current.filePath, 'utf8'));
  const convos = { ...(parsed.frontmatter.convos ?? {}) };
  if (!(convoId in convos)) return current;
  delete convos[convoId];
  writeThreadPath(
    current.filePath,
    normalizeFrontmatter({ ...parsed.frontmatter, convos }),
    parsed.note
  );
  return readThreadPath(current.filePath);
};

// archive a non-default convo: set archived: true in frontmatter so it
// disappears from the active sidebar list but remains recoverable. caller
// is expected to kill the pty separately.
export const archiveThreadConvo: typeof types.archiveThreadConvo = (
  id: string,
  convoId: string
): ThreadRecord | null => {
  if (convoId === DEFAULT_CONVO_ID) return getThreadById(id);
  return setThreadConvo(id, convoId, { archived: true });
};

export const threadHasChildren: typeof types.threadHasChildren = (id: string): boolean =>
  listThreadFiles().some((other) => other.parentId === id);

// unlink a thread's .md file. caller is responsible for killing the pty and
// for refusing on has-children (no cascade in this pass). returns true if
// the file existed and was removed.
export const deleteThread: typeof types.deleteThread = (id: string): boolean => {
  const current = getThreadById(id);
  if (!current) return false;
  if (existsSync(current.filePath)) unlinkSync(current.filePath);
  return true;
};

//
// Archived Layout Migration
//

// reconcile each thread file's location with its `archived` frontmatter so
// the `archived/` subdir and the boolean field stay in sync. one-off at api
// boot; cheap enough to re-run idempotently.
export const migrateArchivedLayout: typeof types.migrateArchivedLayout = (): void => {
  ensureThreadsDir();
  // move top-level files marked archived: true into archived/
  for (const file of readdirSync(THREADS_DIR)) {
    if (!file.endsWith('.md')) continue;
    const path = join(THREADS_DIR, file);
    try {
      const parsed = splitFrontmatter(readFileSync(path, 'utf8'));
      if (parsed.frontmatter.archived !== true) continue;
      const target = join(THREADS_DIR, ARCHIVED_SUBDIR, file);
      mkdirSync(join(THREADS_DIR, ARCHIVED_SUBDIR), { recursive: true });
      renameSync(path, target);
    } catch (error) {
      console.error(`[threads] migrate (top->archived) failed for ${path}:`, error);
    }
  }
  // ensure files under archived/ carry `archived: true` in frontmatter
  const archivedDir = join(THREADS_DIR, ARCHIVED_SUBDIR);
  if (!existsSync(archivedDir)) return;
  for (const file of readdirSync(archivedDir)) {
    if (!file.endsWith('.md')) continue;
    const path = join(archivedDir, file);
    try {
      const parsed = splitFrontmatter(readFileSync(path, 'utf8'));
      if (parsed.frontmatter.archived === true) continue;
      writeThreadPath(
        path,
        normalizeFrontmatter({ ...parsed.frontmatter, archived: true }),
        parsed.note
      );
    } catch (error) {
      console.error(`[threads] migrate (archived flag) failed for ${path}:`, error);
    }
  }
};

//
// Seed Data
//

export const ensureSeedThreads: typeof types.ensureSeedThreads = (): void => {
  ensureThreadsDir();
  if (readdirSync(THREADS_DIR).some((file) => file.endsWith('.md'))) return;
  createThread({
    title: 'welcome',
    note: [
      '# welcome',
      '',
      'threads is a mind map and agent orchestrator backed by a directory',
      'of markdown files.',
      'each thread is a note and one or more convos -- a convo is an agent',
      'running in a terminal.',
      'threads can have subthreads, forming a tree.',
    ].join('\n'),
  });
};
