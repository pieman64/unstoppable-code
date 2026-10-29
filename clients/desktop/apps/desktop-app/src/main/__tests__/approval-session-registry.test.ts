import type { ApprovalCheck, ApprovalMode } from '@canopy/desktop-shared/types';
import type {
  ApprovalCheckDisplay,
  ApprovalOutcome,
} from '../approvals/approval-service';
import {
  registerApprovalSession,
  reevaluatePendingApprovalsForChat,
  requestChatApproval,
  resetApprovalSessionRegistryForTests,
} from '../approvals/approval-session-registry';

function denyAll(): Promise<ApprovalOutcome> {
  return Promise.resolve({ decision: 'deny' });
}

function recorder(): {
  calls: ApprovalMode[];
  previousModes: Array<ApprovalMode | undefined>;
  reevaluatePendingApprovals: (
    mode: ApprovalMode,
    previousMode?: ApprovalMode,
  ) => Promise<void>;
  check: () => Promise<ApprovalOutcome>;
} {
  const calls: ApprovalMode[] = [];
  const previousModes: Array<ApprovalMode | undefined> = [];
  return {
    calls,
    previousModes,
    reevaluatePendingApprovals: (
      mode: ApprovalMode,
      previousMode?: ApprovalMode,
    ): Promise<void> => {
      calls.push(mode);
      previousModes.push(previousMode);
      return Promise.resolve();
    },
    check: denyAll,
  };
}

describe('approval session registry', () => {
  beforeEach(() => {
    resetApprovalSessionRegistryForTests();
  });

  it('broadcasts to every handle enrolled for one chat', async () => {
    // A chat can own an agent handle and a Claude-terminal handle at once.
    const agent = recorder();
    const terminal = recorder();
    registerApprovalSession('p', 'w', 'c', agent);
    registerApprovalSession('p', 'w', 'c', terminal);

    await reevaluatePendingApprovalsForChat('p', 'w', 'c', 'full-access');

    expect(agent.calls).toEqual(['full-access']);
    expect(terminal.calls).toEqual(['full-access']);
  });

  it('forwards the pre-widening mode to every handle', async () => {
    // The handles cannot derive it themselves: `ipc/chat.ts` has already
    // applied the new mode to each of them through `setMode` before it
    // broadcasts, so the dispatcher is the only remaining holder of the
    // mode the chat was actually in.
    const agent = recorder();
    const terminal = recorder();
    registerApprovalSession('p', 'w', 'c', agent);
    registerApprovalSession('p', 'w', 'c', terminal);

    await reevaluatePendingApprovalsForChat(
      'p',
      'w',
      'c',
      'full-access',
      'ask',
    );

    expect(agent.previousModes).toEqual(['ask']);
    expect(terminal.previousModes).toEqual(['ask']);
  });

  it('does not broadcast to a handle for a different chat', async () => {
    const mine = recorder();
    const other = recorder();
    registerApprovalSession('p', 'w', 'c', mine);
    registerApprovalSession('p', 'w', 'other-chat', other);

    await reevaluatePendingApprovalsForChat('p', 'w', 'c', 'auto');

    expect(mine.calls).toEqual(['auto']);
    expect(other.calls).toEqual([]);
  });

  it('lets the remaining handles run when one throws, and never rejects', async () => {
    const healthy = recorder();
    registerApprovalSession('p', 'w', 'c', {
      reevaluatePendingApprovals: (): Promise<void> =>
        Promise.reject(new Error('handle exploded')),
      check: denyAll,
    });
    registerApprovalSession('p', 'w', 'c', healthy);

    await expect(
      reevaluatePendingApprovalsForChat('p', 'w', 'c', 'full-access'),
    ).resolves.toBeUndefined();
    expect(healthy.calls).toEqual(['full-access']);
  });

  it('stops delivering to a handle once it unregisters', async () => {
    const handle = recorder();
    const unregister = registerApprovalSession('p', 'w', 'c', handle);
    unregister();

    await reevaluatePendingApprovalsForChat('p', 'w', 'c', 'full-access');

    expect(handle.calls).toEqual([]);
  });

  it('is a no-op for a chat with no enrolled handles', async () => {
    await expect(
      reevaluatePendingApprovalsForChat('p', 'w', 'nobody', 'full-access'),
    ).resolves.toBeUndefined();
  });
});

describe('requestChatApproval', () => {
  const check: ApprovalCheck = {
    kind: 'file-write',
    path: '/workspace/report.csv',
  };
  const display: ApprovalCheckDisplay = {
    title: 'Save report.csv?',
    details: { kind: 'file-write', path: 'report.csv' },
  };

  function handle(outcome: ApprovalOutcome | Error): {
    asked: Array<[ApprovalCheck, ApprovalCheckDisplay]>;
    session: {
      reevaluatePendingApprovals: () => Promise<void>;
      check: (
        check: ApprovalCheck,
        display: ApprovalCheckDisplay,
      ) => Promise<ApprovalOutcome>;
    };
  } {
    const asked: Array<[ApprovalCheck, ApprovalCheckDisplay]> = [];
    return {
      asked,
      session: {
        reevaluatePendingApprovals: (): Promise<void> => Promise.resolve(),
        check: (
          asking: ApprovalCheck,
          shown: ApprovalCheckDisplay,
        ): Promise<ApprovalOutcome> => {
          asked.push([asking, shown]);
          return outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve(outcome);
        },
      },
    };
  }

  beforeEach(() => {
    resetApprovalSessionRegistryForTests();
  });

  it("asks the chat's newest live handle and returns its decision", async () => {
    const older = handle({ decision: 'deny' });
    const newer = handle({ decision: 'allow' });
    registerApprovalSession('p', 'w', 'c', older.session);
    registerApprovalSession('p', 'w', 'c', newer.session);

    await expect(
      requestChatApproval('p', 'w', 'c', check, display),
    ).resolves.toEqual({ decision: 'allow' });
    expect(newer.asked).toEqual([[check, display]]);
    expect(older.asked).toEqual([]);
  });

  it('asks the remaining handle once the newest unregisters', async () => {
    const older = handle({ decision: 'allow' });
    const newer = handle({ decision: 'deny' });
    registerApprovalSession('p', 'w', 'c', older.session);
    const unregister = registerApprovalSession('p', 'w', 'c', newer.session);
    unregister();

    await expect(
      requestChatApproval('p', 'w', 'c', check, display),
    ).resolves.toEqual({ decision: 'allow' });
    expect(newer.asked).toEqual([]);
  });

  it('denies when the chat has no live handle, without asking another chat', async () => {
    const other = handle({ decision: 'allow' });
    registerApprovalSession('p', 'w', 'other-chat', other.session);

    const outcome = await requestChatApproval('p', 'w', 'c', check, display);

    expect(outcome.decision).toBe('deny');
    expect(outcome.message).toEqual(expect.any(String));
    expect(other.asked).toEqual([]);
  });

  it('denies when the handle fails, and never rejects', async () => {
    const broken = handle(new Error('prompt bridge gone'));
    registerApprovalSession('p', 'w', 'c', broken.session);

    const outcome = await requestChatApproval('p', 'w', 'c', check, display);

    expect(outcome.decision).toBe('deny');
    expect(broken.asked).toHaveLength(1);
  });
});
