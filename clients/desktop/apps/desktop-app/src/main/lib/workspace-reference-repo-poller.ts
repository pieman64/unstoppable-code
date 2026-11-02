import {
  IPC_CHANNELS,
  type SidebarItem,
  type WorkspaceReferenceRepoStatus,
  type WorkspaceReferenceRepoStatusEvent,
  type WorkspaceReferenceRepoWarningCode,
} from '@canopy/desktop-shared/types';
import type { WorkerGitDispatcher } from '../canopy-runtime/worker-git-adapter';
import { inspectReferenceRepo } from './workspace-reference-repo-health';
import { sendToWindow, type SendableBrowserWindow } from './window-send';

const STALE_THRESHOLD = 30_000;
const IMMEDIATE_TICK_DELAY = 1_000;
const GRADUAL_TICK_DELAY = 30_000;

interface TrackedWorkspaceReferenceRepo {
  workspaceId: string;
  lastCheckedAt: number;
  lastStatus: WorkspaceReferenceRepoStatus | null;
}

const tracked = new Map<string, TrackedWorkspaceReferenceRepo>();
const immediateQueue: string[] = [];
const gradualQueue: string[] = [];
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let getWindowFn: (() => SendableBrowserWindow | null) | null = null;
let gitDispatcher: WorkerGitDispatcher | null = null;
let running = false;
let ticking = false;
let lastPollAt = 0;
let lastGradualPollAt = 0;

function removeFromQueue(queue: string[], workspaceId: string): void {
  let index = queue.indexOf(workspaceId);
  while (index !== -1) {
    queue.splice(index, 1);
    index = queue.indexOf(workspaceId);
  }
}

function moveToFront(queue: string[], workspaceId: string): void {
  removeFromQueue(queue, workspaceId);
  queue.unshift(workspaceId);
}

function ensureTracked(workspaceId: string): TrackedWorkspaceReferenceRepo {
  let entry = tracked.get(workspaceId);
  if (!entry) {
    entry = {
      workspaceId,
      lastCheckedAt: 0,
      lastStatus: null,
    };
    tracked.set(workspaceId, entry);
  }
  if (!gradualQueue.includes(workspaceId)) {
    gradualQueue.push(workspaceId);
  }
  return entry;
}

function sendStatusEvent(event: WorkspaceReferenceRepoStatusEvent): void {
  sendToWindow(
    getWindowFn?.() ?? null,
    IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
    event,
  );
}

function statusesMatch(
  left: WorkspaceReferenceRepoStatus | null,
  right: WorkspaceReferenceRepoStatus | null,
): boolean {
  const comparableLeft = left
    ? {
        ...left,
        lastCheckedAt: '',
      }
    : null;
  const comparableRight = right
    ? {
        ...right,
        lastCheckedAt: '',
      }
    : null;
  return JSON.stringify(comparableLeft) === JSON.stringify(comparableRight);
}

async function checkWorkspace(
  dispatcher: WorkerGitDispatcher,
  entry: TrackedWorkspaceReferenceRepo,
): Promise<void> {
  const status = await inspectReferenceRepo(dispatcher, entry.workspaceId);
  const didUpdateReferenceRepo = Boolean(status?.didAutoPull);
  const changed = !statusesMatch(entry.lastStatus, status);

  entry.lastCheckedAt = Date.now();
  entry.lastStatus = status;

  if (changed || didUpdateReferenceRepo) {
    sendStatusEvent({
      workspaceId: entry.workspaceId,
      status,
      didUpdateReferenceRepo,
    });
  }
}

function getNextImmediateWorkspaceId(): string | null {
  while (immediateQueue.length > 0) {
    const workspaceId = immediateQueue.shift();
    if (workspaceId && tracked.has(workspaceId)) {
      return workspaceId;
    }
  }
  return null;
}

function getNextGradualWorkspaceId(): string | null {
  while (gradualQueue.length > 0) {
    const workspaceId = gradualQueue[0];
    if (tracked.has(workspaceId)) {
      return workspaceId;
    }
    gradualQueue.shift();
  }
  return null;
}

function rotateGradualQueue(workspaceId: string): void {
  removeFromQueue(gradualQueue, workspaceId);
  gradualQueue.push(workspaceId);
}

function getImmediateDueAt(): number | null {
  return immediateQueue.some((workspaceId) => tracked.has(workspaceId))
    ? lastPollAt + IMMEDIATE_TICK_DELAY
    : null;
}

function getGradualDueAt(): number | null {
  const workspaceId = getNextGradualWorkspaceId();
  if (!workspaceId) {
    return null;
  }

  return Math.max(
    lastPollAt + IMMEDIATE_TICK_DELAY,
    lastGradualPollAt + GRADUAL_TICK_DELAY,
  );
}

function getNextDueAt(): number | null {
  const dueTimes = [getImmediateDueAt(), getGradualDueAt()].filter(
    (value): value is number => value !== null,
  );
  if (dueTimes.length === 0) {
    return null;
  }
  return Math.min(...dueTimes);
}

function scheduleNext(): void {
  if (!running || ticking) {
    return;
  }

  const nextDueAt = getNextDueAt();
  if (nextDueAt === null) {
    if (pollTimeout !== null) {
      clearTimeout(pollTimeout);
      pollTimeout = null;
    }
    return;
  }

  if (pollTimeout !== null) {
    clearTimeout(pollTimeout);
  }

  pollTimeout = setTimeout(
    () => {
      pollTimeout = null;
      void tick().catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('workspace reference repo poller tick failed', error);
      });
    },
    Math.max(nextDueAt - Date.now(), 0),
  );
}

async function tick(): Promise<void> {
  const dispatcher = gitDispatcher;
  if (!running || ticking || !dispatcher) {
    return;
  }

  ticking = true;

  try {
    const now = Date.now();

    const immediateDueAt = getImmediateDueAt();
    if (immediateDueAt !== null && immediateDueAt <= now) {
      const workspaceId = getNextImmediateWorkspaceId();
      if (workspaceId) {
        const entry = tracked.get(workspaceId);
        if (entry) {
          lastPollAt = Date.now();
          await checkWorkspace(dispatcher, entry);
          return;
        }
      }
    }

    const gradualDueAt = getGradualDueAt();
    if (gradualDueAt !== null && gradualDueAt <= now) {
      const workspaceId = getNextGradualWorkspaceId();
      if (workspaceId) {
        const entry = tracked.get(workspaceId);
        if (entry) {
          lastPollAt = Date.now();
          lastGradualPollAt = lastPollAt;
          rotateGradualQueue(workspaceId);
          await checkWorkspace(dispatcher, entry);
          return;
        }
      }
    }
  } finally {
    ticking = false;
    scheduleNext();
  }
}

export function startPolling(
  getWindow: () => SendableBrowserWindow | null,
  dispatcher: WorkerGitDispatcher,
): void {
  getWindowFn = getWindow;
  gitDispatcher = dispatcher;
  running = true;
  scheduleNext();
}

export function stopPolling(): void {
  running = false;
  if (pollTimeout !== null) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
}

export function syncTrackedWorkspaces(
  items: SidebarItem[],
  preserveWorkspaceIds: ReadonlySet<string> = new Set(),
): void {
  const nextWorkspaceIds = new Set(
    items
      .filter(
        (item): item is Extract<SidebarItem, { type: 'multi-repo' }> =>
          item.type === 'multi-repo' && Boolean(item.sourceRepoPath),
      )
      .map((item) => item.id),
  );

  for (const workspaceId of Array.from(tracked.keys())) {
    if (
      !nextWorkspaceIds.has(workspaceId) &&
      !preserveWorkspaceIds.has(workspaceId)
    ) {
      tracked.delete(workspaceId);
      removeFromQueue(immediateQueue, workspaceId);
      removeFromQueue(gradualQueue, workspaceId);
    }
  }

  for (const workspaceId of Array.from(nextWorkspaceIds)) {
    ensureTracked(workspaceId);
  }

  scheduleNext();
}

export function requestRefresh(
  workspaceId: string,
  force: boolean = false,
): void {
  const entry = ensureTracked(workspaceId);
  if (!force && Date.now() - entry.lastCheckedAt < STALE_THRESHOLD) {
    scheduleNext();
    return;
  }

  moveToFront(immediateQueue, workspaceId);
  scheduleNext();
}

export function getCachedStatus(
  workspaceId: string,
): WorkspaceReferenceRepoStatus | null {
  return tracked.get(workspaceId)?.lastStatus ?? null;
}

export function resolveWarning(
  workspaceId: string,
  warningCode: WorkspaceReferenceRepoWarningCode,
): Promise<void> {
  void warningCode;
  requestRefresh(workspaceId, true);
  return Promise.resolve();
}
