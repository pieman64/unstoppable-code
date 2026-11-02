import { useCallback, useEffect } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type {
  BackgroundTaskStopOutcome,
  BackgroundTaskStopRequest,
  CanopyClient,
} from '@canopy/app-core';
import { useCanopyClient } from '../CanopyClientProvider';

/**
 * Stops sent for native background tasks whose end has not been seen yet,
 * keyed by {@link backgroundTaskStopKey}. Each value is the token of the stop
 * that set it, so a late outcome of an earlier stop cannot clear a newer one.
 */
export interface BackgroundTaskStopState {
  readonly pending: Readonly<Record<string, number>>;
  /** Marks the task as stopping and returns this stop's token. */
  readonly markPending: (key: string) => number;
  /** Clears the entry; with a token, only if that stop still owns it. */
  readonly clearPending: (key: string, token?: number) => void;
}

export type BackgroundTaskStopStore = UseBoundStore<
  StoreApi<BackgroundTaskStopState>
>;

/** One task's pending-stop key: project, worktree, chat and task id. */
export function backgroundTaskStopKey(
  request: BackgroundTaskStopRequest,
): string {
  return JSON.stringify([
    request.projectId,
    request.worktreeId,
    request.chatId,
    request.taskId,
  ]);
}

function createBackgroundTaskStopStore(): BackgroundTaskStopStore {
  let nextToken = 0;
  return create<BackgroundTaskStopState>()((set) => ({
    pending: {},
    markPending: (key: string): number => {
      nextToken += 1;
      const token = nextToken;
      set((state) => ({ pending: { ...state.pending, [key]: token } }));
      return token;
    },
    clearPending: (key: string, token?: number): void => {
      set((state) => {
        const current = state.pending[key];
        if (current === undefined) return state;
        if (token !== undefined && current !== token) return state;
        return {
          pending: Object.fromEntries(
            Object.entries(state.pending).filter(([entry]) => entry !== key),
          ),
        };
      });
    },
  }));
}

/*
 * One pending set per client rather than a provider-registry store: the App
 * Advisor dispatcher marks a task stopping outside React, and every row copy
 * under the provider for the same client must see it. The set holds no
 * transport state, so nothing needs disposing with the client.
 */
const storesByClient = new WeakMap<CanopyClient, BackgroundTaskStopStore>();

/** The pending-stop set shared by every surface of this client. */
export function backgroundTaskStopStoreFor(
  client: CanopyClient,
): BackgroundTaskStopStore {
  const existing = storesByClient.get(client);
  if (existing) return existing;
  const store = createBackgroundTaskStopStore();
  storesByClient.set(client, store);
  return store;
}

/** The chat a pending key belongs to, or `null` for a key it did not make. */
function parseBackgroundTaskStopKey(
  key: string,
): BackgroundTaskStopRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const parts = Array.from<unknown>(parsed);
  if (parts.length !== 4) return null;
  const [projectId, worktreeId, chatId, taskId] = parts;
  return typeof projectId === 'string' &&
    typeof worktreeId === 'string' &&
    typeof chatId === 'string' &&
    typeof taskId === 'string'
    ? { projectId, worktreeId, chatId, taskId }
    : null;
}

/**
 * Clears every pending stop of one chat whose task the host no longer
 * reports live. A row unmounts when its task ends (and a stop sent with no
 * row mounted has no row at all), so it never sees `live` turn false; the
 * host calls this from its own authoritative live-task set instead.
 */
export function clearEndedBackgroundTaskStops(
  client: CanopyClient,
  chat: Omit<BackgroundTaskStopRequest, 'taskId'>,
  liveTaskIds: ReadonlySet<string>,
): void {
  const store = backgroundTaskStopStoreFor(client);
  for (const key of Object.keys(store.getState().pending)) {
    const request = parseBackgroundTaskStopKey(key);
    if (
      request &&
      request.projectId === chat.projectId &&
      request.worktreeId === chat.worktreeId &&
      request.chatId === chat.chatId &&
      !liveTaskIds.has(request.taskId)
    ) {
      store.getState().clearPending(key);
    }
  }
}

/**
 * Stops one native background task and keeps every copy of its row in step.
 * The task reads as stopping until its end is seen: on `stopped` the entry
 * stays until the host reports the task is no longer live (see
 * {@link useBackgroundTaskStop}); `already-finished` and `session-ended`
 * clear it because the host reports that end itself. A rejection clears it
 * and rejects again for the caller to report. Never reports a terminal
 * status itself.
 */
export async function requestBackgroundTaskStop(
  client: CanopyClient,
  request: BackgroundTaskStopRequest,
): Promise<BackgroundTaskStopOutcome> {
  const store = backgroundTaskStopStoreFor(client);
  const key = backgroundTaskStopKey(request);
  const token = store.getState().markPending(key);
  let outcome: BackgroundTaskStopOutcome;
  try {
    outcome = await client.command('activity.stopBackgroundTask', {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
      taskId: request.taskId,
    });
  } catch (error: unknown) {
    store.getState().clearPending(key, token);
    throw error;
  }
  if (outcome !== 'stopped') store.getState().clearPending(key, token);
  return outcome;
}

export interface BackgroundTaskStopControl {
  /** A stop for this task was sent and its end has not been seen. */
  readonly stopping: boolean;
  /** Sends the stop; rejects when the host could not send it. */
  readonly stop: () => Promise<BackgroundTaskStopOutcome>;
}

/**
 * The shared stop state of one task for a row. `live` is the host's own
 * signal that the task is still running; once it turns false the pending
 * entry is cleared for every copy of the row.
 */
export function useBackgroundTaskStop(
  request: BackgroundTaskStopRequest,
  live: boolean,
): BackgroundTaskStopControl {
  const client = useCanopyClient();
  const store = backgroundTaskStopStoreFor(client);
  const { projectId, worktreeId, chatId, taskId } = request;
  const key = backgroundTaskStopKey({ projectId, worktreeId, chatId, taskId });
  const stopping = store((state) => state.pending[key] !== undefined);
  useEffect(() => {
    if (!live) store.getState().clearPending(key);
  }, [key, live, store]);
  const stop = useCallback(
    (): Promise<BackgroundTaskStopOutcome> =>
      requestBackgroundTaskStop(client, {
        projectId,
        worktreeId,
        chatId,
        taskId,
      }),
    [chatId, client, projectId, taskId, worktreeId],
  );
  return { stopping: live && stopping, stop };
}
