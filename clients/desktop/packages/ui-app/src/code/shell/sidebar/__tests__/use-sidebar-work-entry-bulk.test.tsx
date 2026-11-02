/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useSidebarWorkEntryBulk,
  workEntryRowKey,
  type SidebarWorkEntryBulk,
  type UseSidebarWorkEntryBulkInput,
  type WorkEntryBatchTarget,
} from '../use-sidebar-work-entry-bulk';
import type { SpaceNotificationMenuState } from '@canopy/ui-shared/components';
import type { SidebarSelectionRows } from '../sidebar-row-selection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROWS: SidebarSelectionRows = new Map([
  [
    'chats',
    [
      {
        key: 'work-entry:chats/a',
        kind: 'work-entry',
        selectable: true,
        label: 'Plan',
        projectName: 'Chats',
      },
    ],
  ],
]);

describe('useSidebarWorkEntryBulk (CAN-3975)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: SidebarWorkEntryBulk | undefined;

  function Probe(props: UseSidebarWorkEntryBulkInput): JSX.Element {
    latest = useSidebarWorkEntryBulk(props);
    return <span />;
  }

  function render(
    over: Partial<UseSidebarWorkEntryBulkInput> = {},
  ): SidebarWorkEntryBulk {
    act(() =>
      root.render(
        <Probe
          enabled
          remove={() => Promise.resolve()}
          getFacts={() => ({})}
          rows={ROWS}
          {...over}
        />,
      ),
    );
    if (latest === undefined) throw new Error('Not rendered');
    return latest;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = undefined;
  });

  it('keys rows by workspace and entry', () => {
    expect(workEntryRowKey('chats', 'a')).toBe('work-entry:chats/a');
  });

  it("resolves a target with the row's names", () => {
    const { binding } = render();
    expect(binding.targetFor('work-entry:chats/a')).toEqual({
      key: 'work-entry:chats/a',
      workspaceLocalId: 'chats',
      workEntryId: 'a',
      label: 'Plan',
      projectName: 'Chats',
    });
    expect(binding.targetFor('work-entry:chats/zzz')).toBeUndefined();
  });

  it('skips a missing entry', () => {
    const { binding } = render({ getFacts: () => undefined });
    expect(binding.blockedReasonFor('work-entry:chats/a')).toBe(
      'Chat was not found',
    );
  });

  it('does not depend on reported rows for existence', () => {
    const { binding } = render({ rows: new Map() });
    expect(binding.blockedReasonFor('work-entry:chats/a')).toBeUndefined();
  });

  it('streaming does not block', () => {
    const { binding } = render({ getFacts: () => ({}) });
    expect(binding.blockedReasonFor('work-entry:chats/a')).toBeUndefined();
  });

  it("blocks on live delegates with the host's reason", () => {
    const { binding } = render({
      getFacts: () => ({
        blockedReason: 'Delegates are still running here. Stop them first.',
      }),
    });
    expect(binding.blockedReasonFor('work-entry:chats/a')).toBe(
      'Delegates are still running here. Stop them first.',
    );
  });

  it('removes through the host with the mode only', async () => {
    const remove = jest.fn(() => Promise.resolve());
    const { binding } = render({ remove });
    const target = binding.targetFor('work-entry:chats/a');
    if (target === undefined) throw new Error('Missing target');
    await binding.remove?.(target, {
      mode: 'delete',
      expectedBranchName: 'x',
    });
    expect(remove).toHaveBeenCalledWith('chats', 'a', { mode: 'delete' });
  });

  it('copy uses one window or the mixed wording', () => {
    const { binding } = render({
      retentionDaysFor: (workspace) => (workspace === 'chats' ? 7 : 30),
    });
    const target = (
      workspaceLocalId: string,
      workEntryId: string,
    ): WorkEntryBatchTarget => ({
      key: workEntryRowKey(workspaceLocalId, workEntryId),
      workspaceLocalId,
      workEntryId,
      label: workEntryId,
      projectName: workspaceLocalId,
    });
    expect(
      binding.copyFor('delete', [target('chats', 'a'), target('chats', 'b')])
        .retentionSummary,
    ).toBe('Deleted chats are kept for 7 days, then removed.');
    expect(
      binding.copyFor('delete', [target('chats', 'a'), target('other', 'b')])
        .retentionSummary,
    ).toBe("Restorable for each project's retention window.");
    expect(binding.unitLabelFor([])).toEqual({
      singular: 'chat',
      plural: 'chats',
    });
  });

  it('availability names chats', () => {
    const { binding } = render({ isWorkspaceCommandDisabled: () => true });
    expect(
      binding.availabilityFor(['work-entry:chats/a']).archive.disabledReason,
    ).toContain('chats');
  });

  it('a disabled binding selects nothing', () => {
    const bulk = render({ enabled: false, remove: undefined });
    expect(bulk.binding.enabled).toBe(false);
    expect('remove' in bulk.binding).toBe(false);
    expect(bulk.isSelectable('chats')).toBe(false);
  });

  it('reports pin and done only where the host wires them', () => {
    const { binding } = render({
      getEntryState: () => ({ pinned: false, done: true }),
      setPinned: jest.fn(() => Promise.resolve()),
    });
    expect(binding.rowStateFor?.(workEntryRowKey('chats', 'a'))).toEqual({
      pinned: false,
    });
  });

  it("runs pin and done through the host commands with the entry's own project", async () => {
    const setPinned = jest.fn(() => Promise.resolve());
    const setStatus = jest.fn(() => Promise.resolve());
    const { binding } = render({
      getEntryState: () => ({ pinned: false, done: false }),
      setPinned,
      setStatus,
    });
    const target: WorkEntryBatchTarget = {
      key: workEntryRowKey('chats', 'a'),
      workspaceLocalId: 'chats',
      workEntryId: 'a',
      label: 'Plan',
      projectName: 'Chats',
    };
    await binding.applyStateAction?.(target, { kind: 'pin', pinned: true });
    await binding.applyStateAction?.(target, { kind: 'done', done: true });
    expect(setPinned).toHaveBeenCalledWith('chats', 'a', true);
    expect(setStatus).toHaveBeenCalledWith('chats', 'a', 'done');
  });

  it('a gone entry has no state', () => {
    const { binding } = render({
      getEntryState: () => undefined,
      setPinned: jest.fn(() => Promise.resolve()),
    });
    expect(
      binding.rowStateFor?.(workEntryRowKey('chats', 'a')),
    ).toBeUndefined();
  });

  it('requests a never-read choice, even one the host reports as loading', () => {
    // Web reports a space it has never read as loading before any read
    // starts; the host's own refresh skips a read already in flight.
    const requestNotificationState = jest.fn();
    let state: SpaceNotificationMenuState = {
      status: 'loading',
      override: null,
      selectionKnown: false,
    };
    const { binding } = render({
      getNotificationState: () => state,
      setNotificationChoice: jest.fn(),
      requestNotificationState,
    });
    binding.requestRowState?.(workEntryRowKey('chats', 'a'));
    state = { status: 'ready', override: null, selectionKnown: true };
    binding.requestRowState?.(workEntryRowKey('chats', 'a'));
    expect(requestNotificationState.mock.calls).toEqual([['chats', 'a']]);
  });

  it('commands-disabled entries keep only their notifications', () => {
    const { binding } = render({
      isWorkspaceCommandDisabled: () => true,
      getEntryState: () => ({ pinned: false, done: false }),
      setPinned: jest.fn(() => Promise.resolve()),
      setStatus: jest.fn(() => Promise.resolve()),
      getNotificationState: () => ({
        status: 'ready',
        override: 'mute',
        selectionKnown: true,
      }),
      setNotificationChoice: jest.fn(),
    });
    expect(binding.rowStateFor?.(workEntryRowKey('chats', 'a'))).toEqual({
      notifications: {
        status: 'ready',
        override: 'mute',
        selectionKnown: true,
      },
    });
  });
});
