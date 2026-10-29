import type {
  OsNotificationOptInResponse,
  OsNotificationPreferences,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type { ToastCategory } from '@/stores/githubStore';
import {
  __resetForTests,
  maybeFireOsNotification,
  refreshOsNotificationPrefs,
} from '../osNotifications';
import {
  __resetOsNotificationOfferForTests,
  answerOsNotificationOffer,
  applyOsNotificationOfferPreferences,
  cancelOsNotificationOfferOptIn,
  markOsNotificationOfferAnswered,
  noteOsNotificationOfferCompletion,
  useOsNotificationOfferStore,
} from '../osNotificationOffer';

const preferences: OsNotificationPreferences = {
  enabled: false,
  skipWhenFocused: false,
  defaultSound: 'System',
  categories: {
    chat: true,
    script: true,
    hook: true,
    gitCommit: true,
    gitPush: true,
    prCreate: true,
    pipeline: true,
    terminal: true,
    runComment: true,
  },
  categorySounds: {
    chat: 'Default',
    script: 'Default',
    hook: 'Default',
    gitCommit: 'Default',
    gitPush: 'Default',
    prCreate: 'Default',
    pipeline: 'Default',
    terminal: 'Default',
    runComment: 'Default',
  },
};

const unanswered = { osNotifications: preferences };

interface MockApi {
  showOsNotification: jest.Mock;
  savePreferences: jest.Mock<Promise<unknown>, [Partial<PreferencesData>]>;
  optInToOsNotifications: jest.Mock<Promise<OsNotificationOptInResponse>, []>;
}

let mockApi: MockApi;
let focused = false;
let surface = 'main';

function installMockWindow(): void {
  mockApi = {
    showOsNotification: jest.fn(() => Promise.resolve({ shown: true })),
    savePreferences: jest.fn<Promise<unknown>, [Partial<PreferencesData>]>(() =>
      Promise.resolve({}),
    ),
    optInToOsNotifications: jest.fn(() =>
      Promise.resolve({ enabled: true, delivered: true }),
    ),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: mockApi },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      hasFocus: () => focused,
      body: {
        get dataset(): Record<string, string> {
          return { rendererSurface: surface };
        },
      },
    },
  });
}

function completion(category: ToastCategory, agentCompletion = true): void {
  maybeFireOsNotification({
    title: category,
    body: 'Done',
    category,
    ...(agentCompletion ? { agentCompletion: true } : {}),
  });
}

function pending(): boolean {
  return useOsNotificationOfferStore.getState().pending;
}

describe('notification offer', () => {
  beforeEach(() => {
    focused = false;
    surface = 'main';
    installMockWindow();
    __resetForTests();
    __resetOsNotificationOfferForTests();
    refreshOsNotificationPrefs(preferences);
    applyOsNotificationOfferPreferences(unanswered);
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: undefined,
    });
    __resetForTests();
    __resetOsNotificationOfferForTests();
  });

  describe('arming at the delivery gate', () => {
    it.each(['Chat', 'Pipeline'] as const)(
      'arms on a background %s completion without OS delivery',
      (category) => {
        completion(category);
        expect(pending()).toBe(true);
        expect(mockApi.showOsNotification).not.toHaveBeenCalled();
      },
    );

    it.each(['Chat', 'Pipeline'] as const)(
      'ignores %s events without the completion marker',
      (category) => {
        completion(category, false);
        expect(pending()).toBe(false);
      },
    );

    it.each([
      'Script',
      'Hook',
      'Terminal',
      'Git Commit',
      'Git Push',
      'Git Pull',
      'Git Merge',
      'PR Create',
      'Split PR',
      'Run Comment',
      'Automation',
      'Worktree',
      'GitHub',
      'Account',
      'Privacy',
    ] as const)('never arms for %s', (category) => {
      completion(category);
      expect(pending()).toBe(false);
    });

    it('does not arm when the completion arrives while focused', () => {
      focused = true;
      completion('Chat');
      expect(pending()).toBe(false);
    });

    it('does not arm from an auxiliary window', () => {
      surface = 'app-advisor';
      completion('Chat');
      expect(pending()).toBe(false);
    });

    it('does not arm while the category toggle is off', () => {
      refreshOsNotificationPrefs({
        ...preferences,
        categories: { ...preferences.categories, chat: false },
      });
      completion('Chat');
      expect(pending()).toBe(false);
    });

    it('does not arm before preferences are known', () => {
      __resetOsNotificationOfferForTests();
      completion('Chat');
      expect(pending()).toBe(false);
      __resetForTests();
      applyOsNotificationOfferPreferences(unanswered);
      completion('Chat');
      expect(pending()).toBe(false);
    });

    it('keeps delivering, and never arms, when notifications are on', () => {
      refreshOsNotificationPrefs({ ...preferences, enabled: true });
      completion('Chat');
      expect(mockApi.showOsNotification).toHaveBeenCalledTimes(1);
      expect(pending()).toBe(false);
    });

    it('coalesces repeated completions into one pending offer', () => {
      const listener = jest.fn();
      const unsubscribe = useOsNotificationOfferStore.subscribe(listener);
      completion('Chat');
      completion('Pipeline');
      completion('Chat');
      unsubscribe();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(pending()).toBe(true);
    });
  });

  describe('eligibility', () => {
    it.each([
      [
        'an answer stamp',
        { osNotificationOfferAnsweredAt: '2026-09-01T00:00:00.000Z' },
      ],
      [
        'notifications on',
        { osNotifications: { ...preferences, enabled: true } },
      ],
    ])('is suppressed by %s and clears a pending offer', (_label, patch) => {
      noteOsNotificationOfferCompletion(false);
      expect(pending()).toBe(true);
      applyOsNotificationOfferPreferences({ ...unanswered, ...patch });
      expect(pending()).toBe(false);
      expect(useOsNotificationOfferStore.getState().eligibility).toBe(
        'answered',
      );
    });

    it('stays unknown when preferences failed to load', () => {
      // Main skips the enabled-profile migration after a load error, so a
      // fallback snapshot cannot prove the offer was never answered.
      __resetOsNotificationOfferForTests();
      applyOsNotificationOfferPreferences({
        ...unanswered,
        __error: {
          timestamp: '2026-10-12T00:00:00.000Z',
          reason: 'parse',
          message: 'Unexpected token',
          filePath: '/tmp/preferences.json',
        },
      });
      noteOsNotificationOfferCompletion(false);
      expect(pending()).toBe(false);
      expect(useOsNotificationOfferStore.getState().eligibility).toBe(
        'unknown',
      );
      // A later authoritative sync makes the session eligible.
      applyOsNotificationOfferPreferences(unanswered);
      noteOsNotificationOfferCompletion(false);
      expect(pending()).toBe(true);
    });

    describe('a payload without osNotifications', () => {
      it('keeps the previous eligibility instead of throwing', () => {
        noteOsNotificationOfferCompletion(false);
        expect(() => applyOsNotificationOfferPreferences({})).not.toThrow();
        expect(pending()).toBe(true);
        expect(useOsNotificationOfferStore.getState().eligibility).toBe(
          'eligible',
        );
      });

      it('cannot prove the offer is unanswered', () => {
        __resetOsNotificationOfferForTests();
        applyOsNotificationOfferPreferences({});
        noteOsNotificationOfferCompletion(false);
        expect(pending()).toBe(false);
        expect(useOsNotificationOfferStore.getState().eligibility).toBe(
          'unknown',
        );
      });

      it('still honors an answer stamp', () => {
        noteOsNotificationOfferCompletion(false);
        applyOsNotificationOfferPreferences({
          osNotificationOfferAnsweredAt: '2026-09-01T00:00:00.000Z',
        });
        expect(pending()).toBe(false);
        expect(useOsNotificationOfferStore.getState().eligibility).toBe(
          'answered',
        );
      });
    });

    it('ignores a stale snapshot after an answer', () => {
      markOsNotificationOfferAnswered();
      applyOsNotificationOfferPreferences(unanswered);
      noteOsNotificationOfferCompletion(false);
      expect(pending()).toBe(false);
    });
  });

  describe('answering', () => {
    beforeEach(() => {
      noteOsNotificationOfferCompletion(false);
    });

    it('saves Not now without opting in', async () => {
      await expect(answerOsNotificationOffer('dismiss')).resolves.toEqual({
        kind: 'dismissed',
      });
      const [[patch]] = mockApi.savePreferences.mock.calls;
      expect(Object.keys(patch)).toEqual(['osNotificationOfferAnsweredAt']);
      expect(typeof patch.osNotificationOfferAnsweredAt).toBe('string');
      expect(mockApi.optInToOsNotifications).not.toHaveBeenCalled();
      expect(pending()).toBe(false);
      noteOsNotificationOfferCompletion(false);
      expect(pending()).toBe(false);
    });

    it('saves Turn on before opting in once', async () => {
      const order: string[] = [];
      mockApi.savePreferences.mockImplementation(() => {
        order.push('save');
        return Promise.resolve({});
      });
      mockApi.optInToOsNotifications.mockImplementation(() => {
        order.push('opt-in');
        return Promise.resolve({ enabled: true, delivered: true });
      });
      await expect(answerOsNotificationOffer('enable')).resolves.toEqual({
        kind: 'enabled',
        optIn: { enabled: true, delivered: true },
      });
      expect(order).toEqual(['save', 'opt-in']);
    });

    it('keeps the answer when opt-in throws', async () => {
      mockApi.optInToOsNotifications.mockRejectedValue(new Error('boom'));
      await expect(answerOsNotificationOffer('enable')).resolves.toEqual({
        kind: 'opt-in-failed',
      });
      expect(useOsNotificationOfferStore.getState().eligibility).toBe(
        'answered',
      );
    });

    it.each(['os-denied', 'unsupported', 'error'] as const)(
      'keeps the answer when opt-in reports %s',
      async (reason) => {
        mockApi.optInToOsNotifications.mockResolvedValue({
          enabled: true,
          delivered: false,
          reason,
        });
        await expect(answerOsNotificationOffer('enable')).resolves.toEqual({
          kind: 'enabled',
          optIn: { enabled: true, delivered: false, reason },
        });
        expect(pending()).toBe(false);
        applyOsNotificationOfferPreferences(unanswered);
        noteOsNotificationOfferCompletion(false);
        expect(pending()).toBe(false);
        await expect(answerOsNotificationOffer('enable')).resolves.toEqual({
          kind: 'ignored',
        });
        expect(mockApi.optInToOsNotifications).toHaveBeenCalledTimes(1);
      },
    );

    it('is single-flight', async () => {
      const first = answerOsNotificationOffer('enable');
      expect(useOsNotificationOfferStore.getState().answering).toBe('enable');
      await expect(answerOsNotificationOffer('dismiss')).resolves.toEqual({
        kind: 'ignored',
      });
      await first;
      expect(mockApi.savePreferences).toHaveBeenCalledTimes(1);
      expect(mockApi.optInToOsNotifications).toHaveBeenCalledTimes(1);
    });

    it('keeps the offer after a failed save and retries with the same stamp', async () => {
      mockApi.savePreferences.mockRejectedValueOnce(new Error('disk full'));
      await expect(answerOsNotificationOffer('enable')).resolves.toEqual({
        kind: 'save-failed',
      });
      expect(mockApi.optInToOsNotifications).not.toHaveBeenCalled();
      expect(useOsNotificationOfferStore.getState()).toMatchObject({
        pending: true,
        answering: null,
        saveFailed: true,
      });

      await answerOsNotificationOffer('enable');
      const [[first], [second]] = mockApi.savePreferences.mock.calls;
      expect(second).toEqual(first);
      expect(mockApi.optInToOsNotifications).toHaveBeenCalledTimes(1);
      expect(pending()).toBe(false);
    });

    it.each(['enable', 'dismiss'] as const)(
      'retains the %s choice when a retry requests the other action',
      async (choice) => {
        mockApi.savePreferences.mockRejectedValueOnce(new Error('disk full'));
        await answerOsNotificationOffer(choice);
        const result = await answerOsNotificationOffer(
          choice === 'enable' ? 'dismiss' : 'enable',
        );
        expect(result.kind).toBe(choice === 'enable' ? 'enabled' : 'dismissed');
        expect(mockApi.optInToOsNotifications).toHaveBeenCalledTimes(
          choice === 'enable' ? 1 : 0,
        );
        const [[first], [retry]] = mockApi.savePreferences.mock.calls;
        expect(retry).toEqual(first);
      },
    );

    it('settles a rejected save after a concurrent Settings answer without reopening', async () => {
      let rejectSave: (error: Error) => void = () => undefined;
      mockApi.savePreferences.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSave = reject;
          }),
      );
      const answer = answerOsNotificationOffer('enable');
      applyOsNotificationOfferPreferences({
        ...unanswered,
        osNotificationOfferAnsweredAt: '2026-09-01T00:00:00.000Z',
      });
      rejectSave(new Error('failed'));
      await expect(answer).resolves.toEqual({ kind: 'save-failed' });
      expect(useOsNotificationOfferStore.getState()).toMatchObject({
        eligibility: 'answered',
        pending: false,
        answering: null,
      });
      expect(mockApi.optInToOsNotifications).not.toHaveBeenCalled();
    });

    it('does not opt in after a newer successful Settings choice', async () => {
      let resolveSave: () => void = () => undefined;
      mockApi.savePreferences.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          }),
      );
      const answer = answerOsNotificationOffer('enable');
      markOsNotificationOfferAnswered();
      resolveSave();
      await expect(answer).resolves.toEqual({ kind: 'ignored' });
      expect(mockApi.optInToOsNotifications).not.toHaveBeenCalled();
      expect(pending()).toBe(false);
    });

    it('cancels opt-in as soon as a newer Settings choice starts saving', async () => {
      const answer = answerOsNotificationOffer('enable');
      cancelOsNotificationOfferOptIn();
      await expect(answer).resolves.toEqual({ kind: 'ignored' });
      expect(mockApi.optInToOsNotifications).not.toHaveBeenCalled();
      expect(useOsNotificationOfferStore.getState()).toMatchObject({
        eligibility: 'answered',
        pending: false,
        answering: null,
      });
    });

    it('cancels opt-in after another answer arrives through preference sync', async () => {
      const answer = answerOsNotificationOffer('enable');
      applyOsNotificationOfferPreferences({
        ...unanswered,
        osNotificationOfferAnsweredAt: '2026-09-01T00:00:00.000Z',
      });
      await expect(answer).resolves.toEqual({ kind: 'ignored' });
      expect(mockApi.optInToOsNotifications).not.toHaveBeenCalled();
    });

    it('allows opt-in after its own answer preference sync', async () => {
      mockApi.savePreferences.mockImplementation((patch) => {
        applyOsNotificationOfferPreferences({ ...unanswered, ...patch });
        return Promise.resolve({});
      });
      await expect(answerOsNotificationOffer('enable')).resolves.toMatchObject({
        kind: 'enabled',
      });
      expect(mockApi.optInToOsNotifications).toHaveBeenCalledTimes(1);
    });

    it('cancels opt-in after another answer syncs without osNotifications', async () => {
      const answer = answerOsNotificationOffer('enable');
      applyOsNotificationOfferPreferences({
        osNotificationOfferAnsweredAt: '2026-09-01T00:00:00.000Z',
      });
      await expect(answer).resolves.toEqual({ kind: 'ignored' });
      expect(mockApi.optInToOsNotifications).not.toHaveBeenCalled();
    });

    it('allows opt-in after its own answer syncs without osNotifications', async () => {
      mockApi.savePreferences.mockImplementation((patch) => {
        applyOsNotificationOfferPreferences({
          osNotificationOfferAnsweredAt: patch.osNotificationOfferAnsweredAt,
        });
        return Promise.resolve({});
      });
      await expect(answerOsNotificationOffer('enable')).resolves.toMatchObject({
        kind: 'enabled',
      });
      expect(mockApi.optInToOsNotifications).toHaveBeenCalledTimes(1);
    });

    it('does not reopen when Settings answers while a save is in flight', async () => {
      let resolveSave: () => void = () => undefined;
      mockApi.savePreferences.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          }),
      );
      const answer = answerOsNotificationOffer('dismiss');
      applyOsNotificationOfferPreferences({
        ...unanswered,
        osNotificationOfferAnsweredAt: '2026-09-01T00:00:00.000Z',
      });
      resolveSave();
      await answer;
      expect(pending()).toBe(false);
      expect(useOsNotificationOfferStore.getState().eligibility).toBe(
        'answered',
      );
    });
  });
});
