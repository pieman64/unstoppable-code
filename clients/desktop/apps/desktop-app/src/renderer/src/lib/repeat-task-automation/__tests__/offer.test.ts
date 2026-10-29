/**
 * @jest-environment jsdom
 */
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  AutomationAction,
  AutomationsListResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { REPEAT_TASK_HISTORY_STORAGE_KEY } from '../history';
import {
  answerRepeatTaskOffer,
  loadRepeatTaskAccountKey,
  maybeOfferRepeatTaskAutomation,
} from '../offer';
import type { RepeatTaskOfferDeps } from '../offer';
import { useRepeatTaskOfferStore } from '../offerStore';
import { stopRepeatTaskSuggestions } from '../settings';
import type { HomeTaskSnapshot } from '../types';

type OpenAutomationDraft = ReturnType<
  typeof useNavigationStore.getState
>['openAutomationDraft'];

interface MemoryStorage extends Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
> {
  read(): string | null;
}

function createStorage(): MemoryStorage {
  let value: string | null = null;
  return {
    getItem: (key: string): string | null =>
      key === REPEAT_TASK_HISTORY_STORAGE_KEY ? value : null,
    setItem: (key: string, nextValue: string): void => {
      if (key === REPEAT_TASK_HISTORY_STORAGE_KEY) value = nextValue;
    },
    removeItem: (key: string): void => {
      if (key === REPEAT_TASK_HISTORY_STORAGE_KEY) value = null;
    },
    read: (): string | null => value,
  };
}

function makeSnapshot(
  overrides: Partial<HomeTaskSnapshot> = {},
): HomeTaskSnapshot {
  return {
    surface: 'page',
    mode: 'chat',
    text: 'Summarize billing failures and group them by service',
    workspaceId: 'workspace-1',
    fileReferenceCount: 0,
    attachmentCount: 0,
    scheduled: false,
    linkTargetStatus: 'idle',
    accountEpoch: 0,
    ...overrides,
  };
}

function makeActivity(action: AutomationAction): ScheduledActivity {
  return {
    version: 1,
    id: 'automation-1',
    name: 'Daily digest',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    failureCount: 0,
  };
}

function installApi(value: unknown): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value,
  });
}

function readHistory(storage: MemoryStorage): unknown {
  const raw = storage.read();
  return raw === null ? null : JSON.parse(raw);
}

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
const originalOpenAutomationDraft =
  useNavigationStore.getState().openAutomationDraft;
const openAutomationDraftMock = jest.fn<
  void,
  Parameters<OpenAutomationDraft>
>();

describe('repeat task automation offers', () => {
  let now: number;
  let storage: MemoryStorage;

  beforeEach(() => {
    now = 100;
    storage = createStorage();
    openAutomationDraftMock.mockClear();
    useRepeatTaskOfferStore.setState({ offer: null });
    useNavigationStore.setState({
      openAutomationDraft: openAutomationDraftMock,
    });
    useWorkspaceContextStore.setState({ accountEpoch: 0 });
    useAutomationsStore.setState({
      activities: [],
      loading: false,
      hydrated: true,
      error: null,
    });
  });

  afterEach(() => {
    useNavigationStore.setState({
      openAutomationDraft: originalOpenAutomationDraft,
    });
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  function offerDeps(
    loadAccountKey: () => Promise<string | null> = () =>
      Promise.resolve('account-1'),
    loadSuggestionsEnabled: () => Promise<boolean | null> = () =>
      Promise.resolve(true),
  ): Partial<RepeatTaskOfferDeps> {
    return { now: () => now, loadAccountKey, loadSuggestionsEnabled, storage };
  }

  async function runTwice(
    snapshot: HomeTaskSnapshot = makeSnapshot(),
    deps: Partial<RepeatTaskOfferDeps> = offerDeps(),
  ): Promise<void> {
    await maybeOfferRepeatTaskAutomation(snapshot, deps);
    now += 1;
    await maybeOfferRepeatTaskAutomation(snapshot, deps);
  }

  function shownOffer(): ReturnType<
    typeof useRepeatTaskOfferStore.getState
  >['offer'] {
    return useRepeatTaskOfferStore.getState().offer;
  }

  function answer(choice: 'create' | 'dismiss'): void {
    answerRepeatTaskOffer(choice, { now: () => now, storage });
  }

  it('does not offer on the first run and offers on the second similar run', async () => {
    const snapshot = makeSnapshot();
    const deps = offerDeps();

    await maybeOfferRepeatTaskAutomation(snapshot, deps);
    expect(shownOffer()).toBeNull();
    await maybeOfferRepeatTaskAutomation(snapshot, deps);

    const offer = shownOffer();
    expect(typeof offer?.entryId).toBe('string');
    expect({ ...offer, entryId: undefined }).toEqual({
      entryId: undefined,
      accountEpoch: 0,
      seed: {
        name: 'Summarize billing failures and group them by service',
        prompt: snapshot.text,
        projectId: 'workspace-1',
        isCowork: false,
      },
    });
  });

  it('keeps the shown offer while the same task repeats and is not answered', async () => {
    const snapshot = makeSnapshot();
    const deps = offerDeps();
    await runTwice(snapshot, deps);
    const first = shownOffer();

    now += 1;
    await maybeOfferRepeatTaskAutomation(snapshot, deps);
    expect(shownOffer()).toBe(first);
  });

  it('offers again on the next repeat when the shown offer was dropped unanswered', async () => {
    const snapshot = makeSnapshot();
    const deps = offerDeps();
    await runTwice(snapshot, deps);
    const entryId = shownOffer()?.entryId;

    // A reload drops the session-only offer without answering it.
    useRepeatTaskOfferStore.setState({ offer: null });
    now += 1;
    await maybeOfferRepeatTaskAutomation(snapshot, deps);
    expect(shownOffer()?.entryId).toBe(entryId);
  });

  it('replaces another task offer with the newer repeat and leaves the older task unresolved', async () => {
    const billing = makeSnapshot();
    const support = makeSnapshot({
      text: 'Draft replies for open support tickets about refunds',
    });
    const deps = offerDeps();
    await runTwice(billing, deps);
    const billingEntry = shownOffer()?.entryId;
    now += 1;
    await runTwice(support, deps);

    expect(shownOffer()?.seed.prompt).toBe(support.text);
    expect(shownOffer()?.entryId).not.toBe(billingEntry);
    expect(storage.read()).not.toContain('resolvedAt');
  });

  it('records tasks in send order even when an earlier account read resolves last', async () => {
    let releaseFirst: (key: string) => void = () => undefined;
    const firstKey = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const slowFirst = offerDeps(() => firstKey);
    const older = makeSnapshot({
      text: 'Summarize billing failures for Monday and group them by service',
    });
    const newer = makeSnapshot({
      text: 'Summarize billing failures for Tuesday and group them by service',
    });

    const first = maybeOfferRepeatTaskAutomation(older, slowFirst);
    now += 1;
    const second = maybeOfferRepeatTaskAutomation(newer, offerDeps());
    releaseFirst('account-1');
    await Promise.all([first, second]);

    expect(shownOffer()?.seed.prompt).toBe(newer.text);
  });

  it('shows one offer when two repeats wait on the same automation list load', async () => {
    const snapshot = makeSnapshot();
    const deps = offerDeps();
    await maybeOfferRepeatTaskAutomation(snapshot, deps);

    let finishList: (response: AutomationsListResponse) => void = () =>
      undefined;
    const listResponse = new Promise<AutomationsListResponse>((resolve) => {
      finishList = resolve;
    });
    installApi({ automations: { list: () => listResponse } });
    useAutomationsStore.setState({ hydrated: false, loading: false });
    const shown: unknown[] = [];
    const stop = useRepeatTaskOfferStore.subscribe((state) => {
      if (state.offer !== null) shown.push(state.offer);
    });
    try {
      now += 1;
      const second = maybeOfferRepeatTaskAutomation(snapshot, deps);
      now += 1;
      const third = maybeOfferRepeatTaskAutomation(snapshot, deps);
      await Promise.resolve();
      finishList({ activities: [], recentRuns: [] });
      await Promise.all([second, third]);

      expect(shown).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('opens the prefilled draft on Create automation and resolves the task', async () => {
    const snapshot = makeSnapshot({
      text: '  Summarize billing failures\nKeep the original prompt.  ',
    });
    const deps = offerDeps();
    await runTwice(snapshot, deps);
    answer('create');

    expect(openAutomationDraftMock).toHaveBeenCalledWith({
      name: 'Summarize billing failures',
      prompt: snapshot.text,
      projectId: 'workspace-1',
      isCowork: false,
    });
    expect(shownOffer()).toBeNull();
    expect(readHistory(storage)).toEqual([
      expect.objectContaining({ resolvedAt: now }),
    ]);

    now += 1;
    await maybeOfferRepeatTaskAutomation(snapshot, deps);
    expect(shownOffer()).toBeNull();
  });

  it('resolves on Not now without opening the draft', async () => {
    const snapshot = makeSnapshot();
    const deps = offerDeps();
    await runTwice(snapshot, deps);
    answer('dismiss');

    expect(openAutomationDraftMock).not.toHaveBeenCalled();
    expect(shownOffer()).toBeNull();
    expect(readHistory(storage)).toEqual([
      expect.objectContaining({ resolvedAt: now }),
    ]);

    now += 1;
    await maybeOfferRepeatTaskAutomation(snapshot, deps);
    expect(shownOffer()).toBeNull();
  });

  it('only hides the offer when it is answered after an account switch', async () => {
    await runTwice();
    useWorkspaceContextStore.setState({ accountEpoch: 1 });
    answer('create');

    expect(openAutomationDraftMock).not.toHaveBeenCalled();
    expect(shownOffer()).toBeNull();
    expect(storage.read()).not.toContain('resolvedAt');
  });

  it('offers again after switching accounts away and back while the offer was hidden', async () => {
    const snapshot = makeSnapshot();
    const deps = offerDeps();
    await runTwice(snapshot, deps);
    const entryId = shownOffer()?.entryId;

    useWorkspaceContextStore.setState({ accountEpoch: 1 });
    useWorkspaceContextStore.setState({ accountEpoch: 2 });
    now += 1;
    await maybeOfferRepeatTaskAutomation(
      makeSnapshot({ accountEpoch: 2 }),
      deps,
    );

    expect(shownOffer()).toEqual(
      expect.objectContaining({ entryId, accountEpoch: 2 }),
    );
  });

  it('does not record or offer when the account epoch changes before offering', async () => {
    const snapshot = makeSnapshot();
    const loadAccountKey = (): Promise<string | null> => {
      useWorkspaceContextStore.setState({ accountEpoch: 1 });
      return Promise.resolve('account-1');
    };

    await maybeOfferRepeatTaskAutomation(snapshot, offerDeps(loadAccountKey));

    expect(shownOffer()).toBeNull();
    expect(storage.read()).toBeNull();
  });

  describe('Suggest automations for repeated tasks setting', () => {
    it('does not compare or record a task while the setting is off', async () => {
      const deps = offerDeps(undefined, () => Promise.resolve(false));
      const loadAccountKey = jest.fn(() => Promise.resolve('account-1'));
      await runTwice(makeSnapshot(), { ...deps, loadAccountKey });

      expect(loadAccountKey).not.toHaveBeenCalled();
      expect(storage.read()).toBeNull();
      expect(shownOffer()).toBeNull();
    });

    it('clears recorded tasks and the shown offer once the setting is off', async () => {
      const snapshot = makeSnapshot();
      await runTwice(snapshot);
      expect(shownOffer()).not.toBeNull();

      now += 1;
      await maybeOfferRepeatTaskAutomation(
        snapshot,
        offerDeps(undefined, () => Promise.resolve(false)),
      );
      expect(storage.read()).toBeNull();
      expect(shownOffer()).toBeNull();
    });

    it('neither records nor clears when the setting cannot be read', async () => {
      const snapshot = makeSnapshot();
      await maybeOfferRepeatTaskAutomation(snapshot, offerDeps());
      const recorded = storage.read();

      now += 1;
      await maybeOfferRepeatTaskAutomation(
        snapshot,
        offerDeps(undefined, () => Promise.resolve(null)),
      );
      expect(storage.read()).toBe(recorded);
      expect(shownOffer()).toBeNull();
    });

    it('drops a task that was being compared when suggestions stop', async () => {
      const snapshot = makeSnapshot();
      await maybeOfferRepeatTaskAutomation(snapshot, offerDeps());

      now += 1;
      await maybeOfferRepeatTaskAutomation(
        snapshot,
        offerDeps(() => {
          stopRepeatTaskSuggestions(storage);
          return Promise.resolve('account-1');
        }),
      );
      expect(storage.read()).toBeNull();
      expect(shownOffer()).toBeNull();
    });
  });

  it('leaves a suppressed offer unresolved so it can appear after the automation is removed', async () => {
    const snapshot = makeSnapshot();
    const activity = makeActivity({
      type: 'worktree_prompt',
      workspaceId: 'workspace-1',
      prompt:
        'Summarize billing failures and group them by service every Monday',
    });
    const deps = offerDeps();

    await maybeOfferRepeatTaskAutomation(snapshot, deps);
    useAutomationsStore.setState({ activities: [activity] });
    now += 1;
    await maybeOfferRepeatTaskAutomation(snapshot, deps);
    expect(shownOffer()).toBeNull();
    expect(storage.read()).not.toContain('resolvedAt');

    useAutomationsStore.setState({ activities: [] });
    now += 1;
    await maybeOfferRepeatTaskAutomation(snapshot, deps);
    expect(shownOffer()).not.toBeNull();
  });

  it('does nothing when the account key is inconclusive', async () => {
    await maybeOfferRepeatTaskAutomation(
      makeSnapshot(),
      offerDeps(() => Promise.resolve(null)),
    );

    expect(shownOffer()).toBeNull();
    expect(storage.read()).toBeNull();
  });

  it('uses the account id or signed-out scope only for authoritative account reads', async () => {
    installApi({
      loadCanopyCloudAccount: () =>
        Promise.resolve({ read: 'ok', account: { id: 'account-1' } }),
    });
    await expect(loadRepeatTaskAccountKey()).resolves.toBe('account-1');

    installApi({
      loadCanopyCloudAccount: () =>
        Promise.resolve({ read: 'ok', account: null }),
    });
    await expect(loadRepeatTaskAccountKey()).resolves.toBe('signed-out');

    installApi({
      loadCanopyCloudAccount: () =>
        Promise.resolve({ read: 'unavailable', account: { id: 'account-1' } }),
    });
    await expect(loadRepeatTaskAccountKey()).resolves.toBeNull();

    installApi({
      loadCanopyCloudAccount: () =>
        Promise.reject(new Error('account read failed')),
    });
    await expect(loadRepeatTaskAccountKey()).resolves.toBeNull();

    Reflect.deleteProperty(window, 'api');
    await expect(loadRepeatTaskAccountKey()).resolves.toBeNull();
  });

  it('does not offer an ineligible App Advisor task', async () => {
    await maybeOfferRepeatTaskAutomation(
      makeSnapshot({ workspaceId: APP_ADVISOR_PROJECT_ID }),
      offerDeps(),
    );

    expect(shownOffer()).toBeNull();
    expect(storage.read()).toBeNull();
  });

  it('persists only the task token signature', async () => {
    const snapshot = makeSnapshot();
    await maybeOfferRepeatTaskAutomation(snapshot, offerDeps());

    const raw = storage.read();
    expect(raw).not.toContain(snapshot.text);
    const entries: unknown = raw === null ? null : JSON.parse(raw);
    expect(entries).toEqual([
      expect.objectContaining({
        tokens: [
          'billing',
          'failures',
          'group',
          'service',
          'summarize',
          'them',
        ],
      }),
    ]);
  });
});
