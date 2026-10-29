// ---------------------------------------------------------------------------
// Pipeline dependency manifest wire contracts (CAN-1314).
//
// A pipeline may declare the capabilities it depends on — plugins, skills,
// MCP servers, connectors, local runtimes, and local packages — so install
// surfaces can show a readiness menu before the first run and the executor
// can degrade gracefully when optional dependencies are absent.
//
// These shapes are the single source of truth for every surface that
// serializes dependencies across the desktop/web boundary (pipeline YAML,
// shared-pipeline payloads, pinned public-share snapshots). Structural
// normalization lives here so web and desktop parse identically; pipeline-
// context validation (step references, duplicate ids, projection from
// `plugin_collections`) lives in `@canopy/desktop-shared`.
//
// The manifest must never carry credentials or machine-specific private
// values: the schema has no credential fields and free-text fields are
// rejected when they contain secret-like content.
//
// This module must remain pure: no Node, Electron, React, Prisma, Next.js,
// or app imports. It runs in the renderer, the main process, and the web app.
// ---------------------------------------------------------------------------

import {
  normalizeShareablePluginRef,
  type ShareablePluginRef,
  type ShareableSkillRef,
} from '../plugins';

export const PIPELINE_DEPENDENCY_KINDS = [
  'plugin',
  'skill',
  'mcp',
  'connector',
  'local_runtime',
  'local_package',
] as const;

export type PipelineDependencyKind = (typeof PIPELINE_DEPENDENCY_KINDS)[number];

/**
 * Declared behavior when a dependency is missing, denied, or unhealthy.
 *
 * - `block` — affected steps cannot run (default for required dependencies).
 * - `skip` — affected steps are skipped (default for optional dependencies).
 * - `reduced` — affected steps are skipped and the run is labeled
 *   reduced-capability.
 * - `queue` — reserved: declared on the wire but not yet executable.
 * - `alternative` — a compatible alternative from `alternatives` can satisfy
 *   the dependency.
 */
export const PIPELINE_DEPENDENCY_FALLBACKS = [
  'block',
  'skip',
  'reduced',
  'queue',
  'alternative',
] as const;

export type PipelineDependencyFallback =
  (typeof PIPELINE_DEPENDENCY_FALLBACKS)[number];

export const PIPELINE_DEPENDENCY_HEALTH_CHECKS = [
  'none',
  'installed',
  'connection',
] as const;

export type PipelineDependencyHealthCheck =
  (typeof PIPELINE_DEPENDENCY_HEALTH_CHECKS)[number];

/**
 * Live readiness of a dependency on the local machine. `installed` and
 * `connected` are the satisfied states; everything else needs attention.
 */
export const PIPELINE_DEPENDENCY_STATUSES = [
  'installed',
  'connected',
  'not_installed',
  'needs_authorization',
  'update_required',
  'blocked_by_policy',
  'unavailable',
  'incompatible',
] as const;

export type PipelineDependencyStatus =
  (typeof PIPELINE_DEPENDENCY_STATUSES)[number];

export function isPipelineDependencyStatusSatisfied(
  status: PipelineDependencyStatus,
): boolean {
  return status === 'installed' || status === 'connected';
}

export const PIPELINE_DEPENDENCY_ACTIONS = [
  'install',
  'connect',
  'authorize',
  'update',
  'choose_alternative',
] as const;

export type PipelineDependencyAction =
  (typeof PIPELINE_DEPENDENCY_ACTIONS)[number];

/**
 * How a missing dependency can be prepared.
 *
 * - `guided` — the app can install it after explicit user approval.
 * - `instructions` — the app only shows the declared manual instructions;
 *   nothing is executed on the user's behalf.
 */
export interface PipelineDependencyInstall {
  mode: 'guided' | 'instructions';
  instructions?: string;
}

interface PipelineDependencyBase {
  /** Stable manifest-unique id, referenced by `alternatives`. */
  id: string;
  required: boolean;
  /** Human-readable capability this dependency enables. */
  capability?: string;
  /**
   * Step ids affected when the dependency is missing. Omitted means the
   * dependency affects the whole pipeline unless desktop normalization merges
   * a matching plugin-collection default with non-empty inferred step reach.
   */
  steps?: string[];
  /** Supported version range (free-form range expression, e.g. ">=2.40"). */
  version?: string;
  fallback: PipelineDependencyFallback;
  config_deferrable?: boolean;
  health_check?: PipelineDependencyHealthCheck;
  /** Data-access boundary shown to the user; never credentials. */
  privacy?: string;
  /** Sibling dependency ids that can satisfy the same capability. */
  alternatives?: string[];
  install?: PipelineDependencyInstall;
}

export interface PipelineSkillDependency extends PipelineDependencyBase {
  kind: 'skill';
  ref: ShareableSkillRef;
}

export interface PipelinePluginDependency extends PipelineDependencyBase {
  kind: 'plugin';
  ref: Exclude<ShareablePluginRef, ShareableSkillRef>;
}

export interface PipelineMcpDependency extends PipelineDependencyBase {
  kind: 'mcp';
  /**
   * Portable MCP target. Raw serverId/configId refs are machine-local and
   * must never appear in a manifest; the curated-catalog id is the portable
   * identity importers resolve locally.
   */
  server: { catalog_id: string };
}

export interface PipelineConnectorDependency extends PipelineDependencyBase {
  kind: 'connector';
  /** Connector identity, e.g. `github`. */
  connector: string;
}

export interface PipelineLocalRuntimeDependency extends PipelineDependencyBase {
  kind: 'local_runtime';
  /** Runtime identity, e.g. `ollama`. */
  runtime: string;
}

export interface PipelineLocalPackageDependency extends PipelineDependencyBase {
  kind: 'local_package';
  package: {
    /** Executable probed on PATH, e.g. `gh`. */
    probe: string;
    /** Flag that prints the version, e.g. `--version`. */
    version_flag?: string;
  };
}

export type PipelineDependency =
  | PipelineSkillDependency
  | PipelinePluginDependency
  | PipelineMcpDependency
  | PipelineConnectorDependency
  | PipelineLocalRuntimeDependency
  | PipelineLocalPackageDependency;

/**
 * Raw manifest input variant of a dependency: `required` and `fallback` may
 * be omitted, in which case normalization applies the documented defaults
 * (`required: false`; `fallback: block` for required entries, `skip`
 * otherwise). `Pipeline.dependencies` uses this shape; every normalized
 * surface uses the strict {@link PipelineDependency}.
 */
type AsDependencyInput<T extends PipelineDependency> = Omit<
  T,
  'required' | 'fallback'
> & {
  required?: boolean;
  fallback?: PipelineDependencyFallback;
};

export type PipelineDependencyInput =
  | AsDependencyInput<PipelineSkillDependency>
  | AsDependencyInput<PipelinePluginDependency>
  | AsDependencyInput<PipelineMcpDependency>
  | AsDependencyInput<PipelineConnectorDependency>
  | AsDependencyInput<PipelineLocalRuntimeDependency>
  | AsDependencyInput<PipelineLocalPackageDependency>;

// ---------------------------------------------------------------------------
// Structural normalization. Throws on invalid input with `${context} ...`
// messages so desktop normalization and web pinned-snapshot parsing report
// identical errors.
// ---------------------------------------------------------------------------

const SECRET_LIKE_PATTERNS: readonly RegExp[] = [
  /\bcsk_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[0-9A-Za-z_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|credentials?)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+]{8,}/i,
];

/**
 * Return `true` when free-form text looks like it embeds a credential.
 * Deliberately pattern-based and conservative: manifests describe
 * capabilities and instructions, never secret values.
 */
export function containsSecretLikeContent(text: string): boolean {
  return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${context} unexpected field "${key}"`);
    }
  }
}

function readRequiredString(
  value: unknown,
  context: string,
  field: string,
): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new Error(`${context} ${field} must be a non-empty string`);
  }
  return text;
}

function readOptionalText(
  value: unknown,
  context: string,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredString(value, context, field);
}

/**
 * Recursively reject secret-like content in EVERY string of a raw manifest
 * entry — ids, kind targets, nested refs, and free text alike — before any
 * field-specific normalization runs. This is the no-credentials contract's
 * single enforcement point; per-field readers do not re-check.
 *
 * Exported so consumers that assemble dependency rows from other declared
 * sources (e.g. `plugin_collections` defaults projected into dependency
 * rows) enforce the same contract on those inputs.
 */
const MAX_SECRET_SCAN_DEPTH = 32;

export function assertNoSecretLikeContent(
  value: unknown,
  context: string,
  path: readonly string[] = [],
): void {
  // YAML aliases can produce shared or cyclic references in parsed input;
  // the visited set and depth cap bound the traversal so an untrusted
  // manifest cannot stack-overflow or wedge normalization.
  const visited = new WeakSet<object>();
  const visit = (
    entry: unknown,
    entryPath: readonly string[],
    depth: number,
  ): void => {
    if (typeof entry === 'string') {
      if (containsSecretLikeContent(entry)) {
        const label = entryPath.length > 0 ? `${entryPath.join(' ')} ` : '';
        throw new Error(
          `${context} ${label}must not contain secret-like content`,
        );
      }
      return;
    }
    if (Array.isArray(entry)) {
      if (visited.has(entry)) {
        return;
      }
      visited.add(entry);
      if (depth >= MAX_SECRET_SCAN_DEPTH) {
        throw new Error(`${context} is nested too deeply to validate`);
      }
      for (const element of entry) {
        visit(element, entryPath, depth + 1);
      }
      return;
    }
    if (isRecord(entry)) {
      if (visited.has(entry)) {
        return;
      }
      visited.add(entry);
      if (depth >= MAX_SECRET_SCAN_DEPTH) {
        throw new Error(`${context} is nested too deeply to validate`);
      }
      for (const [key, nested] of Object.entries(entry)) {
        visit(nested, [...entryPath, key], depth + 1);
      }
    }
  };
  visit(value, path, 0);
}

function readOptionalBoolean(
  value: unknown,
  context: string,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${context} ${field} must be a boolean`);
  }
  return value;
}

const VERSION_RANGE_PATTERN = /^[0-9A-Za-z .,<>=^~*|x+-]+$/;

function readVersionRange(value: unknown, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const range = readRequiredString(value, context, 'version');
  if (!VERSION_RANGE_PATTERN.test(range)) {
    throw new Error(
      `${context} version "${range}" must be a version range expression`,
    );
  }
  return range;
}

function readStringList(
  value: unknown,
  context: string,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} ${field} must be a non-empty array of strings`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const text = readRequiredString(entry, context, `${field}[${index}]`);
    if (seen.has(text)) {
      throw new Error(`${context} ${field} contains duplicate "${text}"`);
    }
    seen.add(text);
    return text;
  });
}

function readInstall(
  value: unknown,
  context: string,
): PipelineDependencyInstall | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${context} install must be an object`);
  }
  assertOnlyKeys(value, ['mode', 'instructions'], `${context} install`);
  if (value.mode !== 'guided' && value.mode !== 'instructions') {
    throw new Error(
      `${context} install mode must be "guided" or "instructions"`,
    );
  }
  const instructions = readOptionalText(
    value.instructions,
    context,
    'install instructions',
  );
  if (value.mode === 'instructions' && !instructions) {
    throw new Error(
      `${context} install mode "instructions" requires install instructions`,
    );
  }
  return {
    mode: value.mode,
    ...(instructions !== undefined ? { instructions } : {}),
  };
}

function readEnumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
  field: string,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(
      `${context} ${field} must be one of: ${allowed.join(', ')}`,
    );
  }
  return match;
}

/**
 * Reject unknown keys in a raw shareable-ref object and its nested
 * source/marketplace before delegating to `normalizeShareablePluginRef`
 * (which builds a clean object but tolerates extra input fields). Manifest
 * refs must not smuggle credential-named fields through raw-YAML
 * persistence. Unknown `type` discriminators are left for the ref
 * normalizer's own error.
 */
function assertShareableRefOnlyKeys(
  ref: Record<string, unknown>,
  context: string,
): void {
  if (ref.type === 'skill') {
    assertOnlyKeys(ref, ['type', 'source', 'skill_name'], `${context} ref`);
    if (isRecord(ref.source)) {
      assertOnlyKeys(
        ref.source,
        ref.source.type === 'github' ? ['type', 'repo'] : ['type', 'id'],
        `${context} ref source`,
      );
    }
    return;
  }
  if (
    ref.type === 'plugin' ||
    ref.type === 'claude_plugin' ||
    ref.type === 'codex_plugin'
  ) {
    assertOnlyKeys(
      ref,
      ['type', 'marketplace', 'plugin_name'],
      `${context} ref`,
    );
    if (isRecord(ref.marketplace)) {
      assertOnlyKeys(
        ref.marketplace,
        ref.marketplace.type === 'github' ? ['type', 'repo'] : ['type', 'id'],
        `${context} ref marketplace`,
      );
    }
  }
}

const BASE_KEYS = [
  'id',
  'kind',
  'required',
  'capability',
  'steps',
  'version',
  'fallback',
  'config_deferrable',
  'health_check',
  'privacy',
  'alternatives',
  'install',
] as const;

interface ReadDependencyBaseResult {
  base: PipelineDependencyBase;
  record: Record<string, unknown>;
}

function readDependencyBase(
  value: unknown,
  context: string,
): ReadDependencyBaseResult {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }

  const id = readRequiredString(value.id, context, 'id');
  const required = readOptionalBoolean(value.required, context, 'required');
  const fallback = readEnumField(
    value.fallback,
    PIPELINE_DEPENDENCY_FALLBACKS,
    context,
    'fallback',
  );
  const alternatives = readStringList(
    value.alternatives,
    context,
    'alternatives',
  );
  if (fallback === 'alternative' && !alternatives) {
    throw new Error(
      `${context} fallback "alternative" requires a non-empty alternatives list`,
    );
  }

  const capability = readOptionalText(value.capability, context, 'capability');
  const steps = readStringList(value.steps, context, 'steps');
  const version = readVersionRange(value.version, context);
  const configDeferrable = readOptionalBoolean(
    value.config_deferrable,
    context,
    'config_deferrable',
  );
  const healthCheck = readEnumField(
    value.health_check,
    PIPELINE_DEPENDENCY_HEALTH_CHECKS,
    context,
    'health_check',
  );
  const privacy = readOptionalText(value.privacy, context, 'privacy');
  const install = readInstall(value.install, context);

  const base: PipelineDependencyBase = {
    id,
    required: required ?? false,
    fallback: fallback ?? (required ? 'block' : 'skip'),
    ...(capability !== undefined ? { capability } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(configDeferrable !== undefined
      ? { config_deferrable: configDeferrable }
      : {}),
    ...(healthCheck !== undefined ? { health_check: healthCheck } : {}),
    ...(privacy !== undefined ? { privacy } : {}),
    ...(alternatives !== undefined ? { alternatives } : {}),
    ...(install !== undefined ? { install } : {}),
  };
  return { base, record: value };
}

/**
 * Structurally normalize one manifest entry. Throws on invalid input.
 *
 * Pipeline-context rules (duplicate ids across the manifest, `steps`
 * referencing real step ids, `alternatives` referencing sibling ids,
 * unsupported-at-runtime fallbacks) are the caller's responsibility.
 */
export function normalizePipelineDependency(
  value: unknown,
  context: string,
): PipelineDependency {
  assertNoSecretLikeContent(value, context, []);
  const { base, record } = readDependencyBase(value, context);

  if (record.kind === 'skill' || record.kind === 'plugin') {
    assertOnlyKeys(record, [...BASE_KEYS, 'ref'], context);
    if (!isRecord(record.ref)) {
      throw new Error(`${context} ref must be a shareable plugin ref object`);
    }
    assertShareableRefOnlyKeys(record.ref, context);
    let ref: ShareablePluginRef;
    try {
      ref = normalizeShareablePluginRef(record.ref);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${context} ref is invalid: ${message}`);
    }
    if (record.kind === 'skill') {
      if (ref.type !== 'skill') {
        throw new Error(
          `${context} kind "skill" requires a ref of type "skill", got "${ref.type}"`,
        );
      }
      return { ...base, kind: 'skill', ref };
    }
    if (ref.type === 'skill') {
      throw new Error(
        `${context} kind "plugin" requires a plugin ref, got a skill ref`,
      );
    }
    return { ...base, kind: 'plugin', ref };
  }

  if (record.kind === 'mcp') {
    assertOnlyKeys(record, [...BASE_KEYS, 'server'], context);
    if (!isRecord(record.server)) {
      throw new Error(`${context} server must be an object`);
    }
    assertOnlyKeys(record.server, ['catalog_id'], `${context} server`);
    const catalogId = readRequiredString(
      record.server.catalog_id,
      context,
      'server catalog_id',
    );
    return { ...base, kind: 'mcp', server: { catalog_id: catalogId } };
  }

  if (record.kind === 'connector') {
    assertOnlyKeys(record, [...BASE_KEYS, 'connector'], context);
    const connector = readRequiredString(
      record.connector,
      context,
      'connector',
    );
    return { ...base, kind: 'connector', connector };
  }

  if (record.kind === 'local_runtime') {
    assertOnlyKeys(record, [...BASE_KEYS, 'runtime'], context);
    const runtime = readRequiredString(record.runtime, context, 'runtime');
    return { ...base, kind: 'local_runtime', runtime };
  }

  if (record.kind === 'local_package') {
    assertOnlyKeys(record, [...BASE_KEYS, 'package'], context);
    if (!isRecord(record.package)) {
      throw new Error(`${context} package must be an object`);
    }
    assertOnlyKeys(
      record.package,
      ['probe', 'version_flag'],
      `${context} package`,
    );
    const probe = readRequiredString(
      record.package.probe,
      context,
      'package probe',
    );
    if (/[\s/\\]/.test(probe)) {
      throw new Error(
        `${context} package probe must be a bare executable name`,
      );
    }
    const versionFlag =
      record.package.version_flag === undefined
        ? undefined
        : readRequiredString(
            record.package.version_flag,
            context,
            'package version_flag',
          );
    return {
      ...base,
      kind: 'local_package',
      package: {
        probe,
        ...(versionFlag !== undefined ? { version_flag: versionFlag } : {}),
      },
    };
  }

  throw new Error(
    `${context} kind must be one of: ${PIPELINE_DEPENDENCY_KINDS.join(', ')}`,
  );
}
