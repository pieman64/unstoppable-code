import { CodexLoginModal } from './CodexLoginModal';
import '@xterm/xterm/css/xterm.css';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { installTerminalLinks } from '@canopy/ui-app/terminal';
import type {
  AgentProviderAuthStatus,
  AgentProviderType,
  AuthTerminalProvider,
} from '@canopy/desktop-shared/types';
import { Button } from '@canopy/ui-shared/components';
import { ChevronRightIcon } from '@canopy/ui-shared/icons/AppIcons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DialogModal } from '@/components/shared/DialogModal';
import { invalidateClaudeAuthStatusCache } from '@/hooks/useClaudeAuthStatus';
import { invalidateCodexAuthStatusCache } from '@/hooks/useCodexAuthStatus';
import { invalidateGitHubCliStatusCache } from '@/hooks/useGitHubCliStatus';
import { copyTextToClipboard } from '@/lib/clipboard';
import { isDifferentProviderAccount } from '@/lib/accountChangeDetection';
import { TerminalSelectionMenu } from '@/components/terminal/TerminalSelectionMenu';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  computeRelevantAccountSnapshots,
  OtherAccountSnapshotsPanel,
} from '@/components/pages/usage/OtherAccountSnapshots';
import { findProviderAuthorizationUrl } from './authAuthorizationUrl';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';

const NOW_TICK_MS = 30_000;

const STATUS_POLL_MS = 2000;
const TERMINAL_BG = '#0b0c10';
const TERMINAL_AREA_HEIGHT = 380;

type ModalView =
  | { kind: 'running' }
  | { kind: 'exit-checking'; exitCode: number | null }
  | { kind: 'login-failed'; exitCode: number | null };

interface AuthLoginModalProps {
  provider: AuthTerminalProvider;
  onClose: () => void;
  /** Return true when an embedded browser has opened the provider OAuth URL. */
  onAuthorizationUrl?: (url: string) => boolean | Promise<boolean>;
  ownerDocument?: Document;
  /** Why the sign-in is needed now, shown above the terminal. */
  intro?: string;
  introTestId?: string;
  /** Explicitly abandon an interrupted action, separately from settling close. */
  onCancel?: () => void;
}

function providerLabel(provider: AuthTerminalProvider): string {
  if (provider === 'opencode') return 'OpenCode';
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'GitHub';
}

function invalidateProviderCache(provider: AuthTerminalProvider): void {
  if (provider === 'opencode') return;
  if (provider === 'claude') {
    invalidateClaudeAuthStatusCache();
  } else if (provider === 'codex') {
    invalidateCodexAuthStatusCache();
  } else {
    invalidateGitHubCliStatusCache();
  }
}

async function fetchProviderStatus(
  provider: AuthTerminalProvider,
): Promise<AgentProviderAuthStatus> {
  // Only ever called from `refreshStatus`, which first invalidates the renderer
  // cache — i.e. this is always a deliberate re-probe (initial open, poll, or
  // post-sign-in). Force a fresh main-process probe so the now-TTL-cached
  // settings handler can't return a stale pre-login status after a login lands.
  if (provider === 'claude') {
    return window.api.getClaudeAuthStatus({ forceRefresh: true });
  }
  if (provider === 'codex') {
    return window.api.getCodexAuthStatus({ forceRefresh: true });
  }
  if (provider === 'opencode')
    return {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: null,
    };
  const gh = await window.api.getGitHubCliStatus();
  return {
    authenticated: gh.authenticated,
    accountLabel: gh.username,
    detail: null,
    error: gh.error,
  };
}

function StatusFooter({
  provider,
  status,
  trailing,
}: {
  provider: AuthTerminalProvider;
  status: AgentProviderAuthStatus | null;
  /** Optional control rendered flush-right in the footer (snapshots toggle). */
  trailing?: JSX.Element | null;
}): JSX.Element {
  if (provider === 'opencode')
    return (
      <div
        data-testid="auth-login-status"
        className="px-5 py-3 border-t text-s fg-secondary"
      >
        Choose a provider and follow its sign-in instructions.
      </div>
    );
  return (
    <div
      data-testid="auth-login-status"
      className="flex items-center gap-2 px-5 py-3 border-t bg-base/40"
    >
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ${
          status === null
            ? 'bg-fg-secondary'
            : status.authenticated
              ? 'bg-success'
              : 'bg-destructive'
        }`}
      />
      <div className="min-w-0 flex-1 text-s">
        {status === null && (
          <span className="fg-secondary">
            Checking {providerLabel(provider)} status&hellip;
          </span>
        )}
        {status?.authenticated && (
          <span className="fg-secondary">
            Signed in
            {status.accountLabel ? (
              <>
                {' as '}
                <span
                  className={`font-medium fg-primary ${POSTHOG_REPLAY_BLOCK_CLASS}`}
                >
                  {status.accountLabel}
                </span>
              </>
            ) : null}
            {status.detail ? (
              <span className="ml-2 text-xs">({status.detail})</span>
            ) : null}
          </span>
        )}
        {status && !status.authenticated && (
          <span className="fg-destructive">
            {status.error || `Not signed in to ${providerLabel(provider)}.`}
          </span>
        )}
      </div>
      {trailing}
    </div>
  );
}

function LoginFailedView({
  provider,
  exitCode,
  onLogin,
  onCancel,
}: {
  provider: AuthTerminalProvider;
  exitCode: number | null;
  onLogin: () => void;
  onCancel: () => void;
}): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 px-6 text-center"
      style={{ height: TERMINAL_AREA_HEIGHT }}
    >
      <div>
        <h3 className="text-m font-medium fg-primary">
          {providerLabel(provider)} sign-in did not complete
        </h3>
        <p className="mt-1 text-s fg-secondary">
          The {providerLabel(provider)} sign-in process exited
          {exitCode !== null && exitCode !== 0
            ? ` with code ${exitCode}`
            : ''}{' '}
          without authenticating. Try again, or cancel to close this window.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size={settingsButtonSize}
          variant="ghost"
          onClick={onCancel}
          data-testid="auth-login-cancel"
        >
          Cancel
        </Button>
        <Button
          size={settingsButtonSize}
          variant="primary"
          onClick={onLogin}
          data-testid="auth-login-submit"
        >
          Sign in
        </Button>
      </div>
    </div>
  );
}

export function AuthLoginModal(props: AuthLoginModalProps): JSX.Element {
  return props.provider === 'codex' ? (
    <CodexLoginModal
      onClose={props.onClose}
      ownerDocument={props.ownerDocument}
    />
  ) : (
    <TerminalAuthLoginModal {...props} />
  );
}

function TerminalAuthLoginModal({
  provider,
  onClose,
  onAuthorizationUrl,
  ownerDocument,
  intro,
  introTestId,
  onCancel,
}: AuthLoginModalProps): JSX.Element {
  const terminalFrameRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const onAuthorizationUrlRef = useRef(onAuthorizationUrl);
  const authorizationOutputRef = useRef('');
  const openedAuthorizationUrlsRef = useRef(new Set<string>());
  // Captures the account status from the mount-time status fetch only. The
  // login PTY waits for that fetch to settle so this stays the "before" side
  // of the account-change comparison even when the login flow completes fast.
  const baselineStatusRef = useRef<AgentProviderAuthStatus | null>(null);
  const openResumePrompt = useUsageLimitResumePromptStore((s) => s.open);
  const initializeObservability = useObservabilityStore((s) => s.initialize);
  const usage = useObservabilityStore((s) => s.usage);

  const [status, setStatus] = useState<AgentProviderAuthStatus | null>(null);
  const [preLoginStatusSettled, setPreLoginStatusSettled] = useState(false);
  const [view, setView] = useState<ModalView>({ kind: 'running' });
  const [attempt, setAttempt] = useState(0);
  const [selectionMenu, setSelectionMenu] = useState<{
    top: number;
    left: number;
  } | null>(null);
  // Default collapsed on every open: this component is conditionally mounted by
  // its callers, so a fresh `false` here means each open starts collapsed.
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    onAuthorizationUrlRef.current = onAuthorizationUrl;
  }, [onAuthorizationUrl]);

  // Snapshots only exist for the usage-tracked providers; GitHub has none.
  const snapshotProvider: AgentProviderType | null =
    provider === 'claude' || provider === 'codex' ? provider : null;

  // Load the observability snapshot so `usage.accountSnapshots` is populated
  // even when the user hasn't opened the Usage page this session.
  useEffect(() => {
    if (snapshotProvider) {
      void initializeObservability();
    }
  }, [snapshotProvider, initializeObservability]);

  const activeSummary = useMemo(
    () =>
      snapshotProvider
        ? usage.providers.find((p) => p.provider === snapshotProvider)
        : undefined,
    [usage.providers, snapshotProvider],
  );

  const relevantSnapshots = useMemo(
    () =>
      snapshotProvider
        ? computeRelevantAccountSnapshots(
            snapshotProvider,
            activeSummary?.accountEmail,
            activeSummary?.subscriptionLabel,
            usage.accountSnapshots ?? [],
            nowMs,
          )
        : [],
    [snapshotProvider, activeSummary, usage.accountSnapshots, nowMs],
  );

  const hasSnapshots = relevantSnapshots.length > 0;
  const snapshotsPanelOpen = snapshotsOpen && hasSnapshots;

  // Keep reset countdowns / future-window filtering fresh only while visible.
  useEffect(() => {
    if (!snapshotProvider || !snapshotsPanelOpen) {
      return;
    }
    const id = setInterval(() => setNowMs(Date.now()), NOW_TICK_MS);
    return (): void => clearInterval(id);
  }, [snapshotProvider, snapshotsPanelOpen]);

  useCurrentUiStateReporter('auth.loginModal', {
    open: true,
    provider,
    snapshotsAvailable: hasSnapshots,
    snapshotsPanelOpen,
  });

  const refreshStatus =
    useCallback(async (): Promise<AgentProviderAuthStatus | null> => {
      invalidateProviderCache(provider);
      try {
        const result = await fetchProviderStatus(provider);
        setStatus(result);
        return result;
      } catch {
        return null;
      }
    }, [provider]);

  const copyTerminalSelection = useCallback(async (): Promise<boolean> => {
    const text = terminalRef.current?.getSelection() ?? '';
    if (!text) {
      return false;
    }
    return copyTextToClipboard(text);
  }, []);

  // Initial fetch + polling. Continues across all views; cleared on unmount.
  // Only this effect's own mount-time fetch may seed `baselineStatusRef`.
  useEffect(() => {
    let cancelled = false;
    baselineStatusRef.current = null;
    setPreLoginStatusSettled(false);
    void refreshStatus()
      .then((result) => {
        if (cancelled) {
          return;
        }
        baselineStatusRef.current = result;
      })
      .finally(() => {
        if (!cancelled) {
          setPreLoginStatusSettled(true);
        }
      });
    const id = setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);
    return (): void => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshStatus]);

  // PTY + xterm lifecycle. Re-runs each time `attempt` changes (e.g. user
  // clicks Sign in after a failed attempt) so a fresh terminal and session
  // are created. The cleanup tears down the prior xterm + session.
  useEffect(() => {
    if (view.kind !== 'running') {
      return;
    }
    if (!preLoginStatusSettled) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }
    authorizationOutputRef.current = '';
    openedAuthorizationUrlsRef.current.clear();

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: TERMINAL_BG,
        foreground: '#e6e6e6',
        cursor: '#e6e6e6',
        selectionBackground: 'rgba(120, 168, 120, 0.22)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const disposeLinks = installTerminalLinks(term, (url) => {
      void window.api.browser.openExternal({ url });
    });
    terminalRef.current = term;
    // Drop focus into the terminal as soon as it mounts — some login flows
    // (notably `gh auth login`) prompt for input immediately, and the
    // DialogModal's close button would otherwise hold focus.
    term.focus();

    let cols = 80;
    let rows = 24;
    try {
      fit.fit();
      if (term.cols > 0 && term.rows > 0) {
        cols = term.cols;
        rows = term.rows;
      }
    } catch {
      // FitAddon throws when the host has no layout yet; fall back above.
    }

    const offOutput = window.api.authTerminal.onOutput((event) => {
      if (event.sessionId !== sessionIdRef.current) {
        return;
      }
      term.write(event.data);
      authorizationOutputRef.current =
        `${authorizationOutputRef.current}${event.data}`.slice(-32_768);
      const authorizationUrl = findProviderAuthorizationUrl(
        provider,
        authorizationOutputRef.current,
      );
      if (
        authorizationUrl &&
        !openedAuthorizationUrlsRef.current.has(authorizationUrl)
      ) {
        openedAuthorizationUrlsRef.current.add(authorizationUrl);
        void Promise.resolve()
          .then(() => onAuthorizationUrlRef.current?.(authorizationUrl))
          .catch(() => false)
          .then(async (handled) => {
            if (!handled) {
              await window.api.browser.openExternal({ url: authorizationUrl });
            }
          })
          .catch(() => {
            // The terminal link remains available for a manual retry.
          });
      }
    });

    const offExit = window.api.authTerminal.onExit((event) => {
      if (event.sessionId !== sessionIdRef.current) {
        return;
      }
      const exitCode = event.exitCode ?? null;
      term.write(
        `\r\n\x1b[2m[process exited with code ${exitCode ?? '?'}]\x1b[0m\r\n`,
      );
      // Forget the dead session immediately so cleanup writes don't try to
      // stop a PTY that already exited on its own.
      sessionIdRef.current = null;
      setView({ kind: 'exit-checking', exitCode });
      void refreshStatus().then((result) => {
        if (
          result?.authenticated ||
          (provider === 'opencode' && exitCode === 0)
        ) {
          if (
            result !== null &&
            (provider === 'claude' || provider === 'codex') &&
            isDifferentProviderAccount(
              provider,
              baselineStatusRef.current,
              result,
            )
          ) {
            openResumePrompt(provider);
          }
          onCloseRef.current();
        } else {
          setView({ kind: 'login-failed', exitCode });
        }
      });
    });

    const inputDisposable = term.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }
      void window.api.authTerminal.write({ sessionId, data }).catch(() => {
        // Best-effort: a stale session id just no-ops on main.
      });
    });

    const updateSelectionMenu = (): void => {
      if (term.cols <= 0 || term.rows <= 0 || !term.getSelection()) {
        setSelectionMenu(null);
        return;
      }
      const range = term.getSelectionPosition();
      if (!range) {
        setSelectionMenu(null);
        return;
      }
      const frame = terminalFrameRef.current;
      if (!frame) {
        setSelectionMenu(null);
        return;
      }
      const hostRect = host.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      if (hostRect.width <= 0 || hostRect.height <= 0) {
        setSelectionMenu(null);
        return;
      }

      const cellWidth = hostRect.width / term.cols;
      const cellHeight = hostRect.height / term.rows;
      const viewportY = term.buffer.active.viewportY;
      const startTopY = (range.start.y - viewportY) * cellHeight;
      const endBottomY = (range.end.y - viewportY + 1) * cellHeight;
      const endX = (range.end.x + 1) * cellWidth;
      const menuHeight = 28;
      const menuEstimatedWidth = 76;
      const margin = 6;
      const hostOffsetTop = hostRect.top - frameRect.top;
      const hostOffsetLeft = hostRect.left - frameRect.left;

      const aboveTop = startTopY - menuHeight - margin;
      const belowTop = endBottomY + margin;
      let top: number;
      if (aboveTop >= margin) {
        top = aboveTop;
      } else if (belowTop + menuHeight <= hostRect.height - margin) {
        top = belowTop;
      } else {
        top = margin;
      }
      top = Math.max(
        margin,
        Math.min(top, hostRect.height - menuHeight - margin),
      );

      let left = endX - menuEstimatedWidth;
      if (left < margin) {
        left = Math.min(
          endX + margin,
          hostRect.width - menuEstimatedWidth - margin,
        );
      }
      left = Math.max(
        margin,
        Math.min(left, hostRect.width - menuEstimatedWidth - margin),
      );

      setSelectionMenu({
        top: hostOffsetTop + top,
        left: hostOffsetLeft + left,
      });
    };

    const selectionDisposable = term.onSelectionChange(updateSelectionMenu);
    const scrollDisposable = term.onScroll(updateSelectionMenu);

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    void window.api.authTerminal
      .start({ provider, cols, rows })
      .then((response) => {
        if (disposed) {
          void window.api.authTerminal
            .stop({ sessionId: response.sessionId })
            .catch(() => undefined);
          return;
        }
        sessionIdRef.current = response.sessionId;

        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            try {
              fit.fit();
            } catch {
              return;
            }
            const sessionId = sessionIdRef.current;
            if (!sessionId) {
              return;
            }
            if (term.cols <= 0 || term.rows <= 0) {
              return;
            }
            void window.api.authTerminal
              .resize({
                sessionId,
                cols: term.cols,
                rows: term.rows,
              })
              .catch(() => undefined);
            updateSelectionMenu();
          });
          resizeObserver.observe(host);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        term.write(
          `\r\n\x1b[31mFailed to start ${providerLabel(provider)} sign-in: ${message}\x1b[0m\r\n`,
        );
      });

    return (): void => {
      disposed = true;
      offOutput();
      offExit();
      try {
        inputDisposable.dispose();
      } catch {
        // ignore
      }
      try {
        selectionDisposable.dispose();
        scrollDisposable.dispose();
      } catch {
        // ignore
      }
      setSelectionMenu(null);
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void window.api.authTerminal.stop({ sessionId }).catch(() => undefined);
        sessionIdRef.current = null;
      }
      invalidateProviderCache(provider);
      disposeLinks();
      try {
        term.dispose();
      } catch {
        // ignore
      }
      if (terminalRef.current === term) {
        terminalRef.current = null;
      }
    };
  }, [
    attempt,
    openResumePrompt,
    preLoginStatusSettled,
    provider,
    refreshStatus,
    view.kind,
  ]);

  const handleLogin = useCallback((): void => {
    setView({ kind: 'running' });
    setAttempt((a) => a + 1);
  }, []);

  const showTerminal = view.kind === 'running' || view.kind === 'exit-checking';

  const snapshotsToggle = hasSnapshots ? (
    <button
      type="button"
      onClick={(): void => setSnapshotsOpen((value) => !value)}
      aria-expanded={snapshotsPanelOpen}
      data-testid="auth-login-snapshots-toggle"
      className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium fg-secondary transition-colors hover:bg-secondary hover:fg-primary"
    >
      <span>Other account snapshots</span>
      <ChevronRightIcon
        size={12}
        aria-hidden
        className={`transition-transform ${
          snapshotsPanelOpen ? 'rotate-90' : ''
        }`}
      />
    </button>
  ) : null;

  return (
    <DialogModal
      onClose={onClose}
      title={`Sign in to ${providerLabel(provider)}`}
      subtitle="Complete the sign-in flow in the terminal below."
      maxWidth={snapshotsPanelOpen ? '4xl' : '3xl'}
      closeOnBackdrop
      overlayClassName="z-modal"
      ownerDocument={ownerDocument}
    >
      <div className="flex" data-testid="auth-login-modal">
        <div className="flex min-w-0 flex-1 flex-col">
          {intro ? (
            <p
              className="px-5 pt-2 text-s fg-primary"
              data-testid={introTestId}
            >
              {intro}
            </p>
          ) : null}
          {onCancel ? (
            <div className="px-5 pt-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="github-connect-cancel"
                onClick={onCancel}
              >
                Cancel
              </Button>
            </div>
          ) : null}
          {showTerminal ? (
            <div className="px-5 pt-2 pb-4">
              <div
                ref={terminalFrameRef}
                className="relative overflow-hidden rounded-lg border"
                style={{
                  height: TERMINAL_AREA_HEIGHT,
                  backgroundColor: TERMINAL_BG,
                }}
              >
                <div
                  ref={hostRef}
                  data-testid="auth-login-terminal"
                  className={`${POSTHOG_REPLAY_BLOCK_CLASS} absolute inset-0 p-2`}
                />
                {selectionMenu !== null ? (
                  <TerminalSelectionMenu
                    top={selectionMenu.top}
                    left={selectionMenu.left}
                    onCopy={copyTerminalSelection}
                  />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="px-5 pt-2 pb-4">
              <LoginFailedView
                provider={provider}
                exitCode={view.exitCode}
                onLogin={handleLogin}
                onCancel={onCancel ?? onClose}
              />
            </div>
          )}
          <StatusFooter
            provider={provider}
            status={status}
            trailing={snapshotsToggle}
          />
        </div>
        {snapshotsPanelOpen && snapshotProvider ? (
          // `relative` host + `absolute inset-0` scroller keeps the panel's
          // height pinned to the terminal column so tall snapshot content
          // scrolls internally instead of growing the modal.
          <div
            data-testid="auth-login-snapshots-panel"
            className="relative w-80 shrink-0 border-l bg-base/20"
          >
            <div className="absolute inset-0 overflow-y-auto overscroll-contain p-4">
              <OtherAccountSnapshotsPanel
                provider={snapshotProvider}
                snapshots={relevantSnapshots}
                nowMs={nowMs}
              />
            </div>
          </div>
        ) : null}
      </div>
    </DialogModal>
  );
}
