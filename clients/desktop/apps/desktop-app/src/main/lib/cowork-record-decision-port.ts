import { PROJECT_COLORS } from '@canopy/desktop-shared/constants/project-colors';
import type {
  CoworkWorkspaceSettings,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { ensureCoworkHomeScaffold } from './chat-project-utils';
import {
  getWorkspaceIndexRepository,
  renameWorkspaceIndexEntry,
} from './sidebar-items';
import {
  getWorkspaceManifestRepository,
  readWorkspaceConfigDetailed,
  updateWorkspaceConfig,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import {
  admitCoworkIndex,
  admitCoworkProvisionEntry,
  admitCoworkProvisionManifest,
  allocateCoworkMigrationTo,
  applyCoworkMigrationManifestTo,
  applyCoworkProvisionIndexTo,
  applyCoworkProvisionManifestCreateTo,
  applyCoworkProvisionManifestTo,
  withUnknownCoworkFields,
} from './worktree-record-decision-apply';
import type {
  CoworkDefaultNameDecision,
  CoworkDefaultNameOutcome,
  CoworkIndexDecision,
  CoworkIndexDecisionOutcome,
  CoworkManifestDecision,
  CoworkMigrationDecision,
  CoworkMigrationOutcome,
  CoworkProvisionDecision,
  CoworkProvisionManifestPass,
  CoworkProvisionOutcome,
} from './worktree-record-decisions';

// The designated Cowork members of `W5RecordDecisionPort` (W5c2), applied by
// the writers the records used. Kept apart so the ownership, private memory
// and seed records do not load the Cowork scaffold.

function paletteColor(count: number): string {
  return PROJECT_COLORS[count % PROJECT_COLORS.length];
}

/** Restores the raw file's unknown Cowork fields on `config`. */
async function preserveCoworkFields(
  workspaceId: string,
  config: WorkspaceConfigFile,
): Promise<CoworkWorkspaceSettings> {
  const raw = await getWorkspaceManifestRepository().read(workspaceId);
  return withUnknownCoworkFields(
    raw.authority === 'ok' ? raw.document.cowork : undefined,
    config,
  );
}

/**
 * Applies one Cowork index decision through the index repository, which
 * admits the index storage and schedules the Portal sync after its commit.
 * The caller holds the workspace mutation queue; a migration's manifest is
 * read, not written, there.
 */
export async function applyCoworkIndexDecision(
  decision: CoworkMigrationDecision,
): Promise<CoworkMigrationOutcome>;
export async function applyCoworkIndexDecision(
  decision: CoworkDefaultNameDecision,
): Promise<CoworkDefaultNameOutcome>;
export async function applyCoworkIndexDecision(
  decision: CoworkIndexDecision,
): Promise<CoworkIndexDecisionOutcome>;
export async function applyCoworkIndexDecision(
  decision: CoworkIndexDecision,
): Promise<CoworkIndexDecisionOutcome> {
  switch (decision.kind) {
    case 'cowork.migration':
      return getWorkspaceIndexRepository().update<CoworkMigrationOutcome>(
        async (snapshot) => {
          admitCoworkIndex(snapshot.authority);
          const allocated = allocateCoworkMigrationTo(
            snapshot.entries,
            decision,
            paletteColor(snapshot.entries.length),
          );
          if (!allocated.entries)
            return { result: { id: allocated.id, created: false } };
          // Refuse unreadable state before publication; the initial write still follows the index.
          const manifest = await readWorkspaceConfigDetailed(allocated.id);
          if (manifest.authority === 'unreadable')
            throw new WorkspaceConfigUnreadableError();
          return {
            result: { id: allocated.id, created: true },
            entries: allocated.entries,
          };
        },
      );
    case 'cowork.default-name':
      // The rename writer keeps its condition and its degraded-read decline.
      return renameWorkspaceIndexEntry(
        decision.workspaceId,
        decision.name,
        decision.onlyWhenNamed,
      );
  }
}

/**
 * Applies a default Cowork provision from the index and manifest read under
 * their queues, never a caller's projection: the manifest decision applies
 * inside the index update, and a new home is scaffolded before the index is
 * published. The caller holds the workspace mutation queue.
 */
export function applyCoworkProvisionDecision(
  decision: CoworkProvisionDecision,
): Promise<CoworkProvisionOutcome> {
  return getWorkspaceIndexRepository().update(async (snapshot) => {
    admitCoworkIndex(snapshot.authority);
    const entry = admitCoworkProvisionEntry(snapshot.entries, decision);
    const pass = await updateWorkspaceConfig(
      decision.workspaceId,
      async (config, read): Promise<CoworkProvisionManifestPass> => {
        if (read.authority !== 'absent') {
          admitCoworkProvisionManifest(config, read, decision);
          await preserveCoworkFields(decision.workspaceId, config);
        }
        return applyCoworkProvisionManifestTo(
          config,
          read,
          {
            entry,
            count: snapshot.entries.length,
            color: paletteColor(snapshot.entries.length),
          },
          decision,
        );
      },
      {
        ownership: decision.owner ? 'replace' : 'preserve',
        shouldWrite: (result) => result.changed && !result.deferManifest,
      },
    );
    if (pass.scaffold) await ensureCoworkHomeScaffold(decision.workspaceId);
    return applyCoworkProvisionIndexTo(snapshot.entries, entry, pass, decision);
  });
}

/** Applies one Cowork manifest decision in the manifest queue. */
export async function applyCoworkManifestDecision(
  workspaceId: string,
  decision: CoworkManifestDecision,
): Promise<void> {
  switch (decision.kind) {
    case 'cowork.provision.manifest':
      await updateWorkspaceConfig(workspaceId, (config, read): void =>
        applyCoworkProvisionManifestCreateTo(config, read, decision),
      );
      return;
    case 'cowork.migration.manifest':
      await updateWorkspaceConfig(
        workspaceId,
        async (config): Promise<void> => {
          const current = await preserveCoworkFields(workspaceId, config);
          applyCoworkMigrationManifestTo(config, current, decision);
        },
      );
      return;
  }
}
