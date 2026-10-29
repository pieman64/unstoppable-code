/** @jest-environment jsdom */
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

it('projects source counts and bulk progress without private filter text (CAN-4262)', () => {
  const snapshot = buildCurrentUiStateSnapshot({
    'plugins.marketplaceSources': {
      sourceCount: 2,
      invalidCount: 1,
      selectedSourceId: 'source',
      loading: false,
      refreshing: true,
      listError: false,
      busySourceIds: ['source'],
      filters: {
        query: 'private repository',
        searchActive: true,
        categoryActive: false,
        authorActive: true,
      },
      bulkInstall: { running: true, cancelling: true, done: 1, total: 3 },
    },
  });
  expect(snapshot.plugins?.marketplaceSources).toMatchObject({
    sourceCount: 2,
    invalidCount: 1,
    selectedSourceId: 'source',
    refreshing: true,
    filters: { searchActive: true, categoryActive: false, authorActive: true },
    bulkInstall: { running: true, cancelling: true, done: 1, total: 3 },
  });
  expect(JSON.stringify(snapshot.plugins)).not.toContain('private repository');
});
