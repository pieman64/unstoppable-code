import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  isClaudeModsPluginId,
  parseClaudeModsGetArgs,
  parseClaudeModsUpdate,
  type ClaudeModsChatContext,
  type ClaudeModsGetArgs,
  type ClaudeModPluginDetailsTarget,
  type ClaudeModPluginState,
  type ClaudeModsState,
  type ClaudeModsUpdate,
  type ClaudeModsUpdateErrorCode,
  type ClaudeModsUpdateResult,
} from '@canopy/protocol/claude-mods';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  isClaudeModContentDigest,
  isClaudeModPluginId,
  type ClaudeModAdmission,
} from '@canopy/desktop-shared/types/claude-mod-admission';
import {
  computeClaudePluginContentDigest,
  inspectClaudePluginHooks,
  listClaudeAutoLoadedPlugins,
  type ClaudeModAuthority,
} from '@canopy/desktop-shared/node/plugins/claude-mod-admission';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import {
  readClaudePluginInstallPathsById,
  registeredClaudePluginId,
} from '../plugins/claude-enabled-plugins';
import { claudeMarketplaceNames } from '../plugins/inherited-cursor-plugins';
import { resolveClaudeModConfigDirectory } from '../agents/claude-mod-admission-launch';
import { getFeatureFlagService } from '../feature-flags';
import {
  readPreferencesFileDetailed,
  updatePreferencesFile,
} from './preferences-store';
import { resolveClaudeModsChatScope } from './claude-mods-chat-scope';
import { logMainProcessWarn } from './main-process-logging';

export type ClaudeModOperationErrorCode =
  | 'invalid-input'
  | 'plugin-not-found'
  | 'plugin-ambiguous'
  | 'not-a-mod'
  | 'plugin-unreadable'
  | 'digest-changed'
  | 'authority-unreadable'
  | 'save-failed'
  | 'save-outcome-unknown';

export type ClaudeModOperationResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: ClaudeModOperationErrorCode } };

export interface ListClaudeModAdmissionsResult {
  admissions: ClaudeModAdmission[];
  authority: ClaudeModAuthority;
  warning?: string;
}

export interface ReadClaudeModKillSwitchResult {
  modsDisabled: boolean;
  authority: ClaudeModAuthority;
  warning?: string;
}

export interface AdmitClaudeModInput {
  pluginId: string;
  expectedContentDigest: string;
}

export interface RevokeClaudeModInput {
  pluginId: string;
}

export interface SetClaudeModKillSwitchInput {
  modsDisabled: boolean;
}

export interface RevokeClaudeModResult {
  pluginId: string;
  revoked: boolean;
}

export interface ClaudeModKillSwitchWriteResult {
  modsDisabled: boolean;
}

type PreferencesCommitCallback = (preferences: PreferencesData) => void;

interface ClaudeModCatalogPlugin {
  readonly marketplace: MarketplaceInfo;
  readonly plugin: PluginInfo;
}

interface ClaudeModCatalogLookup {
  readonly pluginId: string;
  readonly plugins: readonly ClaudeModCatalogPlugin[];
  readonly details?: ClaudeModPluginDetailsTarget;
}

type ClaudeModDigestErrorCode =
  | 'plugin-not-found'
  | 'plugin-ambiguous'
  | 'not-a-mod'
  | 'plugin-unreadable';

type ClaudeModDigestResolution =
  | {
      readonly success: true;
      readonly pluginId: string;
      readonly contentDigest: string;
      readonly details?: ClaudeModPluginDetailsTarget;
    }
  | {
      readonly success: false;
      readonly code: ClaudeModDigestErrorCode;
      readonly pluginId: string;
      readonly details?: ClaudeModPluginDetailsTarget;
    };

interface ClaudeModServiceRequest {
  readonly context?: ClaudeModsChatContext;
  projectPathsPromise?: Promise<readonly string[] | null>;
  marketplacesPromise?: Promise<readonly MarketplaceInfo[] | null>;
}

const CATALOG_DETAILS_PART_PATTERN = /^[^\s\\]{1,200}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function succeeded<T>(data: T): ClaudeModOperationResult<T> {
  return { success: true, data };
}

function failed<T>(
  code: ClaudeModOperationErrorCode,
): ClaudeModOperationResult<T> {
  return { success: false, error: { code } };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function saveError<T>(error: unknown): ClaudeModOperationResult<T> {
  return failed(
    isStorageOutcomeUnknownError(error) ||
      hasErrorCode(error, 'PREFERENCES_GENERATION_UNKNOWN')
      ? 'save-outcome-unknown'
      : 'save-failed',
  );
}

function isClaudeModAdmissionEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission.key,
  );
}

function authorityWarning(): string {
  return 'Claude Mod preferences are unreadable; no admissions are active.';
}

async function readableAuthority(): Promise<
  { ok: true; authority: 'ok' | 'absent' } | { ok: false }
> {
  const read = await readPreferencesFileDetailed();
  if (read.authority === 'unreadable') {
    logMainProcessWarn(authorityWarning());
    return { ok: false };
  }
  return { ok: true, authority: read.authority };
}

export async function listClaudeModAdmissions(): Promise<
  ClaudeModOperationResult<ListClaudeModAdmissionsResult>
> {
  const read = await readPreferencesFileDetailed();
  if (read.authority === 'unreadable') {
    const warning = authorityWarning();
    logMainProcessWarn(warning);
    return succeeded({
      admissions: [],
      authority: 'unreadable',
      warning,
    });
  }
  return succeeded({
    admissions: [...read.preferences.claudeModAdmissions],
    authority: read.authority,
  });
}

export async function readClaudeModKillSwitch(): Promise<
  ClaudeModOperationResult<ReadClaudeModKillSwitchResult>
> {
  const read = await readPreferencesFileDetailed();
  if (read.authority === 'unreadable') {
    const warning = authorityWarning();
    logMainProcessWarn(warning);
    return succeeded({
      modsDisabled: false,
      authority: 'unreadable',
      warning,
    });
  }
  return succeeded({
    modsDisabled: read.preferences.claudeModsDisabled,
    authority: read.authority,
  });
}

function createClaudeModServiceRequest(
  context?: ClaudeModsChatContext,
): ClaudeModServiceRequest {
  return { context };
}

async function resolveClaudeModProjectPaths(
  request: ClaudeModServiceRequest,
): Promise<readonly string[] | null> {
  if (!request.context) return [];
  request.projectPathsPromise ??= resolveClaudeModsChatScope(
    request.context,
  ).catch(() => null);
  return request.projectPathsPromise;
}

async function loadClaudeModMarketplaces(): Promise<
  readonly MarketplaceInfo[] | null
> {
  try {
    const { loadMarketplacesCacheOnly } =
      await import('../plugins/plugin-service');
    const catalog = await loadMarketplacesCacheOnly();
    if (!catalog.success || !catalog.data) return null;
    return catalog.data.marketplaces;
  } catch {
    return null;
  }
}

async function resolveClaudeModMarketplaces(
  request: ClaudeModServiceRequest,
): Promise<readonly MarketplaceInfo[] | null> {
  request.marketplacesPromise ??= loadClaudeModMarketplaces();
  return request.marketplacesPromise;
}

function lookupClaudeModCatalogPlugin(
  pluginId: string,
  marketplaces: readonly MarketplaceInfo[],
): ClaudeModCatalogLookup {
  const separator = pluginId.indexOf('@');
  if (separator < 0) return { pluginId, plugins: [] };
  const pluginName = pluginId.slice(0, separator);
  const marketplaceId = pluginId.slice(separator + 1);
  const byId = marketplaces.find((entry) => entry.id === marketplaceId);
  // A launch names a native install by the marketplace's registered name.
  const marketplace =
    byId ??
    marketplaces.find((entry) =>
      claudeMarketplaceNames(entry).includes(marketplaceId),
    );
  if (!marketplace) return { pluginId, plugins: [] };

  const facetPlugins = marketplace.plugins.filter(
    (plugin) => plugin.facets.claude?.name === pluginName,
  );
  const firstFacetPlugin = marketplace.plugins.find(
    (plugin) => plugin.facets.claude?.name === pluginName,
  );
  if (firstFacetPlugin) {
    const details = catalogPluginDetails(marketplace, firstFacetPlugin);
    return {
      pluginId,
      // Catalog copies launch under the catalog id, never a registered name.
      plugins: byId
        ? facetPlugins.map((plugin) => ({ marketplace, plugin }))
        : [],
      ...(details ? { details } : {}),
    };
  }

  const catalogPlugin = marketplace.plugins.find(
    (plugin) => plugin.name === pluginName,
  );
  if (!catalogPlugin) return { pluginId, plugins: [] };
  const claudeFacet = catalogPlugin.facets.claude;
  const normalizedPluginId = claudeFacet
    ? `${claudeFacet.name}@${marketplaceId}`
    : pluginId;
  const normalizedPlugins = claudeFacet
    ? marketplace.plugins
        .filter((plugin) => plugin.facets.claude?.name === claudeFacet.name)
        .map((plugin) => ({ marketplace, plugin }))
    : [];
  const details = catalogPluginDetails(marketplace, catalogPlugin);
  return {
    pluginId: normalizedPluginId,
    plugins: normalizedPlugins,
    ...(details ? { details } : {}),
  };
}

function catalogPluginDetails(
  marketplace: MarketplaceInfo,
  plugin: PluginInfo,
): ClaudeModPluginDetailsTarget | undefined {
  return CATALOG_DETAILS_PART_PATTERN.test(marketplace.id) &&
    CATALOG_DETAILS_PART_PATTERN.test(plugin.name)
    ? { marketplaceId: marketplace.id, pluginName: plugin.name }
    : undefined;
}

function failedClaudeModDigestResolution(
  code: ClaudeModDigestErrorCode,
  pluginId: string,
  details?: ClaudeModPluginDetailsTarget,
): ClaudeModDigestResolution {
  return {
    success: false,
    code,
    pluginId,
    ...(details ? { details } : {}),
  };
}

async function resolveCurrentPluginDigest(
  pluginId: string,
  request: ClaudeModServiceRequest,
  normalizeCatalogName: boolean,
): Promise<ClaudeModDigestResolution> {
  const projectPaths = await resolveClaudeModProjectPaths(request);
  if (projectPaths === null) {
    return failedClaudeModDigestResolution('plugin-not-found', pluginId);
  }

  const marketplaces = await resolveClaudeModMarketplaces(request);
  if (!marketplaces) {
    return failedClaudeModDigestResolution('plugin-unreadable', pluginId);
  }
  const catalogLookup = lookupClaudeModCatalogPlugin(pluginId, marketplaces);
  const normalizedPluginId = normalizeCatalogName
    ? catalogLookup.pluginId
    : pluginId;
  if (!isClaudeModPluginId(normalizedPluginId)) {
    return failedClaudeModDigestResolution(
      'plugin-not-found',
      pluginId,
      catalogLookup.details,
    );
  }
  const claudeConfigDir = resolveClaudeModConfigDirectory({
    environment: request.context
      ? { runtime: 'agent', workspaceId: request.context.projectId }
      : { runtime: 'agent' },
    // A relative CLAUDE_CONFIG_DIR resolves against the chat's launch folder.
    cwd: projectPaths[0] ?? homedir(),
  });
  const resolvedPluginId = registeredClaudePluginId(
    normalizedPluginId,
    marketplaces,
    claudeConfigDir,
  );
  const catalogPlugins =
    catalogLookup.pluginId === resolvedPluginId ? catalogLookup.plugins : [];
  const details = catalogLookup.details;
  const unreadable = (): ClaudeModDigestResolution =>
    failedClaudeModDigestResolution(
      'plugin-unreadable',
      resolvedPluginId,
      details,
    );

  const lookup = readClaudePluginInstallPathsById(
    claudeConfigDir,
    resolvedPluginId,
  );
  if (lookup.status === 'unreadable') return unreadable();
  if (lookup.found && lookup.installPaths.length === 0) return unreadable();

  const installPaths = new Set<string>();
  const addInstallPath = (installPath: string): boolean => {
    try {
      installPaths.add(realpathSync(installPath));
      return true;
    } catch {
      return false;
    }
  };
  for (const installPath of lookup.installPaths) {
    if (!addInstallPath(installPath)) return unreadable();
  }

  try {
    const pluginResolver = await import('../plugins/plugin-resolver');
    for (const { marketplace, plugin } of catalogPlugins) {
      const installPath = await pluginResolver.resolvePluginInfoPath(
        plugin,
        marketplace,
        [],
        false,
        'claude',
      );
      if (installPath !== null && !addInstallPath(installPath)) {
        return unreadable();
      }
    }
  } catch {
    return unreadable();
  }

  const settingSources: Parameters<
    typeof listClaudeAutoLoadedPlugins
  >[0]['settingSources'] = request.context ? ['user', 'project'] : ['user'];
  try {
    for (const plugin of listClaudeAutoLoadedPlugins({
      claudeConfigDir,
      settingSources,
      projectPaths,
    })) {
      if (plugin.pluginId !== resolvedPluginId) continue;
      if (plugin.installPath === null || !addInstallPath(plugin.installPath)) {
        return unreadable();
      }
    }
  } catch {
    return unreadable();
  }

  if (installPaths.size === 0) {
    return failedClaudeModDigestResolution(
      'plugin-not-found',
      resolvedPluginId,
      details,
    );
  }

  const digests = new Set<string>();
  let modFound = false;
  for (const installPath of installPaths) {
    const inspection = inspectClaudePluginHooks(installPath);
    if (!inspection.success) return unreadable();
    modFound ||= inspection.hasMods;
    const digest = computeClaudePluginContentDigest(installPath);
    if (!digest) return unreadable();
    digests.add(digest);
  }
  if (digests.size > 1) {
    return failedClaudeModDigestResolution(
      'plugin-ambiguous',
      resolvedPluginId,
      details,
    );
  }
  if (!modFound) {
    return failedClaudeModDigestResolution(
      'not-a-mod',
      resolvedPluginId,
      details,
    );
  }
  const contentDigest = digests.values().next().value;
  return typeof contentDigest === 'string'
    ? {
        success: true,
        pluginId: resolvedPluginId,
        contentDigest,
        ...(details ? { details } : {}),
      }
    : unreadable();
}

type PreferencesWriteResult =
  | { success: true }
  | { success: false; kind: 'save'; error: unknown }
  | { success: false; kind: 'callback'; error: unknown };

async function updatePreferencesAndNotify(
  updater: (latest: PreferencesData) => Partial<PreferencesData>,
  onCommitted?: PreferencesCommitCallback,
): Promise<PreferencesWriteResult> {
  let callbackFailure: { error: unknown } | undefined;
  try {
    await updatePreferencesFile(
      updater,
      onCommitted
        ? (preferences): void => {
            try {
              onCommitted(preferences);
            } catch (error) {
              callbackFailure = { error };
            }
          }
        : undefined,
    );
  } catch (error) {
    return callbackFailure
      ? { success: false, kind: 'callback', error: callbackFailure.error }
      : { success: false, kind: 'save', error };
  }
  return callbackFailure
    ? { success: false, kind: 'callback', error: callbackFailure.error }
    : { success: true };
}

async function admitClaudeModForServiceRequest(
  input: AdmitClaudeModInput,
  onCommitted: PreferencesCommitCallback | undefined,
  request: ClaudeModServiceRequest,
  normalizeCatalogName: boolean,
): Promise<ClaudeModOperationResult<ClaudeModAdmission>> {
  if (
    !isRecord(input) ||
    !isClaudeModPluginId(input.pluginId) ||
    !isClaudeModContentDigest(input.expectedContentDigest)
  ) {
    return failed('invalid-input');
  }
  const authority = await readableAuthority();
  if (!authority.ok) return failed('authority-unreadable');

  const current = await resolveCurrentPluginDigest(
    input.pluginId,
    request,
    normalizeCatalogName,
  );
  if (!current.success) return failed(current.code);
  if (current.contentDigest !== input.expectedContentDigest) {
    return failed('digest-changed');
  }

  const admission: ClaudeModAdmission = {
    pluginId: current.pluginId,
    contentDigest: current.contentDigest,
    admittedAt: new Date().toISOString(),
  };
  const write = await updatePreferencesAndNotify(
    (latest) => ({
      claudeModAdmissions: [
        ...latest.claudeModAdmissions.filter(
          (entry) => entry.pluginId !== admission.pluginId,
        ),
        admission,
      ],
    }),
    onCommitted,
  );
  if (!write.success) {
    if (write.kind === 'callback') throw write.error;
    return saveError(write.error);
  }
  return succeeded(admission);
}

export async function admitClaudeMod(
  input: AdmitClaudeModInput,
  onCommitted?: PreferencesCommitCallback,
): Promise<ClaudeModOperationResult<ClaudeModAdmission>> {
  return admitClaudeModForServiceRequest(
    input,
    onCommitted,
    createClaudeModServiceRequest(),
    false,
  );
}

export async function revokeClaudeMod(
  input: RevokeClaudeModInput,
  onCommitted?: PreferencesCommitCallback,
): Promise<ClaudeModOperationResult<RevokeClaudeModResult>> {
  if (!isRecord(input) || !isClaudeModPluginId(input.pluginId)) {
    return failed('invalid-input');
  }
  const authority = await readableAuthority();
  if (!authority.ok) return failed('authority-unreadable');

  let revoked = false;
  const write = await updatePreferencesAndNotify((latest) => {
    revoked = latest.claudeModAdmissions.some(
      (entry) => entry.pluginId === input.pluginId,
    );
    return {
      claudeModAdmissions: latest.claudeModAdmissions.filter(
        (entry) => entry.pluginId !== input.pluginId,
      ),
    };
  }, onCommitted);
  if (!write.success) {
    if (write.kind === 'callback') throw write.error;
    return saveError(write.error);
  }
  return succeeded({ pluginId: input.pluginId, revoked });
}

export async function setClaudeModKillSwitch(
  input: SetClaudeModKillSwitchInput,
  onCommitted?: PreferencesCommitCallback,
): Promise<ClaudeModOperationResult<ClaudeModKillSwitchWriteResult>> {
  if (!isRecord(input) || typeof input.modsDisabled !== 'boolean') {
    return failed('invalid-input');
  }
  const authority = await readableAuthority();
  if (!authority.ok) return failed('authority-unreadable');
  const write = await updatePreferencesAndNotify(
    () => ({
      claudeModsDisabled: input.modsDisabled,
    }),
    onCommitted,
  );
  if (!write.success) {
    if (write.kind === 'callback') throw write.error;
    return saveError(write.error);
  }
  return succeeded({ modsDisabled: input.modsDisabled });
}

async function readClaudeModsStatePlugin(
  pluginId: string,
  authority: ClaudeModAuthority,
  admissions: readonly ClaudeModAdmission[],
  request: ClaudeModServiceRequest,
): Promise<ClaudeModPluginState> {
  const projectPaths = await resolveClaudeModProjectPaths(request);
  if (projectPaths === null) return { pluginId, status: 'unavailable' };

  if (authority === 'unreadable') {
    const marketplaces = await resolveClaudeModMarketplaces(request);
    if (!marketplaces) return { pluginId, status: 'unavailable' };
    const catalogLookup = lookupClaudeModCatalogPlugin(pluginId, marketplaces);
    const resolvedPluginId = isClaudeModPluginId(catalogLookup.pluginId)
      ? catalogLookup.pluginId
      : pluginId;
    return {
      pluginId: resolvedPluginId,
      status: 'unavailable',
      ...(catalogLookup.details ? { details: catalogLookup.details } : {}),
    };
  }
  const current = await resolveCurrentPluginDigest(pluginId, request, true);
  if (!current.success) {
    return {
      pluginId: current.pluginId,
      status: 'unavailable',
      ...(current.details ? { details: current.details } : {}),
    };
  }

  const matchingAdmissions = admissions.filter(
    (entry) => entry.pluginId === current.pluginId,
  );
  const admission =
    matchingAdmissions.length === 1 ? matchingAdmissions[0] : undefined;
  if (!admission) {
    return {
      pluginId: current.pluginId,
      status: 'not-allowed',
      contentDigest: current.contentDigest,
      ...(current.details ? { details: current.details } : {}),
    };
  }
  return {
    pluginId: current.pluginId,
    status:
      admission.contentDigest === current.contentDigest ? 'allowed' : 'changed',
    contentDigest: current.contentDigest,
    ...(current.details ? { details: current.details } : {}),
  };
}

function requestedClaudeModsPluginId(value: unknown): string | undefined {
  if (!isRecord(value) || !isClaudeModsPluginId(value.pluginId)) {
    return undefined;
  }
  return value.pluginId;
}

async function getClaudeModsStateForRequest(
  args: unknown,
  request: ClaudeModServiceRequest,
): Promise<ClaudeModsState> {
  const enabled = isClaudeModAdmissionEnabled();
  const preferenceRead = await readPreferencesFileDetailed();
  const authorityUnreadable = preferenceRead.authority === 'unreadable';
  if (authorityUnreadable) logMainProcessWarn(authorityWarning());

  const state: ClaudeModsState = {
    enabled,
    modsDisabled:
      !authorityUnreadable && preferenceRead.preferences.claudeModsDisabled,
    authorityUnreadable,
  };
  if (!enabled) return state;

  const parsedArgs = parseClaudeModsGetArgs(args);
  if (!parsedArgs) {
    const requestedPluginId = requestedClaudeModsPluginId(args);
    return requestedPluginId
      ? {
          ...state,
          plugin: { pluginId: requestedPluginId, status: 'unavailable' },
        }
      : state;
  }
  const requestedPluginId = parsedArgs.pluginId;
  if (requestedPluginId === undefined) return state;
  if (!isClaudeModPluginId(requestedPluginId)) {
    return {
      ...state,
      plugin: { pluginId: requestedPluginId, status: 'unavailable' },
    };
  }

  const projectPaths = await resolveClaudeModProjectPaths(request);
  if (projectPaths === null) {
    return {
      ...state,
      plugin: { pluginId: requestedPluginId, status: 'unavailable' },
    };
  }

  return {
    ...state,
    plugin: await readClaudeModsStatePlugin(
      requestedPluginId,
      preferenceRead.authority,
      authorityUnreadable ? [] : preferenceRead.preferences.claudeModAdmissions,
      request,
    ),
  };
}

export async function getClaudeModsState(
  args: ClaudeModsGetArgs,
): Promise<ClaudeModsState> {
  const parsedArgs = parseClaudeModsGetArgs(args);
  return getClaudeModsStateForRequest(
    args,
    createClaudeModServiceRequest(parsedArgs?.context),
  );
}

/**
 * Running Claude chats decide admission again at their next turn, so a change
 * applies from the next message instead of only in new chats.
 */
async function reloadClaudeChatsForModChange(
  scope: 'skipped' | 'all',
): Promise<void> {
  try {
    const [sessions, terminals] = await Promise.all([
      import('../agents/session-manager'),
      import('../integration/claude-terminal-session-service'),
    ]);
    sessions.markClaudeSessionsForModAdmissionChange(scope);
    terminals
      .getClaudeTerminalSessionService()
      .relaunchForModAdmissionChange(scope);
  } catch (error) {
    logMainProcessWarn(
      `Claude chats were not reloaded after a Mod change: ${String(error)}`,
    );
  }
}

function isClaudeModsUpdate(value: unknown): value is ClaudeModsUpdate {
  if (!isRecord(value)) return false;
  if (value.action === 'allow') {
    return (
      isClaudeModPluginId(value.pluginId) &&
      isClaudeModContentDigest(value.contentDigest)
    );
  }
  if (value.action === 'disallow') return isClaudeModPluginId(value.pluginId);
  return (
    value.action === 'set-mods-disabled' &&
    typeof value.modsDisabled === 'boolean'
  );
}

function mapClaudeModUpdateError(
  code: ClaudeModOperationErrorCode,
): ClaudeModsUpdateErrorCode {
  return code;
}

export async function updateClaudeModsState(
  update: ClaudeModsUpdate,
  onCommitted: (preferences: PreferencesData) => void,
): Promise<ClaudeModsUpdateResult> {
  if (!isClaudeModAdmissionEnabled()) return { ok: false, code: 'flag-off' };
  const parsedUpdate = parseClaudeModsUpdate(update);
  if (!parsedUpdate || !isClaudeModsUpdate(parsedUpdate)) {
    return { ok: false, code: 'invalid-input' };
  }

  const request = createClaudeModServiceRequest(
    parsedUpdate.action === 'set-mods-disabled'
      ? undefined
      : parsedUpdate.context,
  );
  if (
    parsedUpdate.action !== 'set-mods-disabled' &&
    parsedUpdate.context !== undefined
  ) {
    const projectPaths = await resolveClaudeModProjectPaths(request);
    if (projectPaths === null) return { ok: false, code: 'plugin-not-found' };
  }

  if (parsedUpdate.action === 'allow') {
    const result = await admitClaudeModForServiceRequest(
      {
        pluginId: parsedUpdate.pluginId,
        expectedContentDigest: parsedUpdate.contentDigest,
      },
      onCommitted,
      request,
      parsedUpdate.context !== undefined,
    );
    if (!result.success) {
      return { ok: false, code: mapClaudeModUpdateError(result.error.code) };
    }
    await reloadClaudeChatsForModChange('skipped');
    const stateArgs: ClaudeModsGetArgs = parsedUpdate.context
      ? { pluginId: parsedUpdate.pluginId, context: parsedUpdate.context }
      : { pluginId: parsedUpdate.pluginId };
    return {
      ok: true,
      state: await getClaudeModsStateForRequest(stateArgs, request),
    };
  }

  if (parsedUpdate.action === 'disallow') {
    const result = await revokeClaudeMod(
      { pluginId: parsedUpdate.pluginId },
      onCommitted,
    );
    if (!result.success) {
      return { ok: false, code: mapClaudeModUpdateError(result.error.code) };
    }
    await reloadClaudeChatsForModChange('all');
    const stateArgs: ClaudeModsGetArgs = parsedUpdate.context
      ? { pluginId: parsedUpdate.pluginId, context: parsedUpdate.context }
      : { pluginId: parsedUpdate.pluginId };
    return {
      ok: true,
      state: await getClaudeModsStateForRequest(stateArgs, request),
    };
  }

  const result = await setClaudeModKillSwitch(
    { modsDisabled: parsedUpdate.modsDisabled },
    onCommitted,
  );
  if (!result.success) {
    return { ok: false, code: mapClaudeModUpdateError(result.error.code) };
  }
  // Both ways reach every chat: turning Mods back on also restores session
  // Mods the kill switch turned off, which leave no skipped record.
  await reloadClaudeChatsForModChange('all');
  return { ok: true, state: await getClaudeModsStateForRequest({}, request) };
}
