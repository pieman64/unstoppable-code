import type { CopilotAccountUsage } from '@canopy/desktop-shared/types/copilot-connection';
import { getFeatureFlagService } from '../feature-flags';
import { notifyCopilotUsageChanged } from './usage-events';
import { buildDelegationCursorEnvironment } from '@canopy/desktop-shared/node/delegation/environment';
import type {
  CopilotAccount,
  CopilotConnectionStatus,
  CopilotModelEntry,
} from '@canopy/desktop-shared/types';
import { initCopilotModels } from '@canopy/desktop-shared/types';
import {
  isCopilotModel,
  copilotModelsFromSdk,
} from '@canopy/desktop-shared/lib/copilot-models';
import {
  getCopilotRuntimeRootDir,
  getCopilotRuntimeStateDir,
} from '@canopy/desktop-shared/pipelines/config-paths';
import {
  copilotExecutableName,
  getCopilotRuntimeArtifact,
  COPILOT_RUNTIME_VERSION,
} from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import {
  startCopilotRuntime,
  type OwnedCopilotRuntime,
} from '@canopy/desktop-shared/node/copilot/runtime';
import type { CopilotRuntimeAuth } from '@canopy/desktop-shared/node/copilot/runtime-auth';
import {
  pollDeviceFlow,
  refreshDeviceGrant,
  startDeviceFlow,
  type DeviceFlowOptions,
} from '@canopy/desktop-shared/node/copilot/device-flow';
import { sameCopilotAccount } from '@canopy/desktop-shared/node/copilot/auth';
import { BRAND } from '@canopy/brand/current';
import { getEnhancedEnv } from '../pipelines/config-paths';
import { isE2eBuild } from '../lib/e2e-gate';
import { loadOctokitConstructor } from '../lib/github-octokit-loader';
import { resolveOctokitClientOptions } from '../lib/github-octokit-options';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import {
  assertCopilotHarnessEnabled,
  isCopilotHarnessEnabled,
} from './feature-flag';
import { CopilotRuntimeInstaller } from './runtime-installer';
import {
  beginCopilotAvailabilityProbe,
  invalidateCopilotRuntimeAvailability,
} from './runtime-availability';
import {
  clearCopilotCredential,
  isCopilotCredentialStorageAvailable,
  readCopilotCredential,
  saveCopilotCredential,
  type CopilotCredential,
} from './credential-store';
import {
  CopilotSignInExpiredError,
  createCopilotCredentialBroker,
} from './credential-broker';
import { describeCopilotServiceRefusal } from './service-errors';

const GITHUB_HOST = 'https://github.com';
/**
 * Setup covers the runtime download plus GitHub's device code, which lives
 * for 15 minutes; the cap must outlast the code so an expiry is reported as
 * such rather than as a cut-off.
 */
export const COPILOT_SETUP_TIMEOUT_MS = 30 * 60_000;
/** The runtime download has its own cap so it cannot eat into the code's lifetime. */
export const COPILOT_INSTALL_TIMEOUT_MS = 10 * 60_000;

let generation = 0;
let activeSetup:
  | { token: symbol; abort: AbortController; done: Promise<void> }
  | undefined;
let observingRollout = false;
function observeRollout(): void {
  if (observingRollout) return;
  observingRollout = true;
  getFeatureFlagService().onSnapshotChanged(() => {
    if (!isCopilotHarnessEnabled())
      void revokeCopilotRuntimes().catch(() => undefined);
  });
}
const live = new Set<{ abort: AbortController; done: Promise<void> }>();
let cachedModels:
  | { generation: number; expires: number; models: CopilotModelEntry[] }
  | undefined;
let discovery: Promise<CopilotModelEntry[]> | undefined;
// Every consumer in this process shares one broker per pinned account, so a
// refresh is single-flight across concurrent chats, discovery and usage reads.
let sharedBroker:
  | { pin: CopilotAccount | undefined; auth: CopilotRuntimeAuth }
  | undefined;

function runtimeArtifact(): ReturnType<typeof getCopilotRuntimeArtifact> {
  const artifact = getCopilotRuntimeArtifact();
  if (
    !artifact ||
    typeof __CANOPY_E2E__ === 'undefined' ||
    !__CANOPY_E2E__ ||
    !process.env.CANOPY_E2E_COPILOT_RUNTIME
  )
    return artifact;
  const value: unknown = JSON.parse(process.env.CANOPY_E2E_COPILOT_RUNTIME);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('url' in value) ||
    !('integrity' in value) ||
    !('executableSha256' in value) ||
    !('archiveBytes' in value) ||
    typeof value.url !== 'string' ||
    typeof value.integrity !== 'string' ||
    typeof value.executableSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.executableSha256) ||
    typeof value.archiveBytes !== 'number' ||
    !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes <= 0 ||
    value.archiveBytes > 1024 * 1024
  )
    throw new Error('Invalid Copilot runtime test fixture.');
  return {
    version: artifact.version,
    url: value.url,
    integrity: value.integrity,
    executableSha256: value.executableSha256,
    archiveBytes: value.archiveBytes,
  };
}

function installer(): CopilotRuntimeInstaller {
  const artifact = runtimeArtifact();
  if (!artifact)
    throw new Error('GitHub Copilot is not available on this device.');
  return new CopilotRuntimeInstaller({
    root: getCopilotRuntimeRootDir(),
    artifact,
    executableName: copilotExecutableName(),
    allowLoopback: typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__,
  });
}

/** The brand's GitHub App; its client id is public and never a secret. */
function deviceFlowOptions(): DeviceFlowOptions {
  const clientId = BRAND.copilot?.gitHubAppClientId;
  if (!clientId)
    throw new Error("GitHub Copilot sign-in isn't set up for this build.");
  const override = isE2eBuild()
    ? process.env.CANOPY_GITHUB_OAUTH_BASE_URL?.trim()
    : undefined;
  return { clientId, baseUrl: override || undefined };
}

function samePin(
  left: CopilotAccount | undefined,
  right: CopilotAccount | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return sameCopilotAccount(left, right);
}

function credentialBroker(pin: CopilotAccount | undefined): CopilotRuntimeAuth {
  if (sharedBroker && samePin(sharedBroker.pin, pin)) return sharedBroker.auth;
  const options = deviceFlowOptions();
  const auth = createCopilotCredentialBroker({
    pin,
    read: readCopilotCredential,
    save: saveCopilotCredential,
    clear: async (): Promise<void> => {
      // A rejected refresh signs the user out mid-session; the UI must learn
      // it now rather than at the next status probe.
      await clearCopilotCredential();
      invalidateCopilotRuntimeAvailability();
      cachedModels = undefined;
    },
    refresh: (refreshToken, signal) =>
      refreshDeviceGrant(options, refreshToken, signal),
  });
  sharedBroker = { pin, auth };
  return auth;
}

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket|network|timed? ?out|closed|exited/i.test(
    message,
  );
}

async function resolveGitHubIdentity(
  token: string,
  signal: AbortSignal,
): Promise<{ login: string; id: string }> {
  const Octokit = loadOctokitConstructor();
  const octokit = new Octokit(resolveOctokitClientOptions(token));
  const { data } = await octokit.rest.users.getAuthenticated({
    request: { signal },
  });
  if (
    typeof data.login !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(data.login)
  )
    throw new Error('GitHub did not return a usable account.');
  return { login: data.login, id: String(data.id) };
}

/** The credential and the pin are both app-owned; only a matching pair counts. */
async function signedInAccount(preferences: {
  copilotAccount?: CopilotAccount;
}): Promise<CopilotAccount | null> {
  const pin = preferences.copilotAccount;
  if (!pin) return null;
  const read = await readCopilotCredential();
  if (read.status !== 'present') return null;
  // A refresh token that has lapsed cannot be renewed; the sign-in is over.
  if (Date.parse(read.credential.refreshTokenExpiresAt) <= Date.now())
    return null;
  return sameCopilotAccount(
    { host: read.credential.host, login: read.credential.login },
    pin,
  )
    ? pin
    : null;
}

/**
 * Copilot is still chosen in Settings but its sign-in is gone: a rejected
 * refresh cleared the credential (often during the startup quota probe), or
 * the refresh token lapsed. Status reads that as not connected; model
 * requests report the expiry, as the broker does whenever it finds no
 * credential, until the user reconnects or disconnects.
 */
async function signInExpired(): Promise<boolean> {
  if (activeSetup) return false;
  const preferences = await readPreferencesFile();
  if (preferences.copilotEnabled !== true || !preferences.copilotAccount)
    return false;
  const read = await readCopilotCredential();
  return (
    read.status === 'absent' ||
    (read.status === 'present' &&
      Date.parse(read.credential.refreshTokenExpiresAt) <= Date.now())
  );
}

export async function copilotConnectionStatus(): Promise<CopilotConnectionStatus> {
  const cache = beginCopilotAvailabilityProbe();
  try {
    const artifact = runtimeArtifact();
    const preferences = await readPreferencesFile();
    const installed = !!artifact && (await installer().isInstalled());
    const account = await signedInAccount(preferences);
    const enabled =
      !activeSetup &&
      isCopilotHarnessEnabled() &&
      preferences.copilotEnabled === true &&
      account !== null;
    cache(!!artifact && installed && enabled);
    return {
      supported: !!artifact,
      installed,
      enabled,
      version: COPILOT_RUNTIME_VERSION,
      phase: enabled && installed ? 'connected' : 'idle',
      archiveBytes: artifact?.archiveBytes,
      account: enabled ? account : null,
    };
  } catch (error) {
    cache(false);
    throw error;
  }
}

interface ManagedCopilotRuntimeOptions {
  signal: AbortSignal;
  cwd?: string;
  workspaceId?: string;
  requireAccount?: boolean;
  executionKind?: 'agent' | 'pipeline';
  restrictedEnvironment?: boolean;
  environment?: Record<string, string>;
}
export type ManagedCopilotRuntime = OwnedCopilotRuntime & {
  account: CopilotAccount | null;
  generation: number;
  auth: CopilotRuntimeAuth;
};

/** All managed consumers share revocation and carry the app-held identity. */
export async function openManagedCopilotRuntime(
  options: ManagedCopilotRuntimeOptions,
): Promise<ManagedCopilotRuntime> {
  return openCopilotRuntime(options);
}

async function openCopilotRuntime(
  options: ManagedCopilotRuntimeOptions,
  setupToken?: symbol,
): Promise<ManagedCopilotRuntime> {
  assertCopilotHarnessEnabled();
  if (activeSetup && activeSetup.token !== setupToken)
    throw new Error(
      'Copilot account setup is in progress. Try again when it finishes.',
    );
  observeRollout();
  const epoch = generation;
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  let finish!: () => void;
  const record = {
    abort,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  live.add(record);
  let runtime: OwnedCopilotRuntime | undefined;
  let closing: Promise<void> | undefined;
  const onAbort = (): void => {
    void close().catch(() => undefined);
  };
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      try {
        await runtime?.close();
      } finally {
        signal.removeEventListener('abort', onAbort);
        live.delete(record);
        finish();
      }
    })();
    return closing;
  };
  try {
    const preferences = await readPreferencesFile();
    const requireAccount = options.requireAccount !== false;
    if (requireAccount && !preferences.copilotEnabled)
      throw new Error('Connect GitHub Copilot in Settings > Labs.');
    const auth = credentialBroker(preferences.copilotAccount);
    // Prove the credential before paying for a process; this also refreshes.
    if (requireAccount) await auth.token(signal);
    const executable = await installer().verify(signal);
    assertCopilotHarnessEnabled();
    if (epoch !== generation)
      throw new Error('Copilot connection changed. Try again.');
    const baseEnvironment = getEnhancedEnv({
      includeCanopySecrets: false,
      environment: options.workspaceId
        ? {
            runtime: options.executionKind ?? 'agent',
            workspaceId: options.workspaceId,
          }
        : false,
    });
    runtime = await startCopilotRuntime({
      executable,
      expectedVersion: COPILOT_RUNTIME_VERSION,
      workingDirectory: options.cwd ?? getCopilotRuntimeStateDir(),
      stateDirectory: getCopilotRuntimeStateDir(),
      env: {
        ...(options.restrictedEnvironment
          ? buildDelegationCursorEnvironment(baseEnvironment)
          : baseEnvironment),
        ...Object.fromEntries(
          Object.entries(options.environment ?? {}).filter(
            ([key]) =>
              ![
                'HOME',
                'USERPROFILE',
                'HOMEDRIVE',
                'HOMEPATH',
                'HOMESHARE',
              ].includes(key.toUpperCase()),
          ),
        ),
      },
      signal,
    });
    // Parent exit is only the beginning of cleanup: tools can outlive it.
    // Keep the ownership record until the runtime reaps those descendants.
    signal.addEventListener('abort', onAbort, { once: true });
    void runtime.exited.then(close, close).catch(() => undefined);
    signal.throwIfAborted();
    if (epoch !== generation)
      throw new Error('Copilot connection changed. Try again.');
    return {
      ...runtime,
      account: requireAccount ? (preferences.copilotAccount ?? null) : null,
      generation: epoch,
      close,
      auth,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function assertCopilotConnectionGeneration(expected: number): void {
  assertCopilotHarnessEnabled();
  if (expected !== generation)
    throw new Error('Copilot connection was revoked.');
}

export async function revokeCopilotRuntimes(): Promise<void> {
  await revokeRuntimes();
}

async function revokeRuntimes(preserveSetup?: symbol): Promise<void> {
  const setup = activeSetup?.token === preserveSetup ? undefined : activeSetup;
  setup?.abort.abort();
  generation++;
  notifyCopilotUsageChanged(false);
  invalidateCopilotRuntimeAvailability();
  cachedModels = undefined;
  discovery = undefined;
  sharedBroker = undefined;
  initCopilotModels([]);
  const pending = Array.from(live);
  for (const record of pending) record.abort.abort();
  await Promise.allSettled([
    ...pending.map((record) => record.done),
    ...(setup ? [setup.done] : []),
  ]);
}

export async function readCopilotAccount(): Promise<CopilotAccount | null> {
  return (await copilotConnectionStatus()).account ?? null;
}

async function signOut(): Promise<void> {
  await updatePreferencesFile(() => ({
    copilotEnabled: false,
    copilotAccount: undefined,
  }));
  await clearCopilotCredential();
  invalidateCopilotRuntimeAvailability();
}

export async function connectCopilot(
  signal: AbortSignal,
  progress: (status: CopilotConnectionStatus) => void,
  changeAccount = false,
): Promise<CopilotConnectionStatus> {
  assertCopilotHarnessEnabled();
  if (activeSetup)
    throw new Error('Copilot account setup is already in progress.');
  let finishSetup: () => void = () => undefined;
  const setup = {
    token: Symbol('copilot-setup'),
    abort: new AbortController(),
    done: new Promise<void>((resolve) => {
      finishSetup = resolve;
    }),
  };
  activeSetup = setup;
  signal = AbortSignal.any([signal, setup.abort.signal]);
  try {
    const flow = deviceFlowOptions();
    if (!isCopilotCredentialStorageAvailable())
      throw new Error("Couldn't store the Copilot sign-in on this device.");
    await revokeRuntimes(setup.token);
    const epoch = generation;
    const base = await copilotConnectionStatus();
    await installer().install(
      AbortSignal.any([
        signal,
        AbortSignal.timeout(COPILOT_INSTALL_TIMEOUT_MS),
      ]),
      (phase, percent) => progress({ ...base, phase, percent }),
    );
    assertCopilotConnectionGeneration(epoch);
    if (changeAccount) await signOut();
    const preferences = await readPreferencesFile();
    let account = changeAccount ? null : await signedInAccount(preferences);
    let savedNew = false;
    if (!account) {
      const start = await startDeviceFlow(flow, signal);
      progress({
        ...base,
        installed: true,
        phase: 'authorizing',
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        expiresAt: start.expiresAt,
      });
      let outcome;
      try {
        outcome = await pollDeviceFlow(flow, start, signal);
      } catch (error) {
        // A cut-off after the code's lifetime is an expiry, not a cancellation.
        if (Date.now() >= Date.parse(start.expiresAt))
          throw new Error('The GitHub code expired. Connect again.');
        throw error;
      }
      if (outcome.status === 'declined')
        throw new Error('GitHub sign-in was declined.');
      if (outcome.status === 'expired')
        throw new Error('The GitHub code expired. Connect again.');
      progress({ ...base, installed: true, phase: 'checking' });
      const identity = await resolveGitHubIdentity(
        outcome.grant.accessToken,
        signal,
      );
      signal.throwIfAborted();
      // Prove Copilot access before anything is saved; the user may have a
      // GitHub account without a Copilot plan.
      const probe = await openCopilotRuntime(
        { signal, requireAccount: false },
        setup.token,
      );
      try {
        await probe.client.rpc.models.list({
          gitHubToken: outcome.grant.accessToken,
        });
      } catch (error) {
        signal.throwIfAborted();
        if (isTransportFailure(error))
          throw new Error(
            "Couldn't check Copilot access. Check your connection and try again.",
          );
        // A seat that exists but is policy-blocked must not read as no seat.
        throw (
          describeCopilotServiceRefusal(error) ??
          new Error("This GitHub account doesn't have Copilot access.")
        );
      } finally {
        await probe.close();
      }
      signal.throwIfAborted();
      assertCopilotConnectionGeneration(epoch);
      const credential: CopilotCredential = {
        version: 1,
        clientId: flow.clientId,
        host: GITHUB_HOST,
        login: identity.login,
        id: identity.id,
        ...outcome.grant,
      };
      await saveCopilotCredential(credential);
      savedNew = true;
      account = { host: GITHUB_HOST, login: identity.login };
    }
    try {
      signal.throwIfAborted();
      assertCopilotConnectionGeneration(epoch);
      await updatePreferencesFile(() => ({
        copilotEnabled: true,
        copilotAccount: account ?? undefined,
      }));
      if (signal.aborted || generation !== epoch)
        throw new Error('Copilot setup was cancelled.');
    } catch (error) {
      // The grant and the pin are one setup. A grant this setup created must
      // not outlive a pin that never landed; a reused grant is left alone.
      if (savedNew) await clearCopilotCredential();
      await updatePreferencesFile(() => ({
        copilotEnabled: false,
        ...(savedNew ? { copilotAccount: undefined } : {}),
      }));
      throw error;
    }
    // Publish a fresh account generation before admitting any managed consumer.
    await revokeRuntimes(setup.token);
    signal.throwIfAborted();
    const connected: CopilotConnectionStatus = {
      ...base,
      installed: true,
      enabled: true,
      phase: 'connected',
      account,
    };
    progress(connected);
    return connected;
  } finally {
    if (activeSetup === setup) activeSetup = undefined;
    finishSetup();
    invalidateCopilotRuntimeAvailability();
    notifyCopilotUsageChanged(true);
  }
}

export async function disconnectCopilot(): Promise<void> {
  await updatePreferencesFile(() => ({
    copilotEnabled: false,
    copilotAccount: undefined,
  }));
  await revokeCopilotRuntimes();
  await clearCopilotCredential();
}

export async function listCopilotModels(
  signal: AbortSignal,
): Promise<CopilotModelEntry[]> {
  signal.throwIfAborted();
  assertCopilotHarnessEnabled();
  const status = await copilotConnectionStatus();
  signal.throwIfAborted();
  if (!status.enabled || !status.installed) {
    if (await signInExpired()) throw new CopilotSignInExpiredError();
    return [];
  }
  if (
    cachedModels?.generation === generation &&
    cachedModels.expires > Date.now()
  )
    return structuredClone(cachedModels.models);
  if (!discovery) {
    const epoch = generation;
    const operation = (async (): Promise<CopilotModelEntry[]> => {
      // Discovery is shared across callers. Its runtime is owned by the
      // account generation and timeout, never by one caller's cancellation.
      const timeout = AbortSignal.timeout(45_000);
      const runtime = await openManagedCopilotRuntime({ signal: timeout });
      try {
        let listed;
        try {
          listed = await runtime.client.rpc.models.list({
            gitHubToken: await runtime.auth.token(timeout),
          });
        } catch (error) {
          throw describeCopilotServiceRefusal(error) ?? error;
        }
        const models = copilotModelsFromSdk(listed.models);
        assertCopilotConnectionGeneration(epoch);
        cachedModels = {
          generation: epoch,
          expires: Date.now() + 60_000,
          models,
        };
        initCopilotModels(models);
        return models;
      } finally {
        await runtime.close();
      }
    })();
    discovery = operation;
    void operation
      .finally(() => {
        if (discovery === operation) discovery = undefined;
      })
      .catch(() => undefined);
  }
  return structuredClone(await waitForModelDiscovery(discovery, signal));
}

function waitForModelDiscovery(
  operation: Promise<CopilotModelEntry[]>,
  signal: AbortSignal,
): Promise<CopilotModelEntry[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error('Copilot model discovery cancelled.'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (models) => {
        cleanup();
        resolve(models);
      },
      (error: unknown) => {
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error(
                typeof error === 'string'
                  ? error
                  : 'Copilot model discovery failed.',
              ),
        );
      },
    );
  });
}

/** Validate against this account's policy-filtered catalog before a durable send. */
export async function assertCopilotModelAvailable(
  model: string | undefined,
  signal: AbortSignal = AbortSignal.timeout(45_000),
): Promise<CopilotModelEntry> {
  const epoch = generation;
  const unavailable = (): Error =>
    new Error(
      'This Copilot model is unavailable. Choose another Copilot model and try again.',
    );
  if (!isCopilotModel(model)) throw unavailable();
  const models = await listCopilotModels(signal);
  assertCopilotConnectionGeneration(epoch);
  const selected = models.find((entry) => entry.id === model);
  if (!selected) throw unavailable();
  return selected;
}

export function getCopilotAccountGeneration(): number {
  return generation;
}

export async function readCopilotAccountUsage(
  signal: AbortSignal,
): Promise<CopilotAccountUsage> {
  const runtime = await openManagedCopilotRuntime({ signal });
  try {
    if (!runtime.account)
      throw new Error('Connect Copilot to see account usage.');
    const response = await runtime.client.rpc.account.getQuota({
      gitHubToken: await runtime.auth.token(signal),
    });
    assertCopilotConnectionGeneration(runtime.generation);
    const limits = Object.entries(response.quotaSnapshots)
      .slice(0, 16)
      .flatMap(([id, quota]) => {
        if (!quota || !/^[a-z_]{1,64}$/.test(id)) return [];
        const remaining = quota.remainingPercentage;
        return [
          {
            id,
            label:
              id === 'premium_interactions'
                ? 'Premium requests'
                : id === 'chat'
                  ? 'Chat'
                  : id === 'completions'
                    ? 'Completions'
                    : id.replace(/_/g, ' '),
            unlimited: quota.isUnlimitedEntitlement === true,
            ...(Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
              ? { usedPercent: 100 - remaining }
              : {}),
            ...(quota.resetDate && Number.isFinite(Date.parse(quota.resetDate))
              ? { resetsAt: new Date(quota.resetDate).toISOString() }
              : {}),
          },
        ];
      });
    return { account: runtime.account, limits };
  } finally {
    await runtime.close();
  }
}
