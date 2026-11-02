import type {
  NormalizedPipelineAssetDeclaration,
  PipelineAssetInstallMode,
} from './document';

/** Asset ids are short, lower-case and safe as an env-var suffix. */
export const PIPELINE_ASSET_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export const PIPELINE_ASSET_INSTALL_MODES: readonly PipelineAssetInstallMode[] =
  ['seed', 'replace'];

/** One problem with a pipeline's `assets` or `local_state` declaration. */
export interface PipelineAssetIssue {
  /** Editor-style path, for example `assets[1].id`. */
  path: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInstallMode(value: unknown): value is PipelineAssetInstallMode {
  return PIPELINE_ASSET_INSTALL_MODES.some((mode) => mode === value);
}

/**
 * Validate the raw `assets` and `local_state` values of a parsed pipeline.
 * Returns every problem found; an empty list means both are well-formed.
 */
export function validatePipelineAssetDeclarations(pipeline: {
  assets?: unknown;
  local_state?: unknown;
}): PipelineAssetIssue[] {
  const issues: PipelineAssetIssue[] = [];
  const { assets, local_state: localState } = pipeline;
  if (assets !== undefined) {
    if (!Array.isArray(assets)) {
      issues.push({
        path: 'assets',
        message: 'Pipeline assets must be a list of asset declarations',
      });
    } else {
      const seen = new Set<string>();
      assets.forEach((entry: unknown, index) => {
        const entryPath = `assets[${index}]`;
        if (!isRecord(entry)) {
          issues.push({
            path: entryPath,
            message:
              'Each pipeline asset must be an object with an id and path',
          });
          return;
        }
        const { id } = entry;
        if (typeof id !== 'string' || !PIPELINE_ASSET_ID_PATTERN.test(id)) {
          issues.push({
            path: `${entryPath}.id`,
            message:
              typeof id === 'string'
                ? `Invalid asset id "${id}": start with a lower-case letter and use at most 32 lower-case letters, numbers or underscores`
                : 'Pipeline asset id is required',
          });
        } else if (seen.has(id)) {
          issues.push({
            path: `${entryPath}.id`,
            message: `Duplicate asset id "${id}"`,
          });
        } else {
          seen.add(id);
        }
        if (typeof entry.path !== 'string' || entry.path.trim() === '') {
          issues.push({
            path: `${entryPath}.path`,
            message: 'Pipeline asset path is required',
          });
        }
        if (
          entry.description !== undefined &&
          typeof entry.description !== 'string'
        ) {
          issues.push({
            path: `${entryPath}.description`,
            message: 'Pipeline asset description must be text',
          });
        }
        if (
          entry.required !== undefined &&
          typeof entry.required !== 'boolean'
        ) {
          issues.push({
            path: `${entryPath}.required`,
            message: 'Pipeline asset required must be true or false',
          });
        }
        if (entry.install !== undefined && !isInstallMode(entry.install)) {
          issues.push({
            path: `${entryPath}.install`,
            message: 'Pipeline asset install must be seed or replace',
          });
        }
      });
    }
  }
  if (localState !== undefined) {
    if (!Array.isArray(localState)) {
      issues.push({
        path: 'local_state',
        message: 'Pipeline local_state must be a list of paths',
      });
    } else {
      localState.forEach((entry: unknown, index) => {
        if (typeof entry !== 'string' || entry.trim() === '') {
          issues.push({
            path: `local_state[${index}]`,
            message: 'Each pipeline local_state entry must be a path',
          });
        }
      });
    }
  }
  return issues;
}

/**
 * Normalize `assets`, applying `required: true` and `install: 'seed'`.
 * Throws with the first problem when the declaration is malformed.
 */
export function normalizePipelineAssets(
  assets: unknown,
): NormalizedPipelineAssetDeclaration[] | undefined {
  if (assets === undefined) return undefined;
  const [issue] = validatePipelineAssetDeclarations({ assets });
  if (issue) throw new Error(issue.message);
  if (!Array.isArray(assets)) return undefined;
  return assets.filter(isRecord).map((entry) => ({
    id: String(entry.id),
    path: String(entry.path),
    ...(typeof entry.description === 'string'
      ? { description: entry.description }
      : {}),
    required: typeof entry.required === 'boolean' ? entry.required : true,
    install: isInstallMode(entry.install) ? entry.install : 'seed',
  }));
}

/** Normalize `local_state`; throws when an entry is not a path. */
export function normalizePipelineLocalState(
  localState: unknown,
): string[] | undefined {
  if (localState === undefined) return undefined;
  const [issue] = validatePipelineAssetDeclarations({
    local_state: localState,
  });
  if (issue) throw new Error(issue.message);
  return Array.isArray(localState)
    ? localState.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

const EXPRESSION_PATTERN = /\$\{\{([\s\S]*?)\}\}/g;
// `assets.<id>` as an expression root, not a property of another root such as
// `steps.assets` or `env.assets`.
const ASSET_REFERENCE_PATTERN = /(?<![\w.$])assets\.([A-Za-z0-9_-]+)/g;

/** Asset ids read through `${{ assets.<id>... }}` anywhere in a value tree. */
export function findPipelineAssetReferences(value: unknown): string[] {
  const ids = new Set<string>();
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      const expressions = new RegExp(EXPRESSION_PATTERN.source, 'g');
      let expression = expressions.exec(node);
      while (expression) {
        const references = new RegExp(ASSET_REFERENCE_PATTERN.source, 'g');
        let reference = references.exec(expression[1] ?? '');
        while (reference) {
          if (reference[1]) ids.add(reference[1]);
          reference = references.exec(expression[1] ?? '');
        }
        expression = expressions.exec(node);
      }
      return;
    }
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      visit(child);
    }
  };
  visit(value);
  return Array.from(ids);
}

/** Ids of the well-formed `assets` entries a pipeline declares. */
export function declaredPipelineAssetIds(assets: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(assets)) return ids;
  for (const entry of assets) {
    if (isRecord(entry) && typeof entry.id === 'string') ids.add(entry.id);
  }
  return ids;
}
