import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Mirrors `SHARED_WORKSPACE_TEMPLATE_API_VERSION` in
 * `packages/protocol/src/workspace-templates/index.ts`. Kept as a literal
 * here (this is a plain .mjs harness fixture, not part of the TS build graph);
 * the main-process reader rejects the whole cache on any drift, so a bump
 * there fails this fixture loudly rather than silently.
 */
const WORKSPACE_TEMPLATE_API_VERSION = 2;

/**
 * The seeded curated Blueprints. `externalId` must be a real UUID and
 * `contentHash` 64 lowercase hex characters: `normalizeCachedBlueprint()` in
 * `apps/desktop-app/src/main/blueprints/blueprint-catalog.ts` rejects the
 * ENTIRE cache (returns null, not a filtered list) on the first bad entry.
 */
const BLUEPRINT_DEFS = [
  {
    externalId: '11111111-1111-4111-8111-111111111111',
    contentHash: 'a'.repeat(64),
    name: 'Marketing',
    description: 'Campaigns, copy, and launch content.',
    instructions: '# Marketing\n\nWrite in a clear, concrete voice.\n',
    starterPrompts: [
      { id: 'ws-1', text: 'Draft a launch announcement' },
      { id: 'ws-2', text: 'Turn this brief into a content calendar' },
    ],
    customSkills: [
      {
        clientKey: 'marketing-brief-helper',
        name: 'campaign-brief-helper',
        rawSkill:
          '---\nname: campaign-brief-helper\ndescription: Structures campaign briefs.\n---\n\nTurn campaign context into a concise brief.\n',
      },
    ],
    plugins: [
      {
        type: 'claude_plugin',
        marketplace: { type: 'builtin', id: 'app' },
        plugin_name: 'builtin-git',
      },
    ],
  },
  {
    externalId: '22222222-2222-4222-8222-222222222222',
    contentHash: 'b'.repeat(64),
    name: 'Student',
    description: 'Coursework, reading, and exam prep.',
    instructions: '# Student\n\nShow the working. Cite sources.\n',
    starterPrompts: [{ id: 'ws-1', text: 'Explain this reading to me' }],
  },
  {
    externalId: '33333333-3333-4333-8333-333333333333',
    contentHash: 'c'.repeat(64),
    name: 'Research',
    description: 'Literature review and synthesis.',
    instructions: '# Research\n\nSummarize before you conclude.\n',
    starterPrompts: [{ id: 'ws-1', text: 'Summarize these papers' }],
    requirements: [
      {
        id: 'mcp:linear',
        kind: 'mcp',
        displayName: 'Linear',
        required: true,
        affectedSteps: [],
        setupHint: 'Connect Linear in Settings.',
      },
    ],
    // A built-in skill ref that this device does not have. Deliberately
    // `builtin`, not `github`: `prepareDesktopWorkspaceTemplateRefs` only
    // reaches the network for GitHub-backed sources, so a builtin ref stays
    // fully offline and resolves to a stable `unmatched` result. Exercises the
    // seed path's unresolved-ref warning without a marketplace fetch.
    plugins: [
      {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'blueprint-missing-skill',
      },
    ],
  },
];

/**
 * Exactly the `SharedWorkspaceTemplateDocument` field set. There is no
 * `defaultPluginSelections` or `githubRepositories` on this contract:
 * `validateSharedWorkspaceTemplateDocument()` requires a `plugins` array of
 * shareable refs, and a document missing it fails validation, which makes
 * `normalizeCachedBlueprint()` reject the WHOLE seeded cache and leaves the
 * picker empty. A def may carry its own `plugins` refs or `customSkills`;
 * each must satisfy the shared document validator for the same reason.
 */
function documentFor(def) {
  return {
    version: WORKSPACE_TEMPLATE_API_VERSION,
    name: def.name,
    description: def.description,
    instructions: def.instructions,
    plugins: def.plugins ?? [],
    customSkills: def.customSkills ?? [],
    starterPrompts: def.starterPrompts,
  };
}

/**
 * Seeds the prefetched curated Blueprint catalog cache (CAN-2964 §6.1) so the
 * create-project picker resolves without any network access.
 *
 * Main-process reader: `apps/desktop-app/src/main/blueprints/blueprint-catalog.ts`
 *   `getBlueprintCatalogCacheFilePath()` →
 *   `path.join(getDataDir(), 'blueprint-catalog-cache.json')`
 *
 * `fetchedAt` is stamped at seed time so `cacheIsFresh()` passes its 24h gate
 * and `listBlueprints()` serves the cache instead of attempting a fetch. A
 * stale stamp would send the read to the cloud and the picker would render
 * empty.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @returns {{ cacheFilePath: string, blueprints: Array<object> }}
 */
export function seedBlueprintCatalog(options) {
  const { userDataDir } = options ?? {};
  if (!userDataDir) {
    throw new Error('seedBlueprintCatalog requires userDataDir');
  }
  const blueprints = BLUEPRINT_DEFS.map((def) => ({
    externalId: def.externalId,
    contentHash: def.contentHash,
    document: documentFor(def),
    ...(def.requirements ? { requirements: def.requirements } : {}),
  }));
  const cacheFilePath = path.join(userDataDir, 'blueprint-catalog-cache.json');
  writeJson(cacheFilePath, {
    cacheSchemaVersion: 1,
    apiVersion: WORKSPACE_TEMPLATE_API_VERSION,
    fetchedAt: new Date().toISOString(),
    blueprints,
  });
  return { cacheFilePath, blueprints };
}
