import {
  contextOrganizationId,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';

export type ResourceLane =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };

export function lanesForContext(
  context: WorkspaceContext,
  personalOrganizationId: string | null = null,
): ResourceLane[] {
  const organizationId = contextOrganizationId(context, personalOrganizationId);
  return [
    { kind: 'personal' },
    ...(organizationId === null
      ? []
      : [{ kind: 'organization' as const, organizationId }]),
  ];
}

export function laneKey(lane: ResourceLane): string {
  return lane.kind === 'personal'
    ? 'personal'
    : `organization:${lane.organizationId}`;
}

export interface LaneVersion {
  account: string;
  authorization: string;
}

export interface LaneState<T> {
  cursor: string | null;
  etag?: string;
  value?: T;
  inFlight?: Promise<T>;
  version: LaneVersion;
}

/** Hosts own composition; a lane never borrows another lane's authorization. */
export class LanePartitioned<T> {
  private readonly states = new Map<string, LaneState<T>>();

  get(lane: ResourceLane, version: LaneVersion): LaneState<T> {
    const key = laneKey(lane);
    const existing = this.states.get(key);
    if (
      existing?.version.account === version.account &&
      existing.version.authorization === version.authorization
    )
      return existing;
    const state: LaneState<T> = { cursor: null, version: { ...version } };
    this.states.set(key, state);
    return state;
  }

  clear(): void {
    this.states.clear();
  }

  run(
    lane: ResourceLane,
    version: LaneVersion,
    fetch: () => Promise<T>,
  ): Promise<T> {
    const state = this.get(lane, version);
    if (state.inFlight) return state.inFlight;
    const operation = fetch().then((value): T => {
      if (this.states.get(laneKey(lane)) !== state)
        throw new Error('Resource lane changed');
      state.value = value;
      return value;
    });
    state.inFlight = operation;
    const settled = (): void => {
      if (state.inFlight === operation) state.inFlight = undefined;
    };
    void operation.then(settled, settled);
    return operation;
  }
}

export interface LanePagePosition {
  cursor: string | null;
  offset: number;
}

export interface ResourceLanePage<T> {
  lane: ResourceLane;
  position: LanePagePosition;
  data: T[];
  nextCursor: string | null;
}

/** Compose fetched lane pages in their deterministic input order. */
export function composeLanePages<T>(
  pages: ResourceLanePage<T>[],
  limit: number,
): { data: T[]; lanes: Record<string, LanePagePosition> } {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error('Invalid resource page limit');
  const data: T[] = [];
  const lanes: Record<string, LanePagePosition> = {};
  for (const page of pages) {
    const rows = page.data.slice(
      page.position.offset,
      page.position.offset + limit - data.length,
    );
    data.push(...rows);
    const offset = page.position.offset + rows.length;
    lanes[laneKey(page.lane)] =
      offset < page.data.length
        ? { cursor: page.position.cursor, offset }
        : { cursor: page.nextCursor, offset: 0 };
  }
  return { data, lanes };
}
