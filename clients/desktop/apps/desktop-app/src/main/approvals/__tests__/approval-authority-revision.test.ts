import {
  beginApprovalModeTransition,
  clearLiveApprovalMode,
  endApprovalModeTransition,
  setLiveApprovalMode,
} from '../live-approval-modes';
import {
  getApprovalAuthorityRevision,
  markApprovalDefaultsChanged,
  markChatApprovalStateChanged,
  markGlobalApprovalRulesChanged,
  markWorkspaceApprovalRulesChanged,
  onApprovalAuthorityRevision,
  trackPreferencesAuthoritySave,
  trackWorkspaceApprovalRulesSave,
} from '../rule-revisions';

/** Resolves after the listener batch the markers queued with queueMicrotask. */
function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(resolve);
  });
}

async function advancesRevision(mark: () => unknown): Promise<void> {
  const before = getApprovalAuthorityRevision();
  await mark();
  expect(getApprovalAuthorityRevision()).toBeGreaterThan(before);
}

describe('approval authority revision', () => {
  it('every authority mark advances the revision', async () => {
    await advancesRevision(() => markWorkspaceApprovalRulesChanged('w'));
    await advancesRevision(() => markGlobalApprovalRulesChanged());
    await advancesRevision(() => markApprovalDefaultsChanged());
    await advancesRevision(() =>
      markChatApprovalStateChanged({
        projectId: 'p',
        worktreeId: 't',
        chatId: 'c',
      }),
    );

    let settleWorkspaceSave: () => void = () => undefined;
    const workspaceSave = new Promise<void>((resolve) => {
      settleWorkspaceSave = resolve;
    });
    await advancesRevision(() => {
      void trackWorkspaceApprovalRulesSave('w', workspaceSave);
    });
    await advancesRevision(async () => {
      settleWorkspaceSave();
      await workspaceSave;
      await Promise.resolve();
    });

    let settlePreferencesSave: () => void = () => undefined;
    const preferencesSave = new Promise<void>((resolve) => {
      settlePreferencesSave = resolve;
    });
    await advancesRevision(() => {
      void trackPreferencesAuthoritySave(preferencesSave, {
        narrowsFileWrites: false,
      });
    });
    await advancesRevision(async () => {
      settlePreferencesSave();
      await preferencesSave;
      await Promise.resolve();
    });

    await advancesRevision(() => setLiveApprovalMode('p', 't', 'c', 'ask'));
    await advancesRevision(() => clearLiveApprovalMode('p', 't', 'c'));
    let generation = 0;
    await advancesRevision(() => {
      generation = beginApprovalModeTransition('p', 't', 'c', 'auto');
    });
    await advancesRevision(() =>
      endApprovalModeTransition('p', 't', 'c', generation),
    );
  });

  it('listeners run once per microtask with the newest revision', async () => {
    const seen: number[] = [];
    const unsubscribe = onApprovalAuthorityRevision((revision) => {
      seen.push(revision);
    });

    markGlobalApprovalRulesChanged();
    markApprovalDefaultsChanged();
    markWorkspaceApprovalRulesChanged('w');
    expect(seen).toEqual([]);

    await nextMicrotask();
    expect(seen).toEqual([getApprovalAuthorityRevision()]);

    unsubscribe();
    markApprovalDefaultsChanged();
    await nextMicrotask();
    expect(seen).toHaveLength(1);
  });

  it('a throwing listener does not stop the others', async () => {
    const seen: number[] = [];
    const unsubscribeThrowing = onApprovalAuthorityRevision(() => {
      throw new Error('listener failed');
    });
    const unsubscribe = onApprovalAuthorityRevision((revision) => {
      seen.push(revision);
    });

    markApprovalDefaultsChanged();
    await nextMicrotask();

    expect(seen).toEqual([getApprovalAuthorityRevision()]);
    unsubscribeThrowing();
    unsubscribe();
  });
});
