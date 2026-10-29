/**
 * @jest-environment jsdom
 */

import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  spaceNotificationScopeKey,
} from '@canopy/desktop-shared/lib/space-notification-policy';
import type {
  SpaceNotificationPolicySnapshot,
  SpaceNotificationScope,
  SpaceNotificationSetRequest,
  SpaceNotificationSetResult,
  SpaceNotificationsApi,
} from '@canopy/desktop-shared/types';
import { SPACE_NOTIFICATION_MENU_COPY } from '@canopy/ui-shared/components';
import {
  isSpaceNotificationDeliverable,
  spaceNotificationMenuStateFor,
  useSpaceNotificationStore,
} from '../spaceNotificationStore';

const SCOPE = { projectId: 'project-1', worktreeId: 'worktree-1' };
const KEY = spaceNotificationScopeKey(SCOPE);

function snapshot(
  override: 'all' | 'attention' | 'mute' | null,
  revision = 1,
  accountKey = 'user-1',
  writesEnabled = true,
): SpaceNotificationPolicySnapshot {
  return {
    ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
    accountKey,
    writesEnabled,
    spaces: {
      [KEY]: {
        notificationSpaceId: 'space-1',
        revision,
        override,
        transitions: [],
      },
    },
  };
}

const refresh = jest.fn<
  Promise<SpaceNotificationPolicySnapshot>,
  [SpaceNotificationScope]
>();
const set = jest.fn<
  Promise<SpaceNotificationSetResult>,
  [SpaceNotificationSetRequest]
>();
let api: SpaceNotificationsApi;

beforeEach(() => {
  refresh.mockReset();
  set.mockReset();
  api = {
    getSnapshot: jest.fn<Promise<SpaceNotificationPolicySnapshot>, []>(),
    refresh,
    set,
    onChanged: (): (() => void) => (): void => {},
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { spaceNotifications: api },
  });
  useSpaceNotificationStore.setState({
    snapshot: EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
    progress: {},
  });
});

function menu(): ReturnType<typeof spaceNotificationMenuStateFor> {
  return spaceNotificationMenuStateFor(
    useSpaceNotificationStore.getState(),
    SCOPE,
  );
}

it('explains signed-out and unregistered spaces instead of inventing a choice', async () => {
  expect(menu()).toMatchObject({
    selectionKnown: false,
    disabledReason: SPACE_NOTIFICATION_MENU_COPY.signIn,
  });
  useSpaceNotificationStore.setState({
    snapshot: {
      ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      accountKey: 'user-1',
      syncedAt: '2026-10-05T00:00:00Z',
    },
  });
  refresh.mockResolvedValue({
    ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
    accountKey: 'user-1',
    syncedAt: '2026-10-05T00:00:00Z',
  });
  const pending = useSpaceNotificationStore.getState().refresh(SCOPE);
  expect(menu()).toMatchObject({ status: 'loading', selectionKnown: false });
  await pending;
  expect(menu()).toMatchObject({
    status: 'failed',
    selectionKnown: false,
    disabledReason: SPACE_NOTIFICATION_MENU_COPY.loadFailed,
  });
});

it('settles a rejected read as a failed load instead of throwing', async () => {
  useSpaceNotificationStore.setState({
    snapshot: {
      ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      accountKey: 'user-1',
    },
  });
  refresh.mockRejectedValue(new Error('invalid id'));
  await expect(
    useSpaceNotificationStore.getState().refresh(SCOPE),
  ).resolves.toBeUndefined();
  expect(menu()).toMatchObject({
    status: 'failed',
    disabledReason: SPACE_NOTIFICATION_MENU_COPY.loadFailed,
  });
});

it('hides an unknown space from the first open while the cloud has never synced', async () => {
  // Main never reached the cloud this session (no sync yet), so a space with
  // no saved choice cannot load either. The menu must not open with a
  // "Loading…" group that then vanishes and makes the menu jump.
  useSpaceNotificationStore.setState({
    snapshot: {
      ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      accountKey: 'user-1',
      syncedAt: null,
    },
  });
  expect(menu()).toMatchObject({ status: 'failed', selectionKnown: false });
  let resolveRead: (value: SpaceNotificationPolicySnapshot) => void = () =>
    undefined;
  refresh.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRead = resolve;
    }),
  );
  const read = useSpaceNotificationStore.getState().refresh(SCOPE);
  expect(menu()).toMatchObject({ status: 'failed', selectionKnown: false });
  resolveRead({ ...snapshot('attention'), syncedAt: '2026-10-05T00:00:00Z' });
  await read;
  expect(menu()).toMatchObject({ status: 'ready', override: 'attention' });
});

it('shows "Loading…" for an unknown space once the cloud has synced', () => {
  useSpaceNotificationStore.setState({
    snapshot: {
      ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      accountKey: 'user-1',
      syncedAt: '2026-10-05T00:00:00Z',
    },
  });
  refresh.mockReturnValueOnce(new Promise(() => undefined));
  void useSpaceNotificationStore.getState().refresh(SCOPE);
  expect(menu()).toMatchObject({ status: 'loading', selectionKnown: false });
});

it('retries a failed first read quietly, then shows the choice once it loads', async () => {
  // A space that has never loaded and cannot be reached shows no group; a
  // reopen retries without flashing "Loading…" for a group that then vanishes.
  useSpaceNotificationStore.setState({
    snapshot: {
      ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      accountKey: 'user-1',
    },
  });
  refresh.mockRejectedValueOnce(new Error('cloud not configured'));
  await useSpaceNotificationStore.getState().refresh(SCOPE);
  expect(menu()).toMatchObject({ status: 'failed', selectionKnown: false });

  let resolveRetry: (value: SpaceNotificationPolicySnapshot) => void = () =>
    undefined;
  refresh.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRetry = resolve;
    }),
  );
  const retry = useSpaceNotificationStore.getState().refresh(SCOPE);
  expect(menu()).toMatchObject({ status: 'failed', selectionKnown: false });
  resolveRetry(snapshot('mute'));
  await retry;
  expect(menu()).toMatchObject({ status: 'ready', override: 'mute' });
  expect(useSpaceNotificationStore.getState().progress[KEY]).toBeUndefined();
});

it('shows the saved default as checked and never selects a pending choice', async () => {
  useSpaceNotificationStore.getState().applySnapshot(snapshot(null));
  expect(menu()).toMatchObject({ status: 'ready', override: null });
  let resolve: (result: SpaceNotificationSetResult) => void = () => {};
  set.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const saving = useSpaceNotificationStore.getState().setChoice(SCOPE, 'mute');
  expect(menu()).toMatchObject({
    status: 'saving',
    override: null,
    pendingChoice: 'mute',
  });
  // A second click while saving is ignored rather than racing the first.
  await useSpaceNotificationStore.getState().setChoice(SCOPE, 'attention');
  expect(set).toHaveBeenCalledTimes(1);
  expect(set).toHaveBeenCalledWith({
    ...SCOPE,
    override: 'mute',
    expectedRevision: 1,
  });
  resolve({ status: 'saved', snapshot: snapshot('mute', 2) });
  await saving;
  expect(menu()).toMatchObject({ status: 'ready', override: 'mute' });
  expect(isSpaceNotificationDeliverable(SCOPE, 'attention')).toBe(false);
});

it.each([
  ['conflict', SPACE_NOTIFICATION_MENU_COPY.changedElsewhere],
  ['disabled', SPACE_NOTIFICATION_MENU_COPY.writesClosed],
  ['busy', SPACE_NOTIFICATION_MENU_COPY.deliveryInProgress],
  ['failed', SPACE_NOTIFICATION_MENU_COPY.saveFailed],
] as const)('shows a %s save as a visible failure', async (status, copy) => {
  useSpaceNotificationStore.getState().applySnapshot(snapshot('all'));
  set.mockResolvedValue({ status, snapshot: snapshot('attention', 2) });
  await useSpaceNotificationStore.getState().setChoice(SCOPE, 'mute');
  expect(menu()).toMatchObject({
    status: 'failed',
    failure: copy,
    override: 'attention',
  });
});

it('drops another account’s pending save and progress', async () => {
  useSpaceNotificationStore.getState().applySnapshot(snapshot('all'));
  let resolve: (result: SpaceNotificationSetResult) => void = () => {};
  set.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const saving = useSpaceNotificationStore.getState().setChoice(SCOPE, 'mute');
  useSpaceNotificationStore.getState().applySnapshot({
    ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
    accountKey: 'user-2',
  });
  expect(useSpaceNotificationStore.getState().progress).toEqual({});
  resolve({ status: 'saved', snapshot: snapshot('mute', 2, 'user-2') });
  await saving;
  expect(useSpaceNotificationStore.getState().progress).toEqual({});
});

it('keeps a read-only selection visible when the server is not accepting changes', () => {
  useSpaceNotificationStore
    .getState()
    .applySnapshot(snapshot('mute', 1, 'user-1', false));
  expect(menu()).toMatchObject({
    override: 'mute',
    disabledReason: SPACE_NOTIFICATION_MENU_COPY.writesClosed,
  });
  // Turning the switch off never turns enforcement off.
  expect(isSpaceNotificationDeliverable(SCOPE, 'failure')).toBe(false);
});
