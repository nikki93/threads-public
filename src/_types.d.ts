import type * as React from 'react';

//
// Domain Types
//

export type LayoutMode = 'split' | 'preview';

export interface AgentState {
  session_id?: string;
  pty_handle?: string;
}

export type ConvoKind = 'claude' | 'codex';

export interface ConvoState {
  kind: ConvoKind;
  name?: string;
  session_id?: string;
  pty_handle?: string;
  archived?: boolean;
  auto_prompt?: string;
  // populated server-side in `enrichThread`; reflects the per-session
  // working-state file. not stored on disk.
  isWorking?: boolean;
  // 0-100 monotonic progress estimate read from
  // `<workingStateDir>/<threadId>__<convoId>.progress`. populated server-
  // side; not stored on disk. defaults to 0 when the file is missing or
  // invalid.
  progress?: number;
}

export const DEFAULT_CONVO_ID: string;

export interface PreviewConfig {
  command?: string;
  port?: number;
  url?: string;
  label?: string;
  // working directory for `command`. relative paths resolve against the
  // PTY cwd; absolute paths are used as-is.
  cwd?: string;
}

//
// Thread Types
//

export interface ThreadFrontmatter {
  id: string;
  title: string;
  parent_id?: string;
  agents?: Record<string, AgentState>;
  convos?: Record<string, ConvoState>;
  preview?: PreviewConfig;
  preview_open?: boolean;
  archived?: boolean;
  notify?: boolean;
  auto_prompt?: string;
  fork_parent?: boolean;
  // manual sibling order within the parent. unset = sort after all
  // explicitly-ordered siblings, falling back to slug compare.
  order?: number;
}

export interface ThreadCreateInput {
  title: string;
  parentId?: string;
  note?: string;
}

export interface ThreadPatchInput {
  note?: string;
  archived?: boolean;
  notify?: boolean;
  preview?: PreviewConfig | null;
  previewOpen?: boolean;
  order?: number | null;
}

export interface ThreadRecord {
  id: string;
  slug: string;
  fileName: string;
  filePath: string;
  title: string;
  parentId?: string;
  note: string;
  archived: boolean;
  notify: boolean;
  depth: number;
  mtimeMs: number;
  agents: Record<string, AgentState>;
  convos: Record<string, ConvoState>;
  preview?: PreviewConfig;
  previewOpen: boolean;
  hasLivePty: boolean;
  isWorking: boolean;
  latestBlurb?: string;
  autoPrompt?: string;
  forkParent: boolean;
  order?: number;
}

export interface ThreadTreeNode {
  thread: ThreadRecord;
  children: ThreadTreeNode[];
}

export type SidebarItem =
  | { kind: 'thread'; threadId: string; convoId?: undefined }
  | { kind: 'convo'; threadId: string; convoId: string };

//
// Client State
//

export type FocusedPane = 'note' | 'terminal';

export type MobilePane = 'sidebar' | 'note' | 'terminal';

export interface AppState {
  threads: ThreadRecord[];
  selectedId: string | null;
  ancestorOpen: boolean;
  collapsedThreadIds: Record<string, boolean>;
  showArchived: boolean;
  autoCollapseToSelection: boolean;
  loading: boolean;
  error: string | null;
  noteDraft: string;
  noteDraftThreadId: string | null;
  noteDraftBaseline: string;
  noteSaveError: string | null;
  // keyed by `${threadId}:${convoId}`. one entry per open ws.
  terminalTokens: Record<string, string>;
  // per-thread "which convo is showing" — picked up on selection, persisted
  // across reloads, falls back to 'default' when unset.
  activeConvoByThread: Record<string, string>;
  terminalError: string | null;
  focusedPane: FocusedPane;
  mobilePane: MobilePane;
  previewUrls: Record<string, string>;
  previewLabels: Record<string, string>;
  previewConfigKeys: Record<string, string>;
  needsReviewIds: Record<string, boolean>;
  reloadAvailable: boolean;
  selectedHistory: string[];
  selectedHistoryIndex: number;
  sidebarSearchOpen: boolean;
  sidebarSearchQuery: string;
  sidebarSearchHighlightId: string | null;
}

//
// Client Api
//

export function apiGet<T>(path: string): Promise<T>;
export function apiPost<T>(path: string, body?: unknown): Promise<T>;
export function apiPatch<T>(path: string, body: unknown): Promise<T>;
export function apiDelete<T>(path: string): Promise<T>;

//
// Thread Selectors
//

export function cleanThreadTitleLine(line: string): string;
export function deriveThreadTitle(note: string, fallback?: string): string;

export function selectedThread(state: AppState): ThreadRecord | null;
export function ancestorChain(threads: ThreadRecord[], id: string): ThreadRecord[];
export function orderedThreads(threads: ThreadRecord[]): ThreadRecord[];
export function buildThreadTree(threads: ThreadRecord[]): ThreadTreeNode[];
export function pruneTreeByQuery(nodes: ThreadTreeNode[], query: string): ThreadTreeNode[];
export function matchingConvoIds(thread: ThreadRecord, query: string): string[];
export function nonDefaultConvoIds(thread: ThreadRecord, showArchived?: boolean): string[];
export function sidebarSearchItemKey(item: SidebarItem): string;
export function needsReviewKey(threadId: string, convoId: string): string;
export function visibleThreadsForSidebar(
  nodes: ThreadTreeNode[],
  collapsed: Record<string, boolean>,
  showArchived: boolean
): ThreadRecord[];
export function visibleSidebarItems(
  nodes: ThreadTreeNode[],
  collapsed: Record<string, boolean>,
  showArchived: boolean
): SidebarItem[];
export function derivedCollapsedForSelection(
  nodes: ThreadTreeNode[],
  selectedThreadId: string | null
): Record<string, boolean>;
export function effectiveCollapsedMap(state: AppState): Record<string, boolean>;

export function currentSidebarItem(state: AppState): SidebarItem | null;
export function selectSidebarItem(item: SidebarItem): void;

//
// Store Actions
//

export function loadThreads(): Promise<void>;
export function selectThread(id: string): void;
export function navigateThreadHistory(direction: -1 | 1): boolean;
export function setFocusedPane(pane: FocusedPane): void;
export function setMobilePane(pane: MobilePane): void;
export function toggleAncestor(): void;
export function toggleThreadCollapsed(id: string): void;
export function toggleShowArchived(): void;
export function toggleAutoCollapseToSelection(): void;

export function openSidebarSearch(): void;
export function closeSidebarSearch(): void;
export function setSidebarSearchQuery(query: string): void;
export function moveSidebarSearchHighlight(direction: -1 | 1): void;
export function commitSidebarSearch(): void;

export function setNoteDraft(note: string): void;
export function saveSelectedThread(): Promise<void>;

export function createRootThread(): Promise<void>;
export function createSubthread(parentId: string): Promise<void>;
export function toggleSelectedThreadArchived(): Promise<void>;
export function deleteSelectedThread(): Promise<void>;

export function openThreadTerminal(
  threadId: string,
  size?: { cols: number; rows: number }
): Promise<void>;
export function clearThreadTerminal(threadId: string): void;

export function openConvoTerminal(args: {
  threadId: string;
  convoId: string;
  kind?: ConvoKind;
  size?: { cols: number; rows: number };
}): Promise<void>;
export function clearConvoTerminal(threadId: string, convoId: string): void;
export function setActiveConvo(threadId: string, convoId: string): void;
export function spawnConvo(threadId: string, kind: ConvoKind): Promise<void>;
export function closeConvo(threadId: string, convoId: string): Promise<void>;
export function getActiveConvoId(state: AppState, threadId: string): string;

export function togglePreviewForSelected(): Promise<void>;
export function fetchPreviewUrl(threadId: string): Promise<void>;
export function threadHasPreviewConfig(thread: ThreadRecord | null | undefined): boolean;

//
// Activity
//

export function logActivity(event: string, extra?: Record<string, unknown>): void;
export function getTabOpenId(): string;

//
// Server Store
//

export const THREADS_DIR: string;

export function ensureThreadsDir(): void;
export function ensureSeedThreads(): void;
export function migrateArchivedLayout(): void;

export function listThreadFiles(): ThreadRecord[];
export function getThreadById(id: string): ThreadRecord | null;

export function createThread(input: ThreadCreateInput): ThreadRecord;
export function updateThread(id: string, patch: ThreadPatchInput): ThreadRecord | null;
export function setThreadAgent(id: string, runner: string, patch: AgentState): ThreadRecord | null;
export function setThreadConvo(
  id: string,
  convoId: string,
  patch: Partial<ConvoState>
): ThreadRecord | null;
export function removeThreadConvo(id: string, convoId: string): ThreadRecord | null;
export function archiveThreadConvo(id: string, convoId: string): ThreadRecord | null;
export function threadHasChildren(id: string): boolean;
export function deleteThread(id: string): boolean;

//
// Server Runtime
//

export function attachPtyServer(server: import('node:http').Server): void;

export interface ConvoSessionSummary {
  threadId: string;
  convoId: string;
  kind: ConvoKind;
  sessionId: string | null;
  ptyHandle: string;
}

export function ensureThreadPty(
  thread: ThreadRecord,
  size?: { cols: number; rows: number }
): Promise<{ token: string; ptyHandle: string; sessionId: string }>;
export function ensureConvoPty(args: {
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
}>;
export function isThreadPtyAlive(threadId: string): Promise<boolean>;
export function liveThreadIds(): Promise<Set<string>>;
export function liveConvoKeys(): Promise<Set<string>>;
export function listLiveConvos(): Promise<ConvoSessionSummary[]>;
export function killThreadPty(threadId: string): Promise<boolean>;
export function killConvoPty(threadId: string, convoId: string): Promise<boolean>;
export function writeThreadPtyInput(threadId: string, data: string): Promise<boolean>;
export function writeConvoPtyInput(
  threadId: string,
  convoId: string,
  data: string
): Promise<boolean>;

export function ensurePreviewRunning(args: {
  cwd: string;
  command: string;
  port: number;
  timeoutMs?: number;
}): Promise<{ url: string } | { error: string }>;

export function threadTerminalEnv(
  thread: ThreadRecord,
  baseEnv?: Record<string, string | undefined>
): Record<string, string>;

export function findClaudeSessionPath(args: { cwd: string; sessionId: string }): string | null;
export function readClaudeSessionActivity(args: {
  cwd: string;
  sessionId?: string;
  ptyAlive: boolean;
}): { isWorking: boolean; latestBlurb?: string };

//
// Components
//

export function App(): JSX.Element;

export function MobileTopTabs(): JSX.Element;

export function Sidebar(): JSX.Element;
export function SidebarRow(props: { node: ThreadTreeNode }): JSX.Element | null;

export function NotePane(): JSX.Element;
export function AncestorBreadcrumb(): JSX.Element;
export function MarkdownEditor(props: {
  threadId: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element;

export function TerminalPane(): JSX.Element;
export function TerminalView(props: {
  threadId: string;
  convoId: string;
  initialToken: string;
  active: boolean;
  onExit: () => void;
}): JSX.Element;

export function PreviewPane(): JSX.Element;

export function IconButton(props: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
}): JSX.Element;

export interface ErrorBoundaryProps {
  label: string;
  children: React.ReactNode;
}
export class ErrorBoundary extends React.Component<ErrorBoundaryProps> {
  reset(): void;
  render(): React.ReactNode;
}
