import { classifyResourceOwner } from '@canopy/desktop-shared/lib/resource-context';
import type { ResourceContextInput } from '@canopy/desktop-shared/lib/resource-context-policy';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  parseWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  LanePartitioned,
  composeLanePages,
  type LanePagePosition,
  type ResourceLanePage,
  laneKey,
  lanesForContext,
  type ResourceLane,
} from '@canopy/desktop-shared/lib/resource-lanes';
import type {
  ListSharedPipelinesRequest,
  SharedPipelineSummary,
} from '@canopy/desktop-shared/types/pipeline';
import { getFeatureFlagService } from '../feature-flags';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { getResourceContextPolicyService } from '../services/resource-context-policy-service';

export function pipelineResourceContextEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}

export async function pipelineContextSnapshot(): Promise<string> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  const state = service.getState();
  return JSON.stringify([
    service.accountEpoch(),
    state.revision,
    state.context,
  ]);
}

export async function assertPipelineContextSnapshot(
  snapshot: string,
): Promise<void> {
  if (snapshot !== (await pipelineContextSnapshot()))
    throw new Error('Workflow unavailable (context-mismatch)');
}

export async function pipelineContextAllowed(
  resource: ResourceContextInput['resource'],
): Promise<boolean> {
  if (!pipelineResourceContextEnabled()) return true;
  if (classifyResourceOwner(resource.owner, { strict: true }) === 'unknown')
    return false;
  const decision = await getResourceContextPolicyService().decide({
    resource,
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
  });
  return decision.allow;
}

/** A resource-context refusal, as `assertPipelineContext` and its callers raise them. */
export function isPipelineContextDenial(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /^Workflow unavailable \([a-z-]+\)$/.test(error.message)
  );
}

export async function assertPipelineContext(
  resource: ResourceContextInput['resource'],
  projectId?: string,
  executionContext?: string,
): Promise<void> {
  if (!pipelineResourceContextEnabled()) return;
  if (classifyResourceOwner(resource.owner, { strict: true }) === 'unknown')
    throw new Error('Workflow unavailable (unknown-provenance)');
  const parsedExecutionContext =
    executionContext === undefined
      ? undefined
      : parseWorkspaceContext(executionContext);
  if (executionContext !== undefined && parsedExecutionContext === null)
    throw new Error('Workflow unavailable (unsupported-target)');
  const context =
    parsedExecutionContext ?? getWorkspaceContextService().getState().context;
  let target: ResourceContextInput['target'];
  if (projectId) {
    // Defer the sidebar/catalog graph until target authorization.
    const { resolveWorkspaceTarget, WorkspaceTargetResolutionError } =
      await import('../services/workspace-target');
    try {
      let persistedTarget:
        | {
            workspaceOwner: WorkspaceContext;
            linkedPersonalCandidate: boolean;
          }
        | undefined;
      if (executionContext !== undefined) {
        const { resolveBackgroundWorkspaceTarget } =
          await import('../services/background-execution-context');
        persistedTarget = await resolveBackgroundWorkspaceTarget(projectId);
      }
      target = await resolveWorkspaceTarget(projectId, {
        ...persistedTarget,
        ...(context.kind === 'organization'
          ? { organizationId: context.organizationId }
          : {}),
      });
    } catch (error) {
      if (error instanceof WorkspaceTargetResolutionError)
        throw new Error(`Workflow unavailable (${error.reason})`);
      if (executionContext !== undefined)
        throw new Error('Workflow unavailable (unknown-provenance)');
      throw error;
    }
  }
  const decision = await getResourceContextPolicyService().decide({
    resource,
    ...(target ? { target } : {}),
    invocation:
      executionContext === undefined
        ? { mode: 'foreground', context }
        : {
            mode: 'background',
            context,
            executionContext,
          },
  });
  if (!decision.allow)
    throw new Error(`Workflow unavailable (${decision.reason})`);
}

interface Page {
  data: SharedPipelineSummary[];
  nextCursor: string | null;
}
interface Cursor {
  snapshot: string;
  query: string;
  lanes: Record<string, LanePagePosition>;
}
const inventories = new Map<string, LanePartitioned<Page>>();
let currentSnapshot: string | undefined;

function decodeCursor(value: string, snapshot: string, query: string): Cursor {
  const parsed: unknown = JSON.parse(
    Buffer.from(value, 'base64url').toString('utf8'),
  );
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('snapshot' in parsed) ||
    parsed.snapshot !== snapshot ||
    !('query' in parsed) ||
    parsed.query !== query ||
    !('lanes' in parsed) ||
    typeof parsed.lanes !== 'object' ||
    parsed.lanes === null ||
    Array.isArray(parsed.lanes)
  )
    throw new Error('Workflow unavailable (context-mismatch)');
  const lanes: Record<string, LanePagePosition> = {};
  const entries: [string, unknown][] = Object.entries(parsed.lanes);
  for (const [key, cursor] of entries) {
    if (
      typeof cursor !== 'object' ||
      cursor === null ||
      !('cursor' in cursor) ||
      (cursor.cursor !== null && typeof cursor.cursor !== 'string') ||
      !('offset' in cursor) ||
      typeof cursor.offset !== 'number' ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    )
      throw new Error('Invalid pipeline cursor');
    lanes[key] = { cursor: cursor.cursor, offset: cursor.offset };
  }
  return { snapshot, query, lanes };
}

/** Each lane keeps its own conditional response, cursor and in-flight request. */
export async function listPipelineLanes(
  params: ListSharedPipelinesRequest,
  fetch: (
    lane: ResourceLane,
    cursor: string | undefined,
    etag: string | null,
  ) => Promise<
    | { status: 'not-modified' }
    | { status: 'fresh'; body: Page; etag: string | null }
  >,
): Promise<Page> {
  const snapshot = await pipelineContextSnapshot();
  if (snapshot !== currentSnapshot) {
    for (const inventory of Array.from(inventories.values())) inventory.clear();
    inventories.clear();
    currentSnapshot = snapshot;
  }
  const query = JSON.stringify([
    params.limit,
    params.q,
    params.triggerType,
    params.createdBy,
  ]);
  const cursor = params.cursor
    ? decodeCursor(params.cursor, snapshot, query)
    : undefined;
  const key = JSON.stringify([query, params.cursor]);
  let inventory = inventories.get(key);
  if (!inventory) {
    if (inventories.size >= 32) {
      for (const previous of Array.from(inventories.values())) previous.clear();
      inventories.clear();
    }
    inventory = new LanePartitioned<Page>();
    inventories.set(key, inventory);
  }
  const partition = inventory;
  const version = {
    account: String(getWorkspaceContextService().accountEpoch()),
    authorization: snapshot,
  };
  const lanes = lanesForContext(
    getWorkspaceContextService().getState().context,
    getWorkspaceContextService().personalOrganizationId?.() ?? null,
  );
  const next: Cursor = { snapshot, query, lanes: {} };
  const pages = await Promise.all(
    lanes.map(
      async (lane): Promise<ResourceLanePage<SharedPipelineSummary>> => {
        const position = cursor?.lanes[laneKey(lane)];
        const laneCursor = position?.cursor;
        if (cursor && position === undefined)
          throw new Error('Invalid pipeline cursor');
        if (cursor && laneCursor === null) {
          return {
            lane,
            position: { cursor: null, offset: 0 },
            data: [],
            nextCursor: null,
          };
        }
        const state = partition.get(lane, version);
        const page = await partition.run(
          lane,
          version,
          async (): Promise<Page> => {
            const result = await fetch(
              lane,
              laneCursor || undefined,
              state.etag ?? null,
            );
            await assertPipelineContextSnapshot(snapshot);
            if (result.status === 'not-modified') {
              if (!state.value)
                throw new Error('Pipeline inventory unavailable');
              return state.value;
            }
            state.etag = result.etag ?? undefined;
            state.cursor = result.body.nextCursor;
            return result.body;
          },
        );
        const allowed = await Promise.all(
          page.data.map(
            async (row): Promise<boolean> =>
              pipelineContextAllowed({ owner: row.owner }),
          ),
        );
        const data = page.data.filter((row, index) => {
          const owner = classifyResourceOwner(row.owner, { strict: false });
          const matchesLane =
            typeof owner === 'object'
              ? lane.kind === 'organization' &&
                owner.organizationId === lane.organizationId
              : lane.kind === 'personal';
          return matchesLane && allowed[index];
        });
        return {
          lane,
          position: position ?? { cursor: '', offset: 0 },
          data,
          nextCursor: page.nextCursor,
        };
      },
    ),
  );
  await assertPipelineContextSnapshot(snapshot);
  const composed = composeLanePages(pages, params.limit ?? 50);
  next.lanes = composed.lanes;
  return {
    data: composed.data,
    nextCursor: Object.values(next.lanes).some((value) => value.cursor !== null)
      ? Buffer.from(JSON.stringify(next)).toString('base64url')
      : null,
  };
}
