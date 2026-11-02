import type { WorktreeMenuContext } from '../worktree-menu-items';
import { WORKTREE_BATCH_UNIT } from '@canopy/ui-shared/components';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ArchiveIcon,
  LabelIcon,
  PencilIcon,
  SplitIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  batchActionAvailability,
  deriveWorktreeMenuItems,
  foldWorktreeMenuIntoMore,
  foldWorktreeNotificationsIntoSubmenu,
  isSplitPrEligible,
  worktreeArchiveBlockedReason,
  worktreeRemovalBlockedReason,
} from '../worktree-menu-items';

const context: WorktreeMenuContext = {
  subject: 'worktree',
  label: 'Feature',
  branch: 'feature',
  hidden: false,
  done: false,
  launchAvailable: true,
  launchRunning: false,
  pipelineAvailable: true,
  splitPrEligible: true,
  splitPrLocked: false,
  splitPrBlockers: [],
  groupingAction: { kind: 'group-with-base' },
  addRepositoryAvailable: true,
  hasActiveSession: false,
  removalLockedBySplitPr: false,
};
const capabilities = {
  pipelines: 'execute' as const,
  worktreeSplitPr: true,
  worktreeBranchGrouping: true,
  worktreeRepositoryAttachment: true,
  removal: { behavior: 'archive' as const },
};
const callbacks = {
  onSetLabelRequested: jest.fn(),
  onBranchInfoRequested: jest.fn(),
  onLaunchRequested: jest.fn(),
  onDispatchPipelineRequested: jest.fn(),
  onSplitPrRequested: jest.fn(),
  onCreateBranchRequested: jest.fn(),
  onGroupingRequested: jest.fn(),
  onAddRepositoryRequested: jest.fn(),
  onToggleHiddenRequested: jest.fn(),
  onRemovalRequested: jest.fn(),
};

describe('deriveWorktreeMenuItems — pinning', () => {
  // Desktop's row menu pins a worktree above its siblings. The shared menu
  // offers the same item, in the same first position and wording, only when
  // the host wires it (CAN-3053 flag flip); the portal never does.
  it('leads with Pin to top when the host wires pinning', () => {
    const onTogglePinnedRequested = jest.fn();
    const { items } = deriveWorktreeMenuItems(context, capabilities, {
      ...callbacks,
      onTogglePinnedRequested,
      testIds: { togglePin: 'pin-id' },
    });
    expect(items[0]).toMatchObject({
      key: 'toggle-pin',
      label: 'Pin to top',
      testId: 'pin-id',
    });
    items[0]?.onSelect?.();
    expect(onTogglePinnedRequested).toHaveBeenCalledTimes(1);
  });

  it('reads Unpin for a pinned row', () => {
    const { items } = deriveWorktreeMenuItems(
      { ...context, pinned: true },
      capabilities,
      { ...callbacks, onTogglePinnedRequested: jest.fn() },
    );
    expect(items[0]).toMatchObject({ key: 'toggle-pin', label: 'Unpin' });
  });

  it('offers no pin item without a host handler', () => {
    const { items } = deriveWorktreeMenuItems(context, capabilities, callbacks);
    expect(items.map((item) => item.key)).not.toContain('toggle-pin');
  });
});

describe('deriveWorktreeMenuItems — move to organization', () => {
  it('offers Move to organization after Add repository when the host wires it', () => {
    const onMoveToOrganizationRequested = jest.fn();
    const { items } = deriveWorktreeMenuItems(context, capabilities, {
      ...callbacks,
      onMoveToOrganizationRequested,
      testIds: { moveToOrganization: 'move-id' },
    });
    const keys = items.map((item) => item.key);
    expect(keys.indexOf('move-to-organization')).toBe(
      keys.indexOf('add-repository') + 1,
    );
    const move = items.find((item) => item.key === 'move-to-organization');
    expect(move).toMatchObject({
      label: 'Move to org…',
      testId: 'move-id',
    });
    move?.onSelect?.();
    expect(onMoveToOrganizationRequested).toHaveBeenCalledTimes(1);
  });

  it('offers no Move to organization without a host handler', () => {
    const { items } = deriveWorktreeMenuItems(context, capabilities, callbacks);
    expect(items.map((item) => item.key)).not.toContain('move-to-organization');
  });

  it('keeps Move to organization out of the compact More submenu', () => {
    const { items } = deriveWorktreeMenuItems(context, capabilities, {
      ...callbacks,
      onMoveToOrganizationRequested: jest.fn(),
    });
    const folded = foldWorktreeMenuIntoMore(items);
    expect(folded.map((item) => item.key)).toContain('move-to-organization');
    const more = folded.find((item) => item.key === 'more');
    expect(more?.submenu?.map((item) => item.key)).not.toContain(
      'move-to-organization',
    );
  });
});

describe('deriveWorktreeMenuItems — sentence case', () => {
  const dispatchLabel = (patch: Partial<WorktreeMenuContext>): unknown =>
    deriveWorktreeMenuItems(
      { ...context, ...patch },
      capabilities,
      callbacks,
    ).items.find((item) => item.key === 'dispatch-pipeline')?.label;

  it('reads Dispatch Pipeline by default', () => {
    expect(dispatchLabel({})).toBe('Dispatch workflow');
    expect(dispatchLabel({ sentenceCaseLabels: false })).toBe(
      'Dispatch workflow',
    );
  });

  it('reads Dispatch pipeline when the host asks for sentence case', () => {
    expect(dispatchLabel({ sentenceCaseLabels: true })).toBe(
      'Dispatch workflow',
    );
  });
});

describe('deriveWorktreeMenuItems', () => {
  it.each([
    ['eligible', {}, true],
    ['toggle off', { splitPrEnabled: false }, false],
    ['closed PR', { prState: 'closed' }, false],
    ['below threshold', { prAdditions: 10 }, false],
    ['multi repo', { isSingleRepo: false }, false],
  ] as const)('derives split eligibility for %s', (_name, patch, expected) => {
    expect(
      isSplitPrEligible({
        prState: 'open',
        prAdditions: 600,
        prDeletions: 100,
        splitPrEnabled: true,
        thresholdLines: 500,
        isSingleRepo: true,
        ...patch,
      }),
    ).toBe(expected);
  });

  // A done worktree has shipped its PR; splitting it would rework merged
  // history. The legacy row gated Split PR on `!isDone` and so does the
  // shared menu (CAN-3053 review), whatever its eligibility and blockers.
  it.each([
    ['unblocked', []],
    ['blocked', ['Commit or stash local changes']],
  ] as const)(
    'omits Split PR from a done worktree when %s',
    (_name, blockers) => {
      const items = deriveWorktreeMenuItems(
        { ...context, done: true, splitPrBlockers: blockers },
        capabilities,
        callbacks,
      ).items;
      expect(items.some((item) => item.key === 'split-pr')).toBe(false);
    },
  );

  it('omits Split PR unless capability and host callback are both present', () => {
    expect(
      deriveWorktreeMenuItems(
        context,
        { ...capabilities, worktreeSplitPr: undefined },
        callbacks,
      ).items.some((item) => item.key === 'split-pr'),
    ).toBe(false);
    expect(
      deriveWorktreeMenuItems(context, capabilities, {
        ...callbacks,
        onSplitPrRequested: undefined,
      }).items.some((item) => item.key === 'split-pr'),
    ).toBe(false);
  });

  // A blocked Split PR stays in the menu, disabled, and names each blocker
  // in a hover card the user can read (CAN-3053: desktop's row did the same;
  // a native title is invisible to anyone who does not wait for it).
  it('keeps a blocked Split PR visible and disabled with every blocker in its hover card', () => {
    const item = deriveWorktreeMenuItems(
      {
        ...context,
        splitPrBlockers: [
          'Commit or stash local changes',
          'Resolve the merge conflicts reported by GitHub first',
        ],
      },
      capabilities,
      callbacks,
    ).items.find((candidate) => candidate.key === 'split-pr');
    expect(item).toMatchObject({ disabled: true });
    expect(item?.tooltip).toBeUndefined();
    const card = renderToStaticMarkup(<>{item?.richTooltip}</>);
    expect(card).toContain('Split PR');
    expect(card).toContain('Commit or stash local changes');
    expect(card).toContain(
      'Resolve the merge conflicts reported by GitHub first',
    );
  });

  it('offers an unblocked Split PR without a hover card', () => {
    const item = deriveWorktreeMenuItems(
      context,
      capabilities,
      callbacks,
    ).items.find((candidate) => candidate.key === 'split-pr');
    expect(item).toMatchObject({ disabled: false });
    expect(item?.richTooltip).toBeUndefined();
  });
  it('emits the canonical full desktop order', () => {
    const items = deriveWorktreeMenuItems(
      context,
      capabilities,
      callbacks,
    ).items;
    expect(items.map((item) => item.key)).toEqual([
      'set-label',
      'branch-info',
      'launch',
      'dispatch-pipeline',
      'split-pr',
      'create-branch',
      'group-with-base',
      'add-repository',
      'toggle-hidden',
      'archive',
    ]);
    const archiveItem = items[items.length - 1];
    expect(archiveItem).toMatchObject({
      label: 'Archive',
      tone: 'default',
    });
    expect(renderToStaticMarkup(archiveItem?.icon ?? <></>)).toBe(
      renderToStaticMarkup(<ArchiveIcon />),
    );
  });

  it('does not expose legacy Auto Archive Lock or Unlock actions', () => {
    const items = deriveWorktreeMenuItems(
      context,
      capabilities,
      callbacks,
    ).items;
    expect(items.map((item) => item.key)).not.toContain('auto-archive-lock');
    expect(items.map((item) => item.label)).not.toEqual(
      expect.arrayContaining(['Lock', 'Unlock']),
    );
  });

  it('omits the three L3 action families for default-deny web capabilities', () => {
    const result = deriveWorktreeMenuItems(
      context,
      {
        pipelines: 'crud-only',
        worktreeSplitPr: false,
        worktreeBranchGrouping: false,
        worktreeRepositoryAttachment: false,
        removal: { behavior: 'archive', presentation: 'delete' },
      },
      callbacks,
    );
    expect(result.items.map((item) => item.key)).not.toEqual(
      expect.arrayContaining(['split-pr', 'group-with-base', 'add-repository']),
    );
    expect(result.items[result.items.length - 1]).toMatchObject({
      key: 'delete',
      label: 'Delete',
      tone: 'destructive',
    });
    expect(
      renderToStaticMarkup(
        result.items[result.items.length - 1]?.icon ?? <></>,
      ),
    ).toBe(renderToStaticMarkup(<TrashIcon />));
  });

  it.each([
    ['worktree', 'archive', 'Archive Feature', 'neutral', ArchiveIcon],
    ['session', 'archive', 'Archive session Feature', 'neutral', ArchiveIcon],
    ['worktree', 'delete', 'Delete Feature', 'destructive', TrashIcon],
    ['session', 'delete', 'Delete session Feature', 'destructive', TrashIcon],
  ] as const)(
    'uses %s copy with %s presentation for the done-row direct action',
    (subject, presentation, label, tone, Icon) => {
      const action = deriveWorktreeMenuItems(
        { ...context, subject, done: true },
        {
          ...capabilities,
          removal: { behavior: 'archive', presentation },
        },
        callbacks,
      ).directActions[0];
      expect(action).toMatchObject({ label, tone });
      const ActionIcon = action?.icon;
      expect(renderToStaticMarkup(ActionIcon ? <ActionIcon /> : <></>)).toBe(
        renderToStaticMarkup(<Icon />),
      );
    },
  );

  // An untitled cloud session's branch is the synthetic `cloud`; its removal
  // names the session, never that placeholder, under either presentation.
  it.each([
    ['archive', 'Archive session'],
    ['delete', 'Delete session'],
  ] as const)(
    'names an untitled session, not its branch, with %s presentation',
    (presentation, label) => {
      const action = deriveWorktreeMenuItems(
        {
          ...context,
          subject: 'session',
          label: '',
          branch: 'cloud',
          done: true,
        },
        {
          ...capabilities,
          removal: { behavior: 'archive', presentation },
        },
        callbacks,
      ).directActions[0];
      expect(action?.label).toBe(label);
    },
  );

  it.each([
    {
      name: 'active session',
      patch: { hasActiveSession: true },
      tooltip: 'Stop active sessions before adding a repo',
    },
    {
      name: 'done',
      patch: { done: true },
      tooltip: 'Done worktrees cannot add repos',
    },
    {
      name: 'git pending',
      patch: { setupPhase: 'git-pending' as const },
      tooltip: 'Wait for setup to finish before adding a repo',
    },
    {
      name: 'setup running',
      patch: { setupPhase: 'running-setup' as const },
      tooltip: 'Wait for setup to finish before adding a repo',
    },
  ])(
    'disables Add repository for $name with precedence copy',
    ({ patch, tooltip }) => {
      const item = deriveWorktreeMenuItems(
        { ...context, ...patch },
        capabilities,
        callbacks,
      ).items.find((candidate) => candidate.key === 'add-repository');
      expect(item).toMatchObject({ disabled: true, tooltip });
    },
  );

  it('applies launch, split-PR, hide, removal, separator, and direct-action rules', () => {
    const result = deriveWorktreeMenuItems(
      {
        ...context,
        hidden: true,
        done: true,
        launchRunning: true,
        splitPrLocked: true,
        splitPrBlockers: ['Uncommitted changes'],
      },
      capabilities,
      { ...callbacks, onToggleHiddenRequested: undefined },
    );
    expect(result.items.find((item) => item.key === 'launch')).toMatchObject({
      disabled: true,
      tooltip: 'Launch script is already running',
    });
    expect(result.items.find((item) => item.key === 'archive')).toMatchObject({
      separatorBefore: true,
    });
    expect(result.items.some((item) => item.key === 'create-branch')).toBe(
      false,
    );
    expect(result.directActions).toHaveLength(1);
  });

  it('names only the lock when a locked Split PR is also blocked', () => {
    const splitPr = deriveWorktreeMenuItems(
      {
        ...context,
        splitPrLocked: true,
        splitPrBlockers: ['Uncommitted changes'],
      },
      capabilities,
      callbacks,
    ).items.find((item) => item.key === 'split-pr');
    expect(splitPr).toMatchObject({ disabled: true });
    // The lock outranks the blockers: it is the one reason shown.
    const splitPrCard = renderToStaticMarkup(<>{splitPr?.richTooltip}</>);
    expect(splitPrCard).toContain(
      'A Split PR is already in progress for this worktree.',
    );
    expect(splitPrCard).not.toContain('Uncommitted changes');
  });

  it.each([
    ['ungroup-from-base', 'Unstack from base'],
    ['ungroup-children', 'Unstack children'],
    ['group-children', 'Stack children'],
    ['group-with-base', 'Stack on base'],
  ] as const)('normalizes %s to exactly one grouping item', (kind, label) => {
    const result = deriveWorktreeMenuItems(
      { ...context, groupingAction: { kind } },
      capabilities,
      callbacks,
    );
    expect(result.items.filter((item) => item.key.includes('group'))).toEqual([
      expect.objectContaining({ key: kind, label }),
    ]);
  });
});

// Desktop shows Delete on a clean or freshly created worktree that is not
// done. The shared code has no local-git state, so the host's verdict alone
// admits the chip; without it a row that is not done stays chip-free.
it('shows the removal chip on a row the host clears for direct removal', () => {
  const onRemovalRequested = jest.fn();
  const withoutVerdict = deriveWorktreeMenuItems(context, capabilities, {
    onRemovalRequested,
  });
  expect(withoutVerdict.directActions).toEqual([]);

  const menu = deriveWorktreeMenuItems(
    { ...context, directRemovalAvailable: true },
    capabilities,
    { onRemovalRequested, testIds: { directRemoval: 'chip' } },
  );
  expect(menu.directActions).toHaveLength(1);
  expect(menu.directActions[0]).toMatchObject({
    key: 'remove',
    testId: 'chip',
  });
  menu.directActions[0]?.onSelect();
  expect(onRemovalRequested).toHaveBeenCalledTimes(1);

  // An active session still disables removal, chip included.
  const locked = deriveWorktreeMenuItems(
    { ...context, directRemovalAvailable: true, hasActiveSession: true },
    capabilities,
    { onRemovalRequested },
  );
  expect(locked.directActions).toEqual([]);

  // So does a removal already in flight: the chip leaves and the menu's
  // removal is disabled until the host settles the row.
  const removing = deriveWorktreeMenuItems(
    { ...context, directRemovalAvailable: true, removalInProgress: true },
    capabilities,
    { onRemovalRequested },
  );
  expect(removing.directActions).toEqual([]);
  expect(removing.items.find((item) => item.key === 'archive')?.disabled).toBe(
    true,
  );
});

it('offers archive and delete with a confirmed Delete shortcut on done rows', () => {
  const onRemovalRequested = jest.fn();
  const menu = deriveWorktreeMenuItems(
    { ...context, done: true, retentionDays: 7 },
    {
      ...capabilities,
      removal: { behavior: 'archive', retention: 'archive-or-delete' },
    },
    { onRemovalRequested },
  );
  expect(menu.items.map((item) => item.key)).toEqual(['archive', 'delete']);
  expect(menu.directActions).toHaveLength(1);
  // Delete keeps the item for the retention window, so it is recoverable and
  // reads neutral like Archive, in the menu and on the hover chip alike.
  expect(menu.directActions[0]).toMatchObject({
    label: 'Delete Feature',
    icon: TrashIcon,
    tone: 'neutral',
    className: 'pointer-coarse:hidden',
  });
  expect(menu.items.map((item) => item.tone)).toEqual(['default', 'default']);
  expect(menu.directActions[0]?.onSelect).toBe(menu.items[1]?.onSelect);
  menu.directActions[0]?.onSelect();
  expect(onRemovalRequested).toHaveBeenCalledTimes(1);
  expect(onRemovalRequested).toHaveBeenCalledWith('delete');
  expect(menu.items[1]?.tooltip).toBe('Kept for 7 days, then removed');
  menu.items[1]?.onSelect?.();
  expect(onRemovalRequested).toHaveBeenCalledWith('delete');
});

it.each([
  { done: false },
  { hasActiveSession: true },
  { removalLockedBySplitPr: true },
  { removalInProgress: true },
])('withholds the retention shortcut for %p', (patch) => {
  const menu = deriveWorktreeMenuItems(
    { ...context, done: true, ...patch },
    {
      ...capabilities,
      removal: { behavior: 'archive', retention: 'archive-or-delete' },
    },
    callbacks,
  );
  expect(menu.directActions).toEqual([]);
});
it.each([false, true])(
  'withholds retention actions when handler missing=%p or removal unavailable',
  (missingHandler) => {
    const menu = deriveWorktreeMenuItems(
      { ...context, done: true },
      {
        ...capabilities,
        removal: {
          behavior: missingHandler ? 'archive' : false,
          retention: 'archive-or-delete',
        },
      },
      { onRemovalRequested: missingHandler ? undefined : jest.fn() },
    );
    expect(menu.directActions).toEqual([]);
    expect(menu.items).toEqual([]);
  },
);
it('uses singular retention tooltip for a one-day window', () => {
  const menu = deriveWorktreeMenuItems(
    { ...context, retentionDays: 1 },
    {
      ...capabilities,
      removal: { behavior: 'archive', retention: 'archive-or-delete' },
    },
    callbacks,
  );
  expect(menu.items.find((item) => item.key === 'delete')?.tooltip).toBe(
    'Kept for 1 day, then removed',
  );
});

it.each([
  ['idle', {}, true],
  ['active session', { hasActiveSession: true }, false],
  ['split PR lock', { removalLockedBySplitPr: true }, false],
] as const)(
  'offers the cloud retention shortcut for %s only when removable',
  (_name, patch, available) => {
    const onRemovalRequested = jest.fn();
    const menu = deriveWorktreeMenuItems(
      { ...context, backend: 'cloud', ...patch },
      {
        ...capabilities,
        removal: { behavior: 'archive', retention: 'archive-or-delete' },
      },
      { onRemovalRequested },
    );
    expect(menu.directActions).toHaveLength(available ? 1 : 0);
    if (available) {
      menu.directActions[0]?.onSelect();
      expect(onRemovalRequested).toHaveBeenCalledWith('delete');
    }
  },
);

describe('deriveWorktreeMenuItems — notifications', () => {
  const notifications = {
    status: 'ready' as const,
    override: 'attention' as const,
  };
  const keys = ['notify-all', 'notify-attention', 'notify-mute'];

  it('offers nothing unless the host supplies both state and a writer', () => {
    const withoutWriter = deriveWorktreeMenuItems(
      { ...context, notifications },
      capabilities,
      callbacks,
    );
    const withoutState = deriveWorktreeMenuItems(context, capabilities, {
      ...callbacks,
      onNotificationChoiceRequested: jest.fn(),
    });
    for (const menu of [withoutWriter, withoutState]) {
      expect(menu.items.some((item) => keys.includes(item.key))).toBe(false);
    }
  });

  it('adds one labelled radio group above Hide with the saved choice checked', () => {
    const onNotificationChoiceRequested = jest.fn();
    const { items } = deriveWorktreeMenuItems(
      { ...context, notifications },
      capabilities,
      {
        ...callbacks,
        onNotificationChoiceRequested,
        testIds: { notifications: 'row' },
      },
    );
    const group = items.filter((item) => keys.includes(item.key));
    expect(group.map((item) => item.key)).toEqual(keys);
    expect(
      items[items.findIndex((item) => item.key === 'notify-mute') + 1]?.key,
    ).toBe('toggle-hidden');
    expect(group[0]).toMatchObject({
      label: 'All activity',
      role: 'menuitemradio',
      checked: false,
      separatorBefore: true,
      sectionLabel: 'Notifications',
      testId: 'row-notify-all',
    });
    expect(group.map((item) => item.checked)).toEqual([false, true, false]);
    // The current choice is not a command; All activity clears the override.
    expect(group[1]?.onSelect).toBeUndefined();
    group[2]?.onSelect?.();
    group[0]?.onSelect?.();
    expect(onNotificationChoiceRequested.mock.calls).toEqual([
      ['mute'],
      [null],
    ]);
    expect(group[2]?.sectionStatus).toBeUndefined();
  });

  it('omits the group for a space whose choice never loaded', () => {
    // Nothing to choose and nothing to show: the cloud could not be reached.
    const { items } = deriveWorktreeMenuItems(
      {
        ...context,
        notifications: {
          status: 'failed',
          override: null,
          selectionKnown: false,
          failure: 'Couldn’t load notifications.',
        },
      },
      capabilities,
      { ...callbacks, onNotificationChoiceRequested: jest.fn() },
    );
    expect(items.some((item) => keys.includes(item.key))).toBe(false);
  });

  it('disables every choice and explains why on the last row', () => {
    const { items } = deriveWorktreeMenuItems(
      {
        ...context,
        notifications: { ...notifications, status: 'failed', failure: 'Nope' },
      },
      capabilities,
      {
        ...callbacks,
        onNotificationChoiceRequested: jest.fn(),
        testIds: { notifications: 'row' },
      },
    );
    expect(items.find((item) => item.key === 'notify-mute')).toMatchObject({
      disabled: false,
      sectionStatus: { tone: 'failure', text: 'Nope' },
      sectionStatusTestId: 'row-status',
    });
    const saving = deriveWorktreeMenuItems(
      {
        ...context,
        notifications: {
          ...notifications,
          status: 'saving',
          pendingChoice: 'mute',
        },
      },
      capabilities,
      { ...callbacks, onNotificationChoiceRequested: jest.fn() },
    ).items.filter((item) => keys.includes(item.key));
    // A save keeps the rows' ink and the menu's height: no greyed rows and no
    // status line, only no new save and a spinner on the pending row.
    expect(saving.some((item) => item.disabled)).toBe(false);
    expect(saving.some((item) => item.onSelect)).toBe(false);
    expect(saving[2]?.sectionStatus).toBeUndefined();
    expect(saving[1]?.checked).toBe(true);
    expect(saving[2]?.checked).toBe(false);
    // Screen readers hear the save in flight on the pending row.
    expect(saving.map((item) => item.busy === true)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe('deriveWorktreeMenuItems — label row copy', () => {
  const labelRow = (
    renameLabelAction?: boolean,
  ): ReturnType<typeof deriveWorktreeMenuItems>['items'][number] | undefined =>
    deriveWorktreeMenuItems(
      renameLabelAction === undefined
        ? context
        : { ...context, renameLabelAction },
      capabilities,
      callbacks,
    ).items.find((item) => item.key === 'set-label');

  it('keeps "Set label" with the label glyph by default', () => {
    for (const row of [labelRow(), labelRow(false)]) {
      expect(row?.label).toBe('Set label');
      expect(renderToStaticMarkup(row?.icon ?? <></>)).toBe(
        renderToStaticMarkup(<LabelIcon />),
      );
    }
  });

  it('reads "Rename" with a pencil with early access', () => {
    const row = labelRow(true);
    expect(row?.label).toBe('Rename');
    expect(renderToStaticMarkup(row?.icon ?? <></>)).toBe(
      renderToStaticMarkup(<PencilIcon />),
    );
  });
});

describe('foldWorktreeMenuIntoMore', () => {
  const row = (
    key: Parameters<typeof foldWorktreeMenuIntoMore>[0][number]['key'],
    separatorBefore = false,
  ): Parameters<typeof foldWorktreeMenuIntoMore>[0][number] => ({
    key,
    label: key,
    icon: null,
    onSelect: jest.fn(),
    separatorBefore,
  });

  it('moves the rare rows into More before Archive and Delete, removing none', () => {
    const items = [
      row('toggle-pin'),
      row('set-label'),
      row('branch-info'),
      row('invite'),
      row('launch'),
      row('dispatch-pipeline'),
      row('create-branch'),
      row('add-repository'),
      row('toggle-hidden', true),
      row('archive'),
      row('delete'),
    ];
    const folded = foldWorktreeMenuIntoMore(items);
    expect(folded.map((item) => item.key)).toEqual([
      'toggle-pin',
      'set-label',
      'invite',
      'launch',
      'more',
      'archive',
      'delete',
    ]);
    const more = folded.find((item) => item.key === 'more');
    expect(more?.submenu?.map((item) => item.key)).toEqual([
      'branch-info',
      'dispatch-pipeline',
      'create-branch',
      'add-repository',
      'toggle-hidden',
    ]);
    // The removal rows keep their divider; the moved rows drop theirs.
    expect(folded.find((item) => item.key === 'archive')?.separatorBefore).toBe(
      true,
    );
    expect(more?.submenu?.every((item) => item.separatorBefore !== true)).toBe(
      true,
    );
  });

  it('keeps a blocked Split PR disabled with its hover card inside More', () => {
    const { items } = deriveWorktreeMenuItems(
      { ...context, splitPrBlockers: ['Commit or stash local changes'] },
      capabilities,
      callbacks,
    );
    const more = foldWorktreeMenuIntoMore(items).find(
      (item) => item.key === 'more',
    );
    const splitPr = more?.submenu?.find((item) => item.key === 'split-pr');
    expect(splitPr).toMatchObject({ disabled: true });
    expect(renderToStaticMarkup(<>{splitPr?.richTooltip}</>)).toContain(
      'Commit or stash local changes',
    );
  });

  it('leaves a menu with no rare rows unchanged', () => {
    const items = [row('toggle-pin'), row('archive', true)];
    expect(foldWorktreeMenuIntoMore(items)).toEqual(items);
  });
});

describe('foldWorktreeNotificationsIntoSubmenu', () => {
  const derive = (
    override: 'attention' | 'mute' | null,
    status: 'ready' | 'failed' = 'ready',
  ): ReturnType<typeof deriveWorktreeMenuItems>['items'] =>
    deriveWorktreeMenuItems(
      { ...context, notifications: { status, override } },
      capabilities,
      {
        ...callbacks,
        onNotificationChoiceRequested: jest.fn(),
        testIds: { notifications: 'row' },
      },
    ).items;

  it('replaces the headed group with one Notifications submenu in its place', () => {
    const items = derive('attention');
    const folded = foldWorktreeNotificationsIntoSubmenu(items);
    const index = folded.findIndex((item) => item.key === 'notifications');
    expect(index).toBe(items.findIndex((item) => item.key === 'notify-all'));
    expect(folded[index + 1]?.key).toBe('toggle-hidden');
    expect(folded.some((item) => item.role === 'menuitemradio')).toBe(false);
    const submenu = folded[index];
    expect(submenu).toMatchObject({ kind: 'submenu', label: 'Notifications' });
    expect(submenu?.separatorBefore).not.toBe(true);
    expect(submenu?.submenu?.map((item) => item.key)).toEqual([
      'notify-all',
      'notify-attention',
      'notify-mute',
    ]);
    // The submenu's own label is the heading; the saved choice stays checked.
    expect(
      submenu?.submenu?.every(
        (item) =>
          item.sectionLabel === undefined && item.separatorBefore !== true,
      ),
    ).toBe(true);
    expect(
      submenu?.submenu?.filter((item) => item.checked).map((item) => item.key),
    ).toEqual(['notify-attention']);
  });

  it('keeps the status line under the last choice', () => {
    const folded = foldWorktreeNotificationsIntoSubmenu(
      derive('mute', 'failed'),
    );
    const submenu = folded.find((item) => item.key === 'notifications');
    expect(submenu?.submenu?.at(-1)?.sectionStatus).toMatchObject({
      tone: 'failure',
    });
  });

  it('leaves a menu without notification choices unchanged', () => {
    const { items } = deriveWorktreeMenuItems(context, capabilities, callbacks);
    expect(foldWorktreeNotificationsIntoSubmenu(items)).toEqual(items);
  });
});

describe('CAN-4280 action icon uniqueness', () => {
  it.each([
    [false, false, false],
    [false, true, false],
    [false, false, true],
    [true, false, false],
    [true, true, true],
  ])(
    'keeps distinct glyphs with done=%s pinned=%s hidden=%s',
    (done, pinned, hidden) => {
      const glyphs = new Map<string, string>([
        // Desktop inserts this beside the shared actions for temporary projects.
        ['split-workspace', renderToStaticMarkup(<SplitIcon />)],
      ]);
      for (const kind of [
        'group-with-base',
        'ungroup-from-base',
        'group-children',
        'ungroup-children',
      ] as const) {
        const { items } = deriveWorktreeMenuItems(
          { ...context, done, pinned, hidden, groupingAction: { kind } },
          capabilities,
          {
            ...callbacks,
            onDebugInfoRequested: jest.fn(),
            onMoveToOrganizationRequested: jest.fn(),
            onTogglePinnedRequested: jest.fn(),
          },
        );
        for (const item of items) {
          expect(item.icon).not.toBeNull();
          glyphs.set(item.key, renderToStaticMarkup(<>{item.icon}</>));
        }
      }
      expect(new Set(glyphs.values()).size).toBe(glyphs.size);
    },
  );
});

describe('worktreeRemovalBlockedReason', () => {
  const clear = { removalLockedBySplitPr: false, removalInProgress: false };

  it('returns undefined when nothing blocks removal', () => {
    expect(worktreeRemovalBlockedReason(clear)).toBeUndefined();
  });

  it('names the blocking fact, in-progress removal first', () => {
    expect(
      worktreeRemovalBlockedReason({
        removalLockedBySplitPr: true,
        removalInProgress: true,
        hasActiveSession: true,
      }),
    ).toBe('Removal is already in progress');
    expect(
      worktreeRemovalBlockedReason({
        ...clear,
        removalLockedBySplitPr: true,
        hasActiveSession: true,
      }),
    ).toBe('A Split PR is in progress; it must finish before archiving.');
    expect(
      worktreeRemovalBlockedReason({
        ...clear,
        hasActiveSession: true,
        setupPhase: 'running-setup',
      }),
    ).toBe('Stop all sessions before archiving');
    expect(
      worktreeRemovalBlockedReason({ ...clear, setupPhase: 'git-pending' }),
    ).toBe('Wait for setup to finish');
  });

  it('keeps the single-row fallback for a disabled Archive', () => {
    expect(worktreeArchiveBlockedReason(clear)).toBe(
      'Stop all sessions before archiving',
    );
  });
});

describe('batchActionAvailability', () => {
  it('enables both actions when every row offers Archive and Delete', () => {
    expect(
      batchActionAvailability(
        [
          { removal: 'archive', retention: 'archive-or-delete' },
          { removal: 'delete', retention: 'archive-or-delete' },
        ],
        WORKTREE_BATCH_UNIT,
      ),
    ).toEqual({ archive: { enabled: true }, delete: { enabled: true } });
  });

  it('enables only Archive, and offers no Delete, when every row offers only Archive', () => {
    expect(
      batchActionAvailability(
        [{ removal: 'archive' }, { removal: 'archive' }],
        WORKTREE_BATCH_UNIT,
      ),
    ).toEqual({
      archive: { enabled: true },
      delete: {
        enabled: false,
        offered: false,
        disabledReason: "Some selected worktrees can't be deleted",
      },
    });
  });

  it('disables both for mixed archive and delete capabilities', () => {
    const availability = batchActionAvailability(
      [{ removal: 'archive' }, { removal: 'delete' }],
      WORKTREE_BATCH_UNIT,
    );
    expect(availability.archive).toEqual({
      enabled: false,
      disabledReason: "Some selected worktrees can't be archived",
    });
    expect(availability.delete).toEqual({
      enabled: false,
      disabledReason: "Some selected worktrees can't be deleted",
    });
  });

  it('disables Delete when retention support is mixed', () => {
    const availability = batchActionAvailability(
      [
        { removal: 'archive', retention: 'archive-or-delete' },
        { removal: 'archive' },
      ],
      WORKTREE_BATCH_UNIT,
    );
    expect(availability.archive.enabled).toBe(true);
    expect(availability.delete).toEqual({
      enabled: false,
      disabledReason: "Some selected worktrees can't be deleted",
    });
  });

  it('disables both when a row has no removal or its workspace is gated', () => {
    expect(
      batchActionAvailability(
        [
          { removal: 'archive', retention: 'archive-or-delete' },
          { removal: false },
        ],
        WORKTREE_BATCH_UNIT,
      ).archive.enabled,
    ).toBe(false);
    const gated = batchActionAvailability(
      [
        { removal: 'archive', retention: 'archive-or-delete' },
        {
          removal: 'archive',
          retention: 'archive-or-delete',
          commandsDisabled: true,
        },
      ],
      WORKTREE_BATCH_UNIT,
    );
    expect(gated.archive).toEqual({
      enabled: false,
      disabledReason: "Some selected worktrees can't be changed right now",
    });
    expect(gated.delete.enabled).toBe(false);
  });

  it('enables nothing for an empty selection', () => {
    expect(batchActionAvailability([], WORKTREE_BATCH_UNIT)).toEqual({
      archive: { enabled: false },
      delete: { enabled: false },
    });
  });
});

describe('deriveWorktreeMenuItems — bulk selection (CAN-3975)', () => {
  it('the selection menu carries its state actions', () => {
    const onBulkStateActionRequested = jest.fn();
    const { items } = deriveWorktreeMenuItems(
      {
        ...context,
        multiSelected: true,
        bulkSelection: {
          count: 2,
          unitLabel: WORKTREE_BATCH_UNIT,
          availability: {
            archive: { enabled: true },
            delete: { enabled: false, offered: false },
          },
          stateActions: { pin: { pinned: false }, hide: true },
        },
      },
      capabilities,
      {
        ...callbacks,
        onBulkRemovalRequested: jest.fn(),
        onBulkStateActionRequested,
        testIds: { bulkHide: 'hide-id' },
      },
    );
    expect(items.map((item) => item.label)).toEqual([
      'Unpin 2 worktrees',
      'Hide 2 worktrees',
      'Archive 2 worktrees',
    ]);
    expect(items[1]?.testId).toBe('hide-id');
    items[1]?.onSelect?.();
    expect(onBulkStateActionRequested).toHaveBeenCalledWith({ kind: 'hide' });
  });

  it('offers Select, or Deselect for a selected row, only when the host wires it', () => {
    const plain = deriveWorktreeMenuItems(context, capabilities, callbacks);
    expect(plain.items.some((item) => item.key === 'toggle-selection')).toBe(
      false,
    );
    const onToggleSelectionRequested = jest.fn();
    const select = deriveWorktreeMenuItems(context, capabilities, {
      ...callbacks,
      onToggleSelectionRequested,
    });
    const item = select.items.find((entry) => entry.key === 'toggle-selection');
    expect(item?.label).toBe('Select');
    item?.onSelect?.();
    expect(onToggleSelectionRequested).toHaveBeenCalledTimes(1);
    const deselect = deriveWorktreeMenuItems(
      { ...context, multiSelected: true },
      capabilities,
      { ...callbacks, onToggleSelectionRequested },
    );
    expect(
      deselect.items.find((entry) => entry.key === 'toggle-selection')?.label,
    ).toBe('Deselect');
  });

  it("names the platform's click shortcut beside Select", () => {
    const platform = jest.spyOn(navigator, 'platform', 'get');
    try {
      const shortcutOn = (value: string): string | undefined => {
        platform.mockReturnValue(value);
        return deriveWorktreeMenuItems(context, capabilities, {
          ...callbacks,
          onToggleSelectionRequested: jest.fn(),
        }).items.find((entry) => entry.key === 'toggle-selection')?.shortcut;
      };
      expect(shortcutOn('MacIntel')).toBe('⌘ Click');
      expect(shortcutOn('Win32')).toBe('Ctrl Click');
    } finally {
      platform.mockRestore();
    }
  });

  it("returns only the selection's actions for a row in a selection of 2 or more", () => {
    const onBulkRemovalRequested = jest.fn();
    const onClearSelectionRequested = jest.fn();
    const { items, directActions } = deriveWorktreeMenuItems(
      {
        ...context,
        done: true,
        multiSelected: true,
        bulkSelection: {
          count: 3,
          unitLabel: WORKTREE_BATCH_UNIT,
          availability: {
            archive: { enabled: true },
            delete: {
              enabled: false,
              disabledReason: "Some selected worktrees can't be deleted",
            },
          },
        },
      },
      capabilities,
      {
        ...callbacks,
        onToggleSelectionRequested: jest.fn(),
        onBulkRemovalRequested,
        onClearSelectionRequested,
      },
    );
    expect(items.map((item) => [item.key, item.label])).toEqual([
      ['bulk-archive', 'Archive 3 worktrees'],
      ['bulk-delete', 'Delete 3 worktrees'],
      ['clear-selection', 'Clear selection'],
    ]);
    expect(items[1]).toMatchObject({
      disabled: true,
      tooltip: "Some selected worktrees can't be deleted",
    });
    expect(directActions).toEqual([]);
    items[0]?.onSelect?.();
    expect(onBulkRemovalRequested).toHaveBeenCalledWith('archive');
    items[2]?.onSelect?.();
    expect(onClearSelectionRequested).toHaveBeenCalledTimes(1);
  });

  it('leaves out a bulk action no selected row offers', () => {
    const { items } = deriveWorktreeMenuItems(
      {
        ...context,
        multiSelected: true,
        bulkSelection: {
          count: 2,
          unitLabel: WORKTREE_BATCH_UNIT,
          availability: {
            archive: { enabled: true },
            delete: { enabled: false, offered: false },
          },
        },
      },
      capabilities,
      {
        ...callbacks,
        onBulkRemovalRequested: jest.fn(),
        onClearSelectionRequested: jest.fn(),
      },
    );
    expect(items.map((item) => item.key)).toEqual([
      'bulk-archive',
      'clear-selection',
    ]);
  });

  it('keeps the row menu for a selection of one', () => {
    const { items } = deriveWorktreeMenuItems(
      {
        ...context,
        multiSelected: true,
        bulkSelection: {
          count: 1,
          unitLabel: WORKTREE_BATCH_UNIT,
          availability: {
            archive: { enabled: true },
            delete: { enabled: true },
          },
        },
      },
      capabilities,
      { ...callbacks, onBulkRemovalRequested: jest.fn() },
    );
    expect(items.some((item) => item.key === 'bulk-archive')).toBe(false);
    expect(items.some((item) => item.key === 'archive')).toBe(true);
  });
});
