import { open, stat } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type ActivityBgProcessOutputEvent,
} from '@canopy/desktop-shared/types';
import { sendToAllWindows } from './window-send';

const POLL_INTERVAL_MS = 1500;
/**
 * Upper bound on the final read performed when a session is torn down. Teardown
 * must never block on a stalled filesystem, so an unfinished flush is dropped.
 */
const FINAL_FLUSH_TIMEOUT_MS = 1_000;
const OUTPUT_CHUNK_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES_PER_POLL = 512 * 1024;

interface PollerState {
  key: string;
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  taskId: string;
  outputFile: string;
  lastOffset: number;
  partialLine: string;
  /** Prevent a read that outlives teardown from publishing stale output. */
  stopped: boolean;
  /** The read currently underway, so a flush can join it instead of no-oping. */
  inFlightPoll: Promise<boolean> | null;
  getWindow: () => BrowserWindow | null;
  intervalId: ReturnType<typeof setInterval>;
}

const pollers = new Map<string, PollerState>();

async function readOutputDelta(
  state: PollerState,
): Promise<{ chunks: string[]; hasUnreadBytes: boolean }> {
  const fileStat = await stat(state.outputFile);

  if (fileStat.size < state.lastOffset) {
    state.lastOffset = 0;
    state.partialLine = '';
  }

  if (fileStat.size === state.lastOffset) {
    return { chunks: [], hasUnreadBytes: false };
  }

  const file = await open(state.outputFile, 'r');
  try {
    const chunks: string[] = [];
    let remainingBytes = Math.min(
      fileStat.size - state.lastOffset,
      MAX_OUTPUT_BYTES_PER_POLL,
    );

    while (remainingBytes > 0) {
      const length = Math.min(remainingBytes, OUTPUT_CHUNK_BYTES);
      const buffer = Buffer.alloc(length);
      const result = await file.read(buffer, 0, length, state.lastOffset);
      if (result.bytesRead === 0) {
        break;
      }

      state.lastOffset += result.bytesRead;
      remainingBytes -= result.bytesRead;
      chunks.push(buffer.subarray(0, result.bytesRead).toString('utf8'));
    }

    return {
      chunks,
      hasUnreadBytes: state.lastOffset < fileStat.size,
    };
  } finally {
    await file.close();
  }
}

function createSessionKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

function createPollerKey(sessionKey: string, taskId: string): string {
  return `${sessionKey}/${taskId}`;
}

function emitOutput(
  getWindow: () => BrowserWindow | null,
  event: ActivityBgProcessOutputEvent,
): void {
  void getWindow;
  sendToAllWindows(IPC_CHANNELS.activityBgProcessOutput, event);
}

async function readAndEmitOutput(state: PollerState): Promise<boolean> {
  try {
    const { chunks, hasUnreadBytes } = await readOutputDelta(state);
    if (state.stopped || chunks.length === 0) return hasUnreadBytes;

    for (const chunk of chunks) {
      const normalized = (state.partialLine + chunk).replace(/\r\n/g, '\n');
      const parts = normalized.split('\n');
      const endsWithNewline = normalized.endsWith('\n');

      state.partialLine = endsWithNewline ? '' : (parts.pop() ?? '');

      if (parts.length === 0) {
        continue;
      }

      emitOutput(state.getWindow, {
        projectId: state.projectId,
        worktreeId: state.worktreeId,
        chatId: state.chatId,
        taskId: state.taskId,
        outputFile: state.outputFile,
        lines: parts,
      });
    }
    return hasUnreadBytes;
  } catch {
    // Output files can disappear while tasks are being torn down.
    return false;
  }
}

function emitPartialLine(state: PollerState): void {
  if (state.stopped || state.partialLine.length === 0) return;
  const line = state.partialLine;
  state.partialLine = '';
  emitOutput(state.getWindow, {
    projectId: state.projectId,
    worktreeId: state.worktreeId,
    chatId: state.chatId,
    taskId: state.taskId,
    outputFile: state.outputFile,
    lines: [line],
  });
}

/**
 * Read and emit whatever is new in the task's output file. Concurrent callers
 * join the read already underway rather than starting a second one, so a
 * teardown flush can await the in-flight poll before taking its own final read.
 */
function pollOutput(state: PollerState): Promise<boolean> {
  if (state.stopped) return Promise.resolve(false);
  const inFlight = state.inFlightPoll;
  if (inFlight) return inFlight;

  const run = readAndEmitOutput(state).then(
    (hasUnreadBytes) => {
      state.inFlightPoll = null;
      return hasUnreadBytes;
    },
    () => {
      state.inFlightPoll = null;
      return false;
    },
  );
  state.inFlightPoll = run;
  return run;
}

async function drainOutputTail(state: PollerState): Promise<void> {
  let hasUnreadBytes = true;
  while (!state.stopped && hasUnreadBytes) {
    hasUnreadBytes = await pollOutput(state);
  }
}

function withFlushTimeout(work: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FINAL_FLUSH_TIMEOUT_MS);
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    void work.then(settle, settle);
  });
}

export function startOutputPolling(
  request: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    taskId: string;
    outputFile: string;
  },
  getWindow: () => BrowserWindow | null,
): void {
  const sessionKey = createSessionKey(
    request.projectId,
    request.worktreeId,
    request.chatId,
  );
  const key = createPollerKey(sessionKey, request.taskId);
  const existing = pollers.get(key);

  if (existing && existing.outputFile === request.outputFile) {
    return;
  }

  if (existing) {
    existing.stopped = true;
    clearInterval(existing.intervalId);
    pollers.delete(key);
  }

  const state: PollerState = {
    key,
    sessionKey,
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
    taskId: request.taskId,
    outputFile: request.outputFile,
    lastOffset: 0,
    partialLine: '',
    stopped: false,
    inFlightPoll: null,
    getWindow,
    intervalId: setInterval(() => {
      void pollOutput(state);
    }, POLL_INTERVAL_MS),
  };

  pollers.set(key, state);
  void pollOutput(state);
}

export function stopOutputPolling(
  projectId: string,
  worktreeId: string,
  chatId: string,
  taskId: string,
): void {
  const sessionKey = createSessionKey(projectId, worktreeId, chatId);
  const key = createPollerKey(sessionKey, taskId);
  const state = pollers.get(key);
  if (!state) return;
  state.stopped = true;
  clearInterval(state.intervalId);
  pollers.delete(key);
}

/**
 * Drain every pending output tail for a session before discarding its pollers
 * Session teardown kills the provider CLI, and the bytes its
 * background tasks wrote just before exiting would otherwise never reach the
 * renderer, because the interval poller is discarded the moment the session is
 * destroyed. Each read stays capped, while the drain repeats until caught up
 * or `FINAL_FLUSH_TIMEOUT_MS` expires; pollers are always removed either way.
 */
export async function flushAndStopOutputPollingForSession(
  sessionKey: string,
): Promise<void> {
  const matching = Array.from(pollers.values()).filter(
    (state) => state.sessionKey === sessionKey,
  );
  if (matching.length === 0) return;

  // Stop the timers first so no new interval poll starts behind the final read.
  for (const state of matching) {
    clearInterval(state.intervalId);
  }

  try {
    await withFlushTimeout(
      Promise.all(
        matching.map(async (state) => {
          // Join a read already underway, then take a fresh one so the tail
          // written after that read started is not lost.
          await state.inFlightPoll;
          await drainOutputTail(state);
          emitPartialLine(state);
        }),
      ),
    );
  } finally {
    for (const state of matching) {
      state.stopped = true;
      pollers.delete(state.key);
    }
  }
}

export function stopAllOutputPolling(): void {
  for (const state of Array.from(pollers.values())) {
    state.stopped = true;
    clearInterval(state.intervalId);
  }
  pollers.clear();
}
