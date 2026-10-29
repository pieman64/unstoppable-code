jest.mock('@/lib/brand', () => ({ brandText: { appName: 'App' } }));

import type { DesktopPublisherSkill } from '@canopy/desktop-shared/types/skills';
import { entryIdForSelection } from '../relatedCapabilities';
import { CUSTOM_SKILL_SOURCE_ID } from '../sharedSkillImport';
import {
  buildUnifiedPluginEntries,
  visibleEntryId,
} from '../unifiedPluginEntries';

function publisherSkill(
  overrides: Partial<DesktopPublisherSkill> = {},
): DesktopPublisherSkill {
  return {
    externalId: 'publisher-pdf',
    name: 'pdf',
    description: 'Reads PDFs',
    publisher: 'Anthropic',
    ...overrides,
  };
}

describe('visibleEntryId', () => {
  it('opens a local copy folded into its publisher entry through that entry', () => {
    expect(
      visibleEntryId('skill:custom:app:pdf', [
        publisherSkill({ installedSkillName: 'pdf' }),
      ]),
    ).toBe('public-share:skill:publisher-pdf');
  });

  it('recognizes the entry id the Marketplace builds for a local skill', () => {
    const entryId = entryIdForSelection(
      { kind: 'skill', sourceId: CUSTOM_SKILL_SOURCE_ID, skillName: 'pdf' },
      [],
    );
    expect(
      visibleEntryId(entryId, [publisherSkill({ installedSkillName: 'pdf' })]),
    ).toBe('public-share:skill:publisher-pdf');
  });

  it('keeps every other entry id as it is', () => {
    const publishers = [publisherSkill({ installedSkillName: 'pdf' })];
    expect(visibleEntryId('skill:custom:app:pdf-2', publishers)).toBe(
      'skill:custom:app:pdf-2',
    );
    expect(visibleEntryId('skill:github:acme:tools:pdf', publishers)).toBe(
      'skill:github:acme:tools:pdf',
    );
    expect(visibleEntryId('skill:custom:app:pdf', [publisherSkill()])).toBe(
      'skill:custom:app:pdf',
    );
  });
});

describe('publisher skill entries', () => {
  // CAN-2989: the web's canonical skill detail is the Marketplace route. The
  // entry must derive its path from the protocol helper rather than spell a
  // path of its own, so it cannot drift from where the web serves the skill.
  it('points a publisher skill at the canonical web share path', () => {
    const externalId = '8f0d2c4e-6a1b-5c3d-9e7f-0a1b2c3d4e5f';
    const [entry] = buildUnifiedPluginEntries({
      curatedPlugins: [],
      marketplaces: [],
      installedSkills: [],
      mcpServers: [],
      mcpStatuses: [],
      curatedMcpServers: [],
      providerConnectors: [],
      publisherSkills: [
        {
          externalId,
          name: 'charts',
          description: 'Draw charts',
          publisher: 'OpenAI plugins',
        },
      ],
    }).filter((candidate) => candidate.ref.type === 'public-share');

    expect(entry?.ref).toMatchObject({
      type: 'public-share',
      shareKind: 'skill',
      externalId,
      sharePath: `/portal/plugins/skills/shared/${externalId}`,
    });
  });
});
