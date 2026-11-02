import { EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS } from '@canopy/protocol/experiments';
import type * as FeatureFlags from '@canopy/protocol/feature-flags';
import type * as LabsExperiments from '../labs-experiments';
import {
  LABS_EXPERIMENTS,
  validateLabsExperiments,
  parseLabsExperimentFixtures,
  hiddenLabsSidebarKeys,
  labsOwnedSidebarKeys,
  findLabsExperimentForPage,
  type LabsExperiment,
} from '../labs-experiments';
const page: LabsExperiment = {
  id: 'plugins-preview',
  name: 'Plugins preview',
  description: 'Preview.',
  pages: ['plugins'],
  sidebarKeys: ['plugins'],
  flagKey: 'fixture-plugins',
  requiresEarlyAccess: true,
  fixtureAvailability: 'offered',
};
const PAGE_EXPERIMENTS = [
  ['overview-page', 'overview', 'canopy-desktop-labs-overview-page'],
  ['kanban-page', 'kanban', 'canopy-desktop-labs-kanban-page'],
  ['statistics-page', 'statistics', 'canopy-desktop-labs-statistics-page'],
  ['audit-trail-page', 'audit', 'canopy-desktop-labs-audit-trail-page'],
] as const;
describe('experiment registry', () => {
  it('offers Files reads independently without owning navigation or inheriting Early access', () => {
    expect(
      LABS_EXPERIMENTS.find((entry) => entry.id === 'daemon-files-reads'),
    ).toMatchObject({
      flagKey: 'canopy-desktop-labs-daemon-files-reads',
      requiresEarlyAccess: false,
      pages: [],
      sidebarKeys: [],
    });
    expect(EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS).not.toContain(
      'daemon-files-reads',
    );
  });
  // CAN-4551: off by default, so no automation converts until someone opts in.
  it('offers chat automation pipelines independently, owning no navigation', () => {
    expect(
      LABS_EXPERIMENTS.find(
        (entry) => entry.id === 'chat-automation-pipelines',
      ),
    ).toMatchObject({
      flagKey: 'canopy-desktop-labs-chat-automation-pipelines',
      requiresEarlyAccess: false,
      pages: [],
      sidebarKeys: [],
    });
    expect(EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS).not.toContain(
      'chat-automation-pipelines',
    );
  });
  it('keeps only the Appearance preference, Files reads, chat automation pipelines and pages after UI graduation', () => {
    expect(LABS_EXPERIMENTS.map((entry) => entry.id)).toEqual([
      'early-access',
      'sidebar',
      'activity-card',
      'daemon-files-reads',
      'chat-automation-pipelines',
      ...PAGE_EXPERIMENTS.map(([id]) => id),
    ]);
  });
  it('registers Early access without navigation ownership and four independent page experiments', () => {
    expect(LABS_EXPERIMENTS[0]).toMatchObject({
      pages: [],
      sidebarKeys: [],
      requiresEarlyAccess: false,
    });
    for (const [id, owned, flagKey] of PAGE_EXPERIMENTS)
      expect(LABS_EXPERIMENTS.find((entry) => entry.id === id)).toMatchObject({
        pages: [owned],
        sidebarKeys: [owned],
        flagKey,
        requiresEarlyAccess: false,
      });
    expect(
      LABS_EXPERIMENTS.find((entry) => entry.id === 'audit-trail-page')?.name,
    ).toBe('Audit trail');
    expect(() => validateLabsExperiments(LABS_EXPERIMENTS)).not.toThrow();
  });
  it('rejects a registry flag that is not a Labs availability flag', () => {
    jest.isolateModules(() => {
      jest.doMock(
        '@canopy/protocol/feature-flags',
        (): typeof FeatureFlags => ({
          ...jest.requireActual<typeof FeatureFlags>(
            '@canopy/protocol/feature-flags',
          ),
          isLabsExperimentFlagKey: (key: string): boolean =>
            key !== 'canopy-desktop-labs-kanban-page',
        }),
      );
      expect(() =>
        jest.requireActual<typeof LabsExperiments>('../labs-experiments'),
      ).toThrow('Invalid experiment flag defaults.');
    });
  });
  it('rejects an Early access entry that requires itself', () => {
    expect(() =>
      validateLabsExperiments([
        { ...LABS_EXPERIMENTS[0], requiresEarlyAccess: true },
      ]),
    ).toThrow('Early access cannot require itself.');
  });
  it('hides every experiment-owned sidebar key before the snapshot is ready', () => {
    expect(hiddenLabsSidebarKeys(null)).toEqual([
      'overview',
      'kanban',
      'statistics',
      'audit',
    ]);
  });
  it('validates fixture metadata and retains navigation helpers', () => {
    const entries = [
      ...LABS_EXPERIMENTS,
      ...parseLabsExperimentFixtures([page]),
    ];
    expect(findLabsExperimentForPage('plugins', entries)).toEqual(page);
    expect(hiddenLabsSidebarKeys(null, entries)).toContain('plugins');
  });
  it('lists every sidebar key the registry owns, in registry order', () => {
    expect(labsOwnedSidebarKeys()).toEqual([
      'overview',
      'kanban',
      'statistics',
      'audit',
    ]);
  });
  it('owns a key whether or not its experiment is on', () => {
    const allOff = hiddenLabsSidebarKeys(null);
    expect(labsOwnedSidebarKeys(LABS_EXPERIMENTS)).toEqual(allOff);
  });
  it('owns fixture keys and drops keys whose experiment left the registry', () => {
    const feed = { ...page, id: 'feed-preview', sidebarKeys: ['feed'] };
    const entries = [
      ...LABS_EXPERIMENTS.filter((entry) => entry.id !== 'kanban-page'),
      ...parseLabsExperimentFixtures([feed]),
    ];
    const owned = labsOwnedSidebarKeys(entries);
    expect(owned).toContain('feed');
    expect(owned).not.toContain('kanban');
  });
  it('lists a key owned by two experiments once', () => {
    const twin: LabsExperiment = {
      ...page,
      id: 'kanban-twin',
      sidebarKeys: ['kanban'],
    };
    const owned = labsOwnedSidebarKeys([...LABS_EXPERIMENTS, twin]);
    expect(owned.filter((key) => key === 'kanban')).toHaveLength(1);
  });
  it('defaults fixtures to requiring Early access', () => {
    const withoutField = {
      id: page.id,
      name: page.name,
      description: page.description,
      pages: page.pages,
      sidebarKeys: page.sidebarKeys,
      flagKey: page.flagKey,
      fixtureAvailability: page.fixtureAvailability,
    };
    expect(parseLabsExperimentFixtures([withoutField])[0]).toMatchObject({
      requiresEarlyAccess: true,
    });
    expect(
      parseLabsExperimentFixtures([
        { ...withoutField, requiresEarlyAccess: false },
      ])[0],
    ).toMatchObject({ requiresEarlyAccess: false });
  });
  it('caps fixtures so registry plus fixtures fit the snapshot', () => {
    const fixtures = (count: number): LabsExperiment[] =>
      Array.from({ length: count }, (_, index) => ({
        ...page,
        id: `fixture-${index}`,
        flagKey: `fixture-flag-${index}`,
        pages: [],
        sidebarKeys: [],
      }));
    const room = 100 - LABS_EXPERIMENTS.length;
    expect(parseLabsExperimentFixtures(fixtures(room))).toHaveLength(room);
    expect(() => parseLabsExperimentFixtures(fixtures(room + 1))).toThrow();
  });
  it.each([
    { ...page, id: 'early-access' },
    { ...page, id: 'BAD' },
    { ...page, pages: ['unknown'] },
    { ...page, sidebarKeys: ['unknown'] },
    { ...page, fixtureAvailability: 'bad' },
    { ...page, name: '' },
    { ...page, flagKey: 'canopy-desktop-labs-early-access' },
    { ...page, pages: ['plugins', 'plugins'] },
    { ...page, id: 'audit-copy', pages: ['audit'], sidebarKeys: [] },
    { ...page, id: 'kanban-copy', pages: [], sidebarKeys: ['kanban'] },
  ])('rejects invalid fixtures %p', (fixture) => {
    expect(() => parseLabsExperimentFixtures([fixture])).toThrow();
  });
  it('rejects duplicate ownership, flag keys, ids and invalid production defaults', () => {
    expect(() =>
      parseLabsExperimentFixtures([
        page,
        { ...page, id: 'second', flagKey: 'second' },
      ]),
    ).toThrow();
    expect(() => validateLabsExperiments([page])).toThrow();
    expect(() =>
      validateLabsExperiments([
        {
          ...page,
          fixtureAvailability: undefined,
          flagKey: 'canopy-portal-enabled',
        },
      ]),
    ).toThrow();
  });
});
