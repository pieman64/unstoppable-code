import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  normalizeConfiguredPrompt,
  isValidatedConfiguredPromptReferences,
  validateConfiguredPromptReferences,
} from '@canopy/protocol/configured-prompt-references';
import {
  compareTriggerNames,
  isHookTriggerName,
  type PipelineHookAction,
  type PipelineHookSource,
} from '../../hooks';
import {
  getShareablePluginRefKey,
  normalizeGitHubRepoRef,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import {
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
  MAX_SCRIPT_TIMEOUT_SECONDS,
  isLinuxCommandShell,
  isMacCommandShell,
  isWindowsCommandShell,
  normalizeScriptName,
  type CommandShellDefinition,
  type ScriptDefinition,
  type ScriptDevServerPattern,
  type ScriptDevServerPatternEntry,
  type ScriptDevServerPatternObject,
} from '../../scripts';
import type {
  CanopyJsonFile,
  CanopyJsonPlanDetection,
  CanopyJsonRepoEntry,
  CanopyJsonRepoScriptOverrides,
  CanopyJsonScripts,
  ChatHookAction,
  HookAction,
  HookTriggerName,
  PlanDetectionRule,
} from '../../types';
import { isThinkingLevel } from '../../types';
import type { AgentModelConfig } from '../../types';
import {
  codexSpeedFastMode,
  isCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import { normalizePlanDetectionRule } from '../../plan-detection';
import {
  isApprovalMode,
  normalizeApprovalRules,
} from '../../lib/approval-engine';
import type { ApprovalRule } from '@canopy/execution-engine/types/approvals';
import { validateId } from '@canopy/execution-engine/node/lib/validation';
import { isMissingFileError } from './fs-utils';
import {
  isErrnoException,
  isRecord,
} from '@canopy/execution-engine/node/lib/type-guards';
import { normalizePipelineDependency } from '@canopy/protocol/pipelines';
import {
  isProjectStartPage,
  type ProjectStartPage,
} from '@canopy/protocol/start-page';

type JsonRecord = Record<string, unknown>;

export class InvalidCanopyJsonError extends Error {
  readonly filePath: string;
  readonly reason: string;

  constructor(filePath: string, reason: string) {
    super(`${filePath}: ${reason}`);
    this.name = 'InvalidCanopyJsonError';
    this.filePath = filePath;
    this.reason = reason;
  }
}

export async function readCanopyJson(
  repoPath: string,
): Promise<CanopyJsonFile | null> {
  const filePath = await findExistingProjectConfigFile(repoPath);
  if (!filePath) {
    return null;
  }

  try {
    const raw = await readFile(filePath, 'utf8');
    return parseCanopyJson(raw, filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Failed to read ${filePath}`);
  }
}

export async function writeCanopyJson(
  repoPath: string,
  manifest: CanopyJsonFile,
): Promise<CanopyJsonFile> {
  const filePath =
    (await findExistingProjectConfigFile(repoPath)) ??
    getPrimaryProjectConfigFilePath(repoPath);
  const validated = validateCanopyJson(manifest, filePath);
  await mkdir(repoPath, { recursive: true });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  if (noFollow === 0) {
    try {
      const stats = await lstat(filePath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Refusing to write project config through symbolic link: ${filePath}`,
        );
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  try {
    await writeFile(filePath, JSON.stringify(validated, null, 2) + '\n', {
      encoding: 'utf8',
      flag:
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow,
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ELOOP') {
      throw new Error(
        `Refusing to write project config through symbolic link: ${filePath}`,
      );
    }
    throw error;
  }
  return validated;
}
export function getCanopyJsonPath(repoPath: string): string {
  return getPrimaryProjectConfigFilePath(repoPath);
}

export function getProjectConfigFileCandidates(repoPath: string): string[] {
  return BRAND.storage.configFileNames.map((fileName) =>
    path.join(repoPath, fileName),
  );
}

export function getPrimaryProjectConfigFilePath(repoPath: string): string {
  return getProjectConfigFileCandidates(repoPath)[0];
}

export async function findExistingProjectConfigFile(
  repoPath: string,
): Promise<string | null> {
  for (const candidate of getProjectConfigFileCandidates(repoPath)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next configured fallback.
    }
  }
  return null;
}

export function hasManifestRepos(
  manifest: CanopyJsonFile | null,
): manifest is CanopyJsonFile & { repos: CanopyJsonRepoEntry[] } {
  return (
    manifest !== null && Object.prototype.hasOwnProperty.call(manifest, 'repos')
  );
}

export function getManifestRepoById(
  manifest: CanopyJsonFile,
  repoId: string,
): CanopyJsonRepoEntry | undefined {
  return manifest.repos?.find((repo) => repo.id === repoId);
}

export function validateCanopyJson(
  value: unknown,
  context: string,
): CanopyJsonFile {
  const configFileLabel = getConfigFileLabel(context);
  if (!isRecord(value)) {
    throw new Error(
      `${context}: ${configFileLabel} must contain a JSON object`,
    );
  }

  const version = value.version;
  if (version !== 1) {
    throw new Error(`${context}: ${configFileLabel} version must be 1`);
  }

  const scripts = parseManifestScripts(value.scripts, context);
  const hooks = parseManifestHooks(value.hooks, context);
  const plugins = parseManifestPlugins(value.plugins, context);
  const dependencies = parseManifestDependencies(value.dependencies, context);
  const planDetection = parseManifestPlanDetection(value.planDetection);
  const startPage = parseManifestStartPage(value.startPage);
  const approvals = parseManifestApprovals(value.approvals, context);
  const reposPresent = Object.prototype.hasOwnProperty.call(value, 'repos');
  const repos = reposPresent
    ? parseManifestRepos(value.repos, context)
    : undefined;

  const preservedKeys: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      key === 'version' ||
      key === 'scripts' ||
      key === 'hooks' ||
      key === 'plugins' ||
      key === 'dependencies' ||
      key === 'planDetection' ||
      key === 'startPage' ||
      key === 'approvals' ||
      key === 'repos'
    ) {
      continue;
    }
    preservedKeys[key] = entry;
  }

  const manifest: CanopyJsonFile = {
    ...preservedKeys,
    version: 1,
    ...(scripts ? { scripts } : {}),
    ...(hooks ? { hooks } : {}),
    ...(plugins ? { plugins } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(planDetection ? { planDetection } : {}),
    ...(startPage ? { startPage } : {}),
    ...(approvals ? { approvals } : {}),
    ...(reposPresent ? { repos: repos ?? [] } : {}),
  };

  return manifest;
}

function parseManifestDependencies(
  value: unknown,
  context: string,
): CanopyJsonFile['dependencies'] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${context}: dependencies must be an array`);
  }
  return value.map((dependency, index) => {
    const normalized = normalizePipelineDependency(
      dependency,
      `${context}: dependencies[${index}]`,
    );
    if (normalized.kind === 'skill' || normalized.kind === 'plugin') {
      throw new Error(
        `${context}: dependencies[${index}] kind "${normalized.kind}" belongs in plugins`,
      );
    }
    return normalized;
  });
}

function getConfigFileLabel(context: string): string {
  const parsed = path.basename(context);
  return parsed || BRAND.storage.configFileNames[0] || 'project config file';
}

export function parseCanopyJson(raw: string, context: string): CanopyJsonFile {
  try {
    const parsed: unknown = JSON.parse(raw);
    return validateCanopyJson(parsed, context);
  } catch (error) {
    if (error instanceof Error) {
      const normalizedReason = error.message.startsWith(`${context}: `)
        ? error.message.slice(context.length + 2)
        : error.message;
      throw new InvalidCanopyJsonError(context, normalizedReason);
    }

    throw new InvalidCanopyJsonError(context, 'invalid JSON');
  }
}

function parseManifestScripts(
  value: unknown,
  context: string,
): CanopyJsonScripts | undefined {
  const entries = parseScriptRecordEntries(
    value,
    context,
    'scripts',
    (scriptName, rawValue) =>
      parseManifestScriptValue(rawValue, scriptName, context, 'script'),
  );
  return scriptEntriesToObject(entries);
}

function parseManifestScriptValue(
  rawValue: unknown,
  scriptName: string,
  context: string,
  label: 'script' | 'repo script',
): string | ScriptDefinition {
  if (typeof rawValue === 'string') {
    return parseNonEmptyScriptValue(rawValue, scriptName, context, label);
  }

  if (!isRecord(rawValue)) {
    throw new Error(
      `${context}: ${label} "${scriptName}" must be a string or script object`,
    );
  }

  return parseScriptDefinition(rawValue, scriptName, context, label);
}

function parseNonEmptyScriptValue(
  rawValue: string,
  scriptName: string,
  context: string,
  label: 'script' | 'repo script',
): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error(`${context}: ${label} "${scriptName}" must not be empty`);
  }
  return trimmed;
}

function parseScriptDefinition(
  value: JsonRecord,
  scriptName: string,
  context: string,
  label: 'script' | 'repo script',
): string | ScriptDefinition {
  for (const key of Object.keys(value)) {
    if (
      key !== 'command' &&
      key !== 'timeoutSeconds' &&
      key !== 'devServerPattern' &&
      key !== 'shell' &&
      key !== 'interactive'
    ) {
      throw new Error(
        `${context}: ${label} "${scriptName}" contains unsupported key "${key}"`,
      );
    }
  }

  if (typeof value.command !== 'string') {
    throw new Error(`${context}: ${label} "${scriptName}" command is required`);
  }
  const command = parseNonEmptyScriptValue(
    value.command,
    scriptName,
    context,
    label,
  );

  const hasTimeoutSeconds = Object.prototype.hasOwnProperty.call(
    value,
    'timeoutSeconds',
  );
  const hasDevServerPattern = Object.prototype.hasOwnProperty.call(
    value,
    'devServerPattern',
  );
  const hasShell = Object.prototype.hasOwnProperty.call(value, 'shell');
  const hasInteractive = Object.prototype.hasOwnProperty.call(
    value,
    'interactive',
  );
  if (hasInteractive && typeof value.interactive !== 'boolean') {
    throw new Error(
      `${context}: ${label} "${scriptName}" interactive must be a boolean`,
    );
  }
  const interactive = value.interactive === true;

  if (!hasTimeoutSeconds && !hasDevServerPattern && !hasShell && !interactive) {
    return command;
  }

  const definition: ScriptDefinition = { command };

  if (interactive) {
    definition.interactive = true;
  }

  if (hasTimeoutSeconds) {
    definition.timeoutSeconds = parseScriptTimeoutSeconds(
      value.timeoutSeconds,
      scriptName,
      context,
      label,
    );
  }

  if (hasDevServerPattern) {
    definition.devServerPattern = parseScriptDevServerPattern(
      value.devServerPattern,
      scriptName,
      context,
      label,
    );
  }

  if (hasShell) {
    definition.shell = parseCommandShellDefinition(
      value.shell,
      scriptName,
      context,
      label,
    );
  }

  return definition;
}

function parseCommandShellDefinition(
  value: unknown,
  scriptName: string,
  context: string,
  label: 'script' | 'repo script',
): CommandShellDefinition {
  if (!isRecord(value)) {
    throw new Error(
      `${context}: ${label} "${scriptName}" shell must be an object`,
    );
  }

  for (const key of Object.keys(value)) {
    if (key !== 'windows' && key !== 'mac' && key !== 'linux') {
      throw new Error(
        `${context}: ${label} "${scriptName}" shell contains unsupported key "${key}"`,
      );
    }
  }

  const hasWindows = Object.prototype.hasOwnProperty.call(value, 'windows');
  const hasMac = Object.prototype.hasOwnProperty.call(value, 'mac');
  const hasLinux = Object.prototype.hasOwnProperty.call(value, 'linux');
  if (!hasWindows && !hasMac && !hasLinux) {
    throw new Error(
      `${context}: ${label} "${scriptName}" shell must configure windows, mac, or linux`,
    );
  }

  const shell: CommandShellDefinition = {};
  if (hasWindows) {
    if (!isWindowsCommandShell(value.windows)) {
      throw new Error(
        `${context}: ${label} "${scriptName}" shell.windows must be "cmd", "powershell", or "bash"`,
      );
    }
    shell.windows = value.windows;
  }
  if (hasMac) {
    if (!isMacCommandShell(value.mac)) {
      throw new Error(
        `${context}: ${label} "${scriptName}" shell.mac must be "zsh" or "bash"`,
      );
    }
    shell.mac = value.mac;
  }
  if (hasLinux) {
    if (!isLinuxCommandShell(value.linux)) {
      throw new Error(
        `${context}: ${label} "${scriptName}" shell.linux must be "bash" or "zsh"`,
      );
    }
    shell.linux = value.linux;
  }
  return shell;
}

function parseHookCommandShellDefinition(
  value: unknown,
  context: string,
): CommandShellDefinition {
  if (!isRecord(value)) {
    throw new Error(`${context}: shell must be an object`);
  }

  for (const key of Object.keys(value)) {
    if (key !== 'windows' && key !== 'mac' && key !== 'linux') {
      throw new Error(`${context}: shell contains unsupported key "${key}"`);
    }
  }

  const hasWindows = Object.prototype.hasOwnProperty.call(value, 'windows');
  const hasMac = Object.prototype.hasOwnProperty.call(value, 'mac');
  const hasLinux = Object.prototype.hasOwnProperty.call(value, 'linux');
  if (!hasWindows && !hasMac && !hasLinux) {
    throw new Error(`${context}: shell must configure windows, mac, or linux`);
  }

  const shell: CommandShellDefinition = {};
  if (hasWindows) {
    if (!isWindowsCommandShell(value.windows)) {
      throw new Error(
        `${context}: shell.windows must be "cmd", "powershell", or "bash"`,
      );
    }
    shell.windows = value.windows;
  }
  if (hasMac) {
    if (!isMacCommandShell(value.mac)) {
      throw new Error(`${context}: shell.mac must be "zsh" or "bash"`);
    }
    shell.mac = value.mac;
  }
  if (hasLinux) {
    if (!isLinuxCommandShell(value.linux)) {
      throw new Error(`${context}: shell.linux must be "bash" or "zsh"`);
    }
    shell.linux = value.linux;
  }
  return shell;
}

export function parseScriptDevServerPattern(
  value: unknown,
  scriptName: string,
  context: string,
  label: 'script' | 'repo script',
): ScriptDevServerPattern {
  const rawEntries: unknown[] = Array.isArray(value) ? value : [value];
  if (rawEntries.length === 0) {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern array must not be empty`,
    );
  }
  if (rawEntries.length > MAX_SCRIPT_DEV_SERVER_PATTERNS) {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern array must contain at most ${MAX_SCRIPT_DEV_SERVER_PATTERNS} entries`,
    );
  }
  const entries: ScriptDevServerPatternEntry[] = rawEntries.map((rawEntry) =>
    parseScriptDevServerPatternEntry(rawEntry, scriptName, context, label),
  );
  if (!Array.isArray(value)) {
    return entries[0];
  }
  return entries;
}

function parseScriptDevServerPatternEntry(
  value: unknown,
  scriptName: string,
  context: string,
  label: 'script' | 'repo script',
): ScriptDevServerPatternEntry {
  if (typeof value === 'string') {
    return parseScriptDevServerPatternSource(value, scriptName, context, label);
  }
  if (!isRecord(value)) {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern must be a string, object, or array`,
    );
  }
  for (const key of Object.keys(value)) {
    if (
      key !== 'pattern' &&
      key !== 'label' &&
      key !== 'openTarget' &&
      key !== 'autoOpen'
    ) {
      throw new Error(
        `${context}: ${label} "${scriptName}" devServerPattern contains unsupported key "${key}"`,
      );
    }
  }
  if (typeof value.pattern !== 'string') {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern pattern must be a non-empty string`,
    );
  }
  const pattern = parseScriptDevServerPatternSource(
    value.pattern,
    scriptName,
    context,
    label,
  );
  const parsed: ScriptDevServerPatternObject = { pattern };
  if (Object.prototype.hasOwnProperty.call(value, 'autoOpen')) {
    if (typeof value.autoOpen !== 'boolean') {
      throw new Error(
        `${context}: ${label} "${scriptName}" devServerPattern autoOpen must be a boolean`,
      );
    }
    parsed.autoOpen = value.autoOpen;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'openTarget')) {
    if (value.openTarget !== 'in-app' && value.openTarget !== 'external') {
      throw new Error(
        `${context}: ${label} "${scriptName}" devServerPattern openTarget must be "in-app" or "external"`,
      );
    }
    parsed.openTarget = value.openTarget;
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'label')) {
    return parsed;
  }
  if (typeof value.label !== 'string') {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern label must be a non-empty string`,
    );
  }
  const trimmedLabel = value.label.trim();
  if (trimmedLabel.length === 0) {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern label must be a non-empty string`,
    );
  }
  if (trimmedLabel.length > MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH) {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern label must be at most ${MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH} characters`,
    );
  }
  parsed.label = trimmedLabel;
  return parsed;
}

function parseScriptDevServerPatternSource(
  rawValue: string,
  scriptName: string,
  context: string,
  label: 'script' | 'repo script',
): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern pattern must be a non-empty string`,
    );
  }
  if (trimmed.length > MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH) {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern pattern must be at most ${MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH} characters`,
    );
  }
  try {
    new RegExp(trimmed);
  } catch {
    throw new Error(
      `${context}: ${label} "${scriptName}" devServerPattern pattern must be a valid JavaScript regex`,
    );
  }
  return trimmed;
}

export function parseScriptTimeoutSeconds(
  value: unknown,
  scriptName: string,
  context: string,
  label: 'script' | 'repo script',
): number | null {
  if (value === null) {
    return null;
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SCRIPT_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `${context}: ${label} "${scriptName}" timeoutSeconds must be null or between 1 and ${MAX_SCRIPT_TIMEOUT_SECONDS}`,
    );
  }

  return value;
}

function parseScriptRecordEntries<T>(
  value: unknown,
  context: string,
  fieldLabel: 'scripts' | 'repo scripts',
  parseValue: (scriptName: string, rawValue: unknown) => T,
): Array<[string, T]> | undefined {
  const record = parseOptionalRecord(value, context, fieldLabel);
  if (!record) {
    return undefined;
  }

  const entries: Array<[string, T]> = [];
  for (const [rawName, rawValue] of Object.entries(record)) {
    const scriptName = parseManifestScriptName(rawName, context, fieldLabel);
    entries.push([scriptName, parseValue(scriptName, rawValue)]);
  }

  entries.sort(compareScriptEntries);
  return entries.length > 0 ? entries : undefined;
}

function parseManifestScriptName(
  rawName: string,
  context: string,
  fieldLabel: 'scripts' | 'repo scripts',
): string {
  const scriptName = normalizeScriptName(rawName);
  if (!scriptName) {
    throw new Error(
      `${context}: ${fieldLabel} contains an invalid script name`,
    );
  }
  return scriptName;
}

function parseOptionalRecord(
  value: unknown,
  context: string,
  fieldLabel: string,
): JsonRecord | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${context}: ${fieldLabel} must be an object`);
  }
  return value;
}

function scriptEntriesToObject<V>(
  entries: Array<[string, V]> | undefined,
): Record<string, V> | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const result: Record<string, V> = Object.fromEntries(entries);
  return result;
}

function hookEntriesToObject<V>(
  entries: Array<[HookTriggerName, V]> | undefined,
): Partial<Record<HookTriggerName, V>> | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const result: Partial<Record<HookTriggerName, V>> =
    Object.fromEntries(entries);
  return result;
}

function parseHookRecordEntries<T>(
  value: unknown,
  context: string,
  fieldLabel: 'hooks' | 'repo hooks',
  parseValue: (
    triggerName: HookTriggerName,
    rawActions: unknown,
  ) => T | undefined,
): Array<[HookTriggerName, T]> | undefined {
  const record = parseOptionalRecord(value, context, fieldLabel);
  if (!record) {
    return undefined;
  }

  const entries: Array<[HookTriggerName, T]> = [];
  for (const [rawTriggerName, rawActions] of Object.entries(record)) {
    const triggerName = parseHookTriggerName(
      rawTriggerName,
      context,
      fieldLabel,
    );
    const parsed = parseValue(triggerName, rawActions);
    if (parsed === undefined) {
      continue;
    }
    entries.push([triggerName, parsed]);
  }

  entries.sort(compareHookEntries);
  return entries.length > 0 ? entries : undefined;
}

function parseHookActionsEntry(
  rawActions: unknown,
  context: string,
): HookAction[] | undefined {
  const actions = parseHookActions(rawActions, context);
  return actions.length > 0 ? actions : undefined;
}

function parseManifestHooks(
  value: unknown,
  context: string,
): Partial<Record<HookTriggerName, HookAction[]>> | undefined {
  const entries = parseHookRecordEntries(
    value,
    context,
    'hooks',
    (triggerName, rawActions) =>
      parseHookActionsEntry(rawActions, `${context}: hook "${triggerName}"`),
  );
  return hookEntriesToObject(entries);
}

function parseManifestPlanDetection(
  value: unknown,
): CanopyJsonPlanDetection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawRules = Array.isArray(value.rules) ? value.rules : [];
  const seenIds = new Set<string>();
  const rules: PlanDetectionRule[] = [];
  for (const entry of rawRules) {
    const rule = normalizePlanDetectionRule(entry);
    if (rule && !seenIds.has(rule.id)) {
      seenIds.add(rule.id);
      rules.push(rule);
    }
  }
  return rules.length > 0 ? { rules } : undefined;
}

function parseManifestStartPage(value: unknown): ProjectStartPage | undefined {
  return isProjectStartPage(value) ? value : undefined;
}

function parseManifestApprovals(
  value: unknown,
  context: string,
): CanopyJsonFile['approvals'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${context}: approvals must be an object`);
  }

  const approvals: NonNullable<CanopyJsonFile['approvals']> = {};

  if (Object.prototype.hasOwnProperty.call(value, 'defaultMode')) {
    const defaultMode = value.defaultMode;
    if (defaultMode === 'ask' || defaultMode === 'auto') {
      approvals.defaultMode = defaultMode;
    } else if (defaultMode !== 'full-access') {
      // Repo-committed canopy.json may only de-escalate the default mode to
      // 'ask' or 'auto'. 'full-access' is silently dropped (non-escalation);
      // any other invalid value is a genuine config error.
      throw new Error(
        `${context}: approvals.defaultMode must be "ask" or "auto"`,
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, 'rules')) {
    if (!Array.isArray(value.rules)) {
      throw new Error(`${context}: approvals.rules must be an array`);
    }
    const rules: ApprovalRule[] = normalizeApprovalRules(value.rules).map(
      (rule, index) => stampCanopyJsonRuleOrigin(rule, index),
    );
    if (rules.length > 0) {
      approvals.rules = rules;
    }
  }

  return approvals;
}

function stampCanopyJsonRuleOrigin(
  rule: ApprovalRule,
  index: number,
): ApprovalRule {
  return {
    id: rule.id || `canopy-json:${index}`,
    behavior: rule.behavior,
    target: rule.target,
    createdAt: rule.createdAt,
    origin: 'canopy-json',
  };
}

function parseManifestPlugins(
  value: unknown,
  context: string,
): ShareablePluginRef[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: plugins must be an array`);
  }

  const plugins: ShareablePluginRef[] = [];
  const seenKeys = new Set<string>();
  const entries: readonly unknown[] = value;
  for (let index = 0; index < entries.length; index += 1) {
    const plugin = parseShareablePluginRef(
      entries[index],
      `${context}: plugins[${index}]`,
      {
        bundleMessage:
          'canopy.json top-level plugins only support shareable skill, plugin, claude_plugin, and codex_plugin refs; Collections are local-only in canopy.json',
      },
    );
    const key = getShareablePluginRefKey(plugin);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    plugins.push(plugin);
  }

  return plugins.length > 0 ? plugins : undefined;
}

function parseManifestRepos(
  value: unknown,
  context: string,
): CanopyJsonRepoEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: repos must be an array`);
  }

  const seenIds = new Set<string>();
  const repos = value.map((entry, index) =>
    parseManifestRepoEntry(entry, `${context}: repos[${index}]`),
  );

  for (const repo of repos) {
    if (seenIds.has(repo.id)) {
      throw new Error(`${context}: duplicate repo id "${repo.id}"`);
    }
    seenIds.add(repo.id);
  }

  return repos;
}

function parseManifestRepoEntry(
  value: unknown,
  context: string,
): CanopyJsonRepoEntry {
  if (!isRecord(value)) {
    throw new Error(`${context}: repo entry must be an object`);
  }

  if (typeof value.id !== 'string') {
    throw new Error(`${context}: repo id is required`);
  }
  validateId(value.id, `${context}: repo id`);

  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error(`${context}: repo name is required`);
  }

  if (typeof value.url !== 'string' || !value.url.trim()) {
    throw new Error(`${context}: repo url is required`);
  }

  const scripts = parseManifestRepoScripts(value.scripts, context);
  const hooks = parseManifestRepoHooks(value.hooks, context);
  return {
    id: value.id,
    name: value.name.trim(),
    url: value.url.trim(),
    ...(scripts ? { scripts } : {}),
    ...(hooks ? { hooks } : {}),
  };
}

function parseManifestRepoScripts(
  value: unknown,
  context: string,
): CanopyJsonRepoScriptOverrides | undefined {
  const entries = parseScriptRecordEntries(
    value,
    context,
    'repo scripts',
    (scriptName, rawValue) => {
      if (rawValue === null) {
        return null;
      }
      return parseManifestScriptValue(
        rawValue,
        scriptName,
        context,
        'repo script',
      );
    },
  );
  return scriptEntriesToObject(entries);
}

function parseManifestRepoHooks(
  value: unknown,
  context: string,
): Partial<Record<HookTriggerName, HookAction[] | null>> | undefined {
  const entries = parseHookRecordEntries(
    value,
    context,
    'repo hooks',
    (triggerName, rawActions) => {
      if (rawActions === null) {
        return null;
      }
      return parseHookActionsEntry(
        rawActions,
        `${context}: repo hook "${triggerName}"`,
      );
    },
  );
  return hookEntriesToObject(entries);
}

function parseHookTriggerName(
  rawTriggerName: string,
  context: string,
  fieldLabel: 'hooks' | 'repo hooks',
): HookTriggerName {
  if (!isHookTriggerName(rawTriggerName)) {
    throw new Error(
      `${context}: ${fieldLabel} contains an invalid trigger "${rawTriggerName}"`,
    );
  }

  return rawTriggerName;
}

function parseHookActions(value: unknown, context: string): HookAction[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }

  return value.map((entry, index) =>
    parseHookAction(entry, `${context}: actions[${index}]`),
  );
}

function parseHookModelConfig(
  value: unknown,
  context: string,
): AgentModelConfig {
  if (!isRecord(value)) {
    throw new Error(`${context}: modelConfig must be an object`);
  }
  const modelConfig: AgentModelConfig = {};
  if (value.fastMode !== undefined) {
    if (typeof value.fastMode !== 'boolean') {
      throw new Error(`${context}: modelConfig.fastMode must be a boolean`);
    }
    modelConfig.fastMode = value.fastMode;
  }
  if (value.speed !== undefined) {
    if (!isCodexSpeed(value.speed)) {
      throw new Error(
        `${context}: modelConfig.speed must be standard, fast, or ultrafast`,
      );
    }
    const derivedFastMode = codexSpeedFastMode(value.speed);
    if (
      modelConfig.fastMode !== undefined &&
      modelConfig.fastMode !== derivedFastMode
    ) {
      throw new Error(`${context}: modelConfig.fastMode must match its speed`);
    }
    modelConfig.speed = value.speed;
    modelConfig.fastMode = derivedFastMode;
  }
  if (value.thinkingLevel !== undefined) {
    if (
      typeof value.thinkingLevel !== 'string' ||
      !isThinkingLevel(value.thinkingLevel)
    ) {
      throw new Error(
        `${context}: modelConfig.thinkingLevel must be a valid thinking level`,
      );
    }
    modelConfig.thinkingLevel = value.thinkingLevel;
  }
  return modelConfig;
}

function parseHookAction(value: unknown, context: string): HookAction {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }

  if (value.type === 'command') {
    if (typeof value.command !== 'string') {
      throw new Error(`${context}: command must be a string`);
    }

    const command = value.command.trim();
    if (!command) {
      throw new Error(`${context}: command must not be empty`);
    }

    const action: HookAction = {
      type: 'command',
      command,
    };
    if (Object.prototype.hasOwnProperty.call(value, 'shell')) {
      action.shell = parseHookCommandShellDefinition(value.shell, context);
    }
    if (value.interactive !== undefined) {
      if (typeof value.interactive !== 'boolean') {
        throw new Error(`${context}: interactive must be a boolean`);
      }
      if (value.interactive) {
        action.interactive = true;
      }
    }
    return action;
  }

  if (value.type === 'chat') {
    if (typeof value.prompt !== 'string') {
      throw new Error(`${context}: prompt must be a string`);
    }

    const prompt = value.prompt.trim();
    if (!prompt) {
      throw new Error(`${context}: prompt must not be empty`);
    }

    const action: ChatHookAction = {
      type: 'chat',
      prompt,
    };
    if (value.promptReferences !== undefined) {
      const references = value.promptReferences;
      if (
        !isValidatedConfiguredPromptReferences(value.prompt, references, {
          portableOnly: true,
        })
      ) {
        const error = validateConfiguredPromptReferences(
          value.prompt,
          references,
          { portableOnly: true },
        );
        throw new Error(
          `${context}: ${error ?? 'promptReferences is invalid.'}`,
        );
      }
      const normalized = normalizeConfiguredPrompt(value.prompt, references);
      action.promptReferences = normalized.promptReferences;
    }
    if (value.planMode !== undefined) {
      if (typeof value.planMode !== 'boolean') {
        throw new Error(`${context}: planMode must be a boolean`);
      }
      action.planMode = value.planMode;
    }

    if (value.model !== undefined) {
      if (typeof value.model !== 'string') {
        throw new Error(`${context}: model must be a string`);
      }

      const model = value.model.trim();
      if (!model) {
        throw new Error(`${context}: model must not be empty`);
      }
      action.model = model;
    }

    if (value.thinking !== undefined) {
      if (
        typeof value.thinking !== 'string' ||
        !isThinkingLevel(value.thinking)
      ) {
        throw new Error(
          `${context}: thinking must be a supported thinking level`,
        );
      }
      action.modelConfig = {
        ...(action.modelConfig ?? {}),
        thinkingLevel: value.thinking,
      };
    }

    if (value.modelConfig !== undefined) {
      action.modelConfig = parseHookModelConfig(value.modelConfig, context);
    }

    // Unlike most chat-action fields, an invalid or escalating approvalMode
    // is silently dropped rather than throwing. Repository-authored hooks may
    // select ask/auto, but cannot grant themselves full access.
    if (
      value.approvalMode !== undefined &&
      isApprovalMode(value.approvalMode) &&
      value.approvalMode !== 'full-access'
    ) {
      action.approvalMode = value.approvalMode;
    }
    if (
      value.codexFastMode !== undefined &&
      action.modelConfig?.fastMode === undefined
    ) {
      if (typeof value.codexFastMode !== 'boolean') {
        throw new Error(`${context}: codexFastMode must be a boolean`);
      }
      action.modelConfig = {
        ...(action.modelConfig ?? {}),
        fastMode: value.codexFastMode,
      };
    }

    if (value['if-command'] !== undefined) {
      if (typeof value['if-command'] !== 'string') {
        throw new Error(`${context}: if-command must be a string`);
      }

      const ifCommand = value['if-command'].trim();
      if (!ifCommand) {
        throw new Error(`${context}: if-command must not be empty`);
      }
      action['if-command'] = ifCommand;
    }

    if (value.plugins !== undefined) {
      action.plugins = parseChatHookPlugins(
        value.plugins,
        `${context}: plugins`,
      );
    }

    if (value.pluginSelections !== undefined) {
      throw new Error(
        `${context}: pluginSelections are not allowed in canopy.json; use portable plugins instead`,
      );
    }

    if (value.allowChatConcurrency !== undefined) {
      if (typeof value.allowChatConcurrency !== 'boolean') {
        throw new Error(`${context}: allowChatConcurrency must be a boolean`);
      }
      if (value.allowChatConcurrency) {
        action.allowChatConcurrency = true;
      }
    }

    if (value.autoArchive !== undefined) {
      if (typeof value.autoArchive !== 'boolean') {
        throw new Error(`${context}: autoArchive must be a boolean`);
      }
      if (value.autoArchive) {
        action.autoArchive = true;
      }
    }

    return action;
  }

  if (value.type === 'pipeline') {
    const source = parsePipelineHookSource(value.source, context);

    if (typeof value.id !== 'string') {
      throw new Error(`${context}: id must be a string`);
    }

    const id = value.id.trim();
    if (!id) {
      throw new Error(`${context}: id must not be empty`);
    }

    if (source === 'project') {
      validateProjectPipelineHookId(id, context);
    }

    const action: PipelineHookAction = {
      type: 'pipeline',
      source,
      id,
    };

    const inputs = parsePipelineHookInputs(value.inputs, context);
    if (inputs) {
      action.inputs = inputs;
    }

    if (value.modelConfig !== undefined) {
      const modelConfig = parseHookModelConfig(value.modelConfig, context);
      if (modelConfig.speed === 'ultrafast') {
        // Pipeline hooks keep boolean Fast mode authoring; reject Ultra fast
        // explicitly rather than dropping it or running another speed.
        throw new Error(
          `${context}: pipeline hooks do not support Ultra fast; use modelConfig.fastMode`,
        );
      }
      if (typeof modelConfig.fastMode === 'boolean') {
        action.modelConfig = { fastMode: modelConfig.fastMode };
      }
    }
    if (
      value.codexFastMode !== undefined &&
      action.modelConfig?.fastMode === undefined
    ) {
      if (typeof value.codexFastMode !== 'boolean') {
        throw new Error(`${context}: codexFastMode must be a boolean`);
      }
      action.modelConfig = { fastMode: value.codexFastMode };
    }

    if (value.allowPipelineConcurrency !== undefined) {
      if (typeof value.allowPipelineConcurrency !== 'boolean') {
        throw new Error(
          `${context}: allowPipelineConcurrency must be a boolean`,
        );
      }
      if (value.allowPipelineConcurrency) {
        action.allowPipelineConcurrency = true;
      }
    }

    return action;
  }

  throw new Error(
    `${context}: only "command", "chat", and "pipeline" hook actions are supported`,
  );
}

function parsePipelineHookSource(
  value: unknown,
  context: string,
): PipelineHookSource {
  if (
    value === 'bundled' ||
    value === 'local' ||
    value === 'project' ||
    value === 'curated'
  ) {
    return value;
  }

  throw new Error(
    `${context}: source must be one of "bundled", "local", "project", or "curated"`,
  );
}

function validateProjectPipelineHookId(id: string, context: string): void {
  if (path.posix.isAbsolute(id) || path.win32.isAbsolute(id)) {
    throw new Error(`${context}: project pipeline id must be a relative path`);
  }

  const segments = id.split(/[\\/]/);
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`${context}: project pipeline id contains unsafe segments`);
  }

  const extension = path.posix.extname(id.replace(/\\/g, '/')).toLowerCase();
  if (extension !== '.yml' && extension !== '.yaml') {
    throw new Error(
      `${context}: project pipeline id must be a .yml or .yaml path`,
    );
  }
}

function parsePipelineHookInputs(
  value: unknown,
  context: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${context}: inputs must be an object`);
  }

  const entries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) {
      throw new Error(`${context}: inputs contains an empty key`);
    }
    if (typeof rawValue !== 'string') {
      throw new Error(`${context}: input "${key}" must be a string`);
    }
    entries.push([key, rawValue]);
  }

  entries.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseChatHookPlugins(
  value: unknown,
  context: string,
): ShareablePluginRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }

  const plugins: ShareablePluginRef[] = [];
  const entries: readonly unknown[] = value;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    plugins.push(parseShareablePluginRef(entry, `${context}[${index}]`));
  }
  return plugins;
}

interface ParseShareablePluginRefOptions {
  bundleMessage?: string;
}

function parseShareablePluginRef(
  value: unknown,
  context: string,
  options?: ParseShareablePluginRefOptions,
): ShareablePluginRef {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }

  if (value.type === 'bundle') {
    throw new Error(
      options?.bundleMessage ??
        'chat.plugins in canopy.json only support shareable skill, plugin, claude_plugin, and codex_plugin refs; Collections are local-only in canopy.json',
    );
  }

  if (value.type === 'skill') {
    assertOnlyKeys(value, ['type', 'source', 'skill_name'], context);
    if (!isRecord(value.source)) {
      throw new Error(`${context}: source must be an object`);
    }
    const skillName =
      typeof value.skill_name === 'string' ? value.skill_name.trim() : '';
    if (!skillName) {
      throw new Error(`${context}: skill_name must be a non-empty string`);
    }
    if (value.source.type === 'builtin') {
      assertOnlyKeys(value.source, ['type', 'id'], `${context}: source`);
      if (typeof value.source.id !== 'string' || !value.source.id.trim()) {
        throw new Error(
          `${context}: builtin source id must be a non-empty string`,
        );
      }
      return {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: skillName,
      };
    }
    assertOnlyKeys(value.source, ['type', 'repo'], `${context}: source`);
    if (
      value.source.type !== 'github' ||
      typeof value.source.repo !== 'string'
    ) {
      throw new Error(`${context}: source must be builtin or github`);
    }
    return {
      type: 'skill',
      source: {
        type: 'github',
        repo: normalizeGitHubRepoRef(value.source.repo),
      },
      skill_name: skillName,
    };
  }

  if (value.type === 'plugin' || value.type === 'claude_plugin') {
    assertOnlyKeys(value, ['type', 'marketplace', 'plugin_name'], context);
    if (!isRecord(value.marketplace)) {
      throw new Error(`${context}: marketplace must be an object`);
    }
    const pluginName =
      typeof value.plugin_name === 'string' ? value.plugin_name.trim() : '';
    if (!pluginName) {
      throw new Error(`${context}: plugin_name must be a non-empty string`);
    }
    if (value.marketplace.type === 'builtin') {
      assertOnlyKeys(
        value.marketplace,
        ['type', 'id'],
        `${context}: marketplace`,
      );
      if (
        typeof value.marketplace.id !== 'string' ||
        !value.marketplace.id.trim()
      ) {
        throw new Error(
          `${context}: builtin marketplace id must be a non-empty string`,
        );
      }
      return {
        type: value.type,
        marketplace: { type: 'builtin', id: 'app' },
        plugin_name: pluginName,
      };
    }
    assertOnlyKeys(
      value.marketplace,
      ['type', 'repo'],
      `${context}: marketplace`,
    );
    if (
      value.marketplace.type !== 'github' ||
      typeof value.marketplace.repo !== 'string'
    ) {
      throw new Error(`${context}: marketplace must be builtin or github`);
    }
    return {
      type: value.type,
      marketplace: {
        type: 'github',
        repo: normalizeGitHubRepoRef(value.marketplace.repo),
      },
      plugin_name: pluginName,
    };
  }

  if (value.type === 'codex_plugin') {
    assertOnlyKeys(value, ['type', 'marketplace', 'plugin_name'], context);
    if (!isRecord(value.marketplace)) {
      throw new Error(`${context}: marketplace must be an object`);
    }
    const pluginName =
      typeof value.plugin_name === 'string' ? value.plugin_name.trim() : '';
    if (!pluginName) {
      throw new Error(`${context}: plugin_name must be a non-empty string`);
    }
    assertOnlyKeys(
      value.marketplace,
      ['type', 'id'],
      `${context}: marketplace`,
    );
    if (
      value.marketplace.type !== 'codex-builtin' ||
      typeof value.marketplace.id !== 'string' ||
      !value.marketplace.id.trim()
    ) {
      throw new Error(
        `${context}: marketplace must be codex-builtin for codex_plugin refs`,
      );
    }
    return {
      type: 'codex_plugin',
      marketplace: {
        type: 'codex-builtin',
        id: value.marketplace.id.trim(),
      },
      plugin_name: pluginName,
    };
  }

  throw new Error(
    `${context}: plugin type must be "skill", "plugin", "claude_plugin", or "codex_plugin"`,
  );
}

function assertOnlyKeys(
  value: JsonRecord,
  allowedKeys: readonly string[],
  context: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${context}: unexpected field "${key}"`);
    }
  }
}

function compareScriptEntries(
  left: [string, unknown],
  right: [string, unknown],
): number {
  return left[0].localeCompare(right[0]);
}

function compareHookEntries(
  left: [HookTriggerName, unknown],
  right: [HookTriggerName, unknown],
): number {
  return compareTriggerNames(left[0], right[0]);
}
