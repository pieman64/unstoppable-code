'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import type {
  ClaudeModsChatContext,
  ClaudeModsGetArgs,
  ClaudeModsState,
  ClaudeModsUpdate,
  ClaudeModsUpdateErrorCode,
} from '@canopy/protocol/claude-mods';

export type ClaudeModsHookError = ClaudeModsUpdateErrorCode | 'request-failed';

export interface UseClaudeModsResult {
  readonly state: ClaudeModsState | null;
  readonly pending: boolean;
  readonly error: ClaudeModsHookError | null;
  readonly update: (update: ClaudeModsUpdate) => void;
}

interface ClaudeModsSnapshot {
  /** The plugin and chat the snapshot was read for. */
  readonly scopeKey: string;
  readonly state: ClaudeModsState | null;
  readonly pending: boolean;
  readonly error: ClaudeModsHookError | null;
}

const READ_AFTER_UPDATE_ERRORS: ReadonlySet<ClaudeModsUpdateErrorCode> =
  new Set([
    'digest-changed',
    'save-outcome-unknown',
    'plugin-unreadable',
    'not-a-mod',
    'plugin-not-found',
    'flag-off',
  ]);

// The kill switch and plugin controls are separate mounts on one client; after
// any of them changes admission, the others read the new state.
const changeListeners = new WeakMap<CanopyClient, Set<() => void>>();

function changeListenersFor(client: CanopyClient): Set<() => void> {
  let listeners = changeListeners.get(client);
  if (!listeners) {
    listeners = new Set();
    changeListeners.set(client, listeners);
  }
  return listeners;
}

/**
 * The chat context, rebuilt from its ids so a host that passes a new but
 * equal object each render reads and updates the same scope.
 */
function useStableChatContext(
  context: ClaudeModsChatContext | undefined,
): ClaudeModsChatContext | undefined {
  const projectId = context?.projectId;
  const worktreeId = context?.worktreeId;
  const chatId = context?.chatId;
  const repoId = context?.repoId;
  return useMemo(
    () =>
      projectId !== undefined &&
      worktreeId !== undefined &&
      chatId !== undefined
        ? {
            projectId,
            worktreeId,
            chatId,
            ...(repoId !== undefined ? { repoId } : {}),
          }
        : undefined,
    [projectId, worktreeId, chatId, repoId],
  );
}

function scopeKeyFor(
  pluginId: string | undefined,
  context: ClaudeModsChatContext | undefined,
): string {
  return JSON.stringify([
    pluginId ?? null,
    context?.projectId ?? null,
    context?.worktreeId ?? null,
    context?.chatId ?? null,
    context?.repoId ?? null,
  ]);
}

function withContext(
  update: ClaudeModsUpdate,
  context: ClaudeModsChatContext | undefined,
): ClaudeModsUpdate {
  if (context === undefined || update.action === 'set-mods-disabled') {
    return update;
  }
  return update.context === undefined ? { ...update, context } : update;
}

/**
 * Claude Mod admission state for one plugin, or the kill switch without one.
 * `context` names the chat a request comes from, so the desktop resolves the
 * folder that chat launches in.
 */
export function useClaudeMods(
  pluginId?: string,
  context?: ClaudeModsChatContext,
): UseClaudeModsResult {
  const client = useCanopyClient();
  const hasCapability = useCapabilities().claudeModAdmission === true;
  const chatContext = useStableChatContext(context);
  const scopeKey = scopeKeyFor(pluginId, chatContext);
  const [snapshot, setSnapshot] = useState<ClaudeModsSnapshot>(() => ({
    scopeKey,
    state: null,
    pending: false,
    error: null,
  }));
  const mountedRef = useRef(false);
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const updateIdRef = useRef(0);
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  const read = useCallback(
    async (allowWhilePending = false): Promise<void> => {
      if (
        !hasCapability ||
        !mountedRef.current ||
        (pendingRef.current && !allowWhilePending)
      ) {
        return;
      }

      const requestScopeKey = scopeKey;
      const generation = ++generationRef.current;
      const args: ClaudeModsGetArgs = {
        ...(pluginId ? { pluginId } : {}),
        ...(chatContext ? { context: chatContext } : {}),
      };
      try {
        const currentState = await client.query('claudeMods.get', args);
        if (
          mountedRef.current &&
          scopeKeyRef.current === requestScopeKey &&
          generationRef.current === generation
        ) {
          setSnapshot((current) => ({
            ...current,
            scopeKey: requestScopeKey,
            state: currentState,
          }));
        }
      } catch {
        // Keep the last good state. A missing first read stays hidden.
      }
    },
    [chatContext, client, hasCapability, pluginId, scopeKey],
  );

  useEffect(() => {
    mountedRef.current = true;
    pendingRef.current = false;
    generationRef.current += 1;
    updateIdRef.current += 1;
    setSnapshot({ scopeKey, state: null, pending: false, error: null });

    if (!hasCapability) {
      return (): void => {
        mountedRef.current = false;
        generationRef.current += 1;
        updateIdRef.current += 1;
      };
    }

    const onFocus = (): void => {
      void read();
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void read();
    };
    const windowHost = typeof window === 'undefined' ? null : window;
    const documentHost = typeof document === 'undefined' ? null : document;
    windowHost?.addEventListener('focus', onFocus);
    documentHost?.addEventListener('visibilitychange', onVisibilityChange);
    const listeners = changeListenersFor(client);
    listeners.add(onFocus);
    void read();

    return (): void => {
      mountedRef.current = false;
      pendingRef.current = false;
      generationRef.current += 1;
      updateIdRef.current += 1;
      windowHost?.removeEventListener('focus', onFocus);
      documentHost?.removeEventListener('visibilitychange', onVisibilityChange);
      listeners.delete(onFocus);
    };
  }, [client, hasCapability, scopeKey, read]);

  const update = useCallback(
    (nextUpdate: ClaudeModsUpdate): void => {
      if (!hasCapability || !mountedRef.current || pendingRef.current) return;

      pendingRef.current = true;
      const requestScopeKey = scopeKey;
      const updateId = ++updateIdRef.current;
      const generation = ++generationRef.current;
      setSnapshot((current) => ({
        scopeKey: requestScopeKey,
        state: current.scopeKey === requestScopeKey ? current.state : null,
        pending: true,
        error: null,
      }));

      const isCurrentUpdate = (): boolean =>
        mountedRef.current &&
        scopeKeyRef.current === requestScopeKey &&
        updateIdRef.current === updateId &&
        generationRef.current === generation;

      void (async (): Promise<void> => {
        try {
          const result = await client.command(
            'claudeMods.update',
            withContext(nextUpdate, chatContext),
          );
          if (!isCurrentUpdate()) return;

          if (result.ok) {
            setSnapshot((current) => ({
              ...current,
              scopeKey: requestScopeKey,
              state: result.state,
              error: null,
            }));
            // This instance's read is skipped while its update is pending.
            for (const listener of changeListenersFor(client)) listener();
          } else {
            setSnapshot((current) => ({
              ...current,
              scopeKey: requestScopeKey,
              error: result.code,
            }));
            if (READ_AFTER_UPDATE_ERRORS.has(result.code)) await read(true);
          }
        } catch {
          if (isCurrentUpdate()) {
            setSnapshot((current) => ({
              ...current,
              scopeKey: requestScopeKey,
              error: 'request-failed',
            }));
          }
        } finally {
          if (
            mountedRef.current &&
            scopeKeyRef.current === requestScopeKey &&
            updateIdRef.current === updateId
          ) {
            pendingRef.current = false;
            setSnapshot((current) =>
              current.scopeKey === requestScopeKey
                ? { ...current, pending: false }
                : current,
            );
          }
        }
      })();
    },
    [chatContext, client, hasCapability, read, scopeKey],
  );

  const currentSnapshot = snapshot.scopeKey === scopeKey ? snapshot : null;
  return {
    state: currentSnapshot?.state ?? null,
    pending: currentSnapshot?.pending ?? false,
    error: currentSnapshot?.error ?? null,
    update,
  };
}
