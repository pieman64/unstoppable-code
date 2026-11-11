// ---------------------------------------------------------------------------
// Shared helpers for user-configured environment variables.
//
// Consumed by:
//   - the renderer's top-level Environments page, workspace Environment tabs,
//     and shared variable editors (load/save, bulk<->key-value conversion,
//     validation),
//   - the main-process environment-config IPC handler (normalization on
//     read/write),
//   - pipelines/config-paths.ts where `getEnhancedEnv()` merges the user
//     values into the env handed to every spawned subprocess.
//
// Functions are pure and have no Node/Electron/React dependencies.
// ---------------------------------------------------------------------------

import type {
  DefaultEnvironmentKind,
  EnvironmentConfigData,
  EnvironmentDefinition,
  EnvironmentRuntime,
  EnvironmentRuntimeAssignments,
  EnvironmentUsage,
  EnvironmentValue,
  ResolveEnvironmentRequest,
  ResolvedEnvironment,
  UserEnvironmentData,
  UserEnvironmentEntry,
  UserEnvironmentUiMode,
  WorkspaceEnvironmentAssignment,
} from '@canopy/execution-engine/types/user-environment';
import { BRAND } from '@canopy/brand/current';

const VALID_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Stable ids the backend uses for the four protected default environments:
 * a single root (`overall`) and one child per runtime slot. The renderer
 * relies on these to identify default rows for the protected-name/protected-
 * delete guards; the backend seeds environments with these exact ids on
 * first run so saved {@link WorkspaceEnvironmentAssignment.runtimes} entries
 * survive across upgrades.
 *
 * The seed shape these constants drive:
 *  - `Overall`:   `parentId: null`,              `defaultKind: 'overall'`
 *  - `Canopy`:    `parentId: 'default-overall'`, `defaultKind: 'canopy'`
 *  - `Agents`:    `parentId: 'default-overall'`, `defaultKind: 'agent'`
 *  - `Pipelines`: `parentId: 'default-overall'`, `defaultKind: 'pipeline'`
 *
 * Seed `globalRuntimes` use these ids too:
 *  - `canopy:   'default-canopy'`
 *  - `agent:    'default-agent'`
 *  - `pipeline: 'default-pipeline'`
 */
export const DEFAULT_ENVIRONMENT_IDS = {
  overall: 'default-overall',
  canopy: 'default-canopy',
  agent: 'default-agent',
  pipeline: 'default-pipeline',
} as const;

export const DEFAULT_ENVIRONMENT_KIND_ORDER: readonly DefaultEnvironmentKind[] =
  ['overall', 'canopy', 'agent', 'pipeline'];

/**
 * Set of seeded default-environment ids, indexed by id for `has()` checks.
 * Exposed as a `ReadonlySet<string>` so renderer guards can ask
 * `DEFAULT_ENVIRONMENT_ID_SET.has(id)` without depending on the literal
 * union shape.
 */
export const DEFAULT_ENVIRONMENT_ID_SET: ReadonlySet<string> = new Set(
  Object.values(DEFAULT_ENVIRONMENT_IDS),
);

/**
 * Returns the seeded default environment id for a runtime slot. Used by the
 * backend to fall back to the seed when a saved global assignment points at
 * a stale id, and by the renderer to render runtime defaults.
 */
export function getDefaultEnvironmentIdForRuntime(
  runtime: EnvironmentRuntime,
): string {
  return DEFAULT_ENVIRONMENT_IDS[runtime];
}

/**
 * Returns the seeded default environment id for a default-environment
 * "kind" classifier. Symmetrical helper to
 * {@link getDefaultEnvironmentIdForRuntime} so the four protected defaults
 * can be looked up by either coordinate.
 */
export function getDefaultEnvironmentIdForKind(
  kind: DefaultEnvironmentKind,
): string {
  return DEFAULT_ENVIRONMENT_IDS[kind];
}

export function getEnvironmentSortOrder(
  environment: Pick<
    EnvironmentDefinition,
    'defaultKind' | 'id' | 'isDefault' | 'name'
  >,
): number {
  if (!environment.isDefault) {
    return Number.POSITIVE_INFINITY;
  }

  if (environment.defaultKind) {
    return (
      DEFAULT_ENVIRONMENT_KIND_SORT_INDEX.get(environment.defaultKind) ??
      Number.POSITIVE_INFINITY
    );
  }

  const matchingKind = DEFAULT_ENVIRONMENT_KIND_ORDER.find(
    (kind) => DEFAULT_ENVIRONMENT_IDS[kind] === environment.id,
  );
  return matchingKind
    ? (DEFAULT_ENVIRONMENT_KIND_SORT_INDEX.get(matchingKind) ??
        Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;
}

export function compareEnvironmentDefinitions<V extends EnvironmentValue>(
  a: EnvironmentDefinition<V>,
  b: EnvironmentDefinition<V>,
): number {
  const aOrder = getEnvironmentSortOrder(a);
  const bOrder = getEnvironmentSortOrder(b);
  if (aOrder !== bOrder) {
    return aOrder < bOrder ? -1 : 1;
  }

  if (a.isDefault !== b.isDefault) {
    return a.isDefault ? -1 : 1;
  }

  const nameDelta = a.name.localeCompare(b.name);
  return nameDelta !== 0 ? nameDelta : a.id.localeCompare(b.id);
}

/**
 * Environment variables that the user cannot override through this UI. PATH is
 * recomputed by `getEnhancedEnv()` to prepend Canopy's bundled bin directory,
 * so any user-supplied PATH would be silently lost — surface that as a hard
 * skip instead of letting users think it took effect.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['PATH']);

export const DEFAULT_USER_ENVIRONMENT: UserEnvironmentData = {
  uiMode: 'key-value',
  variables: [],
};

const DEFAULT_ENVIRONMENT_NAMES: Record<DefaultEnvironmentKind, string> = {
  overall: 'Overall',
  canopy: BRAND.shortName,
  agent: 'Agents',
  pipeline: 'Workflows',
};

const DEFAULT_ENVIRONMENT_PARENTS: Record<
  DefaultEnvironmentKind,
  string | null
> = {
  overall: null,
  canopy: DEFAULT_ENVIRONMENT_IDS.overall,
  agent: DEFAULT_ENVIRONMENT_IDS.overall,
  pipeline: DEFAULT_ENVIRONMENT_IDS.overall,
};

const RUNTIMES: EnvironmentRuntime[] = ['canopy', 'agent', 'pipeline'];
const DEFAULT_ENVIRONMENT_KIND_SORT_INDEX = new Map<
  DefaultEnvironmentKind,
  number
>(DEFAULT_ENVIRONMENT_KIND_ORDER.map((kind, index) => [kind, index]));

const DEFAULT_GLOBAL_RUNTIMES: EnvironmentRuntimeAssignments = {
  canopy: DEFAULT_ENVIRONMENT_IDS.canopy,
  agent: DEFAULT_ENVIRONMENT_IDS.agent,
  pipeline: DEFAULT_ENVIRONMENT_IDS.pipeline,
};

const ASSIGNED_ENVIRONMENT_DELETE_MESSAGE =
  'Assigned environments cannot be deleted. Remove its runtime assignments first.';
const PARENT_ENVIRONMENT_DELETE_MESSAGE =
  'Parent environments cannot be deleted while another environment inherits from them.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUiMode(value: unknown): value is UserEnvironmentUiMode {
  return value === 'key-value' || value === 'bulk';
}

/** True if `key` is a syntactically valid env var name (POSIX-ish). */
export function isValidUserEnvironmentKey(key: string): boolean {
  return VALID_KEY_PATTERN.test(key);
}

/** True if `key` is reserved and must not be applied to spawned subprocesses. */
export function isReservedUserEnvironmentKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse a bulk `KEY=VALUE` text block into structured entries.
 *
 * - Blank lines and lines starting with `#` (after optional whitespace) are
 *   ignored.
 * - Leading `export ` is stripped so users can paste shell-style snippets.
 * - Values may be wrapped in matching single or double quotes; quotes are
 *   removed and inner content is taken verbatim (no escape sequence handling).
 * - Lines without `=` or with an invalid key are dropped (no exceptions).
 *
 * Duplicate keys: last occurrence wins.
 */
export function parseBulkEnvironment(text: string): UserEnvironmentEntry[] {
  const lines = text.split(/\r?\n/);
  const byKey = new Map<string, string>();

  for (const rawLine of lines) {
    let line = rawLine.trimStart();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trimStart();
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (!isValidUserEnvironmentKey(key)) {
      continue;
    }

    const value = stripSurroundingQuotes(line.slice(equalsIndex + 1));
    byKey.set(key, value);
  }

  const entries: UserEnvironmentEntry[] = [];
  byKey.forEach((value, key) => {
    entries.push({ key, value });
  });
  return entries;
}

/** Serialize structured entries back to a bulk `KEY=VALUE` text block. */
export function serializeBulkEnvironment(
  entries: ReadonlyArray<UserEnvironmentEntry>,
): string {
  return entries.map((entry) => `${entry.key}=${entry.value}`).join('\n');
}

/**
 * Normalize structured entries: trim keys, drop invalid/empty/reserved keys,
 * and collapse duplicates with last-occurrence-wins semantics. Empty values
 * are preserved (users may want to clear a variable that exists in the parent
 * environment).
 */
export function normalizeUserEnvironmentEntries(
  entries: ReadonlyArray<{ key: unknown; value: unknown; secret?: unknown }>,
): UserEnvironmentEntry[] {
  const byKey = new Map<string, UserEnvironmentEntry>();
  for (const entry of entries) {
    if (typeof entry.key !== 'string') {
      continue;
    }
    const key = entry.key.trim();
    if (!isValidUserEnvironmentKey(key) || isReservedUserEnvironmentKey(key)) {
      continue;
    }
    const value = typeof entry.value === 'string' ? entry.value : '';
    byKey.set(key, {
      key,
      value,
      ...(entry.secret === true ? { secret: true } : {}),
    });
  }

  const result: UserEnvironmentEntry[] = [];
  byKey.forEach((entry) => {
    result.push(entry);
  });
  return result;
}

/**
 * Normalize an unknown shape (parsed JSON from disk, or partial input from an
 * IPC caller) into a valid `UserEnvironmentData` object. Invalid fields fall
 * back to defaults; this function never throws.
 */
export function normalizeUserEnvironment(value: unknown): UserEnvironmentData {
  if (!isRecord(value)) {
    return {
      uiMode: DEFAULT_USER_ENVIRONMENT.uiMode,
      variables: [],
    };
  }

  const uiMode = isUiMode(value.uiMode)
    ? value.uiMode
    : DEFAULT_USER_ENVIRONMENT.uiMode;

  const rawVariables = Array.isArray(value.variables) ? value.variables : [];
  const variables = normalizeUserEnvironmentEntries(
    rawVariables.filter(isRecord).map((entry) => ({
      key: entry.key,
      value: entry.value,
      secret: entry.secret,
    })),
  );

  return { uiMode, variables };
}

/**
 * Project the user's variables into a plain `Record<string, string>` ready to
 * be merged into `process.env`. Reserved keys (e.g. PATH) are dropped so they
 * cannot silently break Canopy's bundled-bin PATH handling.
 */
export function toAppliedUserEnvironment<V extends EnvironmentValue>(
  entries: ReadonlyArray<UserEnvironmentEntry<V>>,
): Record<string, V> {
  const applied: Record<string, V> = {};
  for (const entry of entries) {
    if (isReservedUserEnvironmentKey(entry.key)) {
      continue;
    }
    applied[entry.key] = entry.value;
  }
  return applied;
}

export function splitAppliedUserEnvironment<V extends EnvironmentValue>(
  entries: ReadonlyArray<UserEnvironmentEntry<V>>,
): {
  publicApplied: Record<string, V>;
  secretApplied: Record<string, V>;
} {
  const publicApplied: Record<string, V> = {};
  const secretApplied: Record<string, V> = {};
  for (const entry of entries) {
    if (isReservedUserEnvironmentKey(entry.key)) {
      continue;
    }
    if (entry.secret === true) {
      secretApplied[entry.key] = entry.value;
    } else {
      publicApplied[entry.key] = entry.value;
    }
  }
  return { publicApplied, secretApplied };
}

function createDefaultEnvironment(
  kind: DefaultEnvironmentKind,
  now: string,
  overrides?: Partial<EnvironmentDefinition>,
): EnvironmentDefinition {
  return {
    id: DEFAULT_ENVIRONMENT_IDS[kind],
    name: DEFAULT_ENVIRONMENT_NAMES[kind],
    parentId: DEFAULT_ENVIRONMENT_PARENTS[kind],
    isDefault: true,
    defaultKind: kind,
    uiMode: overrides?.uiMode ?? 'key-value',
    variables: overrides?.variables ?? [],
    createdAt: overrides?.createdAt ?? now,
    updatedAt: overrides?.updatedAt ?? now,
  };
}

export function createDefaultEnvironmentConfig(
  now: string,
): EnvironmentConfigData {
  return {
    version: 2,
    environments: [
      createDefaultEnvironment('overall', now),
      createDefaultEnvironment('canopy', now),
      createDefaultEnvironment('agent', now),
      createDefaultEnvironment('pipeline', now),
    ],
    globalRuntimes: { ...DEFAULT_GLOBAL_RUNTIMES },
    workspaceAssignments: [],
  };
}

function normalizeEnvironmentDefinition(
  value: unknown,
  now: string,
): EnvironmentDefinition | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) {
    return null;
  }

  const defaultKind = isDefaultEnvironmentKind(value.defaultKind)
    ? value.defaultKind
    : undefined;
  const uiMode = isUiMode(value.uiMode) ? value.uiMode : 'key-value';
  const rawVariables = Array.isArray(value.variables) ? value.variables : [];

  return {
    id,
    name:
      typeof value.name === 'string' && value.name.trim().length > 0
        ? value.name.trim()
        : id,
    parentId: typeof value.parentId === 'string' ? value.parentId : null,
    isDefault: value.isDefault === true || defaultKind !== undefined,
    defaultKind,
    uiMode,
    variables: normalizeUserEnvironmentEntries(
      rawVariables.filter(isRecord).map((entry) => ({
        key: entry.key,
        value: entry.value,
        secret: entry.secret,
      })),
    ),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
  };
}

function isDefaultEnvironmentKind(
  value: unknown,
): value is DefaultEnvironmentKind {
  return (
    value === 'overall' ||
    value === 'canopy' ||
    value === 'agent' ||
    value === 'pipeline'
  );
}

function normalizeRuntimeAssignments(
  value: unknown,
  validIds: ReadonlySet<string>,
  fallbackDefaults: boolean,
): EnvironmentRuntimeAssignments {
  const input = isRecord(value) ? value : {};
  const result: EnvironmentRuntimeAssignments = {
    canopy: null,
    agent: null,
    pipeline: null,
  };

  for (const runtime of RUNTIMES) {
    const candidate = input[runtime];
    if (typeof candidate === 'string' && validIds.has(candidate)) {
      result[runtime] = candidate;
    } else if (fallbackDefaults) {
      result[runtime] = getDefaultEnvironmentIdForRuntime(runtime);
    }
  }

  return result;
}

function normalizeWorkspaceAssignments(
  value: unknown,
  validIds: ReadonlySet<string>,
  now: string,
): WorkspaceEnvironmentAssignment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byWorkspaceId = new Map<string, WorkspaceEnvironmentAssignment>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.workspaceId !== 'string') {
      continue;
    }
    const workspaceId = item.workspaceId;
    if (!workspaceId.trim()) {
      continue;
    }

    const runtimes = normalizeRuntimeAssignments(
      item.runtimes,
      validIds,
      false,
    );
    const filtered: Partial<EnvironmentRuntimeAssignments> = {};
    for (const runtime of RUNTIMES) {
      if (runtimes[runtime]) {
        filtered[runtime] = runtimes[runtime];
      }
    }
    if (Object.keys(filtered).length === 0) {
      continue;
    }

    byWorkspaceId.set(workspaceId, {
      workspaceId,
      runtimes: filtered,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
    });
  }

  return Array.from(byWorkspaceId.values());
}

function findCycleEnvironmentIds<V extends EnvironmentValue>(
  environments: ReadonlyArray<EnvironmentDefinition<V>>,
): Set<string> {
  const byId = new Map(
    environments.map((environment) => [environment.id, environment]),
  );
  const cyclic = new Set<string>();

  for (const environment of environments) {
    const seen = new Set<string>();
    let current: EnvironmentDefinition<V> | undefined = environment;
    while (current?.parentId) {
      if (seen.has(current.id)) {
        for (const id of Array.from(seen)) {
          cyclic.add(id);
        }
        cyclic.add(current.id);
        break;
      }
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
  }

  return cyclic;
}

export function ensureDefaultEnvironments(
  data: EnvironmentConfigData,
  now: string,
): EnvironmentConfigData {
  const byId = new Map(
    data.environments.map((environment) => [environment.id, environment]),
  );
  const defaults = (['overall', 'canopy', 'agent', 'pipeline'] as const).map(
    (kind) => {
      const existing = byId.get(DEFAULT_ENVIRONMENT_IDS[kind]);
      return createDefaultEnvironment(kind, now, {
        uiMode: existing?.uiMode,
        variables: existing?.variables,
        createdAt: existing?.createdAt,
        updatedAt: existing?.updatedAt,
      });
    },
  );

  const defaultIds = new Set(defaults.map((environment) => environment.id));
  return {
    ...data,
    environments: [
      ...defaults,
      ...data.environments.filter(
        (environment) => !defaultIds.has(environment.id),
      ),
    ],
  };
}

export function normalizeEnvironmentConfig(
  value: unknown,
  now: string,
): EnvironmentConfigData {
  if (!isRecord(value)) {
    return createDefaultEnvironmentConfig(now);
  }

  const rawEnvironments = Array.isArray(value.environments)
    ? value.environments
    : [];
  const environmentsById = new Map<string, EnvironmentDefinition>();
  for (const rawEnvironment of rawEnvironments) {
    const normalized = normalizeEnvironmentDefinition(rawEnvironment, now);
    if (normalized) {
      environmentsById.set(normalized.id, normalized);
    }
  }

  let data: EnvironmentConfigData = {
    version: 2,
    environments: Array.from(environmentsById.values()),
    globalRuntimes: {
      canopy: null,
      agent: null,
      pipeline: null,
    },
    workspaceAssignments: [],
  };
  data = ensureDefaultEnvironments(data, now);

  data.environments = data.environments.map((environment) =>
    DEFAULT_ENVIRONMENT_ID_SET.has(environment.id)
      ? environment
      : { ...environment, isDefault: false, defaultKind: undefined },
  );

  const validIds = new Set(
    data.environments.map((environment) => environment.id),
  );
  data.environments = data.environments.map((environment) => ({
    ...environment,
    parentId:
      environment.parentId && validIds.has(environment.parentId)
        ? environment.parentId
        : null,
  }));

  const cyclicIds = findCycleEnvironmentIds(data.environments);
  if (cyclicIds.size > 0) {
    data.environments = data.environments.map((environment) =>
      cyclicIds.has(environment.id)
        ? { ...environment, parentId: null }
        : environment,
    );
  }
  data = ensureDefaultEnvironments(data, now);

  data.globalRuntimes = normalizeRuntimeAssignments(
    value.globalRuntimes,
    new Set(data.environments.map((environment) => environment.id)),
    true,
  );
  data.workspaceAssignments = normalizeWorkspaceAssignments(
    value.workspaceAssignments,
    new Set(data.environments.map((environment) => environment.id)),
    now,
  );

  return data;
}

export function resolveEnvironmentVariables<V extends EnvironmentValue>(
  config: EnvironmentConfigData<V>,
  environmentId: string | null | undefined,
): ResolvedEnvironment<V> {
  const byId = new Map(
    config.environments.map((environment) => [environment.id, environment]),
  );
  const leaf = environmentId ? byId.get(environmentId) : undefined;
  if (!leaf) {
    return {
      environmentId: null,
      environmentName: null,
      variables: [],
      applied: {},
      publicApplied: {},
      secretApplied: {},
      inheritedEnvironmentIds: [],
    };
  }

  const chain: EnvironmentDefinition<V>[] = [];
  const seen = new Set<string>();
  let current: EnvironmentDefinition<V> | undefined = leaf;
  while (current && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  const byKey = new Map<string, UserEnvironmentEntry<V>>();
  for (const environment of [...chain].reverse()) {
    for (const entry of environment.variables) {
      byKey.set(entry.key, entry);
    }
  }
  const { publicApplied, secretApplied } = splitAppliedUserEnvironment(
    Array.from(byKey.values()),
  );
  const applied = { ...publicApplied, ...secretApplied };

  return {
    environmentId: leaf.id,
    environmentName: leaf.name,
    variables: leaf.variables,
    publicApplied,
    secretApplied,
    applied,
    inheritedEnvironmentIds: chain
      .slice(1)
      .map((environment) => environment.id),
  };
}

export function resolveEnvironmentForRuntime<V extends EnvironmentValue>(
  config: EnvironmentConfigData<V>,
  request: ResolveEnvironmentRequest,
): ResolvedEnvironment<V> {
  const workspaceAssignment = request.workspaceId
    ? config.workspaceAssignments.find(
        (assignment) => assignment.workspaceId === request.workspaceId,
      )
    : undefined;
  const environmentId =
    workspaceAssignment?.runtimes[request.runtime] ??
    config.globalRuntimes[request.runtime];
  return resolveEnvironmentVariables(config, environmentId);
}

/** Secret entries the runtime applies, with the environment that supplies each. */
export function resolveEnvironmentSecretSlots(
  config: EnvironmentConfigData,
  request: ResolveEnvironmentRequest,
): Array<{ key: string; environmentId: string }> {
  const resolved = resolveEnvironmentForRuntime(config, request);
  const environmentId = resolved.environmentId;
  const appliedKeys = new Set(Object.keys(resolved.secretApplied));
  const byId = new Map(
    config.environments.map((environment) => [environment.id, environment]),
  );
  const chain: EnvironmentDefinition[] = [];
  const seen = new Set<string>();
  let environment = environmentId ? byId.get(environmentId) : undefined;
  while (environment && !seen.has(environment.id)) {
    chain.push(environment);
    seen.add(environment.id);
    environment = environment.parentId
      ? byId.get(environment.parentId)
      : undefined;
  }
  const byKey = new Map<
    string,
    { key: string; environmentId: string; secret: boolean }
  >();
  for (const item of chain.reverse()) {
    for (const entry of item.variables) {
      if (!isReservedUserEnvironmentKey(entry.key))
        byKey.set(entry.key, {
          key: entry.key,
          environmentId: item.id,
          secret: entry.secret === true,
        });
    }
  }
  return Array.from(byKey.values()).flatMap((entry) =>
    entry.secret && appliedKeys.has(entry.key)
      ? [{ key: entry.key, environmentId: entry.environmentId }]
      : [],
  );
}

export function validateEnvironmentConfig<V extends EnvironmentValue>(
  config: EnvironmentConfigData<V>,
): { ok: true } | { ok: false; message: string } {
  if (!isRecord(config) || config.version !== 2) {
    return { ok: false, message: 'Invalid environment config version.' };
  }

  const ids = new Set<string>();
  for (const environment of config.environments) {
    if (!environment.id || ids.has(environment.id)) {
      return { ok: false, message: 'Environment ids must be unique.' };
    }
    if (
      !DEFAULT_ENVIRONMENT_ID_SET.has(environment.id) &&
      (environment.isDefault === true || environment.defaultKind !== undefined)
    ) {
      return {
        ok: false,
        message: 'Only seeded default environments can be marked as default.',
      };
    }
    ids.add(environment.id);
    for (const entry of environment.variables) {
      const key = entry.key.trim();
      if (!isValidUserEnvironmentKey(key)) {
        return {
          ok: false,
          message: `Invalid environment variable key: ${entry.key}`,
        };
      }
      if (isReservedUserEnvironmentKey(key)) {
        return {
          ok: false,
          message: `${key} cannot be configured as an environment variable.`,
        };
      }
    }
  }

  for (const kind of ['overall', 'canopy', 'agent', 'pipeline'] as const) {
    const environment = config.environments.find(
      (candidate) => candidate.id === DEFAULT_ENVIRONMENT_IDS[kind],
    );
    if (
      !environment ||
      environment.isDefault !== true ||
      environment.defaultKind !== kind
    ) {
      return {
        ok: false,
        message: `${DEFAULT_ENVIRONMENT_NAMES[kind]} is protected and cannot be removed or repurposed.`,
      };
    }
    if (environment.parentId !== DEFAULT_ENVIRONMENT_PARENTS[kind]) {
      return {
        ok: false,
        message: `${DEFAULT_ENVIRONMENT_NAMES[kind]} has a protected parent assignment.`,
      };
    }
  }

  for (const environment of config.environments) {
    if (environment.parentId && !ids.has(environment.parentId)) {
      return {
        ok: false,
        message: `${environment.name} has an unknown parent environment.`,
      };
    }
  }

  if (findCycleEnvironmentIds(config.environments).size > 0) {
    return {
      ok: false,
      message: 'Environment inheritance cannot contain a cycle.',
    };
  }

  for (const runtime of RUNTIMES) {
    const environmentId = config.globalRuntimes[runtime];
    if (!environmentId || !ids.has(environmentId)) {
      return {
        ok: false,
        message: `Global ${runtime} runtime must reference an existing environment.`,
      };
    }
  }

  for (const assignment of config.workspaceAssignments) {
    for (const runtime of RUNTIMES) {
      const environmentId = assignment.runtimes[runtime];
      if (
        environmentId !== undefined &&
        environmentId !== null &&
        !ids.has(environmentId)
      ) {
        return {
          ok: false,
          message: `Workspace ${assignment.workspaceId} ${runtime} runtime references an unknown environment.`,
        };
      }
    }
  }

  return { ok: true };
}

function isEnvironmentAssigned<V extends EnvironmentValue>(
  config: EnvironmentConfigData<V>,
  environmentId: string,
): boolean {
  for (const runtime of RUNTIMES) {
    if (config.globalRuntimes[runtime] === environmentId) {
      return true;
    }
  }

  for (const assignment of config.workspaceAssignments) {
    for (const runtime of RUNTIMES) {
      if (assignment.runtimes[runtime] === environmentId) {
        return true;
      }
    }
  }

  return false;
}

function isEnvironmentParent<V extends EnvironmentValue>(
  config: EnvironmentConfigData<V>,
  environmentId: string,
): boolean {
  return config.environments.some(
    (environment) => environment.parentId === environmentId,
  );
}

export function validateEnvironmentConfigUpdate<
  P extends EnvironmentValue,
  N extends EnvironmentValue,
>(
  previous: EnvironmentConfigData<P>,
  next: EnvironmentConfigData<N>,
): { ok: true } | { ok: false; message: string } {
  const nextIds = new Set(
    next.environments.map((environment) => environment.id),
  );
  for (const environment of previous.environments) {
    if (nextIds.has(environment.id)) {
      continue;
    }
    if (DEFAULT_ENVIRONMENT_ID_SET.has(environment.id)) {
      continue;
    }

    if (isEnvironmentAssigned(next, environment.id)) {
      return { ok: false, message: ASSIGNED_ENVIRONMENT_DELETE_MESSAGE };
    }

    if (isEnvironmentParent(next, environment.id)) {
      return { ok: false, message: PARENT_ENVIRONMENT_DELETE_MESSAGE };
    }
  }

  const nextValidation = validateEnvironmentConfig(next);
  if (!nextValidation.ok) {
    return nextValidation;
  }

  return { ok: true };
}

export function getEnvironmentUsage<V extends EnvironmentValue>(
  config: EnvironmentConfigData<V>,
  workspaces: ReadonlyArray<{
    id?: string;
    workspaceId?: string;
    name?: string;
  }> = [],
): EnvironmentUsage[] {
  const workspaceNames = new Map<string, string>();
  for (const workspace of workspaces) {
    const id = workspace.workspaceId ?? workspace.id;
    if (id && workspace.name) {
      workspaceNames.set(id, workspace.name);
    }
  }

  const usage: EnvironmentUsage[] = [];
  for (const runtime of RUNTIMES) {
    const environmentId = config.globalRuntimes[runtime];
    if (environmentId) {
      usage.push({ environmentId, kind: 'global-runtime', runtime });
    }
  }
  for (const assignment of config.workspaceAssignments) {
    for (const runtime of RUNTIMES) {
      const environmentId = assignment.runtimes[runtime];
      if (environmentId) {
        usage.push({
          environmentId,
          kind: 'workspace-runtime',
          runtime,
          workspaceId: assignment.workspaceId,
          workspaceName: workspaceNames.get(assignment.workspaceId),
        });
      }
    }
  }
  for (const environment of config.environments) {
    if (environment.parentId) {
      usage.push({
        environmentId: environment.parentId,
        kind: 'parent',
        childEnvironmentId: environment.id,
      });
    }
  }
  return usage;
}
