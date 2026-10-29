import {
  listBuiltinActions,
  readBuiltinActionRawManifest,
  resolveAction,
} from '../pipelines/action-resolver';

/**
 * Read-only access to the bundled builtin pipeline action manifests for the
 * pipeline-editor assistant. Both the system-prompt action catalog and the
 * `GetBuiltinActionDefinition` tool read from the brand-prepared bundled
 * resources (`getBundledActionsDir()`), so any `{{BRAND_*}}` placeholders are
 * already substituted by the brand-prepare/action build step before they reach
 * here.
 */

export interface BuiltinActionSummary {
  /** The `builtin/<name>` identifier segment (the action directory name). */
  name: string;
  /** Manifest `description`, branding already resolved. */
  description: string;
}

export interface BuiltinActionDefinitionResult {
  found: boolean;
  /** Normalized action name (no `builtin/` prefix) when found. */
  name?: string;
  /** The `use:` reference the step should specify, e.g. `builtin/agent-prompt`. */
  uses?: string;
  description?: string;
  /** Raw, branding-resolved `action.yml` text when found. */
  yaml?: string;
  error?: string;
  /** Available builtin action names, included on a not-found error to help recovery. */
  availableActions?: string[];
}

/** Strip an optional `builtin/` scope prefix and surrounding whitespace. */
export function normalizeBuiltinActionName(rawName: string): string {
  return rawName
    .trim()
    .replace(/^builtin\//i, '')
    .trim();
}

/**
 * List every bundled builtin action with its (branding-resolved) description,
 * sorted by name. Used to populate the assistant's system-prompt catalog.
 */
export function listBuiltinActionSummaries(): BuiltinActionSummary[] {
  return listBuiltinActions().map((name) => {
    const definition = resolveAction(`builtin/${name}`);
    return { name, description: definition?.description?.trim() ?? '' };
  });
}

/**
 * Resolve the raw `action.yml` for a bundled builtin action by name (with or
 * without the `builtin/` prefix). Returns a structured not-found result — with
 * the available action names — rather than throwing, so the tool layer can
 * surface a recoverable error to the model.
 */
export function getBuiltinActionDefinition(
  rawName: string,
): BuiltinActionDefinitionResult {
  const name = normalizeBuiltinActionName(rawName);
  if (!name) {
    return {
      found: false,
      error:
        'Provide a builtin action name, e.g. "agent-prompt" or "builtin/agent-prompt".',
    };
  }

  const available = listBuiltinActions();
  if (!available.includes(name)) {
    return {
      found: false,
      error: `No bundled builtin action named "${name}".`,
      availableActions: available,
    };
  }

  const yaml = readBuiltinActionRawManifest(name);
  if (yaml === null) {
    return {
      found: false,
      error: `Could not read the definition for builtin action "${name}".`,
      availableActions: available,
    };
  }

  const definition = resolveAction(`builtin/${name}`);
  return {
    found: true,
    name,
    uses: `builtin/${name}`,
    description: definition?.description?.trim() ?? '',
    yaml,
  };
}
