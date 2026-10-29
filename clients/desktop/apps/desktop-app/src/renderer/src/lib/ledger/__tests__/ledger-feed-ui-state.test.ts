import { createLedgerFeedStore, type LedgerFeedState } from '@canopy/app-state';
import { ledgerFeedUiState } from '../ledger-feed-ui-state';

function feedState(composer: LedgerFeedState['composer']): LedgerFeedState {
  const store = createLedgerFeedStore({
    searchFeed: () => Promise.reject(new Error('Not read')),
    getFeedEntry: () => Promise.reject(new Error('Not read')),
  });
  return { ...store.getState(), composer };
}

describe('ledgerFeedUiState', () => {
  const SCOPE = { projectId: 'project-1', worktreeId: 'wt-1' };

  it('reports where the new entry goes while its form is open', () => {
    expect(
      ledgerFeedUiState(
        feedState({
          shown: true,
          projectId: 'project-1',
          scope: SCOPE,
          draft: null,
        }),
      ),
    ).toMatchObject({
      addingEntry: true,
      draftProjectId: 'project-1',
      draftWorktreeId: 'wt-1',
    });
  });

  it('reports nothing of a draft set aside', () => {
    const state = ledgerFeedUiState(
      feedState({
        shown: false,
        projectId: 'project-1',
        scope: SCOPE,
        draft: null,
      }),
    );

    expect(state).not.toHaveProperty('addingEntry');
    expect(state).not.toHaveProperty('draftProjectId');
    expect(state).not.toHaveProperty('draftWorktreeId');
  });
});
