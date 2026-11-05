'use client';

import {
  isGitHubStarPromptAvailable,
  useOptionalCanopyClient,
  type GitHubStarPromptStore,
} from '@canopy/app-state';
import type { CanopyClient } from '@canopy/app-core';
import { useComposerTipClaim } from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

/** How long the in-app confirmation stays before the row retires. */
export const GITHUB_STAR_PROMPT_DONE_MS = 2000;

export interface UseGitHubStarPromptOptions {
  /** Null when the host's brand or account never shows the prompt. */
  store: GitHubStarPromptStore | null;
  /** The brand's source repository. Null hides the prompt. */
  repository: { readonly url: string } | null;
  /**
   * The GitHub CLI login that would star in app. Null on hosts without
   * in-app starring, or when the CLI is not signed in.
   */
  starLogin: string | null;
  /** This is the active, visible composer. */
  active: boolean;
  /** A turn is streaming: the prompt waits until it ends. */
  turnActive: boolean;
  /** Host telemetry, once per stored impression. */
  onShown?: () => void;
  /** Host telemetry, after starring in app. */
  onStarred?: () => void;
  /** Host telemetry, after opening the repository in the browser. */
  onOpened?: (detail: { fallback: boolean }) => void;
  onDismissed?: () => void;
  /** Return focus to the composer when an action removes the prompt. */
  focusComposer?: () => void;
}

export interface GitHubStarPromptOffer {
  visible: boolean;
  /** The star request is running: further activation is disabled. */
  pending: boolean;
  /** `starred` while the in-app confirmation shows. */
  done: 'starred' | null;
  /** Whether Star stars in app rather than opening the browser. */
  starsInApp: boolean;
  accept: () => Promise<void>;
  dismiss: () => void;
}

const NO_STORE_SUBSCRIPTION = (): (() => void) => () => undefined;

/** Whether the host starred the repository; any failure falls back. */
async function starInApp(host: CanopyClient): Promise<boolean> {
  try {
    return (await host.command('sourceRepository.star', {})).starred;
  } catch {
    return false;
  }
}

function openRepository(host: CanopyClient | null, url: string): void {
  if (host?.openExternalUrl) host.openExternalUrl(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * The one-time GitHub star nudge (CAN-5604), offered after the scope's
 * fifth accepted prompt and once no turn is streaming. Star or dismiss
 * retires it for the scope permanently. Starring runs in app through the
 * host's GitHub CLI when the host offers it, and otherwise opens the
 * repository in the browser.
 */
export function useGitHubStarPrompt({
  store,
  repository,
  starLogin,
  active,
  turnActive,
  onShown,
  onStarred,
  onOpened,
  onDismissed,
  focusComposer,
}: UseGitHubStarPromptOptions): GitHubStarPromptOffer {
  const client = useOptionalCanopyClient();
  const starsInApp =
    client?.capabilities.sourceRepositoryStar === true && starLogin !== null;

  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      store === null ? (): void => undefined : store.subscribe(listener),
    [store],
  );
  const available = useSyncExternalStore(
    store === null ? NO_STORE_SUBSCRIPTION : subscribe,
    () => store !== null && isGitHubStarPromptAvailable(store.getState()),
    () => false,
  );

  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<'starred' | null>(null);
  // A running request and the confirmation keep the claim, so retiring the
  // record never blinks the row out or lets a lower tip appear beside it.
  const wantsToShow =
    (available && repository !== null && active && !turnActive) ||
    pending ||
    done === 'starred';
  const { visible: claimed, isVisible } = useComposerTipClaim(
    'github-star',
    wantsToShow,
  );
  const visible = claimed && done === null;

  const latest = useRef({ client, store, repository, starsInApp, pending });
  latest.current = { client, store, repository, starsInApp, pending };
  const callbacks = useRef({
    onShown,
    onStarred,
    onOpened,
    onDismissed,
    focusComposer,
  });
  callbacks.current = {
    onShown,
    onStarred,
    onOpened,
    onDismissed,
    focusComposer,
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const presented = useRef(false);
  useEffect(() => {
    if (!visible || !isVisible() || presented.current || store === null) return;
    presented.current = true;
    void store
      .getState()
      .markShown()
      .then((wrote) => {
        if (wrote) callbacks.current.onShown?.();
      });
  }, [visible, isVisible, store]);

  useEffect(() => {
    if (done === null) return undefined;
    const timer = setTimeout(() => setDone(null), GITHUB_STAR_PROMPT_DONE_MS);
    return (): void => clearTimeout(timer);
  }, [done]);

  const accept = useCallback(async () => {
    const {
      client: host,
      store: scope,
      repository: target,
      starsInApp: inApp,
      pending: busy,
    } = latest.current;
    if (!visible || busy || !isVisible() || scope === null || target === null)
      return;
    latest.current.pending = true;
    setPending(true);
    const starred = inApp && host !== null && (await starInApp(host));
    if (!starred) openRepository(host, target.url);
    latest.current.pending = false;
    if (mounted.current) {
      setPending(false);
      if (starred) setDone('starred');
    }
    // Store-level: retirement and its telemetry hold even if this composer
    // unmounted mid-request.
    void scope.getState().markStarred();
    if (starred) callbacks.current.onStarred?.();
    else callbacks.current.onOpened?.({ fallback: inApp });
    if (mounted.current) callbacks.current.focusComposer?.();
  }, [visible, isVisible]);

  const dismiss = useCallback(() => {
    const { store: scope, pending: busy } = latest.current;
    if (!visible || busy || !isVisible() || scope === null) return;
    void scope.getState().markDismissed();
    callbacks.current.onDismissed?.();
    callbacks.current.focusComposer?.();
  }, [visible, isVisible]);

  return { visible, pending, done, starsInApp, accept, dismiss };
}
