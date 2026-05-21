import { useEffect, useRef } from 'react';
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentLess,
  indentMore,
} from '@codemirror/commands';
import { insertNewlineContinueMarkup, markdown } from '@codemirror/lang-markdown';
import {
  HighlightStyle,
  codeFolding,
  foldEffect,
  foldGutter,
  foldNodeProp,
  foldService,
  foldable,
  foldedRanges,
  indentUnit,
  syntaxHighlighting,
  unfoldEffect,
} from '@codemirror/language';
import {
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  type Extension,
} from '@codemirror/state';
import {
  type Command,
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  drawSelection,
  keymap,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type * as types from '../_types';
import type { ThreadRecord } from '../_types';
import { selectSidebarItem, setFocusedPane, useAppStore } from '../store';

//
// Hanging Indent
//

// match `  - `, `  * `, `  + `, `1. `, `1) ` (and the optional `[ ]` checkbox)
// at line start; m[0].length is the visual column where the text begins, which
// is where we want wrapped lines to hang.
const LIST_LINE_RE = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX.?]\]\s+)?/;

function buildHangingIndentDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const match = LIST_LINE_RE.exec(line.text);
      if (match) {
        const indent = match[0].length;
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: {
              style: `text-indent: -${indent}ch; padding-left: ${indent}ch`,
            },
          })
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHangingIndentDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildHangingIndentDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

//
// Clickable URLs
//

// detect bare http(s) URLs and decorate them as `.cm-url` so they style as
// links. trailing punctuation (.,;:!?)]}) is stripped from the match so a
// URL at end of a sentence doesn't swallow the period.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
const URL_TRAIL_RE = /[),.;:!?\]}]+$/;

function buildUrlDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text))) {
      const trimmed = m[0].replace(URL_TRAIL_RE, '');
      if (!trimmed) continue;
      const start = from + m.index;
      const end = start + trimmed.length;
      builder.add(
        start,
        end,
        Decoration.mark({
          class: 'cm-url',
          attributes: { 'data-url': trimmed },
        })
      );
    }
  }
  return builder.finish();
}

const urlDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildUrlDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildUrlDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

// open the URL on plain click — works the same on desktop and mobile, where
// there's no cmd modifier. cost: clicking inside a URL no longer places the
// cursor; arrow over or click just outside to position.
const urlClickHandler = EditorView.domEventHandlers({
  mousedown(event) {
    const target = event.target as HTMLElement | null;
    const el = target?.closest('.cm-url') as HTMLElement | null;
    if (!el) return false;
    const url = el.getAttribute('data-url');
    if (!url) return false;
    event.preventDefault();
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  },
});

//
// Inline Markdown Links
//

// match `[label](href)`. label can be empty; href must be non-empty and
// contain no whitespace, parens, or angle brackets. ignores image syntax
// (`![alt](src)`) by requiring no `!` immediately before the `[`.
const MD_LINK_RE = /(^|[^!])\[([^\]\n]*)\]\(([^)\s<>]+)\)/g;

function handleMdLinkClick(href: string): boolean {
  if (href.startsWith('thread:')) {
    const threadId = href.slice('thread:'.length).trim();
    if (!threadId) return false;
    selectSidebarItem({ kind: 'thread', threadId });
    return true;
  }
  if (href.startsWith('convo:')) {
    const rest = href.slice('convo:'.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return false;
    const threadId = rest.slice(0, sep).trim();
    const convoId = rest.slice(sep + 1).trim();
    if (!threadId || !convoId) return false;
    selectSidebarItem({ kind: 'convo', threadId, convoId });
    return true;
  }
  if (/^https?:\/\//i.test(href)) {
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}

// resolve the displayed label for a link. for thread/convo hrefs, look up the
// CURRENT title from the store at render time so renames auto-propagate. fall
// back to the user-typed `[label]` only when the id can't be resolved (broken
// link). file links just use the user's label.
function resolveLinkLabel(href: string, fallbackLabel: string, threads: ThreadRecord[]): string {
  if (href.startsWith('thread:')) {
    const id = href.slice('thread:'.length).trim();
    const thread = threads.find((t) => t.id === id);
    return thread ? thread.title : fallbackLabel;
  }
  if (href.startsWith('convo:')) {
    const rest = href.slice('convo:'.length);
    const sep = rest.indexOf(':');
    if (sep > 0) {
      const id = rest.slice(0, sep).trim();
      const convoId = rest.slice(sep + 1).trim();
      const thread = threads.find((t) => t.id === id);
      const convo = thread?.convos[convoId];
      if (convo) return convo.name || convoId;
    }
    return fallbackLabel;
  }
  return fallbackLabel;
}

// widget that replaces `[label](href)` with just the resolved label. the href
// surfaces via the `title=` tooltip on hover. click bubbles up to the editor's
// mousedown handler via the `.cm-md-link` class (same routing as the inline
// case).
class MdLinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly href: string
  ) {
    super();
  }
  eq(other: MdLinkWidget): boolean {
    return other.label === this.label && other.href === this.href;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-md-link';
    el.textContent = this.label;
    el.title = this.href;
    el.setAttribute('data-href', this.href);
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function selectionTouches(view: EditorView, from: number, to: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function buildMdLinkDecorations(view: EditorView): DecorationSet {
  const threads = useAppStore.getState().threads;
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    MD_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MD_LINK_RE.exec(text))) {
      const lead = m[1] ?? '';
      const rawLabel = m[2] ?? '';
      const href = m[3]!;
      const matchStart = from + m.index + lead.length;
      const matchEnd = from + m.index + m[0].length;
      // when the cursor / selection is inside the link source, drop the widget
      // so the user can edit the raw markdown. plain text is shown; clicks land
      // as normal cursor placement.
      if (selectionTouches(view, matchStart, matchEnd)) continue;
      const label = resolveLinkLabel(href, rawLabel, threads);
      builder.add(
        matchStart,
        matchEnd,
        Decoration.replace({ widget: new MdLinkWidget(label, href) })
      );
    }
  }
  return builder.finish();
}

// no-op effect used to nudge the ViewPlugin to rebuild link decorations when
// the threads list changes upstream (so resolved titles auto-update without
// waiting for a doc edit).
const refreshMdLinks = StateEffect.define<null>();

const mdLinkDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    unsubscribe: () => void;
    constructor(view: EditorView) {
      this.decorations = buildMdLinkDecorations(view);
      let prevThreads = useAppStore.getState().threads;
      this.unsubscribe = useAppStore.subscribe((state) => {
        if (state.threads === prevThreads) return;
        prevThreads = state.threads;
        view.dispatch({ effects: refreshMdLinks.of(null) });
      });
    }
    update(update: ViewUpdate): void {
      const triggered = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(refreshMdLinks))
      );
      if (update.docChanged || update.viewportChanged || update.selectionSet || triggered) {
        this.decorations = buildMdLinkDecorations(update.view);
      }
    }
    destroy(): void {
      this.unsubscribe();
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  }
);

const mdLinkClickHandler = EditorView.domEventHandlers({
  mousedown(event) {
    const target = event.target as HTMLElement | null;
    const el = target?.closest('.cm-md-link') as HTMLElement | null;
    if (!el) return false;
    const href = el.getAttribute('data-href');
    if (!href) return false;
    if (!handleMdLinkClick(href)) return false;
    event.preventDefault();
    return true;
  },
});

//
// List Folding
//

// fold a bulleted/numbered list item from the end of its own line to the end
// of the last more-indented line that follows. blank lines are tolerated
// inside the fold so a multi-paragraph item still folds in one go.
function listItemFoldRange(
  state: EditorState,
  lineStart: number,
  lineEnd: number
): { from: number; to: number } | null {
  const headLine = state.doc.lineAt(lineStart);
  const match = LIST_LINE_RE.exec(headLine.text);
  if (!match) return null;
  const baseIndent = match[1].length;
  let lastChildEnd = -1;
  let pos = lineEnd + 1;
  while (pos <= state.doc.length) {
    const line = state.doc.lineAt(pos);
    if (line.text.trim() === '') {
      pos = line.to + 1;
      continue;
    }
    const lead = /^(\s*)/.exec(line.text);
    const indent = lead ? lead[1].length : 0;
    if (indent <= baseIndent) break;
    lastChildEnd = line.to;
    pos = line.to + 1;
  }
  if (lastChildEnd < 0) return null;
  return { from: lineEnd, to: lastChildEnd };
}

// is the exact range `r` already folded?
function isAlreadyFolded(state: EditorState, r: { from: number; to: number }): boolean {
  let already = false;
  foldedRanges(state).between(r.from, r.to, (from, to) => {
    if (from === r.from && to === r.to) {
      already = true;
      return false;
    }
  });
  return already;
}

// fold the innermost foldable that encloses the cursor — walking back from the
// cursor's line until we find a line whose foldable range covers the cursor.
// this means Cmd-Up while parked inside a `- item` body folds that item, not
// just when the cursor is on the bullet line itself. if the innermost match is
// already folded (e.g. cursor sits on a collapsed child's bullet), keep
// walking outward to fold the next-outer parent instead.
const foldEnclosing: Command = (view) => {
  const state = view.state;
  const effects = [];
  for (const sel of state.selection.ranges) {
    const pos = sel.head;
    const startLineNum = state.doc.lineAt(pos).number;
    for (let n = startLineNum; n >= 1; n--) {
      const line = state.doc.line(n);
      const range = foldable(state, line.from, line.to);
      if (range && line.from <= pos && pos <= range.to) {
        if (isAlreadyFolded(state, range)) continue;
        effects.push(foldEffect.of(range));
        break;
      }
    }
  }
  if (effects.length === 0) return false;
  view.dispatch({ effects });
  return true;
};

// unfold the outermost fold whose header line contains the cursor. list-item
// folds start at the end of the bullet line; we match anywhere on that bullet
// line, plus the position right after the `[...]` placeholder (== fold.to,
// where the cursor lands when arrowing past the atomic fold). after a
// recursive fold, outer and inner share a `to`, so the user-meaningful pick
// at that position is the outer fold — peel one layer at a time from outside.
// when unfolding from after the `[...]`, also move the cursor up to the
// bullet line so the user lands at the top of the now-revealed content.
const unfoldEnclosing: Command = (view) => {
  const state = view.state;
  const effects = [];
  let moveTo: number | null = null;
  for (const sel of state.selection.ranges) {
    const pos = sel.head;
    let hit: { from: number; to: number } | null = null;
    foldedRanges(state).between(0, state.doc.length, (from, to) => {
      const headLineFrom = state.doc.lineAt(from).from;
      if (headLineFrom <= pos && (pos <= from || pos === to)) {
        if (!hit || to - from > hit.to - hit.from) hit = { from, to };
      }
    });
    const found = hit as { from: number; to: number } | null;
    if (found) {
      effects.push(unfoldEffect.of(found));
      if (pos === found.to && state.selection.ranges.length === 1) moveTo = found.from;
    }
  }
  if (effects.length === 0) return false;
  view.dispatch({
    effects,
    ...(moveTo !== null ? { selection: EditorSelection.cursor(moveTo) } : {}),
  });
  return true;
};

// find the innermost foldable range enclosing the cursor, optionally skipping
// any matches that are already folded (so e.g. fold-on-collapsed-child walks
// outward to the parent).
function enclosingFoldable(
  state: EditorState,
  pos: number,
  skipAlreadyFolded = false
): { from: number; to: number } | null {
  const startLineNum = state.doc.lineAt(pos).number;
  for (let n = startLineNum; n >= 1; n--) {
    const line = state.doc.line(n);
    const range = foldable(state, line.from, line.to);
    if (range && line.from <= pos && pos <= range.to) {
      if (skipAlreadyFolded && isAlreadyFolded(state, range)) continue;
      return range;
    }
  }
  return null;
}

// fold the enclosing foldable AND every foldable nested inside it. if the
// innermost enclosing foldable is already folded, walk outward to the parent.
const foldEnclosingRecursive: Command = (view) => {
  const state = view.state;
  const effects = [];
  for (const sel of state.selection.ranges) {
    const outer = enclosingFoldable(state, sel.head, true);
    if (!outer) continue;
    const candidates: { from: number; to: number }[] = [outer];
    const startLine = state.doc.lineAt(outer.from).number;
    const endLine = state.doc.lineAt(outer.to).number;
    for (let n = startLine + 1; n <= endLine; n++) {
      const line = state.doc.line(n);
      const r = foldable(state, line.from, line.to);
      if (r) candidates.push(r);
    }
    for (const r of candidates) {
      if (!isAlreadyFolded(state, r)) effects.push(foldEffect.of(r));
    }
  }
  if (effects.length === 0) return false;
  view.dispatch({ effects });
  return true;
};

// unfold the enclosing fold AND every fold nested inside it. operates on the
// foldable region containing the cursor (so it works whether or not the outer
// item itself is currently folded).
const unfoldEnclosingRecursive: Command = (view) => {
  const state = view.state;
  const effects: StateEffect<unknown>[] = [];
  for (const sel of state.selection.ranges) {
    const region = enclosingFoldable(state, sel.head);
    if (!region) continue;
    foldedRanges(state).between(region.from, region.to, (from, to) => {
      effects.push(unfoldEffect.of({ from, to }));
    });
  }
  if (effects.length === 0) return false;
  view.dispatch({ effects });
  return true;
};

//
// Inline Formatting
//

// wrap (or unwrap) selection with `marker` on each side. toggles when the
// chars immediately bordering the selection already are `marker`. for an
// empty selection: insert the markers and place the cursor between.
function makeWrapCommand(marker: string): Command {
  return (view) => {
    const { state } = view;
    const m = marker.length;
    view.dispatch(
      state.changeByRange((range) => {
        const before = state.sliceDoc(Math.max(0, range.from - m), range.from);
        const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + m));
        if (before === marker && after === marker) {
          return {
            changes: [
              { from: range.from - m, to: range.from },
              { from: range.to, to: range.to + m },
            ],
            range: EditorSelection.range(range.from - m, range.to - m),
          };
        }
        if (range.empty) {
          return {
            changes: { from: range.from, insert: marker + marker },
            range: EditorSelection.cursor(range.from + m),
          };
        }
        return {
          changes: [
            { from: range.from, insert: marker },
            { from: range.to, insert: marker },
          ],
          range: EditorSelection.range(range.from + m, range.to + m),
        };
      })
    );
    return true;
  };
}

const toggleBold = makeWrapCommand('**');
const toggleItalic = makeWrapCommand('*');
const toggleInlineCode = makeWrapCommand('`');
const toggleStrikethrough = makeWrapCommand('~~');

// insert a markdown link. empty selection → `[](url)` with cursor inside `[`.
// selected text → `[text](url)` with `url` selected so the user can replace it.
const insertLink: Command = (view) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      if (range.empty) {
        return {
          changes: { from: range.from, insert: '[](url)' },
          range: EditorSelection.cursor(range.from + 1),
        };
      }
      const text = state.sliceDoc(range.from, range.to);
      const insert = `[${text}](url)`;
      const urlStart = range.from + text.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlStart, urlStart + 3),
      };
    })
  );
  return true;
};

//
// Extensions
//

const draculaMarkdownTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#282a36',
      color: '#f8f8f2',
      fontFamily: 'var(--mono)',
      fontSize: 'var(--app-font-size)',
      fontWeight: '400',
      letterSpacing: '0',
    },
    '.cm-content': {
      caretColor: '#f8f8f2',
      lineHeight: 'var(--app-line-height)',
      padding: '0',
    },
    '.cm-cursor': {
      borderLeftColor: '#f8f8f2',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#6272a4 !important',
    },
    '.cm-content ::selection': {
      backgroundColor: '#6272a4 !important',
    },
    '.cm-focused': {
      outline: 'none',
    },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: 'var(--app-line-height)',
    },
    '.cm-line': {
      padding: '0',
    },
    '.cm-activeLine': {
      backgroundColor: 'transparent',
    },
    '.cm-gutters': {
      backgroundColor: '#282a36',
      borderRight: 'none',
      color: '#6272a4',
    },
    '.cm-foldGutter': {
      width: '12px',
    },
    '.cm-foldGutter .cm-gutterElement': {
      cursor: 'pointer',
      padding: '0 2px',
      textAlign: 'center',
    },
    '.cm-foldGutter .cm-gutterElement:hover': {
      color: '#f8f8f2',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: '#44475a',
      border: 'none',
      color: '#a9b2cf',
      marginLeft: '6px',
      padding: '0 4px',
    },
    '.cm-url': {
      color: '#8be9fd',
      textDecoration: 'underline',
      cursor: 'pointer',
    },
    '.cm-md-link': {
      color: '#8be9fd',
      textDecoration: 'underline',
      textUnderlineOffset: '2px',
      cursor: 'pointer',
    },
  },
  { dark: true }
);

const markdownHighlightStyle = HighlightStyle.define([
  {
    tag: tags.heading1,
    color: '#f8f8f2',
    fontWeight: '700',
    fontSize: '1.6em',
  },
  {
    tag: tags.heading2,
    color: '#f8f8f2',
    fontWeight: '700',
    fontSize: '1.35em',
  },
  {
    tag: tags.heading3,
    color: '#f8f8f2',
    fontWeight: '700',
    fontSize: '1.18em',
  },
  {
    tag: tags.heading4,
    color: '#f8f8f2',
    fontWeight: '700',
    fontSize: '1.08em',
  },
  {
    tag: [tags.heading, tags.heading5, tags.heading6],
    color: '#f8f8f2',
    fontWeight: '700',
  },
  {
    tag: tags.strong,
    color: '#f8f8f2',
    fontWeight: '700',
  },
  {
    tag: tags.emphasis,
    color: '#f8f8f2',
    fontStyle: 'italic',
  },
  {
    tag: tags.link,
    color: '#8be9fd',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  {
    tag: tags.monospace,
    backgroundColor: 'rgba(68, 71, 90, 0.7)',
    color: '#f8f8f2',
  },
  {
    tag: tags.quote,
    color: '#6272a4',
    fontStyle: 'italic',
  },
  {
    tag: tags.strikethrough,
    textDecoration: 'line-through',
  },
  {
    tag: [tags.punctuation, tags.processingInstruction, tags.contentSeparator],
    color: '#6272a4',
  },
]);

function editorExtensions(
  onChange: (value: string) => void,
  isSyncing: () => boolean,
  onSelectionChange: () => void
): Extension[] {
  return [
    drawSelection(),
    history(),
    // disable paragraph folding for parity with bullets (a single-line bullet
    // that just visually wraps isn't foldable — neither should a soft-wrapped
    // paragraph be).
    markdown({
      extensions: [{ props: [foldNodeProp.add({ Paragraph: () => null })] }],
    }),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    keymap.of([
      { key: 'Mod-ArrowUp', run: foldEnclosing },
      { key: 'Mod-ArrowDown', run: unfoldEnclosing },
      { key: 'Mod-Shift-ArrowUp', run: foldEnclosingRecursive },
      { key: 'Mod-Shift-ArrowDown', run: unfoldEnclosingRecursive },
      { key: 'Mod-b', run: toggleBold },
      { key: 'Mod-i', run: toggleItalic },
      { key: 'Mod-e', run: toggleInlineCode },
      { key: 'Mod-Shift-s', run: toggleStrikethrough },
      { key: 'Mod-k', run: insertLink },
      { key: 'Enter', run: insertNewlineContinueMarkup },
      { key: 'Tab', run: indentMore, shift: indentLess },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.lineWrapping,
    codeFolding(),
    foldService.of(listItemFoldRange),
    foldGutter({ openText: '▾', closedText: '▸' }),
    // make folded ranges atomic so arrow keys skip over the [...] placeholder
    // instead of landing inside the fold (which auto-unfolds it).
    EditorView.atomicRanges.of((view) => foldedRanges(view.state)),
    hangingIndent,
    urlDecorations,
    urlClickHandler,
    mdLinkDecorations,
    mdLinkClickHandler,
    draculaMarkdownTheme,
    syntaxHighlighting(markdownHighlightStyle),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !isSyncing()) onChange(update.state.doc.toString());
      if (update.selectionSet) onSelectionChange();
    }),
  ];
}

//
// Per-thread Editor State
//

// keyed by threadId — survives remount (re-keyed) but not full page reload,
// which is the level of persistence the user asked for ("survives re-mount").
// we save the cursor head only (collapsed) so a restored range can't desync
// vim's mode. for scroll we store the CM scroll snapshot effect captured at
// unmount; CM applies it via `scrollTo` on re-creation, which is the official
// hook for setting initial scroll (sync writes to scrollDOM.scrollTop race
// CM's first measure and can be clobbered).
interface EditorMemory {
  cursor: number;
  scrollTo: StateEffect<unknown> | null;
}
const editorMemoryByThread = new Map<string, EditorMemory>();

//
// Editor
//

export const MarkdownEditor: typeof types.MarkdownEditor = ({
  threadId,
  value,
  onChange,
}: {
  threadId: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const syncingRef = useRef(false);
  const saveMemoryRef = useRef<() => void>(() => {});

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const remembered = editorMemoryByThread.get(threadId);
    const docLength = value.length;
    const restoredSelection =
      remembered && remembered.cursor <= docLength
        ? EditorSelection.cursor(remembered.cursor)
        : undefined;
    const view = new EditorView({
      parent: host,
      scrollTo: remembered?.scrollTo ?? undefined,
      state: EditorState.create({
        doc: value,
        selection: restoredSelection ? EditorSelection.create([restoredSelection], 0) : undefined,
        extensions: editorExtensions(
          (next) => onChangeRef.current(next),
          () => syncingRef.current,
          () => saveMemoryRef.current()
        ),
      }),
    });
    // capture scroll + cursor continuously while the editor is alive — by the
    // time React's cleanup runs the scrollDOM has been detached and reads back
    // zero, so sampling at unmount only ever saves "scroll to 0".
    const saveMemory = (): void => {
      editorMemoryByThread.set(threadId, {
        cursor: view.state.selection.main.head,
        scrollTo: view.scrollSnapshot(),
      });
    };
    saveMemoryRef.current = saveMemory;
    saveMemory();
    const onScroll = (): void => saveMemory();
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    const onFocusRequest = (): void => view.focus();
    const onHostFocusIn = (): void => setFocusedPane('note');
    viewRef.current = view;
    window.addEventListener('threads-note-focus', onFocusRequest);
    host.addEventListener('focusin', onHostFocusIn);
    // if focusedPane was 'note' before this editor mounted (e.g. after a
    // reload, or after switching threads while in note mode), self-focus --
    // but skip when another element (e.g. a sidebar row) currently has DOM
    // focus, so we don't steal it during arrow-key nav from the sidebar.
    if (
      useAppStore.getState().focusedPane === 'note' &&
      (document.activeElement === document.body || host.contains(document.activeElement))
    ) {
      view.focus();
    }
    return () => {
      saveMemory();
      view.scrollDOM.removeEventListener('scroll', onScroll);
      window.removeEventListener('threads-note-focus', onFocusRequest);
      host.removeEventListener('focusin', onHostFocusIn);
      view.destroy();
      viewRef.current = null;
    };
  }, [threadId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    syncingRef.current = true;
    // clamp the reused selection to the new doc length — without this, an
    // external update to a shorter doc throws RangeError: Selection points
    // outside of document.
    const selection = view.state.selection;
    const newLen = value.length;
    const clamped = EditorSelection.create(
      selection.ranges.map((r) =>
        EditorSelection.range(Math.min(r.anchor, newLen), Math.min(r.head, newLen))
      ),
      selection.mainIndex
    );
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: clamped,
    });
    syncingRef.current = false;
  }, [value]);

  return <div className="note-editor" ref={hostRef} />;
};
