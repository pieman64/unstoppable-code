import {
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { classifyResourceOwner } from '@canopy/execution-engine/lib/resource-context';
import type { ResourceContextInput } from '@canopy/execution-engine/lib/resource-context-policy';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
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
  ListSharedSkillsRequest,
  SharedSkillSummary,
} from '@canopy/desktop-shared/types/skills';
import { getFeatureFlagService } from '../feature-flags';
import { getWorkspaceContextService } from '../lib/workspace-context-service';

export function skillResourceContextEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}

export async function skillContextSnapshot(): Promise<string> {
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

export async function assertSkillContextSnapshot(
  snapshot: string,
): Promise<void> {
  if (snapshot !== (await skillContextSnapshot()))
    throw new Error('Skill unavailable (context-mismatch)');
}

export async function skillContextAllowed(
  resource: ResourceContextInput['resource'],
): Promise<boolean> {
  if (!skillResourceContextEnabled()) return true;
  if (classifyResourceOwner(resource.owner, { strict: true }) === 'unknown')
    return false;
  const { getResourceContextPolicyService } =
    await import('../services/resource-context-policy-service');
  const decision = await getResourceContextPolicyService().decide({
    resource,
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
  });
  return decision.allow;
}

export async function assertSkillContext(
  resource: ResourceContextInput['resource'],
  projectId?: string,
): Promise<void> {
  if (!skillResourceContextEnabled()) return;
  if (classifyResourceOwner(resource.owner, { strict: true }) === 'unknown')
    throw new Error('Skill unavailable (unknown-provenance)');
  let target: ResourceContextInput['target'];
  const appSurface =
    projectId === APP_ADVISOR_PROJECT_ID ||
    projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
    projectId === PIPELINE_EDITOR_PROJECT_ID;
  if (projectId && !appSurface) {
    const { resolveWorkspaceTarget, WorkspaceTargetResolutionError } =
      await import('../services/workspace-target');
    const context = getWorkspaceContextService().getState().context;
    try {
      target = await resolveWorkspaceTarget(projectId, {
        ...(context.kind === 'organization'
          ? { organizationId: context.organizationId }
          : {}),
      });
    } catch (error) {
      if (error instanceof WorkspaceTargetResolutionError)
        throw new Error(`Skill unavailable (${error.reason})`);
      throw error;
    }
  }
  const { getResourceContextPolicyService } =
    await import('../services/resource-context-policy-service');
  const decision = await getResourceContextPolicyService().decide({
    resource,
    ...(target ? { target } : {}),
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
  });
  if (!decision.allow)
    throw new Error(`Skill unavailable (${decision.reason})`);
}

interface Page {
  skills: SharedSkillSummary[];
  nextCursor?: string;
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
    throw new Error('Skill unavailable (context-mismatch)');
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
      throw new Error('Invalid skill cursor');
    lanes[key] = { cursor: cursor.cursor, offset: cursor.offset };
  }
  return { snapshot, query, lanes };
}

/** Each lane keeps its own conditional response, cursor and in-flight request. */
export async function listSkillLanes(
  params: ListSharedSkillsRequest,
  fetch: (
    lane: ResourceLane,
    cursor: string | undefined,
    etag: string | null,
  ) => Promise<
    | { status: 'not-modified' }
    | { status: 'fresh'; body: Page; etag: string | null }
  >,
): Promise<Page> {
  const snapshot = await skillContextSnapshot();
  if (snapshot !== currentSnapshot) {
    for (const inventory of Array.from(inventories.values())) inventory.clear();
    inventories.clear();
    currentSnapshot = snapshot;
  }
  const query = JSON.stringify([params.limit, params.query, params.createdBy]);
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
    lanes.map(async (lane): Promise<ResourceLanePage<SharedSkillSummary>> => {
      const position = cursor?.lanes[laneKey(lane)];
      const laneCursor = position?.cursor;
      if (cursor && position === undefined)
        throw new Error('Invalid skill cursor');
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
          await assertSkillContextSnapshot(snapshot);
          if (result.status === 'not-modified') {
            if (!state.value) throw new Error('Skill inventory unavailable');
            return state.value;
          }
          state.etag = result.etag ?? undefined;
          state.cursor = result.body.nextCursor ?? null;
          return result.body;
        },
      );
      const allowed = await Promise.all(
        page.skills.map(
          async (row): Promise<boolean> =>
            skillContextAllowed({ owner: row.owner }),
        ),
      );
      const data = page.skills.filter((row, index) => {
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
        nextCursor: page.nextCursor ?? null,
      };
    }),
  );
  await assertSkillContextSnapshot(snapshot);
  const composed = composeLanePages(pages, params.limit ?? 50);
  next.lanes = composed.lanes;
  return {
    skills: composed.data,
    nextCursor: Object.values(next.lanes).some((value) => value.cursor !== null)
      ? Buffer.from(JSON.stringify(next)).toString('base64url')
      : undefined,
  };
}
