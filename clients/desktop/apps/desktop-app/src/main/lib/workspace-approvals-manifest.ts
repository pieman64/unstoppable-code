import type {
  ApprovalMode,
  ApprovalRule,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { watch, type FSWatcher } from 'node:fs';
import { basename } from 'node:path';
import { getProjectConfigFileCandidates, readCanopyJson } from './canopy-json';
import { markWorkspaceApprovalRulesChanged } from '../approvals/rule-revisions';
import { readWorkspaceConfig } from './workspace-persistence';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

/**
 * The repo-committed `canopy.json` `approvals` block, resolved for a given
 * workspace and normalized into the shape the approval subsystem consumes.
 * `rules` is always an array (empty when there is no manifest, no
 * `approvals` block, or the manifest fails to parse); `defaultMode` is only
 * present when the manifest defines one.
 */
export interface WorkspaceApprovalsManifest {
  defaultMode?: ApprovalMode;
  rules: ApprovalRule[];
}

function emptyManifest(): WorkspaceApprovalsManifest {
  return { rules: [] };
}

/**
 * Resolves the repo root that a workspace's `canopy.json` should be read
 * from, mirroring `workspace-source.ts`'s resolution: `single-repo` reads
 * from its `repoPath`; `multi-repo` reads from `sourceRepoPath` only when
 * the workspace is source-backed; cowork and App Advisor workspaces (and
 * any other shape with no resolvable repo root) have no manifest.
 */
async function resolveManifestRepoRoot(
  config: WorkspaceConfigFile,
): Promise<string | undefined> {
  if (config.type === 'single-repo') {
    if (!config.repoPath) {
      return undefined;
    }
    return resolveProjectReferenceRepoPath(config.repoPath);
  }

  if (config.type === 'multi-repo' && config.sourceRepoPath) {
    return resolveWorkspaceReferenceRepoPath(config.sourceRepoPath);
  }

  return undefined;
}

const manifestWatchers = new Map<
  string,
  { repoRoot: string; watcher: FSWatcher }
>();
const observedManifests = new Map<string, string>();

/**
 * Watches the repository root a workspace's manifest is read from, so an
 * edit to it changes the approval settings revision as soon as it lands.
 */
function watchManifestRoot(workspaceId: string, repoRoot: string): void {
  const current = manifestWatchers.get(workspaceId);
  if (current?.repoRoot === repoRoot) return;
  current?.watcher.close();
  manifestWatchers.delete(workspaceId);
  const fileNames = new Set(
    getProjectConfigFileCandidates(repoRoot).map((candidate) =>
      basename(candidate),
    ),
  );
  try {
    const watcher = watch(
      repoRoot,
      { persistent: false },
      (_event, filename) => {
        if (!filename || fileNames.has(filename.toString())) {
          markWorkspaceApprovalRulesChanged(workspaceId);
        }
      },
    );
    watcher.on('error', () => {
      watcher.close();
      if (manifestWatchers.get(workspaceId)?.watcher === watcher) {
        manifestWatchers.delete(workspaceId);
      }
    });
    manifestWatchers.set(workspaceId, { repoRoot, watcher });
  } catch {
    // The next read retries a root that cannot be watched yet.
  }
}

/** Marks the workspace's rules changed when a read sees a new manifest. */
function observeManifest(
  workspaceId: string,
  manifest: WorkspaceApprovalsManifest,
): WorkspaceApprovalsManifest {
  const observed = JSON.stringify([
    manifest.defaultMode ?? null,
    manifest.rules,
  ]);
  const previous = observedManifests.get(workspaceId);
  observedManifests.set(workspaceId, observed);
  if (previous !== undefined && previous !== observed) {
    markWorkspaceApprovalRulesChanged(workspaceId);
  }
  return manifest;
}

/** Stops every manifest watcher. */
export function stopWorkspaceApprovalsManifestWatchers(): void {
  for (const { watcher } of Array.from(manifestWatchers.values())) {
    watcher.close();
  }
  manifestWatchers.clear();
  observedManifests.clear();
}

/**
 * Reads the repo-committed `canopy.json` `approvals` block for a workspace,
 * if one is resolvable. Silent fallback on any missing/corrupt/invalid
 * manifest or unresolvable repo root — an invalid `canopy.json` must not
 * break the approval subsystem; it already surfaces as a parse error
 * elsewhere (e.g. the workspace settings manifest view).
 */
export async function readWorkspaceApprovalsManifest(
  workspaceId: string,
): Promise<WorkspaceApprovalsManifest> {
  try {
    const config = await readWorkspaceConfig(workspaceId);
    const repoRoot = await resolveManifestRepoRoot(config);
    if (!repoRoot) {
      return observeManifest(workspaceId, emptyManifest());
    }
    watchManifestRoot(workspaceId, repoRoot);

    const manifest = await readCanopyJson(repoRoot);
    const approvals = manifest?.approvals;
    if (!approvals) {
      return observeManifest(workspaceId, emptyManifest());
    }

    return observeManifest(workspaceId, {
      ...(approvals.defaultMode !== undefined
        ? { defaultMode: approvals.defaultMode }
        : {}),
      rules: approvals.rules ?? [],
    });
  } catch {
    return observeManifest(workspaceId, emptyManifest());
  }
}
