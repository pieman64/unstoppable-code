import { settleV3Generation } from '../broker-settlement';
import {
  captureSettlementAnswer,
  v3SettlementRequest,
} from '../broker-settlement-contract';
import type {
  V3SettlementContractDependencies,
  V3SettlementContractInput,
} from '../broker-settlement-contract';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import { delegationSettlementKey } from '../record-v3';
import type { StoredDelegationV3ResultLocator } from '../record-v3';
import { delegationTranscriptSettlementDigest } from '../settlement-identity';

function fixture(text: string | undefined = '🌿\uD800'): {
  input: V3SettlementContractInput;
  dependencies: V3SettlementContractDependencies;
  port: InMemoryDelegationTranscriptPort;
  trace: string[];
  locator: () => StoredDelegationV3ResultLocator | undefined;
} {
  const target = {
    kind: 'delegation' as const,
    chatId: 'chat',
    delegationId: 'delegate',
    runGeneration: 1,
  };
  const captured = captureSettlementAnswer(text);
  const request = {
    target,
    settlementKey: delegationSettlementKey('chat', 'delegate', 1),
    resultIndex: 1,
    outcome: { status: 'completed' as const, finishedAt: 200 },
    answer: captured.settleAnswer,
    finalChanges: [],
    openRows: 'finalize' as const,
  };
  const input: V3SettlementContractInput = {
    target,
    registration: {
      chatId: 'chat',
      delegationId: 'delegate',
      runGeneration: 1,
      createdAt: 100,
      store: 'stream',
      origin: { kind: 'launch' },
      executionMode: 'background',
    },
    settleAnswer: captured.settleAnswer,
    intent: {
      runGeneration: 1,
      settlementKey: request.settlementKey,
      assertedResultIndex: 1,
      outcome: request.outcome,
      answer: captured.answer,
      expectedSettlementDigest: delegationTranscriptSettlementDigest(request),
    },
  };
  const port = new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
  });
  const trace: string[] = [];
  let locator: StoredDelegationV3ResultLocator | undefined;
  const dependencies: V3SettlementContractDependencies = {
    commitIntent: () => {
      trace.push('intent');
      return Promise.resolve();
    },
    ensureRegisteredAndOpen: async (registration, target) => {
      trace.push('open');
      const registered = await port.registerGeneration(registration);
      return registered.ok ? port.open({ target }) : registered;
    },
    settle: (request) => {
      trace.push('settle');
      return port.settle(request);
    },
    resultBySettlementKey: (request) => port.resultBySettlementKey(request),
    resultByGeneration: (request) => port.resultByGeneration(request),
    commitLocator: (next) => {
      trace.push('locator');
      locator = next;
      return Promise.resolve();
    },
    notify: () => {
      trace.push('notify');
      return Promise.resolve();
    },
    markNotified: () => {
      trace.push('mark');
      return Promise.resolve();
    },
  };
  return { input, dependencies, port, trace, locator: () => locator };
}

describe('C3 one v3 terminal state machine', () => {
  it('does not turn a failed notification marker into a retry stage', async () => {
    const f = fixture();
    const result = await settleV3Generation(f.input, {
      ...f.dependencies,
      markNotified: () => Promise.reject(new Error('marker failed')),
    });
    expect(result.kind).toBe('settled');
    expect(f.trace).toContain('notify');
  });
  it.each([undefined, '', 'exact', '🌿', '\uD800'])(
    'settles exact answer %p in durable order',
    async (text) => {
      const f = fixture(text);
      const result = await settleV3Generation(f.input, f.dependencies);
      expect(result.kind).toBe('settled');
      expect(f.trace).toEqual([
        'intent',
        'open',
        'settle',
        'locator',
        'notify',
        'mark',
      ]);
      expect(f.locator()).toEqual({
        resultIndex: 1,
        runGeneration: 1,
        status: 'completed',
        settledAt: 200,
      });
    },
  );

  it.each(['intent', 'open', 'settle', 'locator', 'notify'] as const)(
    'retains a retry boundary at %s',
    async (stage) => {
      const f = fixture();
      const fail = (): never => {
        throw new Error('injected crash');
      };
      const deps: V3SettlementContractDependencies = {
        ...f.dependencies,
        ...(stage === 'intent' ? { commitIntent: fail } : {}),
        ...(stage === 'open' ? { ensureRegisteredAndOpen: fail } : {}),
        ...(stage === 'settle' ? { settle: fail } : {}),
        ...(stage === 'locator' ? { commitLocator: fail } : {}),
        ...(stage === 'notify' ? { notify: fail } : {}),
      };
      const result = await settleV3Generation(f.input, deps);
      expect(result.kind).toBe('retry');
      expect(f.trace.includes('notify')).toBe(false);
      expect((await settleV3Generation(f.input, f.dependencies)).kind).toMatch(
        /settled|adopted/,
      );
      const stored = await f.port.resultsPage({
        chatId: 'chat',
        delegationId: 'delegate',
        limit: 100,
      });
      expect(stored.ok && stored.value.results).toHaveLength(1);
    },
  );

  it('does not treat an unavailable lookup as absence or mutate the registry', async () => {
    const f = fixture();
    const result = await settleV3Generation(f.input, {
      ...f.dependencies,
      resultBySettlementKey: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'offline',
            retryable: true,
          },
        }),
    });
    expect(result).toMatchObject({ kind: 'retry', stage: 'lookup' });
    expect(f.trace).toEqual(['intent']);
  });

  it('compares the key explicitly on a generation fallback', async () => {
    const f = fixture();
    await f.dependencies.ensureRegisteredAndOpen(
      f.input.registration,
      f.input.target,
    );
    const request = v3SettlementRequest(f.input);
    await f.port.settle({ ...request, settlementKey: 'different-key' });
    const result = await settleV3Generation(f.input, f.dependencies);
    expect(result.kind).toBe('conflict');
    expect(f.locator()).toBeUndefined();
  });

  it.each(['index', 'outcome', 'digest'] as const)(
    'rejects a matching-key canonical result with a conflicting %s',
    async (field) => {
      const f = fixture();
      await f.dependencies.ensureRegisteredAndOpen(
        f.input.registration,
        f.input.target,
      );
      const settled = await f.port.settle(v3SettlementRequest(f.input));
      if (!settled.ok) throw new Error('Expected canonical result');
      const entry = settled.value.result;
      const result = await settleV3Generation(f.input, {
        ...f.dependencies,
        resultBySettlementKey: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...entry,
              ...(field === 'index' ? { resultIndex: 2 } : {}),
              ...(field === 'outcome'
                ? { outcome: { ...entry.outcome, finishedAt: 201 } }
                : {}),
              ...(field === 'digest'
                ? { settlementDigest: '0'.repeat(64) }
                : {}),
            },
          }),
      });
      expect(result.kind).toBe('conflict');
      expect(f.locator()).toBeUndefined();
    },
  );

  it('surfaces a stale registry floor as conflict without committing a locator', async () => {
    const f = fixture();
    const result = await settleV3Generation(f.input, {
      ...f.dependencies,
      settle: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'stale_identity',
            message: 'floor advanced',
            retryable: false,
          },
        }),
    });
    expect(result.kind).toBe('conflict');
    expect(f.locator()).toBeUndefined();
  });
});
