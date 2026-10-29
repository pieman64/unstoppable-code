import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCanopyDataDir } from '../../canopy-paths';
import type { ChatTabPluginSelections } from '../../types';
import type {
  PipelineModelAliasPreference,
  PipelinePluginCollectionPreference,
  PipelinePreferenceLocator,
} from '../../types/pipeline';
import { serializePipelinePreferenceLocator } from '../../pipelines/plugin-collections';

interface PipelinePreferenceEntry {
  plugin_collections?: Record<string, PipelinePluginCollectionPreference>;
  model_aliases?: Record<string, PipelineModelAliasPreference>;
}

interface PipelinePreferencesFile {
  version: 2;
  entries: Record<string, PipelinePreferenceEntry>;
}

const EMPTY_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
  mcpHttpAuthPreferences: [],
};

function warn(message: string): void {
  process.stderr.write(`[pipeline-plugin-preferences] ${message}\n`);
}

function getPipelinePluginPreferencesFilePath(): string {
  return path.join(getCanopyDataDir(), 'pipeline-plugin-preferences.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function normalizeCollectionIds(value: unknown): string[] {
  return normalizeStringArray(value);
}

function normalizeSkillRefs(
  value: unknown,
): ChatTabPluginSelections['skillRefs'] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: ChatTabPluginSelections['skillRefs'] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const sourceId =
      typeof entry.sourceId === 'string' ? entry.sourceId.trim() : '';
    const skillName =
      typeof entry.skillName === 'string' ? entry.skillName.trim() : '';
    if (!sourceId || !skillName) {
      continue;
    }
    const key = `${sourceId}\0${skillName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ sourceId, skillName });
  }
  return result;
}

function normalizePluginRefs(
  value: unknown,
): ChatTabPluginSelections['pluginRefs'] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: ChatTabPluginSelections['pluginRefs'] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const marketplaceId =
      typeof entry.marketplaceId === 'string' ? entry.marketplaceId.trim() : '';
    const pluginName =
      typeof entry.pluginName === 'string' ? entry.pluginName.trim() : '';
    if (!marketplaceId || !pluginName) {
      continue;
    }
    const key = `${marketplaceId}\0${pluginName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ marketplaceId, pluginName });
  }
  return result;
}

function normalizeMcpServerRefs(): ChatTabPluginSelections['mcpServerRefs'] {
  return [];
}

function normalizeExtraSelections(value: unknown): ChatTabPluginSelections {
  if (!isRecord(value)) {
    return { ...EMPTY_SELECTIONS };
  }

  // Migrate legacy `bundleIds` into the canonical `collectionIds` field on
  // every read so older persisted preference files round-trip cleanly.
  const collectionIds = normalizeCollectionIds(value.collectionIds);
  const legacyBundleIds = normalizeCollectionIds(value.bundleIds);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of [...collectionIds, ...legacyBundleIds]) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return {
    collectionIds: merged,
    skillRefs: normalizeSkillRefs(value.skillRefs),
    pluginRefs: normalizePluginRefs(value.pluginRefs),
    mcpServerRefs: normalizeMcpServerRefs(),
    mcpHttpAuthPreferences: [],
  };
}

function normalizePipelinePluginCollectionPreference(
  raw: unknown,
): PipelinePluginCollectionPreference {
  const source = isRecord(raw) ? raw : {};
  return {
    disabledDefaultKeys: normalizeStringArray(source.disabledDefaultKeys),
    extraSelections: normalizeExtraSelections(source.extraSelections),
  };
}

export function normalizePipelinePluginCollectionPreferences(
  raw: unknown,
): Record<string, PipelinePluginCollectionPreference> {
  if (!isRecord(raw)) {
    return {};
  }

  const result: Record<string, PipelinePluginCollectionPreference> = {};
  for (const [collectionId, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      warn(
        `Dropping invalid preference entry for collection "${collectionId}".`,
      );
      continue;
    }
    const trimmedCollectionId = collectionId.trim();
    if (!trimmedCollectionId) {
      continue;
    }
    result[trimmedCollectionId] =
      normalizePipelinePluginCollectionPreference(entry);
  }
  return result;
}

function normalizePipelineModelAliasPreference(
  raw: unknown,
): PipelineModelAliasPreference | undefined {
  if (!isRecord(raw) || typeof raw.mode !== 'string') {
    return undefined;
  }

  if (raw.mode === 'reset') {
    return undefined;
  }

  if (raw.mode === 'agent') {
    const agentId = typeof raw.agent_id === 'string' ? raw.agent_id.trim() : '';
    if (!agentId || !agentId.startsWith('agent_model_')) {
      return undefined;
    }
    return { mode: 'agent', agent_id: agentId };
  }

  if (raw.mode === 'inline') {
    const base = typeof raw.base === 'string' ? raw.base.trim() : '';
    if (!base) {
      return undefined;
    }
    if (
      raw.instructions !== undefined &&
      typeof raw.instructions !== 'string'
    ) {
      return undefined;
    }
    const pluginCollectionId =
      raw.plugin_collection_id === undefined
        ? undefined
        : typeof raw.plugin_collection_id === 'string'
          ? raw.plugin_collection_id.trim()
          : '';
    if (raw.plugin_collection_id !== undefined && !pluginCollectionId) {
      return undefined;
    }
    return {
      mode: 'inline',
      base,
      ...(raw.instructions !== undefined
        ? { instructions: raw.instructions }
        : {}),
      ...(pluginCollectionId
        ? { plugin_collection_id: pluginCollectionId }
        : {}),
    };
  }

  return undefined;
}

export function normalizePipelineModelAliasPreferences(
  preferences: unknown,
): Record<string, PipelineModelAliasPreference> {
  if (!isRecord(preferences)) {
    return {};
  }

  const result: Record<string, PipelineModelAliasPreference> = {};
  for (const [aliasId, entry] of Object.entries(preferences)) {
    const trimmedAliasId = aliasId.trim();
    if (!trimmedAliasId) {
      continue;
    }
    const normalized = normalizePipelineModelAliasPreference(entry);
    if (!normalized) {
      if (isRecord(entry) && entry.mode !== 'reset') {
        warn(`Dropping invalid model alias preference for "${aliasId}".`);
      }
      continue;
    }
    result[trimmedAliasId] = normalized;
  }
  return result;
}

function normalizePreferenceEntry(raw: unknown): PipelinePreferenceEntry {
  if (!isRecord(raw)) {
    return {};
  }
  return {
    plugin_collections: normalizePipelinePluginCollectionPreferences(
      raw.plugin_collections,
    ),
    model_aliases: normalizePipelineModelAliasPreferences(raw.model_aliases),
  };
}

function omitEmptyEntry(
  entry: PipelinePreferenceEntry,
): PipelinePreferenceEntry {
  const result: PipelinePreferenceEntry = {};
  if (
    entry.plugin_collections &&
    Object.keys(entry.plugin_collections).length > 0
  ) {
    result.plugin_collections = entry.plugin_collections;
  }
  if (entry.model_aliases && Object.keys(entry.model_aliases).length > 0) {
    result.model_aliases = entry.model_aliases;
  }
  return result;
}

function readPreferencesFile(): PipelinePreferencesFile {
  const filePath = getPipelinePluginPreferencesFilePath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code !== 'ENOENT') {
      warn('Failed to parse preference file; using empty defaults.');
    }
    return { version: 2, entries: {} };
  }

  if (!isRecord(parsed) || !isRecord(parsed.entries)) {
    warn('Unsupported preference file version or shape; using empty defaults.');
    return { version: 2, entries: {} };
  }

  const entries: Record<string, PipelinePreferenceEntry> = {};
  if (parsed.version === 1) {
    for (const [locatorKey, rawPreferences] of Object.entries(parsed.entries)) {
      entries[locatorKey] = {
        plugin_collections:
          normalizePipelinePluginCollectionPreferences(rawPreferences),
      };
    }
    return { version: 2, entries };
  }

  if (parsed.version !== 2) {
    warn('Unsupported preference file version or shape; using empty defaults.');
    return { version: 2, entries: {} };
  }

  for (const [locatorKey, rawEntry] of Object.entries(parsed.entries)) {
    entries[locatorKey] = normalizePreferenceEntry(rawEntry);
  }

  return { version: 2, entries };
}

function writePreferencesFile(file: PipelinePreferencesFile): void {
  const filePath = getPipelinePluginPreferencesFilePath();
  const normalizedEntries: PipelinePreferencesFile['entries'] = {};
  for (const [locatorKey, entry] of Object.entries(file.entries)) {
    const normalized = omitEmptyEntry(normalizePreferenceEntry(entry));
    if (Object.keys(normalized).length > 0) {
      normalizedEntries[locatorKey] = normalized;
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ version: 2, entries: normalizedEntries }, null, 2)}\n`,
    'utf8',
  );
}

function getLegacyStoredPreferenceKey(
  locator: PipelinePreferenceLocator,
): string | undefined {
  if (locator.type !== 'stored') {
    return undefined;
  }
  return `stored:${locator.value}`;
}

function entryWithLegacyFallback(
  file: PipelinePreferencesFile,
  locatorKey: string,
  legacyKey: string | undefined,
): PipelinePreferenceEntry {
  if (!legacyKey || legacyKey === locatorKey) {
    return file.entries[locatorKey] ?? {};
  }
  return {
    ...file.entries[legacyKey],
    ...file.entries[locatorKey],
  };
}

export function loadPipelinePluginCollectionPreferences(
  locator: PipelinePreferenceLocator,
): Record<string, PipelinePluginCollectionPreference> {
  const file = readPreferencesFile();
  const locatorKey = serializePipelinePreferenceLocator(locator);
  const stored = file.entries[locatorKey];
  if (stored) {
    return stored.plugin_collections ?? {};
  }

  const legacyKey = getLegacyStoredPreferenceKey(locator);
  if (legacyKey) {
    return file.entries[legacyKey]?.plugin_collections ?? {};
  }

  return {};
}

export function savePipelinePluginCollectionPreferences(
  locator: PipelinePreferenceLocator,
  preferences: Record<string, PipelinePluginCollectionPreference>,
): void {
  const file = readPreferencesFile();
  const locatorKey = serializePipelinePreferenceLocator(locator);
  const legacyKey = getLegacyStoredPreferenceKey(locator);
  file.entries[locatorKey] = {
    ...entryWithLegacyFallback(file, locatorKey, legacyKey),
    plugin_collections:
      normalizePipelinePluginCollectionPreferences(preferences),
  };
  if (legacyKey && legacyKey !== locatorKey) {
    delete file.entries[legacyKey];
  }
  writePreferencesFile(file);
}

export function deletePipelinePluginCollectionPreferences(
  locator: PipelinePreferenceLocator,
): void {
  const file = readPreferencesFile();
  const locatorKey = serializePipelinePreferenceLocator(locator);
  if (file.entries[locatorKey]) {
    delete file.entries[locatorKey].plugin_collections;
  }
  const legacyKey = getLegacyStoredPreferenceKey(locator);
  if (legacyKey && legacyKey !== locatorKey) {
    if (file.entries[legacyKey]) {
      delete file.entries[legacyKey].plugin_collections;
    }
  }
  writePreferencesFile(file);
}

export function loadPipelineModelAliasPreferences(
  locator: PipelinePreferenceLocator,
): Record<string, PipelineModelAliasPreference> {
  const file = readPreferencesFile();
  const locatorKey = serializePipelinePreferenceLocator(locator);
  const stored = file.entries[locatorKey];
  if (stored) {
    return stored.model_aliases ?? {};
  }

  const legacyKey = getLegacyStoredPreferenceKey(locator);
  if (legacyKey) {
    return file.entries[legacyKey]?.model_aliases ?? {};
  }

  return {};
}

export function savePipelineModelAliasPreferences(
  locator: PipelinePreferenceLocator,
  preferences: Record<string, PipelineModelAliasPreference>,
): void {
  const file = readPreferencesFile();
  const locatorKey = serializePipelinePreferenceLocator(locator);
  const legacyKey = getLegacyStoredPreferenceKey(locator);
  file.entries[locatorKey] = {
    ...entryWithLegacyFallback(file, locatorKey, legacyKey),
    model_aliases: normalizePipelineModelAliasPreferences(preferences),
  };
  if (legacyKey && legacyKey !== locatorKey) {
    delete file.entries[legacyKey];
  }
  writePreferencesFile(file);
}

export function deletePipelineModelAliasPreferences(
  locator: PipelinePreferenceLocator,
): void {
  const file = readPreferencesFile();
  const locatorKey = serializePipelinePreferenceLocator(locator);
  if (file.entries[locatorKey]) {
    delete file.entries[locatorKey].model_aliases;
  }
  const legacyKey = getLegacyStoredPreferenceKey(locator);
  if (legacyKey && legacyKey !== locatorKey && file.entries[legacyKey]) {
    delete file.entries[legacyKey].model_aliases;
  }
  writePreferencesFile(file);
}
