import { COWORK_WORKSPACE_FILE_ROOT_ID } from '@canopy/protocol/ui-labels';

/** Catalog root kinds shared by the desktop tree and Portal root list. */
export type FileRootGroupKind =
  | 'git-repo'
  | 'workspace-root'
  | 'attachments'
  | 'standalone';

/** Stable catalog identity used to group roots; never a display label. */
export interface FileRootIdentity {
  readonly id: string;
  /** Absent when an older host omitted it; unclassified roots never group. */
  readonly kind?: FileRootGroupKind;
}

/**
 * Cowork's app-managed standalone roots, by the ids the Cowork root catalog
 * assigns. Attachments are recognized by their own root kind.
 */
const COWORK_MANAGED_STANDALONE_ROOT_IDS: ReadonlySet<string> = new Set([
  'notes',
  'prompts',
]);

export interface FileRootGroups<Root> {
  /** The user's roots in catalog order, including any unknown root. */
  readonly primary: readonly Root[];
  /** App-owned Cowork roots in catalog order; empty outside Cowork catalogs. */
  readonly appManaged: readonly Root[];
}

/** Whether `root` is the Cowork project's own working folder. */
export function isCoworkWorkspaceFileRoot(root: FileRootIdentity): boolean {
  return (
    root.id === COWORK_WORKSPACE_FILE_ROOT_ID && root.kind === 'standalone'
  );
}

/**
 * Splits a flat root catalog into the user's roots and the app-owned roots
 * shown under the brand group. Only a catalog with exactly one Cowork working
 * folder groups anything; other catalogs, and roots without a kind, stay in
 * `primary` so nothing is hidden or mislabelled as app-owned.
 */
export function partitionFileRoots<Root>(
  roots: readonly Root[],
  identify: (root: Root) => FileRootIdentity,
): FileRootGroups<Root> {
  const identities = roots.map(identify);
  const coworkRoots = identities.filter(isCoworkWorkspaceFileRoot).length;
  if (coworkRoots !== 1) return { primary: roots, appManaged: [] };
  const primary: Root[] = [];
  const appManaged: Root[] = [];
  roots.forEach((root, index) => {
    const identity = identities[index];
    const managed =
      identity !== undefined &&
      (identity.kind === 'attachments' ||
        (identity.kind === 'standalone' &&
          COWORK_MANAGED_STANDALONE_ROOT_IDS.has(identity.id)));
    (managed ? appManaged : primary).push(root);
  });
  return { primary, appManaged };
}
