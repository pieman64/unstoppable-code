/**
 * The checklist context an empty new chat publishes for its project's
 * curated template (CAN-3032): which bundled plugins count, and which
 * starter prompts win.
 */

import type { DesktopBlueprintCatalogEntry } from '@canopy/desktop-shared/types';
import {
  blueprintPluginRefs,
  buildOnboardingChatBlueprintContext,
} from '../blueprintContext';

const MARKETING_ID = '11111111-1111-4111-8111-111111111111';

function catalogEntry(
  overrides: Partial<DesktopBlueprintCatalogEntry['document']> = {},
): DesktopBlueprintCatalogEntry {
  return {
    externalId: MARKETING_ID,
    contentHash: 'a'.repeat(64),
    document: {
      version: 2,
      name: 'Marketing',
      description: 'Campaigns, copy, and launch content.',
      instructions: '# Marketing',
      plugins: [
        {
          type: 'claude_plugin',
          marketplace: { type: 'builtin', id: 'app' },
          plugin_name: 'builtin-git',
        },
        {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'campaign-brief-helper',
        },
        {
          type: 'plugin',
          marketplace: { type: 'github', repo: 'demo/market' },
          plugin_name: 'Slack',
        },
        {
          type: 'codex_plugin',
          marketplace: { type: 'codex_builtin', id: 'openai-curated' },
          plugin_name: 'slack',
        },
      ],
      customSkills: [],
      starterPrompts: [
        { id: 'ws-1', text: 'Draft a launch announcement' },
        { id: 'ws-2', text: 'Turn this brief into a content calendar' },
      ],
      ...overrides,
    },
  };
}

describe('blueprintPluginRefs', () => {
  it('keeps plugin refs with their sources in document order, skipping skills and repeats', () => {
    const [git, , slackFromGitHub, slackFromCodex] =
      catalogEntry().document.plugins;
    expect(blueprintPluginRefs(catalogEntry().document.plugins)).toEqual([
      git,
      slackFromGitHub,
      // Same name, different source: a different plugin, so both stay.
      slackFromCodex,
    ]);
  });
});

describe('buildOnboardingChatBlueprintContext', () => {
  it('is null for a plain project or when the catalog does not carry the seed', () => {
    expect(
      buildOnboardingChatBlueprintContext({ id: 'plain' }, catalogEntry()),
    ).toBeNull();
    expect(
      buildOnboardingChatBlueprintContext(
        { id: 'seeded', seededFromBlueprintExternalId: MARKETING_ID },
        undefined,
      ),
    ).toBeNull();
    expect(
      buildOnboardingChatBlueprintContext(
        {
          id: 'seeded',
          seededFromBlueprintExternalId: '22222222-2222-4222-8222-222222222222',
        },
        catalogEntry(),
      ),
    ).toBeNull();
  });

  it('prefers the project’s own starter prompts and selections over the template’s', () => {
    const selections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'builtin', pluginName: 'builtin-git' }],
    };
    expect(
      buildOnboardingChatBlueprintContext(
        {
          id: 'seeded',
          seededFromBlueprintExternalId: MARKETING_ID,
          starterPrompts: [{ id: 'own-1', text: 'My own prompt' }],
          defaultPluginSelections: selections,
        },
        catalogEntry(),
      ),
    ).toEqual({
      projectId: 'seeded',
      externalId: MARKETING_ID,
      name: 'Marketing',
      pluginRefs: blueprintPluginRefs(catalogEntry().document.plugins),
      starterPrompts: [{ id: 'own-1', text: 'My own prompt' }],
      projectSelections: selections,
    });
  });

  it('falls back to the template’s starter prompts when the project owns none', () => {
    expect(
      buildOnboardingChatBlueprintContext(
        { id: 'seeded', seededFromBlueprintExternalId: MARKETING_ID },
        catalogEntry(),
      ),
    ).toMatchObject({
      starterPrompts: [
        { id: 'ws-1', text: 'Draft a launch announcement' },
        { id: 'ws-2', text: 'Turn this brief into a content calendar' },
      ],
      projectSelections: null,
    });
  });
});
