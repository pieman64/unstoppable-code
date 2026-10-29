import type {
  ProjectDiscoveryAction,
  PageResult,
} from '@canopy/desktop-shared/lib/project-discovery';
import type {
  ProjectOwnerContext,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import type { BotAction } from '@canopy/desktop-shared/lib/bot-discovery';
import type { ProjectDiscoveryCaller } from './index';
import { DiscoveryCursorStore } from './cursor-store';
import { DiscoveryError } from './errors';

const cursors = new DiscoveryCursorStore();

export function validateCursor(
  cursor: string | undefined,
  binding?: string,
): void {
  if (cursor !== undefined) cursors.assertLive(cursor, binding);
}

/** Sorted enum filters have set semantics; normalize them before binding. */
function normalized(value: unknown): AppAdvisorJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return value
      .map(normalized)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, AppAdvisorJson> = {};
    for (const [key, field] of Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (field !== undefined) result[key] = normalized(field);
    }
    return result;
  }
  throw new DiscoveryError(
    'execution_failed',
    'Discovery metadata could not be serialized.',
  );
}

export function cursorBinding(
  action: ProjectDiscoveryAction | Extract<BotAction, { sort: string }>,
  caller: ProjectDiscoveryCaller,
  owner: ProjectOwnerContext | null,
  accountEpoch: number,
): string {
  const { cursor, pageSize, ...query } = action;
  void cursor;
  void pageSize;
  return JSON.stringify(normalized({ accountEpoch, caller, owner, query }));
}

export function pageRows<T>(
  rows: T[],
  action: ProjectDiscoveryAction | Extract<BotAction, { sort: string }>,
  binding: string,
  identity: (row: T) => { id: string; incarnation: string },
  sortKey: (row: T) => string,
  freezeMatches = false,
): PageResult<T> {
  const page = cursors.page(
    rows.map((row) => ({ ...identity(row), sortKey: sortKey(row), row })),
    {
      binding,
      pageSize: action.pageSize,
      cursor: action.cursor,
      order: action.order,
      freezeMatches,
    },
  );
  return { ...page, items: page.items.map((item) => item.row) };
}

/** DTOs have optional fields; omit undefined exactly as JSON serialization does. */
export function toDiscoveryJson(value: unknown): AppAdvisorJson {
  const cloned: unknown = JSON.parse(JSON.stringify(value));
  return jsonValue(cloned);
}

function jsonValue(value: unknown): AppAdvisorJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, AppAdvisorJson> = {};
    for (const [key, field] of Object.entries(value))
      result[key] = jsonValue(field);
    return result;
  }
  throw new DiscoveryError(
    'execution_failed',
    'Discovery metadata could not be serialized.',
  );
}
