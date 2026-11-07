import * as fs from 'node:fs';
import { z } from 'zod';
import { isResourceOwner } from '@canopy/protocol/resource-owner';
import type { ResourceOwner } from '@canopy/protocol/resource-owner';
import type { PluginsCache, PluginsCacheV1 } from '../../types/plugins';

export type PluginReadHealth<Current, Legacy = never> =
  | { state: 'absent' }
  | { state: 'valid'; data: Current }
  | ([Legacy] extends [never] ? never : { state: 'legacy'; data: Legacy })
  | { state: 'unsupported'; version: number }
  | { state: 'damaged' }
  | { state: 'unreadable' };

export interface PluginCacheIndex {
  version: 1;
  entries: Record<
    string,
    { cachePath: string; sourceUrl: string; cachedAt: string }
  >;
}

// Validate known fields without discarding provider extensions on republish.
const text = z.string();
const optionalText = text.optional();
// Older scanners copied display metadata from unvalidated manifests.
const displayText = z.preprocess(
  (value) => (typeof value === 'string' ? value : undefined),
  optionalText,
);
const requiredDisplayText = z.preprocess(
  (value) => (typeof value === 'string' ? value : ''),
  text,
);
const displayLanguages = z.preprocess(
  (value) =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
      ? value
      : undefined,
  z.array(text).optional(),
);
const count = z.number().int().nonnegative();
const owner = z.custom<ResourceOwner>(isResourceOwner).optional();
const details = z
  .looseObject({
    skills: z.array(
      z.looseObject({
        name: text,
        description: requiredDisplayText,
        path: text,
        userInvocable: z.boolean().optional(),
      }),
    ),
    agents: z.array(
      z.looseObject({
        name: text,
        description: requiredDisplayText,
        filePath: text,
      }),
    ),
    commands: z.array(
      z.looseObject({
        name: text,
        description: requiredDisplayText,
        filePath: text,
      }),
    ),
    apps: z
      .array(
        z.looseObject({
          name: text,
          description: requiredDisplayText,
          filePath: text,
        }),
      )
      .optional(),
    hooks: z.array(
      z.looseObject({
        event: text,
        matcher: displayText,
        hookType: text,
        command: optionalText,
      }),
    ),
    mcpServers: z.array(
      z.looseObject({
        name: text,
        type: z.enum(['command', 'http']),
        command: optionalText,
        args: z.array(text).optional(),
        url: optionalText,
      }),
    ),
    lspServers: z.array(
      z.looseObject({
        name: text,
        command: text,
        args: z.array(text).optional(),
        languages: displayLanguages,
      }),
    ),
    hasReadme: z.boolean(),
  })
  .nullable();
const externalSource = z.looseObject({
  source: optionalText,
  url: optionalText,
  sha: optionalText,
});
const metadata = {
  name: text,
  displayName: displayText,
  description: displayText,
  version: displayText,
  author: displayText,
  category: displayText,
  homepage: displayText,
  logoUrl: displayText,
  sourcePath: text,
  externalSource: externalSource.optional(),
  cachePath: optionalText,
  cachedAt: optionalText,
  details: details.optional(),
};
const facet = z.looseObject({
  ...metadata,
  provider: z.enum(['claude', 'codex']),
  mode: z.enum(['native', 'compat']),
  installLocation: text,
  marketplacePath: optionalText,
});
const installStatus = z.looseObject({
  available: z.boolean(),
  installed: z.boolean(),
  enabled: z.boolean().optional(),
  version: displayText,
  installPath: optionalText,
  error: optionalText,
  installError: optionalText,
});
const plugin = z.looseObject({
  ...metadata,
  marketplaceId: text,
  owner,
  parked: z.boolean().optional(),
  tryNowPrompt: displayText,
  builtIn: z.boolean().optional(),
  curated: z.boolean().optional(),
  recommended: z.boolean().optional(),
  codexCompatDisabled: z.boolean().optional(),
  globalInstallStatus: z
    .looseObject({
      claude: installStatus.optional(),
      codex: installStatus.optional(),
      checkedAt: text,
    })
    .optional(),
  providerSupport: z.looseObject({
    claude: z.enum(['native', 'none']),
    codex: z.enum(['native', 'compat', 'none']),
  }),
  facets: z.looseObject({
    claude: facet
      .extend({ provider: z.literal('claude'), mode: z.literal('native') })
      .optional(),
    codex: facet
      .extend({ provider: z.literal('codex'), mode: z.literal('native') })
      .optional(),
    codexCompatibility: facet
      .extend({ provider: z.literal('codex'), mode: z.literal('compat') })
      .optional(),
  }),
});
const status = z.looseObject({
  provider: z.enum(['claude', 'codex']),
  state: z.enum(['valid', 'invalid']),
  accepted: z.boolean(),
  pluginCount: count,
  lastCheckedAt: text,
  error: optionalText,
  marketplaceName: optionalText,
  marketplacePath: optionalText,
  installLocation: optionalText,
  structurallyInvalidAtRevision: optionalText,
});
const marketplace = z
  .looseObject({
    id: text,
    name: z.unknown(),
    description: displayText,
    owner,
    sourceType: text,
    sourceUrl: text,
    builtIn: z.boolean().optional(),
    curated: z.boolean().optional(),
    removable: z.boolean().optional(),
    installLocation: text,
    lastUpdated: optionalText,
    pluginCount: count,
    plugins: z.array(plugin),
    providerStatus: z.looseObject({
      claude: status.extend({ provider: z.literal('claude') }),
      codex: status.extend({ provider: z.literal('codex') }),
    }),
    validProviders: z.array(z.enum(['claude', 'codex'])),
  })
  .transform((row) => ({
    ...row,
    name: typeof row.name === 'string' ? row.name : row.id,
  }));
const catalog: z.ZodType<PluginsCache> = z.looseObject({
  version: z.literal(2),
  lastRefreshed: text,
  lastProviderRefreshAt: optionalText,
  marketplaces: z.array(marketplace),
});
const legacyPlugin = z.looseObject({
  name: text,
  description: requiredDisplayText,
  version: requiredDisplayText,
  author: requiredDisplayText,
  category: requiredDisplayText,
  homepage: requiredDisplayText,
  sourcePath: text,
  marketplaceId: text,
  details,
  externalSource: z
    .looseObject({ url: optionalText, sha: optionalText })
    .nullable(),
  cachePath: text.nullable(),
  cachedAt: text.nullable(),
});
const legacyCatalog: z.ZodType<PluginsCacheV1> = z.looseObject({
  version: z.literal(1),
  lastRefreshed: text,
  marketplaces: z.array(
    z
      .looseObject({
        id: text,
        name: z.unknown(),
        description: requiredDisplayText,
        sourceType: text,
        sourceUrl: text,
        installLocation: text,
        lastUpdated: text,
        pluginCount: count,
        plugins: z.array(legacyPlugin),
      })
      .transform((row) => ({
        ...row,
        name: typeof row.name === 'string' ? row.name : row.id,
      })),
  ),
});
const index: z.ZodType<PluginCacheIndex> = z.looseObject({
  version: z.literal(1),
  entries: z.record(
    text,
    z.looseObject({ cachePath: text, sourceUrl: text, cachedAt: text }),
  ),
});
const versioned = z.looseObject({ version: z.number().int().nonnegative() });

export function decodePluginCatalog(
  value: unknown,
): PluginReadHealth<PluginsCache, PluginsCacheV1> {
  const version = versioned.safeParse(value);
  if (!version.success) return { state: 'damaged' };
  if (version.data.version === 1) {
    const result = legacyCatalog.safeParse(value);
    return result.success
      ? { state: 'legacy', data: result.data }
      : { state: 'damaged' };
  }
  if (version.data.version !== 2)
    return { state: 'unsupported', version: version.data.version };
  const result = catalog.safeParse(value);
  if (!result.success) return { state: 'damaged' };
  return {
    state: 'valid',
    data: {
      ...result.data,
      marketplaces: result.data.marketplaces.map((row) => {
        const codex = row.providerStatus.codex;
        return codex.state === 'invalid' && codex.accepted
          ? {
              ...row,
              validProviders: row.validProviders.filter(
                (provider) => provider !== 'codex',
              ),
              providerStatus: {
                ...row.providerStatus,
                codex: { ...codex, accepted: false },
              },
            }
          : row;
      }),
    },
  };
}

export function decodePluginCacheIndex(
  value: unknown,
): PluginReadHealth<PluginCacheIndex> {
  const version = versioned.safeParse(value);
  if (!version.success) return { state: 'damaged' };
  if (version.data.version !== 1)
    return { state: 'unsupported', version: version.data.version };
  const result = index.safeParse(value);
  return result.success
    ? { state: 'valid', data: result.data }
    : { state: 'damaged' };
}

type ReadBytes = (filePath: string) => Uint8Array;
function readPluginFile<Current, Legacy>(
  filePath: string,
  decode: (value: unknown) => PluginReadHealth<Current, Legacy>,
  read: ReadBytes,
): PluginReadHealth<Current, Legacy> {
  let bytes: Uint8Array;
  try {
    bytes = read(filePath);
  } catch (error) {
    return typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'unreadable' };
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    return decode(value);
  } catch {
    return { state: 'damaged' };
  }
}

export function readPluginCatalog(
  filePath: string,
  read: ReadBytes = (file) => fs.readFileSync(file),
): PluginReadHealth<PluginsCache, PluginsCacheV1> {
  return readPluginFile<PluginsCache, PluginsCacheV1>(
    filePath,
    decodePluginCatalog,
    read,
  );
}

export function readPluginCacheIndex(
  filePath: string,
  read: ReadBytes = (file) => fs.readFileSync(file),
): PluginReadHealth<PluginCacheIndex> {
  return readPluginFile<PluginCacheIndex, never>(
    filePath,
    decodePluginCacheIndex,
    read,
  );
}
