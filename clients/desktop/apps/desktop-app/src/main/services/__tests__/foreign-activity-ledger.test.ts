import {
  ForeignActivityLedger,
  type ForeignActivityOperation,
  type ForeignActivitySource,
  type ForeignActivitySourceEvent,
} from '../foreign-activity-ledger';

class Source implements ForeignActivitySource {
  sequence = 0;
  operations: ForeignActivityOperation[] = [];
  listeners = new Set<(event: ForeignActivitySourceEvent) => void>();
  onSnapshot: (() => void) | undefined;

  subscribe(listener: (event: ForeignActivitySourceEvent) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): { sequence: number; operations: ForeignActivityOperation[] } {
    const snapshot = {
      sequence: this.sequence,
      operations: [...this.operations],
    };
    this.onSnapshot?.();
    return snapshot;
  }

  emit(operation: ForeignActivityOperation): void {
    this.sequence += 1;
    this.operations = [operation];
    this.listeners.forEach((listener): void =>
      listener({ sequence: this.sequence, operation }),
    );
  }
}

const running: ForeignActivityOperation = {
  source: 'chat',
  operationId: 'turn-a',
  chatId: 'chat-a',
  workspaceId: 'workspace-a',
  worktreeId: 'worktree-a',
  context: { kind: 'organization', organizationId: 'org-a' },
  active: true,
  resultToken: 'previous:1',
  unreadToken: 'previous:1',
};
const completed: ForeignActivityOperation = {
  ...running,
  active: false,
  resultToken: 'result:2',
  unreadToken: 'result:2',
};
const b = {
  kind: 'organization',
  organizationId: 'org-b',
} satisfies ForeignActivityOperation['context'];
const c = {
  kind: 'organization',
  organizationId: 'org-c',
} satisfies ForeignActivityOperation['context'];

describe('foreign activity epoch ledger', (): void => {
  let source: Source;
  let ledger: ForeignActivityLedger;
  let now: number;
  let nextId: number;
  beforeEach((): void => {
    source = new Source();
    now = 1000;
    nextId = 0;
    ledger = new ForeignActivityLedger(
      source,
      (): number => now,
      (): string => String(++nextId),
    );
  });

  it('A → B → C drops completed A without importing its unread backlog', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    expect(ledger.entries()).toEqual([
      expect.objectContaining({
        state: 'FOREIGN_ACTIVE',
        baselineToken: 'previous:1',
      }),
    ]);
    source.emit(completed);
    expect(ledger.entries()).toEqual([
      expect.objectContaining({ state: 'FOREIGN_COMPLETED_UNREAD' }),
    ]);
    ledger.switchContext('account', c);
    expect(ledger.entries()).toEqual([]);
  });

  it('A → B → C registers A again when its operation is still running', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    ledger.switchContext('account', c);
    expect(ledger.entries()).toHaveLength(1);
    expect(source.listeners.size).toBe(1);
  });

  it('excludes pre-switch unread and does not resurrect it on returning then leaving', (): void => {
    source.emit(completed);
    ledger.switchContext('account', b);
    ledger.switchContext('account', running.context);
    ledger.switchContext('account', c);
    expect(ledger.entries()).toEqual([]);
  });

  it('replays a completion racing the snapshot after registering its baseline', (): void => {
    source.emit(running);
    source.onSnapshot = (): void => source.emit(completed);
    ledger.switchContext('account', b);
    expect(ledger.entries()).toEqual([
      expect.objectContaining({ state: 'FOREIGN_COMPLETED_UNREAD' }),
    ]);
  });

  it('lingers for split attention, ignores the old token, then accepts the matching new token', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    source.emit({ ...completed, unreadToken: 'previous:1' });
    expect(ledger.entries()).toEqual([
      expect.objectContaining({ state: 'FOREIGN_COMPLETED_LINGER' }),
    ]);
    now += 29_999;
    source.emit(completed);
    expect(ledger.entries()).toEqual([
      expect.objectContaining({ state: 'FOREIGN_COMPLETED_UNREAD' }),
    ]);
    source.emit({ ...completed, unreadToken: null });
    expect(ledger.entries()).toEqual([]);
  });

  it('expires linger after 30 seconds and cannot reimport a late unread', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    source.emit({ ...completed, unreadToken: null });
    now += 30_000;
    expect(ledger.entries()).toEqual([]);
    source.emit(completed);
    expect(ledger.entries()).toEqual([]);
  });

  it('ignores stale and duplicate source deliveries across windows', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    source.emit(completed);
    source.listeners.forEach((listener): void =>
      [1, 2].forEach((sequence): void =>
        listener({ sequence, operation: running }),
      ),
    );
    expect(ledger.entries()).toEqual([
      expect.objectContaining({ state: 'FOREIGN_COMPLETED_UNREAD' }),
    ]);
  });

  it('preserves the epoch through partial hydration and interrupts a crash-lost process only after hydration', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    const saved = ledger.file();
    ledger.dispose();
    source.operations = [];
    ledger = new ForeignActivityLedger(
      source,
      (): number => now,
      (): string => 'restart',
    );
    ledger.restore(saved, b);
    ledger.reconcile('chat', false);
    expect(ledger.file().epoch).toBe(saved.epoch);
    expect(ledger.entries()[0]?.state).toBe('FOREIGN_ACTIVE');
    ledger.reconcile('pipeline', true);
    expect(ledger.entries()[0]?.state).toBe('FOREIGN_ACTIVE');
    ledger.reconcile('chat', true);
    expect(ledger.entries()[0]).toMatchObject({
      interrupted: true,
      state: 'FOREIGN_COMPLETED_LINGER',
      operation: { active: false },
    });
  });

  it('clears Interrupted when an authoritative completed result arrives after hydration', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    const saved = ledger.file();
    ledger.dispose();
    source.operations = [];
    ledger.restore(saved, b);
    ledger.reconcile('chat', true);
    expect(ledger.entries()[0]).toMatchObject({
      state: 'FOREIGN_COMPLETED_LINGER',
      interrupted: true,
    });
    source.emit(completed);
    expect(ledger.entries()[0]).toMatchObject({
      state: 'FOREIGN_COMPLETED_UNREAD',
      interrupted: false,
      operation: completed,
    });
  });

  it('bounds completed entries without dropping active operations', (): void => {
    ledger.switchContext('account', b);
    for (let index = 0; index < 205; index += 1) {
      const operationId = `turn-${index}`;
      source.emit({ ...running, operationId });
      now += 1;
      source.emit({ ...completed, operationId });
    }
    source.emit({ ...running, operationId: 'still-running' });
    expect(
      ledger
        .entries()
        .filter((entry): boolean => entry.state === 'FOREIGN_COMPLETED_UNREAD'),
    ).toHaveLength(200);
    expect(
      ledger
        .entries()
        .some(
          (entry): boolean => entry.operation.operationId === 'still-running',
        ),
    ).toBe(true);
  });

  it('removes revoked contexts from entries and persisted state while retaining Personal', (): void => {
    source.operations = [
      running,
      {
        ...running,
        operationId: 'personal-turn',
        context: { kind: 'personal' },
      },
    ];
    ledger.switchContext('account', b);
    const changed = jest.fn();
    ledger.subscribe(changed);
    ledger.retainContexts(
      (context: ForeignActivityOperation['context']): boolean =>
        context.kind === 'personal',
    );
    expect(
      ledger.entries().map((entry): string => entry.operation.operationId),
    ).toEqual(['personal-turn']);
    expect(JSON.stringify(ledger.file())).not.toContain('org-a');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('purges on sign-out and ignores later source delivery', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    ledger.purge();
    source.emit(completed);
    expect(ledger.entries()).toEqual([]);
    expect(ledger.file().accountId).toBe('');
    expect(source.listeners.size).toBe(0);
  });

  it('accepts a new foreign operation after the switch, excluding idle sources', (): void => {
    ledger.switchContext('account', b);
    source.emit(completed);
    expect(ledger.entries()).toEqual([]);
    source.emit({ ...running, operationId: 'new-turn' });
    expect(ledger.entries()).toHaveLength(1);
  });

  it('restores an epoch and registers only new active foreign snapshot operations', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    const saved = ledger.file();
    ledger.dispose();
    const newOperation = {
      ...running,
      operationId: 'new-turn',
      resultToken: 'baseline:3',
    };
    source.operations = [
      { ...running, resultToken: 'changed:2' },
      newOperation,
      { ...completed, operationId: 'idle-turn' },
      { ...running, operationId: 'local-turn', context: b },
    ];
    ledger.restore(saved, b);
    ledger.reconcile('chat', true);
    expect(ledger.file().epoch).toBe(saved.epoch);
    expect(ledger.entries()).toEqual([
      expect.objectContaining({ baselineToken: 'previous:1' }),
      expect.objectContaining({
        operation: newOperation,
        state: 'FOREIGN_ACTIVE',
        baselineToken: 'baseline:3',
      }),
    ]);
    source.emit({
      ...newOperation,
      active: false,
      resultToken: 'new-turn:4',
      unreadToken: 'new-turn:4',
    });
    expect(ledger.entries()[1]?.state).toBe('FOREIGN_COMPLETED_UNREAD');
  });

  it('reconciles a persisted active entry with its hydrated terminal result', (): void => {
    source.emit(running);
    ledger.switchContext('account', b);
    const saved = ledger.file();
    ledger.dispose();
    source.emit(completed);
    ledger = new ForeignActivityLedger(
      source,
      (): number => now,
      (): string => 'restart',
    );
    ledger.restore(saved, b);
    ledger.reconcile('chat', true);
    expect(ledger.entries()[0]?.state).toBe('FOREIGN_COMPLETED_UNREAD');
  });
});
