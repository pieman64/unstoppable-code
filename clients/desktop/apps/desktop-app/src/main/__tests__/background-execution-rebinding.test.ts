import {
  createBackgroundExecutionContextRebinder,
  recordedOwnershipChange,
  type BackgroundExecutionContextRebinderDeps,
  type BackgroundExecutionItemStore,
  type BackgroundExecutionRebindRecord,
  type BackgroundExecutionStoreRebind,
  type WorkspaceOwnershipChange,
} from '../services/background-execution-rebinding';

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const converted: WorkspaceOwnershipChange = {
  workspaceId: 'converted',
  from: { kind: 'personal' },
  to: { kind: 'organization', organizationId: ORG },
};

interface Harness {
  deps: BackgroundExecutionContextRebinderDeps;
  calls: Array<{ itemType: string; input: BackgroundExecutionStoreRebind }>;
  recorded: BackgroundExecutionRebindRecord[];
  marked: { value: boolean };
}

function harness(
  options: {
    recordedChanges?: WorkspaceOwnershipChange[];
    failing?: BackgroundExecutionItemStore['itemType'];
    alreadyRepaired?: boolean;
  } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const recorded: BackgroundExecutionRebindRecord[] = [];
  const marked = { value: options.alreadyRepaired === true };
  const store = (
    itemType: BackgroundExecutionItemStore['itemType'],
    ids: string[],
  ): BackgroundExecutionItemStore => ({
    itemType,
    rebind: (input): Promise<string[]> => {
      calls.push({ itemType, input });
      return options.failing === itemType
        ? Promise.reject(new Error(`${itemType} store failed`))
        : Promise.resolve(ids);
    },
  });
  return {
    calls,
    recorded,
    marked,
    deps: {
      stores: [
        store('automation', ['automation-1']),
        store('watcher', ['watcher-1']),
        store('hook', ['workspace-root:pr:create:0']),
      ],
      listRecordedOwnershipChanges: (): Promise<WorkspaceOwnershipChange[]> =>
        Promise.resolve(options.recordedChanges ?? []),
      hasStartupRepairRun: (): Promise<boolean> =>
        Promise.resolve(marked.value),
      markStartupRepairRun: (): Promise<void> => {
        marked.value = true;
        return Promise.resolve();
      },
      recordRebind: (record): void => {
        recorded.push(record);
      },
    },
  };
}

describe('background execution context rebinding (CAN-3543)', () => {
  it('rebinds every item store with serialized contexts and records each item', async (): Promise<void> => {
    const { deps, calls, recorded } = harness();
    const rebinder = createBackgroundExecutionContextRebinder(deps);

    await rebinder.rebindWorkspace(converted, 'ownership-change');

    const input = {
      workspaceId: 'converted',
      previousContext: 'personal',
      nextContext: `org:${ORG}`,
    };
    expect(calls).toEqual([
      { itemType: 'automation', input },
      { itemType: 'watcher', input },
      { itemType: 'hook', input },
    ]);
    expect(
      recorded.map(({ itemType, itemId, reason }) => [
        itemType,
        itemId,
        reason,
      ]),
    ).toEqual([
      ['automation', 'automation-1', 'ownership-change'],
      ['watcher', 'watcher-1', 'ownership-change'],
      ['hook', 'workspace-root:pr:create:0', 'ownership-change'],
    ]);
  });

  it('does nothing when the owner context did not change', async (): Promise<void> => {
    const { deps, calls } = harness();
    const rebinder = createBackgroundExecutionContextRebinder(deps);

    await expect(
      rebinder.rebindWorkspace(
        { ...converted, from: converted.to },
        'ownership-change',
      ),
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('keeps rebinding the other stores when one fails, then rejects', async (): Promise<void> => {
    const { deps, calls, recorded } = harness({ failing: 'watcher' });
    const rebinder = createBackgroundExecutionContextRebinder(deps);

    await expect(
      rebinder.rebindWorkspace(converted, 'ownership-change'),
    ).rejects.toThrow('watcher store failed');
    expect(calls.map((call) => call.itemType)).toEqual([
      'automation',
      'watcher',
      'hook',
    ]);
    expect(recorded.map((record) => record.itemType)).toEqual([
      'automation',
      'hook',
    ]);
  });

  it('repairs recorded conversions and move backs once at startup', async (): Promise<void> => {
    const movedBack: WorkspaceOwnershipChange = {
      workspaceId: 'moved-back',
      from: { kind: 'organization', organizationId: OTHER_ORG },
      to: { kind: 'personal' },
    };
    const { deps, calls, recorded, marked } = harness({
      recordedChanges: [converted, movedBack],
    });
    const rebinder = createBackgroundExecutionContextRebinder(deps);

    await rebinder.repairRecordedOwnershipChanges();
    await rebinder.repairRecordedOwnershipChanges();

    expect(
      calls
        .filter((call) => call.itemType === 'automation')
        .map((call) => call.input),
    ).toEqual([
      {
        workspaceId: 'converted',
        previousContext: 'personal',
        nextContext: `org:${ORG}`,
      },
      {
        workspaceId: 'moved-back',
        previousContext: `org:${OTHER_ORG}`,
        nextContext: 'personal',
      },
    ]);
    expect(new Set(recorded.map((record) => record.reason))).toEqual(
      new Set(['startup-repair']),
    );
    expect(marked.value).toBe(true);
  });

  it('retries the startup repair next time when a workspace fails', async (): Promise<void> => {
    const { deps, marked } = harness({
      recordedChanges: [converted],
      failing: 'hook',
    });
    const rebinder = createBackgroundExecutionContextRebinder(deps);

    await rebinder.repairRecordedOwnershipChanges();

    expect(marked.value).toBe(false);
  });

  it('skips the startup repair once it has run', async (): Promise<void> => {
    const { deps, calls } = harness({
      recordedChanges: [converted],
      alreadyRepaired: true,
    });
    const rebinder = createBackgroundExecutionContextRebinder(deps);

    await rebinder.repairRecordedOwnershipChanges();

    expect(calls).toEqual([]);
  });
});

describe('recordedOwnershipChange', () => {
  const owner = {
    type: 'organization' as const,
    organizationId: ORG,
    projectId: 'project',
    instanceId: 'instance',
    bindingGeneration: 1,
  };
  const transfer = {
    version: 1 as const,
    previousOwner: { type: 'personal' as const },
    organizationId: ORG,
    projectId: 'project',
    convertedAt: '2026-09-27T10:00:00.000Z',
  };

  it('reads a conversion from Personal', (): void => {
    expect(
      recordedOwnershipChange('ws', { owner, ownershipTransfer: transfer }),
    ).toEqual({
      workspaceId: 'ws',
      from: { kind: 'personal' },
      to: { kind: 'organization', organizationId: ORG },
    });
  });

  it('reads a move back to Personal', (): void => {
    expect(
      recordedOwnershipChange('ws', {
        ownershipTransfer: { ...transfer, movedBackAt: '2026-09-28' },
      }),
    ).toEqual({
      workspaceId: 'ws',
      from: { kind: 'organization', organizationId: ORG },
      to: { kind: 'personal' },
    });
  });

  it.each([
    ['no transfer', { owner }],
    [
      'an owner that is not the transfer organization',
      {
        owner: { ...owner, organizationId: OTHER_ORG },
        ownershipTransfer: transfer,
      },
    ],
    [
      'a moved-back record that is owned again',
      {
        owner,
        ownershipTransfer: { ...transfer, movedBackAt: '2026-09-28' },
      },
    ],
  ])('ignores %s', (_name, config): void => {
    expect(recordedOwnershipChange('ws', config)).toBeNull();
  });
});
