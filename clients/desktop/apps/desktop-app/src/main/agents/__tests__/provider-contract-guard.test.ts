import type { SessionDiagnosticRecord } from '../../observability/service';
import {
  createClaudeContractGuard,
  createCodexContractGuard,
  unclassifiedClaudeEvent,
  unclassifiedCodexNotification,
} from '../provider-contract-guard';

const scope = {
  sessionKey: 'p/w/c',
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'c',
};

function guard(): {
  records: SessionDiagnosticRecord[];
  guard: ReturnType<typeof createClaudeContractGuard>;
} {
  const records: SessionDiagnosticRecord[] = [];
  return {
    records,
    guard: createClaudeContractGuard(
      scope,
      (record) => {
        records.push(record);
      },
      true,
    ),
  };
}

describe('unclassifiedClaudeEvent', () => {
  it('classifies the known message types, system subtypes and result subtypes', () => {
    expect(unclassifiedClaudeEvent({ type: 'assistant' })).toBeUndefined();
    expect(
      unclassifiedClaudeEvent({ type: 'system', subtype: 'init' }),
    ).toBeUndefined();
    expect(
      unclassifiedClaudeEvent({ type: 'result', subtype: 'success' }),
    ).toBeUndefined();
  });

  it('names an unknown type, system subtype or result subtype', () => {
    expect(unclassifiedClaudeEvent({ type: 'brand_new' })).toBe('brand_new');
    expect(
      unclassifiedClaudeEvent({ type: 'system', subtype: 'brand_new' }),
    ).toBe('system/brand_new');
    expect(
      unclassifiedClaudeEvent({ type: 'result', subtype: 'brand_new' }),
    ).toBe('result/brand_new');
  });

  it('ignores host events and values that are not provider frames', () => {
    expect(unclassifiedClaudeEvent({ type: 'canopy_user_prompt' })).toBe(
      undefined,
    );
    expect(unclassifiedClaudeEvent('assistant')).toBeUndefined();
    expect(unclassifiedClaudeEvent({})).toBeUndefined();
  });

  it('keeps provider text out of the label', () => {
    expect(unclassifiedClaudeEvent({ type: 'Secret value with spaces!' })).toBe(
      'unrecognized',
    );
    expect(unclassifiedClaudeEvent({ type: 'x'.repeat(200) })).toBe(
      'unrecognized',
    );
  });
});

describe('createClaudeContractGuard', () => {
  it('reports each unclassified event once per session', () => {
    const f = guard();
    f.guard.observe({ type: 'system', subtype: 'brand_new' });
    f.guard.observe({ type: 'system', subtype: 'brand_new' });
    f.guard.observe({ type: 'other_new' });

    expect(f.records).toEqual([
      expect.objectContaining({
        kind: 'provider_contract_unknown_event',
        ...scope,
        providerType: 'claude',
        providerContractEvent: 'system/brand_new',
      }),
      expect.objectContaining({
        kind: 'provider_contract_unknown_event',
        providerContractEvent: 'other_new',
      }),
    ]);
  });

  it('records the harness version from init once per process', () => {
    const f = guard();
    f.guard.observe({
      type: 'system',
      subtype: 'init',
      claude_code_version: '2.5.1',
    });
    f.guard.observe({
      type: 'system',
      subtype: 'init',
      claude_code_version: '2.5.1',
    });

    expect(f.records).toEqual([
      expect.objectContaining({
        kind: 'provider_harness_version',
        providerType: 'claude',
        providerHarnessVersion: '2.5.1',
      }),
    ]);
    f.guard.processRestarted();
    f.guard.observe({
      type: 'system',
      subtype: 'init',
      claude_code_version: '2.5.2',
    });
    expect(f.records.map((record) => record.providerHarnessVersion)).toEqual([
      '2.5.1',
      '2.5.2',
    ]);
  });

  it('reports a root result before any session state once per process', () => {
    const f = guard();
    // The session decides what a root result is; a child result isn't one.
    f.guard.observe({
      type: 'result',
      subtype: 'success',
      parent_tool_use_id: 'tool',
    });
    expect(f.records).toEqual([]);
    f.guard.observe({ type: 'result', subtype: 'success' }, true);
    f.guard.observe({ type: 'result', subtype: 'success' }, true);

    expect(f.records).toEqual([
      expect.objectContaining({
        kind: 'provider_contract_gate_missing',
        providerType: 'claude',
        providerContractEvent: 'system/session_state_changed',
      }),
    ]);
    f.guard.processRestarted();
    f.guard.observe({ type: 'result', subtype: 'success' }, true);
    expect(f.records).toHaveLength(2);
  });

  it('expects no session state from a session that did not ask for it', () => {
    const records: SessionDiagnosticRecord[] = [];
    const compatible = createClaudeContractGuard(
      scope,
      (record) => {
        records.push(record);
      },
      false,
    );
    compatible.observe({ type: 'result', subtype: 'success' }, true);
    expect(records).toEqual([]);
  });

  it('records nothing for a healthy session', () => {
    const f = guard();
    f.guard.observe({ type: 'system', subtype: 'init' });
    f.guard.observe({ type: 'system', subtype: 'session_state_changed' });
    f.guard.observe({ type: 'assistant' });
    f.guard.observe({ type: 'result', subtype: 'success' }, true);

    expect(f.records).toEqual([]);
  });

  it('never lets a diagnostic failure escape into ingestion', () => {
    const throwing = createClaudeContractGuard(
      scope,
      () => {
        throw new Error('diagnostics unavailable');
      },
      true,
    );
    expect(() => throwing.observe({ type: 'brand_new' })).not.toThrow();
    expect(() =>
      throwing.observe({ type: 'result', subtype: 'success' }, true),
    ).not.toThrow();
  });
});

describe('unclassifiedCodexNotification', () => {
  it('classifies every notification method in the lifecycle table', () => {
    expect(unclassifiedCodexNotification('turn/started')).toBeUndefined();
    expect(unclassifiedCodexNotification('item/agentMessage/delta')).toBe(
      undefined,
    );
  });

  it('names an unknown method, keeping provider text out of the label', () => {
    expect(unclassifiedCodexNotification('turn/brandNew')).toBe(
      'turn/brandNew',
    );
    expect(unclassifiedCodexNotification('Secret value!')).toBe('unrecognized');
    expect(unclassifiedCodexNotification('constructor')).toBe('constructor');
  });
});

describe('createCodexContractGuard', () => {
  function codexGuard(): {
    records: SessionDiagnosticRecord[];
    guard: ReturnType<typeof createCodexContractGuard>;
  } {
    const records: SessionDiagnosticRecord[] = [];
    return {
      records,
      guard: createCodexContractGuard(scope, (record) => {
        records.push(record);
      }),
    };
  }

  it('reports each unknown notification method once per session', () => {
    const { records, guard: codex } = codexGuard();
    codex.observe('turn/brandNew', undefined);
    codex.observe('turn/brandNew', undefined);
    codex.observe('item/brandNew', undefined);
    expect(
      records.map((record) => [
        record.kind,
        record.providerType,
        record.providerContractEvent,
      ]),
    ).toEqual([
      ['provider_contract_unknown_event', 'codex', 'turn/brandNew'],
      ['provider_contract_unknown_event', 'codex', 'item/brandNew'],
    ]);
    expect(records[0]).toMatchObject(scope);
  });

  it('records the initialize user agent once per distinct agent', () => {
    const { records, guard: codex } = codexGuard();
    const agent = 'canopy/0.50.0 (Mac OS 15.5.0; arm64) xterm';
    codex.observe('turn/started', agent);
    codex.observe('item/started', agent);
    codex.observe('turn/started', 'canopy/0.51.0 (Mac OS 15.5.0; arm64)');
    expect(
      records.map((record) => [record.kind, record.providerHarnessVersion]),
    ).toEqual([
      ['provider_harness_version', 'canopy/0.50.0'],
      ['provider_harness_version', 'canopy/0.51.0'],
    ]);
  });

  it('records nothing for a healthy session before initialize', () => {
    const { records, guard: codex } = codexGuard();
    codex.observe('turn/started', undefined);
    codex.observe('turn/completed', undefined);
    expect(records).toEqual([]);
  });

  it('never lets a diagnostic failure escape into ingestion', () => {
    const codex = createCodexContractGuard(scope, () => {
      throw new Error('recorder failed');
    });
    expect(() => codex.observe('turn/brandNew', 'canopy/0.50.0')).not.toThrow();
  });
});
