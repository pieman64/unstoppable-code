import {
  LEDGER_STATUSES,
  LEDGER_TERMINAL_STATUSES,
  type LedgerActorRef,
  type LedgerAttribution,
  type LedgerStatus,
} from '@canopy/protocol/canopy-core';

import {
  checkLedgerAttribution,
  checkLedgerCreation,
  defaultLedgerStatus,
  evaluateLedgerUpdate,
  isLedgerEntryOpen,
  resolveLedgerInitialStatus,
  type LedgerUpdatePolicyInput,
} from '../policy';
import { NO_DETAILS } from './ledger-test-harness';

function actor(
  suffix: string,
  kind: LedgerActorRef['kind'] = 'chat',
): LedgerActorRef {
  return {
    actorId: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    kind,
    authorityId: 'authority-1',
  };
}

const CHAT = actor('1');
const OTHER_CHAT = actor('2');
const USER = actor('3', 'user');
const HELPER = actor('4', 'background');
const SIDECAR = actor('5', 'ledger_sidecar');

function selfReported(effective: LedgerActorRef): LedgerAttribution {
  return {
    kind: 'self_reported',
    effectiveActor: effective,
    recordedBy: effective,
    executorDetails: NO_DETAILS,
  };
}

function sidecarAttribution(
  primary: LedgerActorRef,
  overrides: Partial<{
    recordedBy: LedgerActorRef;
    primaryActorId: string;
  }> = {},
): LedgerAttribution {
  return {
    kind: 'sidecar',
    effectiveActor: primary,
    recordedBy: overrides.recordedBy ?? SIDECAR,
    executorDetails: NO_DETAILS,
    sidecarSessionId: 'sidecar-session',
    primaryActorId: overrides.primaryActorId ?? primary.actorId,
    batchId: 'batch-1',
    evidenceEventIds: [],
  };
}

const OPEN_STATUSES: readonly LedgerStatus[] = LEDGER_STATUSES.filter(
  (status: LedgerStatus): boolean => isLedgerEntryOpen(status),
);

function updateInput(
  overrides: Partial<LedgerUpdatePolicyInput>,
): LedgerUpdatePolicyInput {
  return {
    current: { revision: 3, status: 'TODO', owner: CHAT },
    expectedRevision: 3,
    attribution: selfReported(CHAT),
    mayUpdateAnyOpenEntry: false,
    ...overrides,
  };
}

describe('ledger policy', () => {
  it('defaults statuses by entry type', () => {
    expect(defaultLedgerStatus('TASK')).toBe('TODO');
    expect(defaultLedgerStatus('ACTION')).toBe('IN_PROGRESS');
    expect(defaultLedgerStatus('DECISION')).toBe('INFO');
    expect(defaultLedgerStatus('OBSERVATION')).toBe('INFO');
    expect(defaultLedgerStatus('SUMMARY')).toBe('INFO');
  });

  it('treats COMPLETED, FAILED and INFO as the only terminal statuses', () => {
    expect(OPEN_STATUSES).toEqual([
      'TODO',
      'IN_PROGRESS',
      'BLOCKED',
      'NEEDS_REVIEW',
    ]);
    for (const status of LEDGER_TERMINAL_STATUSES) {
      expect(isLedgerEntryOpen(status)).toBe(false);
    }
  });

  it('resolves creation statuses, keeping SUMMARY at INFO', () => {
    expect(resolveLedgerInitialStatus('TASK', undefined)).toBe('TODO');
    expect(resolveLedgerInitialStatus('TASK', 'BLOCKED')).toBe('BLOCKED');
    expect(resolveLedgerInitialStatus('DECISION', 'IN_PROGRESS')).toBe(
      'IN_PROGRESS',
    );
    expect(resolveLedgerInitialStatus('SUMMARY', undefined)).toBe('INFO');
    expect(resolveLedgerInitialStatus('SUMMARY', 'INFO')).toBe('INFO');
    expect(resolveLedgerInitialStatus('SUMMARY', 'TODO')).toEqual({
      reason: 'INVALID_INPUT',
      field: 'status',
    });
  });

  describe('creation', () => {
    it('accepts an agent entry authored and owned by its effective actor', () => {
      expect(
        checkLedgerCreation({
          path: 'add',
          type: 'TASK',
          author: CHAT,
          owner: OTHER_CHAT,
          attribution: selfReported(CHAT),
        }),
      ).toBeNull();
    });

    it('never lets a sidecar author or own an entry', () => {
      expect(
        checkLedgerCreation({
          path: 'add',
          type: 'TASK',
          author: SIDECAR,
          owner: CHAT,
          attribution: selfReported(SIDECAR),
        }),
      ).toEqual({ reason: 'FORBIDDEN', field: 'author' });
      expect(
        checkLedgerCreation({
          path: 'add',
          type: 'TASK',
          author: CHAT,
          owner: SIDECAR,
          attribution: selfReported(CHAT),
        }),
      ).toEqual({ reason: 'OWNER_UNAVAILABLE', field: 'owner' });
    });

    it('reserves SUMMARY for background helpers publishing summaries', () => {
      expect(
        checkLedgerCreation({
          path: 'add',
          type: 'SUMMARY',
          author: CHAT,
          owner: CHAT,
          attribution: selfReported(CHAT),
        }),
      ).toEqual({ reason: 'INVALID_INPUT', field: 'type' });
      expect(
        checkLedgerCreation({
          path: 'add',
          type: 'TASK',
          author: HELPER,
          owner: HELPER,
          attribution: selfReported(HELPER),
        }),
      ).toEqual({ reason: 'FORBIDDEN', field: 'author' });
      expect(
        checkLedgerCreation({
          path: 'summary',
          type: 'SUMMARY',
          author: USER,
          owner: USER,
          attribution: selfReported(USER),
        }),
      ).toEqual({ reason: 'FORBIDDEN', field: 'author' });
      expect(
        checkLedgerCreation({
          path: 'summary',
          type: 'SUMMARY',
          author: HELPER,
          owner: CHAT,
          attribution: selfReported(HELPER),
        }),
      ).toEqual({ reason: 'INVALID_INPUT', field: 'owner' });
    });

    it('requires the author to be the effective attribution actor', () => {
      expect(
        checkLedgerCreation({
          path: 'add',
          type: 'TASK',
          author: CHAT,
          owner: CHAT,
          attribution: selfReported(OTHER_CHAT),
        }),
      ).toEqual({
        reason: 'INVALID_INPUT',
        field: 'attribution.effectiveActor',
      });
    });
  });

  describe('attribution', () => {
    it('accepts sidecar attribution recorded by a sidecar for its primary', () => {
      expect(checkLedgerAttribution(sidecarAttribution(CHAT))).toBeNull();
    });

    it('rejects inconsistent sidecar attribution', () => {
      expect(
        checkLedgerAttribution(
          sidecarAttribution(CHAT, { recordedBy: OTHER_CHAT }),
        ),
      ).toEqual({ reason: 'INVALID_INPUT', field: 'attribution.recordedBy' });
      expect(
        checkLedgerAttribution(
          sidecarAttribution(CHAT, { primaryActorId: OTHER_CHAT.actorId }),
        ),
      ).toEqual({
        reason: 'INVALID_INPUT',
        field: 'attribution.primaryActorId',
      });
      expect(
        checkLedgerAttribution({
          ...selfReported(CHAT),
          recordedBy: SIDECAR,
        }),
      ).toEqual({ reason: 'FORBIDDEN', field: 'attribution.recordedBy' });
    });
  });

  describe('updates', () => {
    it('permits every transition from every open status', () => {
      for (const from of OPEN_STATUSES) {
        for (const to of LEDGER_STATUSES) {
          const decision = evaluateLedgerUpdate(
            updateInput({
              current: { revision: 3, status: from, owner: CHAT },
              requestedStatus: to,
            }),
          );
          expect(decision).toEqual(
            from === to
              ? { kind: 'noop' }
              : { kind: 'change', status: { from, to }, owner: null },
          );
        }
      }
    });

    it('locks terminal entries against every change, including no-ops', () => {
      for (const status of LEDGER_TERMINAL_STATUSES) {
        const current = { revision: 3, status, owner: CHAT };
        const requests: Partial<LedgerUpdatePolicyInput>[] = [
          { requestedStatus: 'TODO' },
          { requestedStatus: status },
          { requestedOwner: OTHER_CHAT },
          { requestedOwner: CHAT },
        ];
        for (const request of requests) {
          expect(
            evaluateLedgerUpdate(updateInput({ current, ...request })),
          ).toEqual({ kind: 'reject', reason: 'TERMINAL_ENTRY' });
        }
      }
    });

    it('checks the revision before the terminal lock', () => {
      expect(
        evaluateLedgerUpdate(
          updateInput({
            current: { revision: 4, status: 'COMPLETED', owner: CHAT },
            requestedStatus: 'TODO',
          }),
        ),
      ).toEqual({
        kind: 'reject',
        reason: 'REVISION_CONFLICT',
        field: 'expectedRevision',
      });
    });

    it('lets agents update only entries they currently own', () => {
      expect(
        evaluateLedgerUpdate(
          updateInput({
            attribution: selfReported(OTHER_CHAT),
            requestedStatus: 'IN_PROGRESS',
          }),
        ),
      ).toEqual({ kind: 'reject', reason: 'FORBIDDEN', field: 'owner' });
      expect(
        evaluateLedgerUpdate(
          updateInput({
            attribution: selfReported(OTHER_CHAT),
            mayUpdateAnyOpenEntry: true,
            requestedStatus: 'IN_PROGRESS',
          }),
        ),
      ).toEqual({
        kind: 'reject',
        reason: 'FORBIDDEN',
        field: 'mayUpdateAnyOpenEntry',
      });
    });

    it('lets the user update and reassign any open entry', () => {
      expect(
        evaluateLedgerUpdate(
          updateInput({
            attribution: { ...selfReported(USER), kind: 'user' },
            mayUpdateAnyOpenEntry: true,
            requestedOwner: OTHER_CHAT,
          }),
        ),
      ).toEqual({
        kind: 'change',
        status: null,
        owner: { from: CHAT, to: OTHER_CHAT },
      });
    });

    it('treats an unchanged status and owner as a no-op', () => {
      expect(
        evaluateLedgerUpdate(
          updateInput({ requestedStatus: 'TODO', requestedOwner: CHAT }),
        ),
      ).toEqual({ kind: 'noop' });
    });

    it('keeps sidecars to status changes for their primary', () => {
      expect(
        evaluateLedgerUpdate(
          updateInput({
            attribution: sidecarAttribution(CHAT),
            requestedStatus: 'COMPLETED',
          }),
        ),
      ).toEqual({
        kind: 'change',
        status: { from: 'TODO', to: 'COMPLETED' },
        owner: null,
      });
      expect(
        evaluateLedgerUpdate(
          updateInput({
            attribution: sidecarAttribution(CHAT),
            requestedOwner: OTHER_CHAT,
          }),
        ),
      ).toEqual({ kind: 'reject', reason: 'FORBIDDEN', field: 'owner' });
    });
  });
});
