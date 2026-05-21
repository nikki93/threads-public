import { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTerminal } from '@fortawesome/free-solid-svg-icons';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type * as types from '../_types';
import {
  apiPost,
  clearConvoTerminal,
  convoTokenKey,
  DEFAULT_CONVO_ID,
  getActiveConvoId,
  openConvoTerminal,
  setFocusedPane,
  useAppStore,
} from '../store';
import { logActivity } from '../activity';
import { IconButton } from './ui';

//
// Theme
//

const draculaTheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  selectionBackground: '#44475a',
  black: '#000000',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#bfbfbf',
  brightBlack: '#4d4d4d',
  brightRed: '#ff6e67',
  brightGreen: '#5af78e',
  brightYellow: '#f4f99d',
  brightBlue: '#caa9fa',
  brightMagenta: '#ff92d0',
  brightCyan: '#9aedfe',
  brightWhite: '#e6e6e6',
};

const TERMINAL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const TERMINAL_FONT_SIZE = 12;
const TERMINAL_LINE_HEIGHT = 1.2;
const TERMINAL_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 12000, 15000] as const;
const TERMINAL_REPLAY_REPAIR_DELAYS_MS = [50, 160] as const;
const MOBILE_KEYBOARD_THRESHOLD_PX = 150;
const TOUCH_SCROLL_FALLBACK_LINE_PX = TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
const TOUCH_SCROLL_INERTIA_MIN_VELOCITY_PX_MS = 0.01;
const TOUCH_SCROLL_INERTIA_DECAY_PER_FRAME = 0.96;
const SPECIAL_KEY_REPEAT_START_MS = 350;
const SPECIAL_KEY_REPEAT_INTERVAL_MS = 75;
const TOUCH_MOUSE_SUPPRESSION_MS = 700;

type TerminalSpecialKey =
  | 'escape'
  | 'control'
  | 'backspace'
  | 'arrowLeft'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowRight'
  | 'paste';

interface TerminalSpecialKeyButton {
  key: TerminalSpecialKey;
  label: string;
  title: string;
}

const TERMINAL_SPECIAL_KEYS: TerminalSpecialKeyButton[] = [
  { key: 'escape', label: 'esc', title: 'escape' },
  { key: 'control', label: 'ctrl', title: 'control modifier' },
  { key: 'backspace', label: '⌫', title: 'backspace' },
  { key: 'arrowLeft', label: '←', title: 'left arrow' },
  { key: 'arrowUp', label: '↑', title: 'up arrow' },
  { key: 'arrowDown', label: '↓', title: 'down arrow' },
  { key: 'arrowRight', label: '→', title: 'right arrow' },
  { key: 'paste', label: 'paste', title: 'paste from clipboard' },
];

//
// Scroll
//

function stopTerminalScrollChain(host: HTMLElement, event: WheelEvent): void {
  const viewport = host.querySelector<HTMLElement>('.xterm-viewport');
  if (!viewport) return;
  const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
  if (maxScrollTop <= 0) {
    event.preventDefault();
    return;
  }
  const scrollingPastTop = viewport.scrollTop <= 0 && event.deltaY < 0;
  const scrollingPastBottom = viewport.scrollTop >= maxScrollTop - 1 && event.deltaY > 0;
  if (scrollingPastTop || scrollingPastBottom) event.preventDefault();
}

function terminalTouchScrollEnabled(): boolean {
  return (
    navigator.maxTouchPoints > 0 ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
  );
}

function terminalTouchLinePx(term: XTerm, viewport: HTMLElement): number {
  if (term.rows > 0 && viewport.clientHeight > 0) {
    return viewport.clientHeight / term.rows;
  }
  return TOUCH_SCROLL_FALLBACK_LINE_PX;
}

function scrollTerminalByTouchPx(
  term: XTerm,
  viewport: HTMLElement,
  deltaPx: number,
  pendingPx: number
): number {
  const nextPendingPx = pendingPx + deltaPx;
  const linePx = terminalTouchLinePx(term, viewport);
  const lines = Math.trunc(nextPendingPx / linePx);
  if (lines === 0) return nextPendingPx;
  term.scrollLines(lines);
  return nextPendingPx - lines * linePx;
}

function attachTerminalTouchScroll(host: HTMLElement, term: XTerm): () => void {
  if (!terminalTouchScrollEnabled()) return () => {};
  const viewport = host.querySelector<HTMLElement>('.xterm-viewport');
  if (!viewport) return () => {};
  const touchTarget = viewport.parentElement ?? viewport;
  let lastY: number | null = null;
  let lastMoveTime = 0;
  let pendingPx = 0;
  let velocityPxMs = 0;
  let inertiaFrame: number | null = null;

  const stopInertia = (): void => {
    if (inertiaFrame !== null) {
      window.cancelAnimationFrame(inertiaFrame);
      inertiaFrame = null;
    }
  };

  const startInertia = (): void => {
    if (Math.abs(velocityPxMs) < TOUCH_SCROLL_INERTIA_MIN_VELOCITY_PX_MS) return;
    let lastFrameTime = performance.now();
    const step = (frameTime: number): void => {
      const elapsedMs = frameTime - lastFrameTime;
      lastFrameTime = frameTime;
      pendingPx = scrollTerminalByTouchPx(term, viewport, velocityPxMs * elapsedMs, pendingPx);
      velocityPxMs *= TOUCH_SCROLL_INERTIA_DECAY_PER_FRAME;
      if (Math.abs(velocityPxMs) < TOUCH_SCROLL_INERTIA_MIN_VELOCITY_PX_MS) {
        inertiaFrame = null;
        velocityPxMs = 0;
        return;
      }
      inertiaFrame = window.requestAnimationFrame(step);
    };
    inertiaFrame = window.requestAnimationFrame(step);
  };

  const resetTouch = (): void => {
    lastY = null;
    lastMoveTime = 0;
    pendingPx = 0;
    velocityPxMs = 0;
    stopInertia();
  };

  const onTouchStart = (event: TouchEvent): void => {
    stopInertia();
    if (event.touches.length !== 1) {
      resetTouch();
      return;
    }
    lastY = event.touches[0]!.clientY;
    lastMoveTime = performance.now();
    pendingPx = 0;
    velocityPxMs = 0;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (event.touches.length !== 1 || lastY === null) {
      resetTouch();
      return;
    }
    const touch = event.touches[0]!;
    const deltaY = lastY - touch.clientY;
    const now = performance.now();
    const elapsedMs = Math.max(1, now - lastMoveTime);
    lastY = touch.clientY;
    lastMoveTime = now;
    if (deltaY === 0) return;
    velocityPxMs = velocityPxMs * 0.4 + (deltaY / elapsedMs) * 0.6;
    pendingPx = scrollTerminalByTouchPx(term, viewport, deltaY, pendingPx);
    if (event.cancelable) event.preventDefault();
  };

  const onTouchEnd = (): void => {
    lastY = null;
    lastMoveTime = 0;
    startInertia();
  };

  touchTarget.addEventListener('touchstart', onTouchStart, { passive: true });
  touchTarget.addEventListener('touchmove', onTouchMove, { passive: false });
  touchTarget.addEventListener('touchend', onTouchEnd, { passive: true });
  touchTarget.addEventListener('touchcancel', resetTouch, { passive: true });
  return () => {
    stopInertia();
    touchTarget.removeEventListener('touchstart', onTouchStart);
    touchTarget.removeEventListener('touchmove', onTouchMove);
    touchTarget.removeEventListener('touchend', onTouchEnd);
    touchTarget.removeEventListener('touchcancel', resetTouch);
  };
}

function refreshTerminalRows(term: XTerm): void {
  if (term.rows <= 0) return;
  term.refresh(0, term.rows - 1);
}

function mobileKeyboardIsOpen(): boolean {
  const viewport = window.visualViewport;
  if (!viewport) return false;
  return viewport.height < window.innerHeight - MOBILE_KEYBOARD_THRESHOLD_PX;
}

function useMobileKeyboardOpen(enabled: boolean): boolean {
  const [keyboardOpen, setKeyboardOpen] = useState<boolean>(() =>
    enabled ? mobileKeyboardIsOpen() : false
  );
  useEffect(() => {
    if (!enabled) {
      setKeyboardOpen(false);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = (): void => setKeyboardOpen(mobileKeyboardIsOpen());
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [enabled]);
  return keyboardOpen;
}

function specialKeyInput(key: TerminalSpecialKey, controlArmed: boolean): string {
  if (key === 'escape') return '\x1b';
  if (key === 'backspace') return controlArmed ? '\x08' : '\x7f';
  if (key === 'arrowLeft') return controlArmed ? '\x1b[1;5D' : '\x1b[D';
  if (key === 'arrowUp') return controlArmed ? '\x1b[1;5A' : '\x1b[A';
  if (key === 'arrowDown') return controlArmed ? '\x1b[1;5B' : '\x1b[B';
  if (key === 'arrowRight') return controlArmed ? '\x1b[1;5C' : '\x1b[C';
  return '';
}

function specialKeyRepeats(key: TerminalSpecialKey): boolean {
  return (
    key === 'backspace' ||
    key === 'arrowLeft' ||
    key === 'arrowUp' ||
    key === 'arrowDown' ||
    key === 'arrowRight'
  );
}

function controlModifiedInput(data: string): string {
  const code = data.codePointAt(0);
  if (code === undefined) return data;
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60);
  if (code === 0x20) return '\x00';
  return data;
}

function sendTerminalInput(ws: WebSocket | null, data: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ kind: 'input', data }));
  }
}

async function fileToBase64(file: Blob): Promise<string> {
  const reader = new FileReader();
  return await new Promise<string>((resolveBase64, rejectBase64) => {
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolveBase64(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => rejectBase64(reader.error ?? new Error('could not read image'));
    reader.readAsDataURL(file);
  });
}

async function uploadPasteImage(file: Blob, mimeType: string): Promise<string> {
  const base64 = await fileToBase64(file);
  const response = await fetch('/api/paste-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mimeType, base64 }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? 'could not save pasted image');
  }
  const body = (await response.json()) as { path: string };
  return body.path;
}

async function pasteClipboardImage(args: {
  event: ClipboardEvent;
  term: XTerm;
  threadId: string;
  setStatus: (status: string) => void;
}): Promise<void> {
  const data = args.event.clipboardData;
  if (!data) return;
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    args.event.preventDefault();
    args.event.stopPropagation();
    args.event.stopImmediatePropagation();
    try {
      const path = await uploadPasteImage(file, file.type || item.type);
      args.term.paste(path);
      logActivity('terminal_image_paste', {
        threadId: args.threadId,
        bytes: file.size,
      });
    } catch (error) {
      const message = error instanceof Error ? `paste error: ${error.message}` : 'paste error';
      args.setStatus(message);
      logActivity('terminal_image_paste_error', {
        threadId: args.threadId,
        message,
      });
    }
    return;
  }
}

function createTerminal(
  el: HTMLElement,
  threadId: string
): {
  term: XTerm;
  fit: FitAddon;
  onWheel: (event: WheelEvent) => void;
  disposeTouchScroll: () => void;
} {
  const term = new XTerm({
    theme: draculaTheme,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    fontWeight: 400,
    fontWeightBold: 700,
    letterSpacing: 0,
    lineHeight: TERMINAL_LINE_HEIGHT,
    cursorBlink: true,
    scrollback: window.innerWidth <= 768 ? 500 : 1000,
  });
  const onWheel = (event: WheelEvent) => stopTerminalScrollChain(el, event);
  term.attachCustomKeyEventHandler((event) => {
    if (
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      return false;
    }
    return true;
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      window.open(uri, '_blank', 'noopener')?.focus();
      logActivity('terminal_link_open', { threadId, uri });
    })
  );
  term.open(el);
  const disposeTouchScroll = attachTerminalTouchScroll(el, term);
  return { term, fit, onWheel, disposeTouchScroll };
}

function TerminalSpecialKeysBar({
  controlArmed,
  onKey,
}: {
  controlArmed: boolean;
  onKey: (key: TerminalSpecialKey) => void;
}): JSX.Element {
  const lastTouchStartRef = useRef(0);
  const repeatTimeoutRef = useRef<number | null>(null);
  const repeatIntervalRef = useRef<number | null>(null);

  const stopRepeat = (): void => {
    if (repeatTimeoutRef.current !== null) {
      window.clearTimeout(repeatTimeoutRef.current);
      repeatTimeoutRef.current = null;
    }
    if (repeatIntervalRef.current !== null) {
      window.clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
  };

  const startRepeat = (key: TerminalSpecialKey): void => {
    stopRepeat();
    onKey(key);
    if (!specialKeyRepeats(key)) return;
    repeatTimeoutRef.current = window.setTimeout(() => {
      repeatTimeoutRef.current = null;
      repeatIntervalRef.current = window.setInterval(
        () => onKey(key),
        SPECIAL_KEY_REPEAT_INTERVAL_MS
      );
    }, SPECIAL_KEY_REPEAT_START_MS);
  };

  useEffect(() => stopRepeat, []);

  return (
    <div className="terminal-special-keys" role="toolbar" aria-label="terminal special keys">
      {TERMINAL_SPECIAL_KEYS.map((button) => (
        <button
          key={button.key}
          type="button"
          tabIndex={-1}
          title={button.title}
          aria-pressed={button.key === 'control' ? controlArmed : undefined}
          className={`terminal-special-key${
            button.key === 'control' && controlArmed ? ' is-active' : ''
          }`}
          onMouseDown={(event) => {
            event.preventDefault();
            if (performance.now() - lastTouchStartRef.current < TOUCH_MOUSE_SUPPRESSION_MS) return;
            startRepeat(button.key);
          }}
          onMouseLeave={stopRepeat}
          onMouseUp={stopRepeat}
          onTouchStart={(event) => {
            event.preventDefault();
            lastTouchStartRef.current = performance.now();
            startRepeat(button.key);
          }}
          onTouchCancel={stopRepeat}
          onTouchEnd={stopRepeat}
          onContextMenu={(event) => event.preventDefault()}>
          {button.label}
        </button>
      ))}
    </div>
  );
}

//
// Terminal
//

export const TerminalView: typeof types.TerminalView = ({
  threadId,
  convoId,
  initialToken,
  active,
  onExit,
}: {
  threadId: string;
  convoId: string;
  initialToken: string;
  active: boolean;
  onExit: () => void;
}): JSX.Element => {
  const frameRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>('');
  const focusedPane = useAppStore((state) => state.focusedPane);
  const keyboardOpen = useMobileKeyboardOpen(active);
  const [controlArmed, setControlArmedState] = useState<boolean>(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const controlArmedRef = useRef(false);
  const fitRef = useRef<(() => void) | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const showSpecialKeys = active && focusedPane === 'terminal' && keyboardOpen;
  const setControlArmed = (next: boolean | ((armed: boolean) => boolean)): void => {
    const value = typeof next === 'function' ? next(controlArmedRef.current) : next;
    controlArmedRef.current = value;
    setControlArmedState(value);
  };
  const handleSpecialKey = (key: TerminalSpecialKey): void => {
    if (key === 'control') {
      setControlArmed((armed) => !armed);
      termRef.current?.focus();
      return;
    }
    if (key === 'paste') {
      setControlArmed(false);
      termRef.current?.focus();
      const sendPasted = (text: string | null | undefined): void => {
        if (text) sendTerminalInput(wsRef.current, text);
      };
      const promptFallback = (): void => sendPasted(window.prompt('paste here:'));
      try {
        const clipboard = navigator.clipboard;
        if (clipboard && typeof clipboard.readText === 'function') {
          clipboard.readText().then(sendPasted, promptFallback);
          return;
        }
      } catch {
        // fall through to prompt
      }
      promptFallback();
      return;
    }
    const data = specialKeyInput(key, controlArmedRef.current);
    setControlArmed(false);
    if (data) sendTerminalInput(wsRef.current, data);
    termRef.current?.focus();
  };
  const sendTerminalData = (data: string): void => {
    const nextData = controlArmedRef.current ? controlModifiedInput(data) : data;
    if (controlArmedRef.current) setControlArmed(false);
    sendTerminalInput(wsRef.current, nextData);
  };
  useEffect(() => {
    if (!showSpecialKeys) setControlArmed(false);
    fitRef.current?.();
  }, [showSpecialKeys]);
  useEffect(() => {
    if (active) {
      fitRef.current?.();
      // skip focus when another element (e.g. a sidebar row) currently has
      // DOM focus, so we don't steal it during arrow-key nav from the sidebar.
      if (useAppStore.getState().focusedPane === 'terminal') {
        const host = frameRef.current;
        if (
          host &&
          (document.activeElement === document.body || host.contains(document.activeElement))
        ) {
          termRef.current?.focus();
        }
      }
    } else {
      // a hidden xterm-helper-textarea still receives focus + keystrokes if we
      // don't blur it. without this, navigating from terminal A to a thread
      // with no terminal would leave input going to invisible A.
      termRef.current?.blur();
    }
  }, [active]);
  useEffect(() => {
    const onFocusRequest = () => {
      if (!activeRef.current) return;
      fitRef.current?.();
      termRef.current?.focus();
    };
    window.addEventListener('threads-terminal-focus', onFocusRequest);
    return () => window.removeEventListener('threads-terminal-focus', onFocusRequest);
  }, []);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onHostFocusIn = (): void => {
      if (!activeRef.current) return;
      setFocusedPane('terminal');
    };
    el.addEventListener('focusin', onHostFocusIn);
    return () => el.removeEventListener('focusin', onHostFocusIn);
  }, []);
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const term = termRef.current;
      if (!activeRef.current || !term) return;
      void pasteClipboardImage({ event, term, threadId, setStatus });
    };
    document.addEventListener('paste', onPaste, { capture: true });
    return () => {
      document.removeEventListener('paste', onPaste, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [threadId]);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    setStatus('');
    let cancelled = false;
    let ws: WebSocket | null = null;
    wsRef.current = null;
    let currentToken = initialToken;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let connectFrame: number | null = null;
    const replayRepairFrames: number[] = [];
    const replayRepairTimers: number[] = [];
    let sessionExited = false;
    const { term, fit, onWheel, disposeTouchScroll } = createTerminal(el, threadId);
    termRef.current = term;

    let lastSentCols = 0;
    let lastSentRows = 0;

    const sendResize = (): void => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (term.cols === lastSentCols && term.rows === lastSentRows) return;
      lastSentCols = term.cols;
      lastSentRows = term.rows;
      ws.send(JSON.stringify({ kind: 'resize', cols: term.cols, rows: term.rows }));
    };

    const fitTerminal = (): void => {
      if (cancelled) return;
      fit.fit();
      sendResize();
    };
    fitRef.current = fitTerminal;

    const clearReconnectTimer = (): void => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const clearConnectFrame = (): void => {
      if (connectFrame !== null) {
        window.cancelAnimationFrame(connectFrame);
        connectFrame = null;
      }
    };

    const clearReplayRepairWork = (): void => {
      while (replayRepairFrames.length > 0) {
        const frame = replayRepairFrames.pop();
        if (frame !== undefined) window.cancelAnimationFrame(frame);
      }
      while (replayRepairTimers.length > 0) {
        const timer = replayRepairTimers.pop();
        if (timer !== undefined) window.clearTimeout(timer);
      }
    };

    const repairReplayLayout = (): void => {
      if (cancelled) return;
      fitTerminal();
      refreshTerminalRows(term);
    };

    const scheduleReplayRepair = (): void => {
      clearReplayRepairWork();
      window.queueMicrotask(repairReplayLayout);
      replayRepairFrames.push(
        window.requestAnimationFrame(() => {
          window.dispatchEvent(new Event('resize'));
          repairReplayLayout();
          replayRepairFrames.push(window.requestAnimationFrame(repairReplayLayout));
        })
      );
      for (const delay of TERMINAL_REPLAY_REPAIR_DELAYS_MS) {
        replayRepairTimers.push(window.setTimeout(repairReplayLayout, delay));
      }
    };

    const connectAfterLayout = (): void => {
      if (cancelled) return;
      clearConnectFrame();
      fitTerminal();
      connectFrame = window.requestAnimationFrame(() => {
        connectFrame = null;
        fitTerminal();
        openWs();
      });
    };

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      clearReconnectTimer();
      if (reconnectAttempt >= TERMINAL_RECONNECT_DELAYS_MS.length) {
        setStatus('reconnect failed — reload tab');
        return;
      }
      const delay = TERMINAL_RECONNECT_DELAYS_MS[reconnectAttempt]!;
      reconnectAttempt += 1;
      setStatus(`reconnecting in ${Math.max(1, Math.round(delay / 1000))}s…`);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void reacquireAndConnect();
      }, delay);
    };

    const reacquireAndConnect = async (): Promise<void> => {
      if (cancelled) return;
      setStatus('reconnecting…');
      try {
        const result = await apiPost<{ token: string }>(`/api/threads/${threadId}/terminal`, {
          convoId,
        });
        if (cancelled) return;
        currentToken = result.token;
        connectAfterLayout();
      } catch {
        if (cancelled) return;
        scheduleReconnect();
      }
    };

    const openWs = (): void => {
      if (cancelled) return;
      clearReconnectTimer();
      fit.fit();
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const next = new WebSocket(
        `${protocol}://${location.host}/api/pty/${currentToken}?cols=${term.cols}&rows=${term.rows}`
      );
      ws = next;
      wsRef.current = next;
      lastSentCols = term.cols;
      lastSentRows = term.rows;
      next.onopen = () => {
        if (cancelled || ws !== next) return;
        reconnectAttempt = 0;
        setStatus('');
      };
      next.onmessage = (event) => {
        if (cancelled || ws !== next) return;
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.kind === 'replay') {
          // Replay must land on a blank terminal, then repaint after layout settles.
          term.reset();
          term.write(msg.data, scheduleReplayRepair);
        }
        if (msg.kind === 'data') {
          term.write(msg.data);
        }
        if (msg.kind === 'exit') {
          sessionExited = true;
          onExit();
          next.close();
        }
      };
      next.onclose = () => {
        if (cancelled || ws !== next) return;
        ws = null;
        wsRef.current = null;
        if (sessionExited) return;
        scheduleReconnect();
      };
      next.onerror = () => {
        // close fires after error; reconnect handled there
      };
    };

    connectAfterLayout();
    term.onData(sendTerminalData);
    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
    });
    window.addEventListener('resize', fitTerminal);
    el.addEventListener('wheel', onWheel, { passive: false });
    resizeObserver.observe(el);
    return () => {
      cancelled = true;
      void convoId; // referenced from reacquireAndConnect
      fitRef.current = null;
      clearReconnectTimer();
      clearConnectFrame();
      clearReplayRepairWork();
      window.removeEventListener('resize', fitTerminal);
      el.removeEventListener('wheel', onWheel);
      disposeTouchScroll();
      resizeObserver.disconnect();
      if (ws) ws.close();
      termRef.current = null;
      wsRef.current = null;
      term.dispose();
    };
  }, [threadId, convoId, initialToken]);
  return (
    <div
      className={`xterm-host${active ? '' : ' is-hidden'}${
        showSpecialKeys ? ' has-special-keys' : ''
      }`}>
      <div className="xterm-frame" ref={frameRef} />
      {showSpecialKeys && (
        <TerminalSpecialKeysBar controlArmed={controlArmed} onKey={handleSpecialKey} />
      )}
      {status && <div className="xterm-status">{status}</div>}
    </div>
  );
};

//
// Pane
//

export const TerminalPane: typeof types.TerminalPane = (): JSX.Element => {
  const selected = useAppStore((state) =>
    state.threads.find((thread) => thread.id === state.selectedId)
  );
  const tokens = useAppStore((state) => state.terminalTokens);
  const error = useAppStore((state) => state.terminalError);
  const activeConvoId = useAppStore((state) =>
    selected ? getActiveConvoId(state, selected.id) : DEFAULT_CONVO_ID
  );

  const selectedId = selected?.id;
  const activeKey = selectedId ? convoTokenKey(selectedId, activeConvoId) : null;
  const hasActiveToken = !!(activeKey && tokens[activeKey]);

  // auto-open the active convo's terminal whenever it switches and we don't
  // have a token yet. covers selecting a thread with a live default pty,
  // switching tabs to a convo we haven't opened in this session, and
  // post-spawn for the freshly-created convo.
  useEffect(() => {
    if (!selected || !activeKey) return;
    if (tokens[activeKey]) return;
    const convo = selected.convos[activeConvoId];
    // only auto-open if the convo entry exists in frontmatter (i.e. spawn
    // has been requested). otherwise the user must click the "open terminal"
    // button.
    if (activeConvoId === DEFAULT_CONVO_ID && !selected.hasLivePty && !convo?.session_id) return;
    void openConvoTerminal({ threadId: selected.id, convoId: activeConvoId });
  }, [selected, activeConvoId, activeKey, tokens]);

  if (!selected) return <section className="convo-pane" />;

  const activeConvo = selected.convos[activeConvoId];
  const convoName =
    activeConvo?.name ||
    (activeConvoId === DEFAULT_CONVO_ID ? (activeConvo?.kind ?? 'claude') : activeConvoId);
  const entries = Object.entries(tokens);
  return (
    <section className={`convo-pane${hasActiveToken ? '' : ' empty-terminal'}`}>
      <div className="mobile-pane-header">
        <span className="mobile-pane-header-thread">{selected.title}</span>
        <span className="mobile-pane-header-sep"> / </span>
        <span className="mobile-pane-header-convo">{convoName}</span>
      </div>
      {entries.length > 0 && (
        <div className="xterm-stack">
          {entries.map(([key, token]) => {
            const sep = key.indexOf(':');
            if (sep < 0) return null;
            const tThreadId = key.slice(0, sep);
            const cId = key.slice(sep + 1);
            const isActive = tThreadId === selectedId && cId === activeConvoId;
            return (
              <TerminalView
                key={key}
                threadId={tThreadId}
                convoId={cId}
                initialToken={token}
                active={isActive}
                onExit={() => clearConvoTerminal(tThreadId, cId)}
              />
            );
          })}
        </div>
      )}
      {!hasActiveToken && (
        <div className="terminal-empty-overlay">
          <IconButton
            title="open terminal"
            onClick={() =>
              void openConvoTerminal({
                threadId: selected.id,
                convoId: activeConvoId,
              }).then(() =>
                window.setTimeout(
                  () => window.dispatchEvent(new Event('threads-terminal-focus')),
                  40
                )
              )
            }>
            <FontAwesomeIcon icon={faTerminal} />
          </IconButton>
          {error && <div className="terminal-error">{error}</div>}
        </div>
      )}
    </section>
  );
};
