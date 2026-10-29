import {
  isMarketplaceSourcesTab,
  MARKETPLACE_TYPE_TABS,
  marketplaceEntityTypeLabel,
  marketplaceKindToneClass,
  marketplaceKindFilterForEntryKind,
  marketplaceTypeTabs,
  marketplaceTabKinds,
  marketplaceTabForKind,
  marketplaceEntryInTab,
  normalizeMarketplaceNavigation,
} from '../marketplace-type-tabs';

describe('marketplace entity types (CAN-3484)', () => {
  it('maps every tab kind to itself and names it after its tab', () => {
    for (const tab of MARKETPLACE_TYPE_TABS) {
      if (tab.id === 'all') continue;
      for (const kind of marketplaceTabKinds(tab.id))
        expect(marketplaceTabForKind(kind)).toBe(tab.id);
    }
  });

  it('combines Pipelines and Automations into Workflows', () => {
    expect(marketplaceTypeTabs().map((tab) => tab.id)).toEqual([
      'all',
      'plugin',
      'app',
      'skill',
      'workflow',
      'collection',
    ]);
    expect(marketplaceKindFilterForEntryKind('automation')).toBe('automation');
    expect(marketplaceEntityTypeLabel('automation')).toBe('Workflows');
  });
});

describe('shared agents and project templates (CAN-3009)', () => {
  it('gives agents and project templates a type tab of their own', () => {
    expect(marketplaceKindFilterForEntryKind('agent')).toBe('agent');
    expect(marketplaceKindFilterForEntryKind('blueprint')).toBe('blueprint');
    expect(marketplaceEntityTypeLabel('agent')).toBe('Agents');
  });

  it('never shows the internal name for a project template', () => {
    expect(marketplaceEntityTypeLabel('blueprint')).toBe('Project templates');
    expect(MARKETPLACE_TYPE_TABS.map((tab) => tab.label).join(' ')).not.toMatch(
      /blueprint/i,
    );
  });

  it('adds a tab only for a kind the host can load', () => {
    expect(
      marketplaceTypeTabs({ agents: true })
        .map((tab) => tab.id)
        .slice(-2),
    ).toEqual(['collection', 'agent']);
    expect(
      marketplaceTypeTabs({ projectTemplates: true })
        .map((tab) => tab.id)
        .slice(-2),
    ).toEqual(['collection', 'blueprint']);
    expect(
      marketplaceTypeTabs({ agents: true, projectTemplates: true })
        .map((tab) => tab.id)
        .slice(-3),
    ).toEqual(['collection', 'agent', 'blueprint']);
  });
});

it('keeps workflow entry kinds distinct and excludes unrelated entries', () => {
  expect(marketplaceTabKinds('workflow')).toEqual(['pipeline', 'automation']);
  expect(marketplaceEntryInTab({ kind: 'automation' }, 'workflow')).toBe(true);
  expect(marketplaceEntryInTab({ kind: 'pipeline' }, 'workflow')).toBe(true);
  expect(marketplaceEntryInTab({ kind: 'skill' }, 'workflow')).toBe(false);
  expect(marketplaceTabForKind('automation')).toBe('workflow');
  expect(marketplaceTabForKind('pipeline')).toBe('workflow');
});

it('normalizes legacy navigation and ownership only at the boundary', () => {
  expect(normalizeMarketplaceNavigation('automation', 'shared-by-me')).toEqual({
    tab: 'workflow',
    focusSection: 'shared-by-me',
  });
  expect(normalizeMarketplaceNavigation('pipeline')).toEqual({
    tab: 'workflow',
  });
  expect(normalizeMarketplaceNavigation('app', 'shared-by-me')).toEqual({
    tab: 'app',
  });
  expect(normalizeMarketplaceNavigation('unknown')).toEqual({ tab: 'all' });
});

it('keeps Sources outside catalog tab membership and gates its visibility', () => {
  expect(isMarketplaceSourcesTab('sources')).toBe(true);
  expect(marketplaceTypeTabs({ sources: true }).at(-1)?.id).toBe('sources');
  expect(marketplaceTypeTabs().some((tab) => tab.id === 'sources')).toBe(false);
  expect(marketplaceTabKinds('sources')).toEqual([]);
  expect(marketplaceEntryInTab({ kind: 'plugin' }, 'sources')).toBe(false);
});

describe('Customize type label tints (CAN-4261)', () => {
  it('gives each kind one muted ink, with workflows sharing one', () => {
    expect(marketplaceKindToneClass('skill')).toBe('fg-kind-skill');
    expect(marketplaceKindToneClass('pipeline')).toBe('fg-kind-workflow');
    expect(marketplaceKindToneClass('automation')).toBe('fg-kind-workflow');
    expect(marketplaceKindToneClass('plugin')).toBe('fg-kind-plugin');
    expect(marketplaceKindToneClass('app')).toBe('fg-kind-mcp');
    expect(marketplaceKindToneClass('collection')).toBe('fg-kind-collection');
    expect(marketplaceKindToneClass('agent')).toBe('fg-kind-agent');
    expect(marketplaceKindToneClass('blueprint')).toBe('fg-kind-template');
  });
});
