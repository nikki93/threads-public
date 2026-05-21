# threads

## Layout

Starting layout:

- `src/_types.d.ts` — code map (see the repo `CLAUDE.md` for the general
  pattern)
- `src/store.ts` — zustand store, store actions, and non-view logic
  (pure data helpers, formatters, parsers — anything that operates on
  long-lived state or pure data)
- `src/components.tsx` — React components AND the `createRoot`
  entrypoint at the bottom under an `// Entrypoint //` section. No
  separate `main.tsx`; `index.html` loads `components.tsx` directly.

As the project grows, promote single files to directories — split by
general section/category, not strictly one symbol per file:

- `components.tsx` → `components/` where each file groups related
  components: one or a few big components together with the small
  util/internal components they use. E.g. `components/Inbox.tsx`
  might hold `Inbox`, `InboxRow`, `InboxHeader`; a generic
  `Spinner` lives in whichever file naturally needs it (or a
  shared `components/util.tsx` if reused across files).
- `store.ts` → `store/` where each file is a coherent slice of
  logic with its helpers, not one function per file.
- `_types.d.ts` → `_types/<system>.d.ts` per subsystem.

Do NOT mix view/component functions and store/logic functions in the
same file. The file-naming convention (`components.*` vs `store.*`)
makes the boundary visible. View code is transient UI/React-bound;
store/logic operates on long-lived state and pure data. Different
change cadences, different testing needs — keep them apart.

## Zustand store

State actions are top-level `export const`s in `store.ts`, referenced
by name from inside the zustand creator:

```ts
export const setDraft: typeof types.setDraft = (draft: string): void => {
  useAppStore.setState({ draft });
};

type Store = AppState & {
  setDraft: typeof setDraft;
  addDraft: typeof addDraft;
};

export const useAppStore = create<Store>()(
  persist((): Store => ({ ...initial, setDraft, addDraft }), {
    name: 'threads',
  })
);
```

The hook itself (`useAppStore`) is NOT declared in `_types.d.ts` —
it's plumbing, not part of the human-level map. Its type is inferred
from `create<Store>()(...)`.

Components import actions directly from `./store` (no selector hop)
and use `useAppStore((s) => s.field)` for state subscriptions:

```ts
import { useAppStore, setDraft, addDraft } from './store';

const draft = useAppStore((s) => s.draft);
```

`AppState` (the pure state shape) lives in `_types.d.ts` Types section.
The full store shape (state + actions) is constructed as a local
`Store` type alias in `store.ts` via `AppState & { ... }`.

## Section grouping in `_types.d.ts`

Typical sections:

- `Types` — domain interfaces (`AppState`, domain types)
- one section per logic group in `store.ts` (e.g. `Notes` for note
  helpers)
- `Store` — store action declarations
- `Components` — React component declarations

Order symbols inside each section to match their order in the impl
files so the map and the impls scan in parallel.

Use blank lines to group declarations inside `_types.d.ts`: separate
constants from functions, selectors from actions, and interfaces from
other entity types. Do not put a blank line between every declaration;
related declarations such as `Sidebar` and `SidebarRow` stay adjacent.
A dense uninterrupted list is harder to scan, but a picket fence of
single-symbol paragraphs is not the house style either.

Implementation files should use section comments of the form:

```ts
//
// Section Name
//
```

Use them consistently enough that files scan top-to-bottom by purpose.

## Scripts

```sh
npm run dev:tailnet  # serve on tailnet (use for previews)
npm run typecheck    # tsc --noEmit
npm run reload       # signal a "reload available" -- shows a blue reload icon in the sidebar toolbar that the user clicks for a full page reload. nothing auto-reloads
npm run format       # prettier
```

After a coherent edit slice, chain the end-of-slice steps in one bash call
— don't run them sequentially in separate tool invocations:

```sh
npm run typecheck && npm run format && npm run reload
```

Add `npm run server:reload` after `format` when api-child code changed
(`src/server/index.ts`, `thread-store.ts`, `pty-server.ts`). Same rule —
chain it in. Sequential tool calls for chainable shell commands waste
turns and slow the loop down.

There may be parallel edit tracks running from other agents in this
project. Before any `npm run reload`, `npm run server:reload`, or
`npm run supervisor:reload`, check whether unrelated files in the
current threads project look halfway edited or not yet ready. If they
do, don't publish that intermediate state by reloading; tell the user a
reload is needed once those parallel edits settle. Only reload when
your own slice is coherent and the other visible edits look ready too.

## Protocol updates

When adding a feature that changes what agents in spawned threads can
or should do — new env vars they receive, new file formats they should
emit, new conventions in notes, new keyword cues, new hooks behavior —
check whether `threads-protocol.md` (one level up from `src/`) needs a
corresponding bullet. The protocol is injected as the appended system
prompt for every spawned PTY; without an update there, agents won't
know the feature exists. Skip only if the feature is purely UI-facing
(things the user clicks but agents never produce or consume).

## Processes

`npm run dev` runs the web app (Vite) and the API server together. The
API server lazily spawns the PTY supervisor on the first terminal
request; the supervisor owns live PTY sessions and is a separate
process. Do not kill the supervisor or live PTY children unless asked
-- check `/api/threads` and the supervisor `/api/pty/sessions` socket
before touching runtime processes.

## Reload semantics

Three separately-restartable layers. Pick the smallest reload that picks
up your edit — going bigger than needed kills live agents for no reason.
**Run the right command after every source edit. Forgetting is the most
common cause of "but the code looks right and it's not working."**

**Sleep before reload commands** when running them from inside a threads
PTY (you almost always are). The api restart drops the SSE stream that
the threads UI uses to show your final assistant message — without a
delay, your reply often disappears from the chat. Prefix with `sleep 3 &&`
(or chain it: `sleep 3 && npm run server:reload`) so your message has
time to flush before the api goes down.

| Edited file                                      | Command                                                      | Live PTYs |
| ------------------------------------------------ | ------------------------------------------------------------ | --------- |
| `src/components/**`, `src/store.ts`, `src/*.css` | `npm run reload` (signals icon; user clicks for full reload) | survive   |
| `src/server/index.ts`                            | `npm run server:reload`                                      | survive   |
| `src/server/thread-store.ts`                     | `npm run server:reload`                                      | survive   |
| `src/server/pty-server.ts`                       | `npm run server:reload`                                      | survive   |
| `src/server/claude-jsonl.ts`                     | `npm run server:reload`                                      | survive   |
| `src/server/preview-server.ts`                   | `npm run server:reload`                                      | survive   |
| `src/server/pty-supervisor.ts`                   | `npm run supervisor:reload`                                  | **DIE**   |
| `src/server/terminal-context.ts` (used by both)  | both commands                                                | **DIE**   |

### `npm run server:reload`

Touches `server-reload.trigger`, watched by `scripts/run-server.ts`,
which SIGTERMs the api child and respawns it. Cheap. Prints
`[server] spawned api child pid N`. Live PTYs survive — they're owned
by the supervisor, not the api.

### `npm run supervisor:reload`

Reads `<socket-dir>/supervisor.pid` (written by the supervisor on boot),
SIGTERMs the supervisor, escalates to SIGKILL after 1s if it didn't take,
verifies dead. The api's `ensurePtySupervisor` respawns the supervisor
lazily on the next request (heartbeat or terminal open). Falls back to
`pgrep` if no pidfile exists (one-time bootstrap path).

**This kills every live agent PTY — including the agent running the
command if it's hosted in a thread terminal.** That's irreducible: the
supervisor owns every PTY master fd, when it dies the slaves get SIGHUP.
Threads recover by re-opening their terminal in the app (claude resumes
via `agents.claude.session_id`). Always warn the user before running this
when other agents are working.

### Common failure

Edit `pty-supervisor.ts`, run `npm run server:reload`, test, see old
behavior, conclude the code is broken. The code is fine — the supervisor
is still running the old version. Use the table above; if you changed
supervisor code, run `supervisor:reload`, not `server:reload`.

## Thread notes

Thread titles are derived from the first line of the markdown note. Write
that line as a short markdown H1 (`# title`); the rest of the note starts
after it.

## Terminals

Thread terminals launch Claude Code inside a `zsh -l -c` PTY kept alive
by the PTY supervisor. Claude receives `THREAD_ID`,
`THREAD_FILE`, `THREADS_DIR`, and related environment
variables; use those to recover the current thread context. The
`agents.claude.session_id` frontmatter value is the resume handle, and
stale or missing session files should fall back to a fresh Claude launch
rather than spinning in a resume loop.
