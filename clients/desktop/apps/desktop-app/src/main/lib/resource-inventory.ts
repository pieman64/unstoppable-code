import { classifyResourceOwner } from '@canopy/execution-engine/lib/resource-context';
import {
  LanePartitioned,
  laneKey,
  lanesForContext,
  type ResourceLane,
} from '@canopy/desktop-shared/lib/resource-lanes';
import { getWorkspaceContextService } from './workspace-context-service';
import {
  assertResourceContext,
  resourceContextSnapshot,
  assertResourceContextSnapshot,
} from './resource-context';
interface InventoryQuery {
  limit?: number;
  query?: string;
  createdBy?: string;
  cursor?: string;
}
type LaneFetch<T extends Row> = (
  lane: ResourceLane,
  cursor: string | undefined,
  etag: string | null,
) => Promise<
  | { status: 'not-modified' }
  | { status: 'fresh'; body: Page<T>; etag: string | null }
>;
interface Row {
  id: string;
  owner?: unknown;
}
interface Page<T extends Row> {
  data: T[];
  nextCursor: string | null;
}
interface Cursor {
  snapshot: string;
  query: string;
  lanes: Record<string, string | null>;
}
export function createResourceLaneInventory<T extends Row>(): (
  params: InventoryQuery,
  fetch: LaneFetch<T>,
) => Promise<Page<T>> {
  const inventories = new Map<string, LanePartitioned<Page<T>>>();
  let currentSnapshot: string | undefined;

  function decodeCursor(
    value: string,
    snapshot: string,
    query: string,
  ): Cursor {
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
      throw new Error('Resource unavailable (context-mismatch)');
    const lanes: Record<string, string | null> = {};
    const entries: [string, unknown][] = Object.entries(parsed.lanes);
    for (const [key, cursor] of entries) {
      if (cursor !== null && typeof cursor !== 'string')
        throw new Error('Invalid resource cursor');
      lanes[key] = cursor;
    }
    return { snapshot, query, lanes };
  }

  /** Each lane keeps its own conditional response, cursor and in-flight request. */
  return async function listResourceLanes(
    params: InventoryQuery,
    fetch: LaneFetch<T>,
  ): Promise<Page<T>> {
    const snapshot = await resourceContextSnapshot();
    if (snapshot !== currentSnapshot) {
      for (const inventory of Array.from(inventories.values()))
        inventory.clear();
      inventories.clear();
      currentSnapshot = snapshot;
    }
    const query = JSON.stringify([
      params.limit,
      params.query,
      params.createdBy,
    ]);
    const cursor = params.cursor
      ? decodeCursor(params.cursor, snapshot, query)
      : undefined;
    const key = JSON.stringify([query, params.cursor]);
    let inventory = inventories.get(key);
    if (!inventory) {
      if (inventories.size >= 32) {
        for (const previous of Array.from(inventories.values()))
          previous.clear();
        inventories.clear();
      }
      inventory = new LanePartitioned<Page<T>>();
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
      lanes.map(async (lane): Promise<T[]> => {
        const laneCursor = cursor?.lanes[laneKey(lane)];
        if (cursor && laneCursor === undefined)
          throw new Error('Invalid resource cursor');
        if (cursor && laneCursor === null) {
          next.lanes[laneKey(lane)] = null;
          return [];
        }
        const state = partition.get(lane, version);
        const page = await partition.run(
          lane,
          version,
          async (): Promise<Page<T>> => {
            const result = await fetch(
              lane,
              laneCursor ?? undefined,
              state.etag ?? null,
            );
            await assertResourceContextSnapshot(snapshot);
            if (result.status === 'not-modified') {
              if (!state.value)
                throw new Error('Resource inventory unavailable');
              return state.value;
            }
            state.etag = result.etag ?? undefined;
            state.cursor = result.body.nextCursor;
            return result.body;
          },
        );
        next.lanes[laneKey(lane)] = page.nextCursor;
        const allowed = await Promise.all(
          page.data.map(async (row): Promise<boolean> => {
            try {
              await assertResourceContext({ owner: row.owner });
              return true;
            } catch {
              return false;
            }
          }),
        );
        return page.data.filter((row, index) => {
          const owner = classifyResourceOwner(row.owner, { strict: false });
          const matchesLane =
            typeof owner === 'object'
              ? lane.kind === 'organization' &&
                owner.organizationId === lane.organizationId
              : lane.kind === 'personal';
          return matchesLane && allowed[index];
        });
      }),
    );
    await assertResourceContextSnapshot(snapshot);
    return {
      data: Array.from(
        new Map(pages.flat().map((row) => [row.id, row])).values(),
      ),
      nextCursor: Object.values(next.lanes).some((value) => value !== null)
        ? Buffer.from(JSON.stringify(next)).toString('base64url')
        : null,
    };
  };
}
