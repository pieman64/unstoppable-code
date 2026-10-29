import {
  useTerminalActivityStore,
  configureTerminalActivityHost,
  type TerminalActivityEntry,
} from '../terminal-activity-store';
import {
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_SANDBOX_ASLEEP_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
  type TerminalExitEvent,
  type TerminalRunningChangedEvent,
} from '@canopy/protocol/terminal';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'wt-1';
const WORKTREE_KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

function resetStore(): void {
  configureTerminalActivityHost({});
  useTerminalActivityStore.setState({
    entriesByWorktree: {},
    runningWorktreeKeys: new Set<string>(),
    unseenWorktreeKeys: new Set<string>(),
    unseenFailureWorktreeKeys: new Set<string>(),
    baselineEstablished: new Set<string>(),
    userInitiatedCloseTerminalIds: new Set<string>(),
  });
}

function runningEvent(
  overrides: Partial<TerminalRunningChangedEvent> & { terminalId: string },
): TerminalRunningChangedEvent {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    running: true,
    processName: 'sleep',
    ...overrides,
  };
}

function exitEvent(
  overrides: Partial<TerminalExitEvent> & { terminalId: string },
): TerminalExitEvent {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    exitCode: 0,
    signal: null,
    ...overrides,
  };
}

function commandEnd(
  terminalId: string,
  exitCode: number | null,
  overrides: Partial<TerminalRunningChangedEvent> = {},
): TerminalRunningChangedEvent {
  return runningEvent({
    terminalId,
    running: false,
    processName: null,
    exitCode,
    ...overrides,
  });
}

function activityEntry(terminalId: string): TerminalActivityEntry | undefined {
  return useTerminalActivityStore.getState().entriesByWorktree[WORKTREE_KEY]?.[
    terminalId
  ];
}

interface WorktreeIndicators {
  running: boolean;
  unseen: boolean;
  unseenFailure: boolean;
}

function worktreeIndicators(): WorktreeIndicators {
  const state = useTerminalActivityStore.getState();
  return {
    running: state.runningWorktreeKeys.has(WORKTREE_KEY),
    unseen: state.unseenWorktreeKeys.has(WORKTREE_KEY),
    unseenFailure: state.unseenFailureWorktreeKeys.has(WORKTREE_KEY),
  };
}

describe('terminalActivityStore', () => {
  beforeEach(() => {
    resetStore();
  });

  afterAll(() => {
    configureTerminalActivityHost({});
  });

  describe('baseline gate', () => {
    it('ignores the first running:false event but seeds baselineEstablished', () => {
      const store = useTerminalActivityStore.getState();
      store.handleRunningChanged(
        runningEvent({ terminalId: 't1', running: false, processName: null }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.baselineEstablished.has('t1')).toBe(true);
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    });

    it('records processStartedAt on running:true and seeds baseline', () => {
      const before = Date.now();
      useTerminalActivityStore
        .getState()
        .handleRunningChanged(runningEvent({ terminalId: 't1' }));
      const after = Date.now();

      const entry =
        useTerminalActivityStore.getState().entriesByWorktree[WORKTREE_KEY][
          't1'
        ];
      const processStartedAt = entry.processStartedAt;
      expect(entry.running).toBe(true);
      expect(entry.processName).toBe('sleep');
      expect(processStartedAt).not.toBeNull();
      if (processStartedAt === null) {
        throw new Error('Expected processStartedAt to be recorded');
      }
      expect(processStartedAt).toBeGreaterThanOrEqual(before);
      expect(processStartedAt).toBeLessThanOrEqual(after);
      expect(
        useTerminalActivityStore.getState().baselineEstablished.has('t1'),
      ).toBe(true);
      expect(
        useTerminalActivityStore
          .getState()
          .runningWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(true);
    });

    it('preserves processStartedAt across repeated running:true updates', () => {
      const realNow = Date.now;
      let nowMs = 1_700_000_000_000;
      Date.now = (): number => nowMs;

      try {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        nowMs += 1_500;
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'node' }),
        );
      } finally {
        Date.now = realNow;
      }

      const entry =
        useTerminalActivityStore.getState().entriesByWorktree[WORKTREE_KEY][
          't1'
        ];
      expect(entry.processStartedAt).toBe(1_700_000_000_000);
      expect(entry.processName).toBe('node');
    });
  });

  describe('script terminals', () => {
    it('leaves activity and completion ownership to the script lifecycle', () => {
      const store = useTerminalActivityStore.getState();
      store.handleRunningChanged(
        runningEvent({
          terminalId: 'script-1',
          kind: 'script',
          processName: 'node',
        }),
      );
      store.handleExit(
        exitEvent({
          terminalId: 'script-1',
          kind: 'script',
          exitCode: 1,
        }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    });
  });

  describe('foreground process completion', () => {
    it('marks worktree unseen when running:false follows running:true ≥3s and non-shell', () => {
      const realNow = Date.now;
      let nowMs = 1_700_000_000_000;
      Date.now = (): number => nowMs;

      try {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        nowMs += 3_500;
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', running: false, processName: null }),
        );
      } finally {
        Date.now = realNow;
      }

      expect(
        useTerminalActivityStore
          .getState()
          .unseenWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(true);
      expect(
        useTerminalActivityStore
          .getState()
          .runningWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(false);
    });

    it('does NOT mark unseen if process ran <3s', () => {
      const realNow = Date.now;
      let nowMs = 1_700_000_000_000;
      Date.now = (): number => nowMs;

      try {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        nowMs += 1_000;
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', running: false, processName: null }),
        );
      } finally {
        Date.now = realNow;
      }

      expect(
        useTerminalActivityStore
          .getState()
          .unseenWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(false);
    });

    it('does NOT mark unseen for shell process names', () => {
      const realNow = Date.now;
      let nowMs = 1_700_000_000_000;
      Date.now = (): number => nowMs;

      try {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'pwsh.exe' }),
        );
        nowMs += 5_000;
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', running: false, processName: null }),
        );
      } finally {
        Date.now = realNow;
      }

      expect(
        useTerminalActivityStore
          .getState()
          .unseenWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(false);
    });

    it('does NOT mark unseen when the process was interrupted by the user', () => {
      const realNow = Date.now;
      let nowMs = 1_700_000_000_000;
      Date.now = (): number => nowMs;

      try {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        nowMs += 5_000;
        store.handleRunningChanged(
          runningEvent({
            terminalId: 't1',
            running: false,
            processName: null,
            interruptedByUser: true,
          }),
        );
      } finally {
        Date.now = realNow;
      }

      expect(
        useTerminalActivityStore
          .getState()
          .unseenWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(false);
    });
  });

  describe('PTY exit', () => {
    it('marks worktree unseen on a clean exit (exitCode=0, signal=null)', () => {
      useTerminalActivityStore
        .getState()
        .handleExit(exitEvent({ terminalId: 't1', exitCode: 0, signal: null }));

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    });

    it('treats signal 0 as a clean exit', () => {
      useTerminalActivityStore
        .getState()
        .handleExit(exitEvent({ terminalId: 't1', exitCode: 0, signal: '0' }));

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.entriesByWorktree[WORKTREE_KEY].t1.signal).toBeNull();
    });

    it('marks worktree unseen-failure on non-zero exit code', () => {
      useTerminalActivityStore
        .getState()
        .handleExit(exitEvent({ terminalId: 't1', exitCode: 1, signal: null }));

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
    });

    it('marks worktree unseen-failure on a non-shutdown signal', () => {
      useTerminalActivityStore.getState().handleExit(
        exitEvent({
          terminalId: 't1',
          exitCode: null,
          signal: 'SIGTERM',
        }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
    });

    it('filters app-shutdown signals (app-quit)', () => {
      useTerminalActivityStore.getState().handleExit(
        exitEvent({
          terminalId: 't1',
          exitCode: null,
          signal: 'app-quit',
        }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
    });

    it('filters app-shutdown signals (fatal-exit)', () => {
      useTerminalActivityStore.getState().handleExit(
        exitEvent({
          terminalId: 't1',
          exitCode: null,
          signal: 'fatal-exit',
        }),
      );

      expect(
        useTerminalActivityStore
          .getState()
          .unseenWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(false);
    });

    it('filters worktree cleanup signals', () => {
      useTerminalActivityStore.getState().handleExit(
        exitEvent({
          terminalId: 't1',
          exitCode: 0,
          signal: TERMINAL_WORKTREE_CLEANUP_SIGNAL,
        }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
    });

    it('filters Canopy-managed cleanup signals', () => {
      useTerminalActivityStore.getState().handleExit(
        exitEvent({
          terminalId: 't1',
          exitCode: 0,
          signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
        }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
    });
  });

  describe('user-initiated close suppression', () => {
    it('suppresses red indicator on SIGKILL after markUserInitiatedClose', () => {
      const store = useTerminalActivityStore.getState();
      store.markUserInitiatedClose('t1');
      store.handleExit(
        exitEvent({ terminalId: 't1', exitCode: null, signal: '9' }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.userInitiatedCloseTerminalIds.has('t1')).toBe(false);
    });

    it('does not affect other terminals in the same worktree', () => {
      const store = useTerminalActivityStore.getState();
      store.markUserInitiatedClose('t1');
      store.handleExit(
        exitEvent({ terminalId: 't1', exitCode: null, signal: '9' }),
      );
      store.handleExit(
        exitEvent({ terminalId: 't2', exitCode: 1, signal: null }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
    });

    it('removes a recreated non-running entry and clears stale unseen state', () => {
      const realNow = Date.now;
      let nowMs = 1_700_000_000_000;
      Date.now = (): number => nowMs;

      try {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        nowMs += 4_000;
        store.markUserInitiatedClose('t1');
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', running: false, processName: null }),
        );

        expect(
          useTerminalActivityStore
            .getState()
            .unseenWorktreeKeys.has(WORKTREE_KEY),
        ).toBe(true);

        store.handleExit(
          exitEvent({ terminalId: 't1', exitCode: null, signal: '9' }),
        );
      } finally {
        Date.now = realNow;
      }

      const next = useTerminalActivityStore.getState();
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.userInitiatedCloseTerminalIds.has('t1')).toBe(false);
    });
  });

  describe('markWorktreeTerminalSeen', () => {
    it('clears unseen + unseen-failure sets and prunes terminated entries', () => {
      const store = useTerminalActivityStore.getState();
      store.handleExit(
        exitEvent({ terminalId: 't1', exitCode: 1, signal: null }),
      );
      store.handleRunningChanged(runningEvent({ terminalId: 't2' }));

      // sanity
      expect(
        useTerminalActivityStore
          .getState()
          .unseenWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(true);
      expect(
        useTerminalActivityStore
          .getState()
          .unseenFailureWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(true);

      useTerminalActivityStore
        .getState()
        .markWorktreeTerminalSeen(WORKTREE_KEY);

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      // terminated entry pruned, running entry preserved
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeDefined();
      expect(next.entriesByWorktree[WORKTREE_KEY]['t1']).toBeUndefined();
      expect(next.entriesByWorktree[WORKTREE_KEY]['t2']).toBeDefined();
    });
  });

  describe('handleTerminalRemoved', () => {
    it('removes the entry and recomputes runningWorktreeKeys membership', () => {
      const store = useTerminalActivityStore.getState();
      store.handleRunningChanged(runningEvent({ terminalId: 't1' }));
      expect(
        useTerminalActivityStore
          .getState()
          .runningWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(true);

      useTerminalActivityStore
        .getState()
        .handleTerminalRemoved(PROJECT_ID, WORKTREE_ID, 't1');

      const next = useTerminalActivityStore.getState();
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
      expect(next.baselineEstablished.has('t1')).toBe(false);
    });

    it('removes a failed entry and clears stale unseen state', () => {
      const store = useTerminalActivityStore.getState();
      store.handleExit(
        exitEvent({ terminalId: 't1', exitCode: 1, signal: null }),
      );

      expect(
        useTerminalActivityStore
          .getState()
          .unseenFailureWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(true);

      store.handleTerminalRemoved(PROJECT_ID, WORKTREE_ID, 't1');

      const next = useTerminalActivityStore.getState();
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
      expect(next.baselineEstablished.has('t1')).toBe(false);
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    });

    it('preserves a user-initiated close marker until the exit event clears it', () => {
      const store = useTerminalActivityStore.getState();
      store.handleRunningChanged(runningEvent({ terminalId: 't1' }));
      store.markUserInitiatedClose('t1');

      store.handleTerminalRemoved(PROJECT_ID, WORKTREE_ID, 't1');

      expect(
        useTerminalActivityStore
          .getState()
          .userInitiatedCloseTerminalIds.has('t1'),
      ).toBe(true);

      store.handleExit(
        exitEvent({ terminalId: 't1', exitCode: null, signal: '9' }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.userInitiatedCloseTerminalIds.has('t1')).toBe(false);
    });
  });

  describe('pruneWorktree', () => {
    it('drops entries and removes the key from all sets', () => {
      const store = useTerminalActivityStore.getState();
      store.handleRunningChanged(runningEvent({ terminalId: 't1' }));
      store.handleExit(
        exitEvent({ terminalId: 't2', exitCode: 1, signal: null }),
      );

      useTerminalActivityStore.getState().pruneWorktree(WORKTREE_KEY);

      const next = useTerminalActivityStore.getState();
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    });
  });

  describe('clocked command and environment events', () => {
    const START_MS = 1_700_000_000_000;
    const NO_INDICATORS: WorktreeIndicators = {
      running: false,
      unseen: false,
      unseenFailure: false,
    };
    let nowMs = START_MS;

    beforeEach(() => {
      nowMs = START_MS;
      jest.spyOn(Date, 'now').mockImplementation((): number => nowMs);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function runCommand(
      terminalId: string,
      durationMs: number,
      exitCode: number | null,
      overrides: Partial<TerminalRunningChangedEvent> = {},
    ): void {
      const store = useTerminalActivityStore.getState();
      store.handleRunningChanged(
        runningEvent({ terminalId, processName: 'make' }),
      );
      nowMs += durationMs;
      store.handleRunningChanged(commandEnd(terminalId, exitCode, overrides));
    }

    describe('command exit status (exitCode)', () => {
      it('marks both unseen sets for a known non-zero status at 3000 ms', () => {
        runCommand('t1', 3_000, 2);

        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: true,
        });
        expect(activityEntry('t1')).toMatchObject({
          running: false,
          processName: null,
          processStartedAt: null,
          exitCode: 2,
          signal: null,
          endedAt: START_MS + 3_000,
        });
      });

      it('records a non-zero status at 2999 ms without an outcome badge', () => {
        runCommand('t1', 2_999, 2);

        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
        expect(activityEntry('t1')).toMatchObject({
          exitCode: 2,
          endedAt: START_MS + 2_999,
        });
      });

      it('marks only unseen completion for a zero status at 3000 ms', () => {
        runCommand('t1', 3_000, 0);

        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: false,
        });
        expect(activityEntry('t1')).toMatchObject({
          exitCode: 0,
          endedAt: START_MS + 3_000,
        });
      });

      it('does not mark a zero status at 2999 ms', () => {
        runCommand('t1', 2_999, 0);

        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
        expect(activityEntry('t1')?.exitCode).toBe(0);
      });

      it('adds neither outcome badge for an explicit null (unknown) status', () => {
        runCommand('t1', 10_000, null);

        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
        expect(activityEntry('t1')).toMatchObject({
          running: false,
          exitCode: null,
          signal: null,
          endedAt: START_MS + 10_000,
        });
      });

      it('keeps the desktop completion rule when exitCode is omitted', () => {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        nowMs += 3_000;
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', running: false, processName: null }),
        );

        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: false,
        });
        expect(activityEntry('t1')).toMatchObject({
          exitCode: null,
          signal: null,
          endedAt: null,
        });
      });

      it('records the status of a selected worktree without marking it', () => {
        configureTerminalActivityHost({
          isWorktreeSelected: (worktreeKey: string): boolean =>
            worktreeKey === WORKTREE_KEY,
        });

        runCommand('t1', 5_000, 1);

        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
        expect(activityEntry('t1')?.exitCode).toBe(1);
      });

      it('does not mark an interrupted command with a non-zero status', () => {
        runCommand('t1', 5_000, 130, { interruptedByUser: true });

        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
      });

      describe.each(['bash', 'sh'])('shell-named command %s', (processName) => {
        beforeEach(() => {
          useTerminalActivityStore
            .getState()
            .handleRunningChanged(
              runningEvent({ terminalId: 't1', processName }),
            );
        });

        it.each([
          { exitCode: 0, unseenFailure: false },
          { exitCode: 7, unseenFailure: true },
        ])(
          'marks explicit status $exitCode unseen until acknowledgement',
          ({ exitCode, unseenFailure }) => {
            const store = useTerminalActivityStore.getState();
            nowMs += 3_000;
            store.handleRunningChanged(commandEnd('t1', exitCode));

            expect(worktreeIndicators()).toEqual({
              running: false,
              unseen: true,
              unseenFailure,
            });
            expect(activityEntry('t1')).toMatchObject({
              exitCode,
              endedAt: START_MS + 3_000,
            });

            store.handleRunningChanged(runningEvent({ terminalId: 'live' }));
            store.markWorktreeTerminalSeen(WORKTREE_KEY);

            expect(worktreeIndicators()).toEqual({
              running: true,
              unseen: false,
              unseenFailure: false,
            });
            expect(activityEntry('live')?.running).toBe(true);
            expect(activityEntry('t1')).toBeUndefined();
          },
        );

        it('keeps legacy observations without a status suppressed', () => {
          nowMs += 5_000;
          useTerminalActivityStore.getState().handleRunningChanged(
            runningEvent({
              terminalId: 't1',
              running: false,
              processName: null,
            }),
          );

          expect(worktreeIndicators()).toEqual(NO_INDICATORS);
        });

        it('never marks an explicit unknown status successful', () => {
          nowMs += 5_000;
          useTerminalActivityStore
            .getState()
            .handleRunningChanged(commandEnd('t1', null));

          expect(worktreeIndicators()).toEqual(NO_INDICATORS);
          expect(activityEntry('t1')?.exitCode).toBeNull();
        });

        it.each([0, 7])(
          'does not mark short commands with status %s',
          (exitCode) => {
            nowMs += 2_999;
            useTerminalActivityStore
              .getState()
              .handleRunningChanged(commandEnd('t1', exitCode));

            expect(worktreeIndicators()).toEqual(NO_INDICATORS);
          },
        );

        it('does not mark an interrupted command', () => {
          nowMs += 5_000;
          useTerminalActivityStore
            .getState()
            .handleRunningChanged(
              commandEnd('t1', 130, { interruptedByUser: true }),
            );

          expect(worktreeIndicators()).toEqual(NO_INDICATORS);
        });

        it('records selected-worktree outcomes without an unseen badge', () => {
          configureTerminalActivityHost({
            isWorktreeSelected: (worktreeKey): boolean =>
              worktreeKey === WORKTREE_KEY,
          });
          nowMs += 5_000;
          useTerminalActivityStore
            .getState()
            .handleRunningChanged(commandEnd('t1', 7));

          expect(worktreeIndicators()).toEqual(NO_INDICATORS);
          expect(activityEntry('t1')?.exitCode).toBe(7);
        });

        it('clears an outcome arriving during a user close', () => {
          const store = useTerminalActivityStore.getState();
          nowMs += 5_000;
          store.markUserInitiatedClose('t1');
          store.handleRunningChanged(commandEnd('t1', 7));
          store.handleExit(
            exitEvent({ terminalId: 't1', exitCode: null, signal: '9' }),
          );

          expect(worktreeIndicators()).toEqual(NO_INDICATORS);
          expect(activityEntry('t1')).toBeUndefined();
        });
      });

      it('replaces a failure with the next success but keeps the worktree acknowledgement sticky', () => {
        const store = useTerminalActivityStore.getState();
        runCommand('t1', 3_000, 1);
        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: true,
        });

        nowMs += 1_000;
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'npm' }),
        );
        expect(activityEntry('t1')).toMatchObject({
          running: true,
          processName: 'npm',
          processStartedAt: nowMs,
          exitCode: null,
          signal: null,
          endedAt: null,
        });

        nowMs += 3_000;
        store.handleRunningChanged(commandEnd('t1', 0));
        expect(activityEntry('t1')).toMatchObject({
          running: false,
          exitCode: 0,
          endedAt: nowMs,
        });
        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: true,
        });

        store.markWorktreeTerminalSeen(WORKTREE_KEY);
        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
      });

      it('starts a fresh timer for a different command right after Ctrl+C', () => {
        const store = useTerminalActivityStore.getState();
        runCommand('t1', 5_000, 130, { interruptedByUser: true });
        expect(worktreeIndicators()).toEqual(NO_INDICATORS);

        nowMs += 100;
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'ls' }),
        );
        expect(activityEntry('t1')).toMatchObject({
          processStartedAt: nowMs,
          exitCode: null,
        });
        nowMs += 2_999;
        store.handleRunningChanged(commandEnd('t1', 1));
        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
        expect(activityEntry('t1')?.exitCode).toBe(1);

        runCommand('t1', 3_000, 1);
        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: true,
        });
      });

      it('clears an obsolete shell exit outcome when a restarted terminal runs a new command', () => {
        const store = useTerminalActivityStore.getState();
        store.handleExit(
          exitEvent({ terminalId: 't1', exitCode: null, signal: 'pipe-error' }),
        );
        expect(activityEntry('t1')?.signal).toBe('pipe-error');

        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        expect(activityEntry('t1')).toMatchObject({
          running: true,
          exitCode: null,
          signal: null,
          endedAt: null,
        });

        nowMs += 3_000;
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', running: false, processName: null }),
        );
        expect(activityEntry('t1')).toMatchObject({
          running: false,
          exitCode: null,
          signal: null,
        });
      });
    });

    // The popover tells a Ctrl+C (130 + interruptedByUser) from a failure, so
    // the entry keeps whether the latest reported outcome was an interrupt.
    describe('interrupted outcome (popover)', () => {
      it('retains that the reported outcome was a user interrupt', () => {
        runCommand('t1', 5_000, 130, { interruptedByUser: true });

        expect(activityEntry('t1')).toMatchObject({
          running: false,
          exitCode: 130,
          interruptedByUser: true,
        });
      });

      it('records a non-interrupted failure as not interrupted', () => {
        runCommand('t1', 5_000, 2);

        expect(activityEntry('t1')).toMatchObject({
          exitCode: 2,
          interruptedByUser: false,
        });
      });

      it('clears the interrupt with the next command and keeps it through an idle snapshot', () => {
        const store = useTerminalActivityStore.getState();
        runCommand('t1', 5_000, 130, { interruptedByUser: true });

        // A later idle event that reports nothing keeps the latest outcome.
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', running: false, processName: null }),
        );
        expect(activityEntry('t1')).toMatchObject({
          exitCode: 130,
          interruptedByUser: true,
        });

        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'make' }),
        );
        expect(activityEntry('t1')).toMatchObject({
          running: true,
          exitCode: null,
          interruptedByUser: false,
        });

        nowMs += 5_000;
        store.handleRunningChanged(commandEnd('t1', 1));
        expect(activityEntry('t1')).toMatchObject({
          exitCode: 1,
          interruptedByUser: false,
        });
      });

      it('never marks a shell exit or a legacy (omitted status) event interrupted', () => {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        nowMs += 5_000;
        store.handleRunningChanged(
          runningEvent({
            terminalId: 't1',
            running: false,
            processName: null,
            interruptedByUser: true,
          }),
        );
        expect(activityEntry('t1')).toMatchObject({
          exitCode: null,
          interruptedByUser: false,
        });

        store.handleExit(exitEvent({ terminalId: 't1', exitCode: 130 }));
        expect(activityEntry('t1')).toMatchObject({
          exitCode: 130,
          interruptedByUser: false,
        });
      });
    });

    describe('environment shutdown', () => {
      it.each([
        TERMINAL_CONNECTION_LOST_SIGNAL,
        TERMINAL_SANDBOX_ASLEEP_SIGNAL,
      ])(
        'drops only the terminal entry on %s without failure or unseen state',
        (signal) => {
          const store = useTerminalActivityStore.getState();
          store.handleRunningChanged(
            runningEvent({ terminalId: 't1', processName: 'sleep' }),
          );
          nowMs += 10_000;
          store.handleExit(
            exitEvent({ terminalId: 't1', exitCode: null, signal }),
          );

          const next = useTerminalActivityStore.getState();
          expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
          expect(next.baselineEstablished.has('t1')).toBe(false);
          expect(worktreeIndicators()).toEqual(NO_INDICATORS);
        },
      );

      it('leaves state untouched for an unknown terminal', () => {
        const before = useTerminalActivityStore.getState();
        before.handleExit(
          exitEvent({
            terminalId: 'unknown',
            exitCode: null,
            signal: TERMINAL_CONNECTION_LOST_SIGNAL,
          }),
        );

        expect(useTerminalActivityStore.getState()).toBe(before);
      });

      it("keeps a sibling terminal's unread command failure", () => {
        const store = useTerminalActivityStore.getState();
        runCommand('t1', 3_000, 2);
        store.handleRunningChanged(
          runningEvent({ terminalId: 't2', processName: 'sleep' }),
        );
        expect(worktreeIndicators()).toEqual({
          running: true,
          unseen: true,
          unseenFailure: true,
        });

        store.handleExit(
          exitEvent({
            terminalId: 't2',
            exitCode: null,
            signal: TERMINAL_CONNECTION_LOST_SIGNAL,
          }),
        );

        expect(activityEntry('t2')).toBeUndefined();
        expect(activityEntry('t1')?.exitCode).toBe(2);
        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: true,
        });
      });

      it("keeps a sibling terminal's unread shell exit failure", () => {
        const store = useTerminalActivityStore.getState();
        store.handleExit(
          exitEvent({ terminalId: 't1', exitCode: 1, signal: null }),
        );
        store.handleRunningChanged(
          runningEvent({ terminalId: 't2', processName: 'sleep' }),
        );

        store.handleExit(
          exitEvent({
            terminalId: 't2',
            exitCode: null,
            signal: TERMINAL_SANDBOX_ASLEEP_SIGNAL,
          }),
        );

        expect(activityEntry('t2')).toBeUndefined();
        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: true,
        });
      });

      it("keeps the terminal's own unread failure sticky after connection-lost until selection", () => {
        const store = useTerminalActivityStore.getState();
        runCommand('t1', 3_000, 2);

        store.handleExit(
          exitEvent({
            terminalId: 't1',
            exitCode: null,
            signal: TERMINAL_CONNECTION_LOST_SIGNAL,
          }),
        );

        expect(activityEntry('t1')).toBeUndefined();
        expect(
          useTerminalActivityStore.getState().baselineEstablished.has('t1'),
        ).toBe(false);
        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: true,
        });

        store.markWorktreeTerminalSeen(WORKTREE_KEY);
        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
      });

      it("keeps the terminal's own unread completion sticky after sandbox-asleep while running clears", () => {
        const store = useTerminalActivityStore.getState();
        runCommand('t1', 3_000, 0);
        nowMs += 1_000;
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        expect(worktreeIndicators()).toEqual({
          running: true,
          unseen: true,
          unseenFailure: false,
        });

        nowMs += 10_000;
        store.handleExit(
          exitEvent({
            terminalId: 't1',
            exitCode: null,
            signal: TERMINAL_SANDBOX_ASLEEP_SIGNAL,
          }),
        );

        expect(activityEntry('t1')).toBeUndefined();
        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: false,
        });

        store.markWorktreeTerminalSeen(WORKTREE_KEY);
        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
      });

      it('does not resurrect a completion from a late running:false', () => {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        nowMs += 10_000;
        store.handleExit(
          exitEvent({
            terminalId: 't1',
            exitCode: null,
            signal: TERMINAL_CONNECTION_LOST_SIGNAL,
          }),
        );
        store.handleRunningChanged(commandEnd('t1', 1));

        expect(worktreeIndicators()).toEqual(NO_INDICATORS);
      });

      it('re-seeds a restarted terminal that reuses its id', () => {
        const store = useTerminalActivityStore.getState();
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', processName: 'sleep' }),
        );
        nowMs += 10_000;
        store.handleExit(
          exitEvent({
            terminalId: 't1',
            exitCode: null,
            signal: TERMINAL_SANDBOX_ASLEEP_SIGNAL,
          }),
        );

        // The restarted PTY's first idle snapshot only seeds the baseline.
        store.handleRunningChanged(
          runningEvent({ terminalId: 't1', running: false, processName: null }),
        );
        expect(worktreeIndicators()).toEqual(NO_INDICATORS);

        nowMs += 1_000;
        runCommand('t1', 3_000, 0);
        expect(worktreeIndicators()).toEqual({
          running: false,
          unseen: true,
          unseenFailure: false,
        });
        expect(activityEntry('t1')).toMatchObject({
          exitCode: 0,
          signal: null,
          endedAt: nowMs,
        });
      });
    });
  });
});
