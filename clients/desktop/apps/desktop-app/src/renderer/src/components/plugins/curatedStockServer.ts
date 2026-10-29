import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import type { McpServerData } from '@canopy/desktop-shared/types/mcp-servers';
import {
  curatedInitialUrl,
  curatedMetadataFromEntry,
  oauthFromCuratedHints,
  validateOAuthForm,
} from '../pages/McpServersTab';

/** Stable serialization: sorted keys, `undefined` members dropped. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The device server Add creates for a catalog entry. */
export function stockCuratedServerData(
  entry: CuratedMcpServerEntry,
  options: { now?: string; configId?: string } = {},
): { server: McpServerData } | { error: string } {
  const validation = validateOAuthForm(oauthFromCuratedHints(entry));
  if (validation.error) return { error: validation.error };
  const now = options.now ?? new Date().toISOString();
  return {
    server: {
      definition: {
        id: '',
        name: entry.name,
        description: entry.shortDescription,
        type: 'http',
        url: curatedInitialUrl(entry),
        httpAuthHandler: 'canopy',
        oauth: validation.oauth ?? undefined,
        curated: curatedMetadataFromEntry(entry),
        createdAt: now,
        updatedAt: now,
      },
      configs: [
        {
          id: options.configId ?? crypto.randomUUID(),
          name: 'Default',
          description: '',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  };
}

function comparableUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const userinfo =
      parsed.username || parsed.password
        ? `${parsed.username}:${parsed.password}@`
        : '';
    return `${parsed.protocol}//${userinfo}${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

// Identity, bookkeeping, and display text. Everything else, including any
// field this list does not know, has to match the stock server.
const IGNORED_DEFINITION_FIELDS = new Set([
  'id',
  'name',
  'description',
  'createdAt',
  'updatedAt',
]);
const IGNORED_CONFIG_FIELDS = new Set([
  'id',
  'name',
  'description',
  'createdAt',
  'updatedAt',
]);

function project(
  record: object,
  ignored: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !ignored.has(key)),
  );
}

function connectionProjection(server: McpServerData): string {
  const definition = project(server.definition, IGNORED_DEFINITION_FIELDS);
  const curated = server.definition.curated;
  return stableJson({
    ...definition,
    url: comparableUrl(definition.url),
    httpAuthHandler: server.definition.httpAuthHandler,
    curated: curated
      ? {
          key: curated.key,
          requiresProviderAuth: curated.requiresProviderAuth === true,
        }
      : undefined,
    configs: server.configs.map((config) =>
      project(config, IGNORED_CONFIG_FIELDS),
    ),
  });
}

/**
 * Whether a device server is what Add would create for this entry, so the
 * account connection can stand in for it without losing anything the user
 * set up. Only identity, timestamps, and display text may differ.
 */
export function matchesStockCuratedServer(
  entry: CuratedMcpServerEntry,
  server: McpServerData,
): boolean {
  const stock = stockCuratedServerData(entry);
  if ('error' in stock) return false;
  return connectionProjection(server) === connectionProjection(stock.server);
}
