import * as fs from 'fs';
import * as path from 'path';
import type {
  InstallBuiltInPluginRequest,
  InstallBuiltInPluginResult,
  PluginInfo,
  PluginProvider,
  PluginsCache,
} from '@canopy/desktop-shared/types/plugins';
import type { IPCResult } from '@canopy/desktop-shared/types/pipeline';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';
import { getBrandEnv } from '@canopy/desktop-shared/brand/env';
import { isE2eBuild } from '../lib/e2e-gate';
import { safeReadJson } from '../lib/fs-utils';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import { getProviderPluginBackfillStateFilePath } from '../lib/paths';

/**
 * Backfill of built-in and curated plugins into a provider the user has just
 * connected (CAN-3639).
 *
 * A plugin the user installed into Claude or Codex before connecting the other
 * provider never reached it: the Marketplace's Add installs only into the
 * providers available at the time. When a provider's authentication is
 * confirmed, the plugins the other provider already has are installed into the
 * new one, once per confirmed account, without touching anything the user
 * removed or never installed.
 */

export interface ProviderPluginBackfillCandidate {
  marketplaceId: string;
  pluginName: string;
}

function otherProvider(provider: PluginProvider): PluginProvider {
  return provider === 'claude' ? 'codex' : 'claude';
}

/** Only the marketplaces Canopy manages install into a provider app. */
function isManagedPlugin(plugin: PluginInfo): boolean {
  return plugin.builtIn === true || plugin.curated === true;
}

/**
 * The plugins `provider` should receive: ones it can host and does not have,
 * which the other provider already has and has not turned off. A plugin
 * installed nowhere was never chosen; one the user disabled stays off rather
 * than coming back enabled elsewhere; one the provider cannot host has
 * nothing to install.
 */
export function planProviderPluginBackfill(
  cache: PluginsCache,
  provider: PluginProvider,
): ProviderPluginBackfillCandidate[] {
  const other = otherProvider(provider);
  const plan: ProviderPluginBackfillCandidate[] = [];
  for (const marketplace of cache.marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (!isManagedPlugin(plugin)) continue;
      const status = plugin.globalInstallStatus;
      const mine = status?.[provider];
      const theirs = status?.[other];
      if (
        !mine?.available ||
        mine.installed ||
        theirs?.installed !== true ||
        theirs.enabled === false
      )
        continue;
      plan.push({
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.name,
      });
    }
  }
  return plan;
}

export interface ProviderPluginBackfillFailure extends ProviderPluginBackfillCandidate {
  error: string;
}

/** What a provider's backfill did for one account. */
export interface ProviderPluginBackfillRecord {
  /** The confirmed auth fingerprint the backfill ran for. */
  fingerprint: string;
  completedAt: string;
  failures: ProviderPluginBackfillFailure[];
}

export const PROVIDER_PLUGIN_BACKFILL_STATE_VERSION = 1;

/**
 * Per provider, the accounts already backfilled, oldest first and bounded to
 * the most recent few, so switching back to an earlier account does not
 * install its plugins again.
 */
export interface ProviderPluginBackfillState {
  version: typeof PROVIDER_PLUGIN_BACKFILL_STATE_VERSION;
  providers: Partial<Record<PluginProvider, ProviderPluginBackfillRecord[]>>;
}

const MAX_BACKFILL_RECORDS_PER_PROVIDER = 8;

function emptyProviderPluginBackfillState(): ProviderPluginBackfillState {
  return { version: PROVIDER_PLUGIN_BACKFILL_STATE_VERSION, providers: {} };
}

export interface ProviderPluginBackfillDependencies {
  loadCache: () => Promise<PluginsCache | null>;
  installPlugin: (
    request: InstallBuiltInPluginRequest,
  ) => Promise<IPCResult<InstallBuiltInPluginResult>>;
  readState: () => ProviderPluginBackfillState;
  writeState: (state: ProviderPluginBackfillState) => void;
  /** Keep the failure on the plugin so the detail page can show and retry it. */
  recordInstallError: (
    candidate: ProviderPluginBackfillCandidate,
    provider: PluginProvider,
    error: string,
  ) => Promise<void>;
  refreshInventory: (reason: string) => void;
  now?: () => Date;
}

/**
 * Why a run recorded nothing and left the account for the next confirmed
 * sign-in: there was no marketplace data to plan from, or a provider's
 * install state could not be read, which looks like "not installed" and
 * would plan nothing (or plan a plugin the provider already has).
 */
export type ProviderPluginBackfillDeferral =
  | 'no-marketplace-data'
  | 'install-status-unreadable';

const DEFERRAL_TEXT: Record<ProviderPluginBackfillDeferral, string> = {
  'no-marketplace-data': 'no marketplace data to plan from',
  'install-status-unreadable': "a provider's install state could not be read",
};

export interface ProviderPluginBackfillReport {
  provider: PluginProvider;
  /**
   * `skipped` when this account was already backfilled; `deferred` when the
   * run could not plan, so nothing is recorded and the next confirmed sign-in
   * tries again.
   */
  status: 'skipped' | 'completed' | 'deferred';
  deferred?: ProviderPluginBackfillDeferral;
  installed: ProviderPluginBackfillCandidate[];
  failed: ProviderPluginBackfillFailure[];
}

/**
 * Whether reading a managed plugin's install state for `provider` or the
 * other provider failed. A failed read reports `installed: false` with the
 * error beside it, so a plan drawn from it would miss everything the other
 * provider has, or install what this provider already has.
 */
function hasUnreadableInstallStatus(
  cache: PluginsCache,
  provider: PluginProvider,
): boolean {
  const other = otherProvider(provider);
  return cache.marketplaces.some((marketplace) =>
    marketplace.plugins.some((plugin) => {
      if (!isManagedPlugin(plugin)) return false;
      const status = plugin.globalInstallStatus;
      return (
        status?.[provider]?.error !== undefined ||
        status?.[other]?.error !== undefined
      );
    }),
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installFailureText(
  result: IPCResult<InstallBuiltInPluginResult>,
  provider: PluginProvider,
): string | null {
  const outcome = result.data?.providerOutcomes[provider];
  if (outcome?.installed === true) return null;
  return outcome?.error ?? result.error ?? 'Install did not complete.';
}

function deferred(
  provider: PluginProvider,
  reason: ProviderPluginBackfillDeferral,
): ProviderPluginBackfillReport {
  return {
    provider,
    status: 'deferred',
    deferred: reason,
    installed: [],
    failed: [],
  };
}

const inFlight = new Map<PluginProvider, Promise<unknown>>();

/**
 * Backfill `provider` for the account `fingerprint` identifies. Runs once per
 * confirmed fingerprint: a repeat observation of the same account, including
 * every app start, finds the record and does nothing. Overlapping requests
 * for one provider run one after the other, so the second sees the first's
 * record instead of installing the same plugins again.
 */
export async function runProviderPluginBackfill(
  provider: PluginProvider,
  fingerprint: string,
  deps: ProviderPluginBackfillDependencies,
): Promise<ProviderPluginBackfillReport> {
  const previous = inFlight.get(provider) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => backfillProvider(provider, fingerprint, deps));
  inFlight.set(provider, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(provider) === run) inFlight.delete(provider);
  }
}

async function backfillProvider(
  provider: PluginProvider,
  fingerprint: string,
  deps: ProviderPluginBackfillDependencies,
): Promise<ProviderPluginBackfillReport> {
  const state = deps.readState();
  if (
    state.providers[provider]?.some(
      (record) => record.fingerprint === fingerprint,
    )
  ) {
    return { provider, status: 'skipped', installed: [], failed: [] };
  }
  // Recording the account after a read that failed would hide every plugin a
  // later read finds: without marketplace data there is nothing to plan from,
  // and an install state that could not be read (the provider app not
  // reachable yet, as at startup) reads as "not installed" on every plugin.
  const cache = await deps.loadCache();
  if (!cache) return deferred(provider, 'no-marketplace-data');
  if (hasUnreadableInstallStatus(cache, provider))
    return deferred(provider, 'install-status-unreadable');
  const plan = planProviderPluginBackfill(cache, provider);
  const installed: ProviderPluginBackfillCandidate[] = [];
  const failed: ProviderPluginBackfillFailure[] = [];
  for (const candidate of plan) {
    let error: string | null;
    try {
      const result = await deps.installPlugin({
        marketplaceId: candidate.marketplaceId,
        pluginName: candidate.pluginName,
        providers: [provider],
      });
      error = installFailureText(result, provider);
    } catch (cause) {
      error = errorText(cause);
    }
    if (error === null) installed.push(candidate);
    else failed.push({ ...candidate, error });
  }
  // Only after the last install: a later install from the same marketplace
  // rescans it and replaces the cached entry, which would drop an error
  // recorded on an earlier plugin.
  for (const { marketplaceId, pluginName, error } of failed) {
    try {
      await deps.recordInstallError(
        { marketplaceId, pluginName },
        provider,
        error,
      );
    } catch {
      // The failure is already in the report and the state file.
    }
  }
  const now = deps.now ?? ((): Date => new Date());
  const current = deps.readState();
  const records = (current.providers[provider] ?? []).filter(
    (record) => record.fingerprint !== fingerprint,
  );
  records.push({
    fingerprint,
    completedAt: now().toISOString(),
    failures: failed,
  });
  deps.writeState({
    version: PROVIDER_PLUGIN_BACKFILL_STATE_VERSION,
    providers: {
      ...current.providers,
      [provider]: records.slice(-MAX_BACKFILL_RECORDS_PER_PROVIDER),
    },
  });
  if (installed.length > 0)
    deps.refreshInventory(`provider-plugin-backfill:${provider}`);
  return { provider, status: 'completed', installed, failed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFailure(value: unknown): value is ProviderPluginBackfillFailure {
  return (
    isRecord(value) &&
    typeof value.marketplaceId === 'string' &&
    typeof value.pluginName === 'string' &&
    typeof value.error === 'string'
  );
}

function isBackfillRecord(
  value: unknown,
): value is ProviderPluginBackfillRecord {
  return (
    isRecord(value) &&
    typeof value.fingerprint === 'string' &&
    typeof value.completedAt === 'string' &&
    Array.isArray(value.failures) &&
    value.failures.every(isFailure)
  );
}

const BACKFILL_PROVIDERS: readonly PluginProvider[] = ['claude', 'codex'];

/**
 * The persisted state, or nothing backfilled yet when the file is missing,
 * malformed, or written by another version: a bad file costs one extra
 * idempotent backfill, never a crash.
 */
export function readProviderPluginBackfillState(
  filePath: string = getProviderPluginBackfillStateFilePath(),
): ProviderPluginBackfillState {
  const raw = safeReadJson<unknown>(filePath);
  const empty = emptyProviderPluginBackfillState();
  if (
    !isRecord(raw) ||
    raw.version !== PROVIDER_PLUGIN_BACKFILL_STATE_VERSION ||
    !isRecord(raw.providers)
  )
    return empty;
  const state = empty;
  for (const provider of BACKFILL_PROVIDERS) {
    const records = raw.providers[provider];
    if (records === undefined) continue;
    if (!Array.isArray(records) || !records.every(isBackfillRecord))
      return emptyProviderPluginBackfillState();
    state.providers[provider] = records;
  }
  return state;
}

export function writeProviderPluginBackfillState(
  state: ProviderPluginBackfillState,
  filePath: string = getProviderPluginBackfillStateFilePath(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * The live dependencies, loaded when a sign-in first needs them so the plugin
 * service stays off the pre-window module graph.
 */
async function liveDependencies(): Promise<ProviderPluginBackfillDependencies> {
  const service = await import('./plugin-service');
  const inventory = await import('./invocable-inventory-service');
  return {
    // Read fresh from the provider apps rather than from the saved cache: a
    // plugin the user disabled or removed in the other provider since the
    // cache was written must not be planned from a stale snapshot.
    loadCache: async (): Promise<PluginsCache | null> => {
      const marketplaces = await service.scanManagedMarketplacesFresh();
      if (marketplaces.length === 0) return null;
      return {
        version: 2,
        lastRefreshed: new Date().toISOString(),
        marketplaces,
      };
    },
    installPlugin: (request) => service.installBuiltInPlugin(request),
    readState: () => readProviderPluginBackfillState(),
    writeState: (state) => writeProviderPluginBackfillState(state),
    recordInstallError: (candidate, provider, error) =>
      service.recordBuiltInPluginInstallError(candidate, provider, error),
    refreshInventory: (reason) =>
      inventory.refreshInvocableInventoryAfterMutation(reason),
  };
}

/** The sign-in event the backfill listens for; see `provider-auth-state`. */
export interface ProviderSignInEvent {
  provider: PluginProvider;
  fingerprint: string;
  status: AgentProviderAuthStatus;
}

export interface StartProviderPluginBackfillOptions {
  /** `subscribeConfirmedProviderAuth`, passed in to keep this module light. */
  subscribe: (listener: (event: ProviderSignInEvent) => void) => () => void;
  run?: (
    provider: PluginProvider,
    fingerprint: string,
  ) => Promise<ProviderPluginBackfillReport>;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * `<BRAND>_E2E_PROVIDER_PLUGIN_BACKFILL=1` turns the backfill on in a
 * UI-automation build, where the mock providers report a signed-in account on
 * every start. Off by default there, so a suite that never asked for it never
 * sees a background install.
 */
export const E2E_PROVIDER_PLUGIN_BACKFILL_ENV_SUFFIX =
  'E2E_PROVIDER_PLUGIN_BACKFILL';

/**
 * Backfill a provider each time its sign-in is confirmed. The run is
 * detached from the sign-in path: the observation never waits for installs,
 * and a failed run is logged rather than thrown into it.
 */
export function startProviderPluginBackfill(
  options: StartProviderPluginBackfillOptions,
): () => void {
  if (
    isE2eBuild() &&
    getBrandEnv(
      options.env ?? process.env,
      E2E_PROVIDER_PLUGIN_BACKFILL_ENV_SUFFIX,
    ) !== '1'
  ) {
    return (): void => undefined;
  }
  const run =
    options.run ??
    (async (
      provider: PluginProvider,
      fingerprint: string,
    ): Promise<ProviderPluginBackfillReport> =>
      runProviderPluginBackfill(
        provider,
        fingerprint,
        await liveDependencies(),
      ));
  return options.subscribe((event) => {
    void run(event.provider, event.fingerprint)
      .then((report) => {
        if (report.status === 'skipped') return;
        if (report.status === 'deferred') {
          logMainProcessWarn(
            `provider-plugin-backfill: ${event.provider} backfill deferred; ${DEFERRAL_TEXT[report.deferred ?? 'no-marketplace-data']}`,
          );
          return;
        }
        if (report.installed.length === 0 && report.failed.length === 0) return;
        logMainProcessInfo(
          `provider-plugin-backfill: ${event.provider} received ${report.installed.length} plugin(s), ${report.failed.length} failed`,
          { installed: report.installed, failed: report.failed },
        );
      })
      .catch((error: unknown) => {
        logMainProcessWarn(
          `provider-plugin-backfill: ${event.provider} backfill failed`,
          errorText(error),
        );
      });
  });
}
