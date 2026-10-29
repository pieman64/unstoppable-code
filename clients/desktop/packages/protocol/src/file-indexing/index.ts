/**
 * Built-in file-index glob definitions shared by:
 *
 * - **backend** preference normalization (validates persisted disabled-id
 *   sets against `BUILTIN_INDEX_GLOB_IDS`),
 * - **backend** matcher construction (turns enabled built-ins + user-defined
 *   custom globs into a single ignore matcher), and
 * - **frontend** settings UI (renders one toggle per built-in by id/label).
 *
 * Centralizing the records guarantees all three sides agree on ids, labels,
 * and patterns. Ids are stable kebab-case strings so that a user's
 * disabled-set persists across label or pattern tweaks.
 *
 * Note: We deliberately do NOT default-exclude generic `build` or `dist`.
 * Those directories often contain generated files that users intentionally
 * want to find. Add them as a custom glob if needed.
 */

/** Exclusions for the file index, not the explorer tree or explorer search. */
export interface FileIndexingPreferences {
  disabledBuiltinGlobIds: string[];
  customGlobs: FileIndexingCustomGlob[];
}

export interface FileIndexingCustomGlob {
  id: string;
  pattern: string;
  enabled: boolean;
}

export interface BuiltinIndexGlob {
  /** Stable identifier — never change once shipped. */
  id: string;
  /** Human-readable label used by the settings UI. */
  label: string;
  /** Glob pattern (POSIX style, anchored by `**`). */
  pattern: string;
}

export const BUILTIN_INDEX_GLOBS: readonly BuiltinIndexGlob[] = [
  {
    id: 'node-modules',
    label: 'Node dependencies',
    pattern: '**/node_modules/**',
  },
  {
    id: 'bower-components',
    label: 'Bower components',
    pattern: '**/bower_components/**',
  },
  {
    id: 'pnpm-store',
    label: 'pnpm store',
    pattern: '**/.pnpm-store/**',
  },
  {
    id: 'yarn-cache',
    label: 'Yarn cache',
    pattern: '**/.yarn/cache/**',
  },
  {
    id: 'yarn-unplugged',
    label: 'Yarn unplugged',
    pattern: '**/.yarn/unplugged/**',
  },
  {
    id: 'python-venv',
    label: 'Python virtualenvs',
    pattern: '**/{.venv,venv,env}/**',
  },
  {
    id: 'python-caches',
    label: 'Python caches',
    pattern: '**/{__pycache__,.pytest_cache,.mypy_cache,.ruff_cache}/**',
  },
  {
    id: 'tox',
    label: 'tox envs',
    pattern: '**/.tox/**',
  },
  {
    id: 'nox',
    label: 'nox envs',
    pattern: '**/.nox/**',
  },
  {
    id: 'ruby-vendor-bundle',
    label: 'Ruby vendor/bundle',
    pattern: '**/vendor/bundle/**',
  },
  {
    id: 'gradle',
    label: 'Gradle cache',
    pattern: '**/.gradle/**',
  },
  {
    id: 'jvm-target',
    label: 'JVM target output',
    pattern: '**/target/**',
  },
] as const;

/**
 * Set of every valid built-in glob id, used by preference normalization to
 * drop unknown entries from a persisted disabled-id list.
 */
export const BUILTIN_INDEX_GLOB_IDS: ReadonlySet<string> = new Set(
  BUILTIN_INDEX_GLOBS.map((g) => g.id),
);

/**
 * Look up a built-in by id. Returns `undefined` if no built-in matches —
 * useful when surfacing migrations or settings UI errors for unknown ids.
 */
export function getBuiltinIndexGlob(id: string): BuiltinIndexGlob | undefined {
  return BUILTIN_INDEX_GLOBS.find((g) => g.id === id);
}

export function createDefaultFileIndexingPreferences(): FileIndexingPreferences {
  return { disabledBuiltinGlobIds: [], customGlobs: [] };
}
