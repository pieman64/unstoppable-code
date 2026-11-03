// Stands in for core reads in unit tests that mock the pipeline sources: a
// list or get answers from the (mocked) store, catalog, cloud and project
// discovery as the desktop sources read them behind
// `core.pipeline.definition.*`, in core's order. The goldens cover the real
// dispatch.
import type { CanopyWorkspaceScope } from '@canopy/protocol/canopy-core';
import {
  isAddressableSharedPipelineRemoteId,
  parseSharedPipelineLocalId,
} from '@canopy/protocol/pipelines';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type {
  IPCResult,
  PipelineData,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import { assertCanopyCloudCapability } from '../../canopy-cloud/client';
import {
  getSharedPipeline,
  listSharedPipelines,
} from '../../pipelines/canopy-server-client';
import {
  getManagedCuratedPipeline,
  listManagedCuratedPipelines,
} from '../../pipelines/curated-pipeline-catalog';
import {
  assertStoredPipelineContext,
  filterProjectPipelineContexts,
  filterStoredPipelineContexts,
} from '../../pipelines/pipeline-install-context';
import { assertPipelineContext } from '../../pipelines/resource-lanes';
import {
  discoverProjectPipelines,
  loadProjectPipelineFromDisk,
} from '../../pipelines/project-pipeline-discovery';
import { buildSharedPipelineInfo } from '../../pipelines/shared-pipeline-info';

/** The stored pipelines a suite mocks, through whichever module it mocks. */
export interface FakeStoredPipelines {
  list(): IPCResult<PipelineInfo[]>;
  get(id: string): IPCResult<PipelineData>;
}

class FakeDefinitionNotFound extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The checkout a project scope names, as the desktop project source finds it. */
async function projectCheckout(
  scope: CanopyWorkspaceScope,
): Promise<string | undefined> {
  const { workspaceId, worktreeId } = scope;
  if (!workspaceId || !worktreeId) return undefined;
  const [{ readAllSidebarItems }, paths] = await Promise.all([
    import('../../lib/sidebar-items'),
    import('../../lib/paths'),
  ]);
  const item = (await readAllSidebarItems()).items.find(
    (candidate) => candidate.id === workspaceId,
  );
  const worktrees = item && 'worktrees' in item ? item.worktrees : [];
  if (!item || !worktrees.some((worktree) => worktree.id === worktreeId))
    return undefined;
  return item.type === 'single-repo'
    ? paths.getWorktreeDir(workspaceId, worktreeId)
    : paths.getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);
}

async function projectPipelines(
  scope: CanopyWorkspaceScope,
): Promise<PipelineInfo[]> {
  const cwd = await projectCheckout(scope);
  if (cwd === undefined) return [];
  // Core knows these rows are project definitions.
  return (
    await filterProjectPipelineContexts(
      await discoverProjectPipelines(cwd).catch((): PipelineInfo[] => []),
      cwd,
      scope.workspaceId,
    )
  ).map((info) => ({ ...info, source: 'project' as const }));
}

function matchesQuery(info: PipelineInfo, query: string | undefined): boolean {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [info.id, info.name, info.description ?? '']
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface PipelineReadFake {
  listDesktopPipelines(params: {
    sources?: readonly string[];
    scope?: CanopyWorkspaceScope;
    query?: string;
  }): Promise<{
    rows: PipelineInfo[];
    unavailableSources: string[];
    sourceFailures: Record<string, unknown>;
  }>;
  readDesktopPipeline(
    definitionId: string,
    scope: CanopyWorkspaceScope,
  ): Promise<PipelineData>;
  readDesktopPipelineSnapshot(
    definitionId: string,
    scope: CanopyWorkspaceScope,
  ): Promise<{ data: PipelineData; checksum: string }>;
  isPipelineDefinitionNotFound(error: unknown): boolean;
  pipelineSourceFailure(error: unknown): unknown;
  pipelineWriteErrorMessage(error: unknown): string;
  PIPELINE_DEFINITION_PORTAL_CALLER: object;
}

export function createPipelineReadFake(
  stored: () => FakeStoredPipelines,
): PipelineReadFake {
  const fake: Omit<PipelineReadFake, 'readDesktopPipelineSnapshot'> = {
    async listDesktopPipelines(params): Promise<{
      rows: PipelineInfo[];
      unavailableSources: string[];
      sourceFailures: Record<string, unknown>;
    }> {
      const requested = new Set(
        params.sources ?? ['bundled', 'user', 'project', 'curated', 'shared'],
      );
      const scope = params.scope ?? {};
      const unavailableSources: string[] = [];
      const sourceFailures: Record<string, unknown> = {};
      const rows: PipelineInfo[] = [];
      if (requested.has('bundled') || requested.has('user')) {
        const listed = stored().list();
        if (!listed.success || !listed.data)
          throw new Error(listed.error ?? 'The workflows could not be listed.');
        const visible = await filterStoredPipelineContexts(
          listed.data,
          scope.workspaceId,
        );
        for (const source of ['bundled', 'user'])
          rows.push(...visible.filter((info) => info.source === source));
      }
      if (requested.has('project'))
        rows.push(...(await projectPipelines(scope)));
      if (requested.has('curated'))
        try {
          rows.push(...(await listManagedCuratedPipelines()));
        } catch (error) {
          sourceFailures.curated = error;
          unavailableSources.push('curated');
        }
      if (requested.has('shared'))
        try {
          await assertCanopyCloudCapability('pipelines-crud-v1');
          const listed = await listSharedPipelines({
            limit: 100,
            ...(params.query?.trim() ? { q: params.query } : {}),
          });
          rows.push(
            ...listed.data
              .filter((row) => isAddressableSharedPipelineRemoteId(row.id))
              .map((pipeline) => buildSharedPipelineInfo({ pipeline })),
          );
        } catch (error) {
          sourceFailures.shared = error;
          unavailableSources.push('shared');
        }
      return {
        rows: rows.filter((info) => matchesQuery(info, params.query)),
        unavailableSources,
        sourceFailures,
      };
    },

    async readDesktopPipeline(definitionId, scope): Promise<PipelineData> {
      if (definitionId.startsWith('curated:'))
        return getManagedCuratedPipeline(definitionId);
      const shared = parseSharedPipelineLocalId(definitionId);
      if (shared) {
        await assertCanopyCloudCapability('pipelines-crud-v1');
        const detail = await getSharedPipeline(shared.remoteId);
        await assertPipelineContext({ owner: detail.owner }, scope.workspaceId);
        return {
          info: buildSharedPipelineInfo({ pipeline: detail }),
          content: parsePipelineText(detail.rawPipeline),
        };
      }
      // A checkout's definition shadows a stored one with its id.
      const project = (await projectPipelines(scope)).find(
        (candidate) => candidate.id === definitionId,
      );
      if (project?.filePath)
        return {
          info: project,
          content: await loadProjectPipelineFromDisk(project.filePath),
        };
      const read = stored().get(definitionId);
      if (!read.success || !read.data)
        throw new FakeDefinitionNotFound(
          read.error ?? `Workflow not found: ${definitionId}`,
        );
      await assertStoredPipelineContext(definitionId, scope.workspaceId);
      return read.data;
    },

    isPipelineDefinitionNotFound: (error) =>
      error instanceof FakeDefinitionNotFound,
    pipelineSourceFailure: (error) => error,
    pipelineWriteErrorMessage: errorMessage,
    PIPELINE_DEFINITION_PORTAL_CALLER: {},
  };
  return {
    ...fake,
    async readDesktopPipelineSnapshot(
      definitionId: string,
      scope: CanopyWorkspaceScope,
    ): Promise<{ data: PipelineData; checksum: string }> {
      return {
        data: await fake.readDesktopPipeline(definitionId, scope),
        checksum: 'sha256:fake',
      };
    },
  };
}
