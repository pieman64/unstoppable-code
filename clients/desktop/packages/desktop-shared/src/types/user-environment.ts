import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import type {
  SecretValueInput,
  StoredSecretErrorCode,
} from '@canopy/execution-engine/types/stored-secrets';

/**
 * A variable value. Main holds plaintext (`string`); replies to the renderer
 * carry a {@link import('@canopy/execution-engine/types/stored-secrets').StoredSecretValue} in place of
 * every non-empty value marked secret, and saves accept either form.
 */
export type EnvironmentValue = SecretValueInput;

/**
 * Which editor the renderer presents by default for user-configured
 * environment variables. Both modes operate on the same persisted list of
 * `variables`; the mode only controls which UI is mounted first.
 */
export type UserEnvironmentUiMode = 'key-value' | 'bulk';

/**
 * Discriminates the three runtimes that can receive an environment
 * assignment. The renderer surfaces a separate slot for each runtime; the
 * backend resolves an effective environment per runtime at spawn time.
 */
export type EnvironmentRuntime = 'canopy' | 'agent' | 'pipeline';

/**
 * Classifies one of the four protected default environments. The `'overall'`
 * kind is the root default that the three runtime-scoped defaults inherit
 * from. These kinds are preserved verbatim by the backend and must not be
 * stripped or repurposed by a save payload.
 */
export type DefaultEnvironmentKind =
  | 'overall'
  | 'canopy'
  | 'agent'
  | 'pipeline';

/** A single user-configured environment variable. */
export interface UserEnvironmentEntry<V extends EnvironmentValue = string> {
  key: string;
  value: V;
  /**
   * When true, pipeline runtime resolution exposes this variable through
   * spawn-only secretEnv instead of persisted execution env. Other runtimes
   * still receive the variable as a normal process environment value.
   */
  secret?: boolean;
}

/**
 * A user-configurable environment. Environments form a tree: each has at
 * most one parent and inherits its parent's variables, with the child's own
 * variables overriding inherited ones at runtime resolution.
 *
 * `isDefault` marks the four protected seed environments
 * (see {@link DEFAULT_ENVIRONMENT_IDS}). Protected defaults may have their
 * `variables` and `uiMode` edited but their `id`, `name`, `parentId`,
 * `isDefault`, and `defaultKind` are kept at the canonical seed values.
 */
export interface EnvironmentDefinition<V extends EnvironmentValue = string> {
  id: string;
  name: string;
  parentId: string | null;
  isDefault: boolean;
  defaultKind?: DefaultEnvironmentKind;
  uiMode: UserEnvironmentUiMode;
  variables: UserEnvironmentEntry<V>[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-runtime environment id triple. Each slot points to the environment id
 * the runtime should resolve to, or `null` when no environment is assigned
 * for that runtime. The backend's resolver follows parent chains starting
 * from this id.
 */
export interface EnvironmentRuntimeAssignments {
  canopy: string | null;
  agent: string | null;
  pipeline: string | null;
}

/**
 * Override assignment for a specific workspace. The `workspaceId` is whatever
 * single identifier the renderer surfaces — `projectId` for single-repo
 * projects and `workspaceId` for multi-repo workspaces. The contract stores
 * it verbatim; runtime resolution compares it to whatever the spawning code
 * forwards.
 *
 * `runtimes` is `Partial` because a workspace may only override one runtime
 * slot and inherit the rest from {@link EnvironmentConfigData.globalRuntimes}.
 */
export interface WorkspaceEnvironmentAssignment {
  workspaceId: string;
  runtimes: Partial<EnvironmentRuntimeAssignments>;
  updatedAt: string;
}

/**
 * The full environment config: the tree of environments, the global runtime
 * assignment triple, and the list of per-workspace overrides. Main works on
 * the plaintext form; the wire carries {@link EnvironmentConfigView}, where
 * values marked secret are stored-secret values. Persisted file shapes (see
 * {@link PersistedEnvironmentConfigFile}) keep variables encrypted at rest.
 */
export interface EnvironmentConfigData<V extends EnvironmentValue = string> {
  version: 2;
  environments: EnvironmentDefinition<V>[];
  globalRuntimes: EnvironmentRuntimeAssignments;
  workspaceAssignments: WorkspaceEnvironmentAssignment[];
}

/** The environment config as it crosses IPC, in both directions. */
export type EnvironmentConfigView = EnvironmentConfigData<EnvironmentValue>;
export type EnvironmentDefinitionView = EnvironmentDefinition<EnvironmentValue>;
export type UserEnvironmentEntryView = UserEnvironmentEntry<EnvironmentValue>;

/**
 * IPC response from `loadEnvironmentConfig`. Surfaces whether the host OS
 * has encryption available so the renderer can warn users when saved values
 * would not be encrypted at rest.
 */
export interface LoadEnvironmentConfigSuccessResponse {
  data: EnvironmentConfigView;
  /**
   * True when the native environment-value availability decision returns true.
   * This is distinct from permission to write tokens.
   * Explicit native unavailability or missing storage permits the historical
   * plaintext environment fallback, but never overwrites unreadable ciphertext.
   * Probe failures and denied backends with native availability do not permit
   * plaintext conversion.
   */
  encryptionAvailable: boolean;
}

/** Failed reads contain no data: callers must retain last-known-good state. */
export interface LoadEnvironmentConfigErrorResponse {
  ok: false;
  error: string;
  secureStorageFailure?: SecureStorageFailure;
}

export type LoadEnvironmentConfigResponse =
  | LoadEnvironmentConfigSuccessResponse
  | LoadEnvironmentConfigErrorResponse;

/** Successful IPC response from `saveEnvironmentConfig`. */
export interface SaveEnvironmentConfigSuccessResponse {
  ok: true;
  data: EnvironmentConfigView;
  encryptionAvailable: boolean;
}

/** Structured IPC validation/error response from `saveEnvironmentConfig`. */
export interface SaveEnvironmentConfigErrorResponse {
  ok: false;
  error: string;
  /** Set when a kept stored secret could not be honoured. */
  storedSecretError?: StoredSecretErrorCode;
  secureStorageFailure?: SecureStorageFailure;
}

/** IPC response from `saveEnvironmentConfig`. */
export type SaveEnvironmentConfigResponse =
  | SaveEnvironmentConfigSuccessResponse
  | SaveEnvironmentConfigErrorResponse;

/**
 * Request shape for the backend's runtime environment resolver. Callers
 * supply the runtime slot to look up; the optional `workspaceId` matches the
 * key the renderer used when saving a workspace assignment.
 */
export interface ResolveEnvironmentRequest {
  values?: 'all' | 'public';
  workspaceId?: string;
  runtime: EnvironmentRuntime;
}

/**
 * Result of resolving an effective environment for a runtime slot. The
 * resolver walks the parent chain from the assigned environment up to the
 * root, merging variables with child-overrides-parent precedence, and
 * returns:
 *
 *  - `environmentId` / `environmentName`: the leaf environment that drives
 *    the resolution, or `null` when no environment is assigned for the slot.
 *  - `variables`: the leaf environment's own (unmerged) variables, useful
 *    for UI display.
 *  - `applied`: the merged key/value map ready to be spread into
 *    `process.env`. Reserved keys (see PATH) are excluded.
 *  - `inheritedEnvironmentIds`: ids walked above the leaf, leaf-most first.
 *    Empty when the leaf has no parent.
 */
export interface ResolvedEnvironment<V extends EnvironmentValue = string> {
  environmentId: string | null;
  environmentName: string | null;
  variables: UserEnvironmentEntry<V>[];
  publicApplied: Record<string, V>;
  secretApplied: Record<string, V>;
  applied: Record<string, V>;
  inheritedEnvironmentIds: string[];
}

/** Describes where an environment is currently referenced. */
export interface EnvironmentUsage {
  environmentId: string;
  kind: 'global-runtime' | 'workspace-runtime' | 'parent';
  runtime?: EnvironmentRuntime;
  workspaceId?: string;
  workspaceName?: string;
  childEnvironmentId?: string;
}

// ---------------------------------------------------------------------------
// Persisted on-disk shapes (contract between renderer and main)
//
// These shapes describe `environments.json` (version 2). The frontend never
// reads/writes them directly — only main does — but they live in shared so
// both sides agree on the format and so backend tests can import them
// without a circular dependency on backend types.
// ---------------------------------------------------------------------------

/**
 * On-disk representation of a single {@link EnvironmentDefinition}.
 *
 * Exactly one of `encryptedVariables` or `plaintextVariables` is populated:
 *  - When native availability is true and the secure policy permits writing,
 *    the backend encrypts the variable list and stores the base64
 *    ciphertext in `encryptedVariables`.
 *  - Only explicit native unavailability or missing storage lets the backend
 *    persist safely readable values verbatim in
 *    `plaintextVariables` and surfaces `encryptionAvailable: false` to the
 *    renderer so it can warn the user.
 */
export interface PersistedEnvironmentDefinition {
  id: string;
  name: string;
  parentId: string | null;
  isDefault: boolean;
  defaultKind?: DefaultEnvironmentKind;
  uiMode: UserEnvironmentUiMode;
  encryptedVariables?: string;
  plaintextVariables?: UserEnvironmentEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * On-disk shape of `environments.json`. The `version` discriminator
 * differentiates this file from the legacy `user-environment.json` (which
 * the backend migrates from when present).
 */
export interface PersistedEnvironmentConfigFile {
  version: 2;
  data: {
    environments: PersistedEnvironmentDefinition[];
    globalRuntimes: EnvironmentRuntimeAssignments;
    workspaceAssignments: WorkspaceEnvironmentAssignment[];
  };
}

// ---------------------------------------------------------------------------
// Legacy version-1 file shape
//
// `user-environment.json` predates the Environments page. Main still reads it
// once to migrate it into `environments.json`; nothing else uses it.
// ---------------------------------------------------------------------------

/**
 * Contents of the legacy version-1 `user-environment.json`: the variables
 * that became the Overall environment.
 *
 * @deprecated Read only by the version-2 migration.
 */
export interface UserEnvironmentData {
  uiMode: UserEnvironmentUiMode;
  variables: UserEnvironmentEntry[];
}
