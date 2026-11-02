import { recordProviderConnectionFailure } from '../lib/provider-connection-events';
import { randomUUID } from 'node:crypto';
import type {
  CodexLoginState,
  CodexLoginStartRequest,
} from '@canopy/desktop-shared/types';
import type { CodexAuthenticationSession } from '@canopy/desktop-shared/node/codex-runtime';
import { getCodexRuntimeService } from '../codex/runtime-service';
import {
  getCodexAuthenticationActiveWorkCount,
  pauseCodexSessionsForAuthentication,
} from '../agents/session-manager';
import { getActivePipelineExecutionHandles } from '../pipelines/pipeline-execution-registry';
import {
  commitVerifiedCodexAccount,
  checkCodexAuthStatus,
  fingerprintCodexRecoveryIdentity,
  verifiedCodexAccountStatus,
} from './provider-auth-state';
import {
  hasCodexAuthenticationGrant,
  recordCodexAuthenticationGrant,
  revokeCodexAuthenticationGrant,
} from '../lib/usage-limited-chats-registry';

function affectedPipelines(): ReturnType<
  typeof getActivePipelineExecutionHandles
> {
  return getActivePipelineExecutionHandles().filter((handle) =>
    Object.values(handle.getState().jobs).some((job) =>
      Object.values(job.steps).some(
        (step) =>
          step.status === 'running' &&
          (step.agent_harness === 'codex' || step.agent_provider === 'codex'),
      ),
    ),
  );
}

function normalizeError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** One desktop-owned attempt. Credential material never crosses IPC. */
export class CodexLoginManager {
  private state: CodexLoginState = {
    attemptId: null,
    phase: 'ready',
    activeWorkCount: 0,
  };
  private session: CodexAuthenticationSession | null = null;
  private launch: Promise<void> | null = null;
  private settling: Promise<void> | null = null;
  private releaseSessions: (() => void) | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private browserLoginUrl: string | null = null;
  private cancelled = false;
  private verificationEpoch = 0;
  private abandoning: Promise<void> | null = null;
  private lastFailedAttemptId: string | null = null;
  private attemptTimedOut = false;
  private readonly listeners = new Set<(state: CodexLoginState) => void>();

  onState(listener: (state: CodexLoginState) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  private publish(update: Partial<CodexLoginState>): void {
    this.state = { ...this.state, ...update };
    if (
      this.state.attemptId &&
      this.lastFailedAttemptId !== this.state.attemptId &&
      (this.state.phase === 'verification-failed' ||
        (this.state.phase === 'complete' &&
          (this.state.outcome === 'cancelled' ||
            this.state.outcome === 'failed')))
    ) {
      // Verification and abandonment can publish several terminal states for
      // one attempt. Classify its merged outcome and report only the first.
      this.lastFailedAttemptId = this.state.attemptId;
      recordProviderConnectionFailure(
        'codex',
        'native_login',
        this.state.outcome === 'cancelled'
          ? 'cancelled'
          : this.attemptTimedOut
            ? 'timeout'
            : 'authentication',
      );
    }
    for (const listener of Array.from(this.listeners)) listener(this.state);
  }

  start(request: CodexLoginStartRequest): CodexLoginState {
    if (this.session) {
      if (this.state.phase === 'confirm' && request.confirmPause) {
        const session = this.session;
        const previousLaunch = this.launch;
        this.publish({ phase: 'pausing', method: request.method });
        this.launch = (async (): Promise<void> => {
          await previousLaunch;
          if (this.cancelled || this.settling) return;
          await this.startLogin(session, request.method);
        })();
        void this.launch.catch(() => {
          void this.finish('failed');
        });
        return this.state;
      }
      if (
        this.state.phase === 'waiting' &&
        request.method !== this.state.method
      ) {
        const session = this.session;
        this.browserLoginUrl = null;
        this.publish({
          phase: 'pausing',
          method: request.method,
          userCode: undefined,
        });
        this.launch = (async (): Promise<void> => {
          await session.resetLogin();
          if (this.cancelled) return;
          await this.startLogin(session, request.method);
        })();
        void this.launch.catch(() => {
          void this.finish('failed');
        });
      }
      return this.state;
    }
    if (
      __CANOPY_E2E__ &&
      (!process.env.CODEX_EXECUTABLE ||
        !process.env.CANOPY_E2E_CODEX_STATE_PATH)
    )
      throw new Error(
        'Codex sign-in tests require an isolated provider fixture.',
      );
    const pipelines = affectedPipelines();
    const runtime = getCodexRuntimeService();
    const activeWorkCount = Math.max(
      getCodexAuthenticationActiveWorkCount() + pipelines.length,
      runtime
        .admin()
        .getResourceSnapshots()
        .reduce((count, worker) => count + worker.activeTurnCount, 0),
    );
    if (activeWorkCount > 0 && !request.confirmPause) {
      this.state = { attemptId: null, phase: 'confirm', activeWorkCount };
      return this.state;
    }
    // No await between the final preflight and admission reservation.
    const session = runtime.beginAuthentication();
    const attemptId = randomUUID();
    let pause: ReturnType<typeof pauseCodexSessionsForAuthentication>;
    try {
      pause = pauseCodexSessionsForAuthentication(attemptId);
    } catch (error) {
      void session.close().catch(() => undefined);
      throw error;
    }
    this.session = session;
    this.releaseSessions = pause.release;
    this.cancelled = false;
    this.attemptTimedOut = false;
    this.settling = null;
    this.state = {
      attemptId,
      phase: 'pausing',
      activeWorkCount,
      method: request.method,
    };
    this.publish({});
    this.timeout = setTimeout(() => {
      this.attemptTimedOut = true;
      void this.finish('failed');
    }, 10 * 60_000);
    this.timeout.unref?.();
    this.launch = (async (): Promise<void> => {
      const pauses = await Promise.allSettled([
        pause.paused,
        ...pipelines.map(async (handle) => {
          if (!handle.pauseForAuthentication)
            throw new Error('An active pipeline cannot be paused safely.');
          await handle.pauseForAuthentication(attemptId);
        }),
        session.ready,
      ]);
      const failure = pauses.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw normalizeError(failure.reason);
      if (this.cancelled) return;
      const pausedChats = pauses[0];
      const impactedCount =
        (pausedChats?.status === 'fulfilled' ? pausedChats.value : 0) +
        pipelines.length;
      if (impactedCount !== this.state.activeWorkCount)
        this.publish({ activeWorkCount: impactedCount });
      if (impactedCount > 0 && !request.confirmPause) {
        this.publish({ phase: 'confirm' });
        return;
      }
      await this.startLogin(session, request.method);
    })();
    void this.launch.catch(() => {
      void this.finish('failed');
    });
    return this.state;
  }

  private async startLogin(
    session: CodexAuthenticationSession,
    method: CodexLoginStartRequest['method'],
  ): Promise<void> {
    const login = await session.start(method, (result) => {
      void this.finish(result.success ? 'success' : 'failed');
    });
    if (this.cancelled || this.settling) return;
    const url =
      login.type === 'chatgpt' ? login.authUrl : login.verificationUrl;
    assertCodexLoginUrl(url);
    this.browserLoginUrl = url;
    this.publish({
      phase: 'waiting',
      userCode: login.type === 'chatgptDeviceCode' ? login.userCode : undefined,
    });
  }

  async finish(
    outcome: 'success' | 'cancelled' | 'failed',
  ): Promise<CodexLoginState> {
    if (!this.session) return this.state;
    if (
      outcome === 'cancelled' &&
      (this.state.phase === 'verifying' ||
        this.state.phase === 'verification-failed')
    ) {
      // Cancel the in-flight probe, rather than joining the promise it is
      // trying to cancel. A late probe must not publish an account or grant.
      if (!this.abandoning) {
        this.verificationEpoch += 1;
        this.abandoning = this.abandonVerification().finally(() => {
          this.abandoning = null;
        });
      }
      this.settling = this.abandoning;
      await this.settling;
      return this.state;
    }
    this.cancelled = true;
    this.browserLoginUrl = null;
    if (!this.settling) {
      this.publish({
        phase: 'verifying',
        outcome,
        userCode: undefined,
      });
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = null;
      this.settling = this.verify();
    }
    await this.settling;
    return this.state;
  }

  private async abandonVerification(): Promise<void> {
    const session = this.session;
    this.cancelled = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    try {
      if (this.state.attemptId)
        await revokeCodexAuthenticationGrant(this.state.attemptId);
      if (session) await session.close();
      await this.launch?.catch(() => undefined);
    } catch {
      this.publish({
        phase: 'verification-failed',
        error: "Couldn't finish cancelling Codex sign-in. Try again.",
      });
      return;
    }
    if (this.session === session) this.session = null;
    this.releaseSessions?.();
    this.releaseSessions = null;
    this.publish({
      phase: 'complete',
      outcome: 'cancelled',
      account: undefined,
      error: undefined,
      userCode: undefined,
    });
  }

  private async verify(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const epoch = ++this.verificationEpoch;
    const isCurrent = (): boolean =>
      epoch === this.verificationEpoch && this.session === session;
    try {
      // A cancellation while start is awaiting its response retires that worker
      // first; late completion cannot overwrite the terminal attempt state.
      await session.retireLogin();
      await this.launch?.catch(() => undefined);
      if (!isCurrent()) return;
      const response = await session.verifyAccount();
      if (!isCurrent()) return;
      const account = verifiedCodexAccountStatus(response);
      const attemptId = this.state.attemptId;
      if (!attemptId)
        throw new Error("Couldn't verify Codex authentication attempt.");
      if (this.state.activeWorkCount > 0) {
        const recoveryFingerprint = fingerprintCodexRecoveryIdentity(account);
        if (!recoveryFingerprint)
          throw new Error(
            "Couldn't verify a stable Codex account identity for recovery.",
          );
        await recordCodexAuthenticationGrant(attemptId, recoveryFingerprint);
      }
      if (!isCurrent()) return;
      await session.close();
      if (!isCurrent()) return;
      const committedAccount = commitVerifiedCodexAccount(account);
      this.session = null;
      this.releaseSessions?.();
      this.releaseSessions = null;
      this.publish({
        phase: 'complete',
        account: committedAccount,
        error: undefined,
      });
    } catch {
      if (!isCurrent()) return;
      this.publish({
        phase: 'verification-failed',
        error:
          "Couldn't verify Codex authentication. Retry before resuming work.",
      });
    }
  }

  async retryVerification(): Promise<CodexLoginState> {
    if (this.state.phase !== 'verification-failed' || this.abandoning)
      return this.state;
    this.publish({ phase: 'verifying', error: undefined });
    this.settling = this.verify();
    await this.settling;
    return this.state;
  }

  browserUrl(): string {
    if (this.state.phase !== 'waiting' || !this.browserLoginUrl)
      throw new Error('No Codex sign-in is waiting.');
    assertCodexLoginUrl(this.browserLoginUrl);
    return this.browserLoginUrl;
  }

  async assertResumeAllowed(attemptId: string): Promise<void> {
    const account = await checkCodexAuthStatus();
    const fingerprint = fingerprintCodexRecoveryIdentity(account);
    if (!fingerprint)
      throw new Error('Verify Codex authentication before resuming this work.');
    if (!(await hasCodexAuthenticationGrant(attemptId, fingerprint)))
      throw new Error(
        'Verify the same Codex account before resuming this work.',
      );
  }
}

export function assertCodexLoginUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'auth.openai.com' ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Codex returned an unsupported sign-in address.');
}

export const codexLoginManager = new CodexLoginManager();
