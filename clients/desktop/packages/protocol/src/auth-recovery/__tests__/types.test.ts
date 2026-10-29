import {
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  isAuthDependencyFailure,
  isCanopyAuthFailureEventData,
  isRecoverableAuthFailureClass,
  isValidAuthDependencyFailure,
  readAuthDependencyFailures,
  RECOVERABLE_AUTH_FAILURE_CLASSES,
  type AuthDependencyFailure,
  type AuthFailureClass,
  type AuthSettingsTarget,
} from '../index';

const ALL_CLASSES: readonly AuthFailureClass[] = [
  'unauthenticated',
  'expired',
  'revoked',
  'reauthorization_required',
  'quota_exceeded',
  'insufficient_scope',
  'misconfigured',
  'provider_outage',
  'network_error',
  'unsupported_auth_method',
];

describe('auth failure recoverability', () => {
  it('treats exactly four classes as recoverable', () => {
    expect([...RECOVERABLE_AUTH_FAILURE_CLASSES].sort()).toEqual([
      'expired',
      'reauthorization_required',
      'revoked',
      'unauthenticated',
    ]);
  });

  it('classifies every known class without throwing', () => {
    for (const value of ALL_CLASSES) {
      expect(typeof isRecoverableAuthFailureClass(value)).toBe('boolean');
    }
  });

  it('rejects a non-recoverable class carrying a recovery action', () => {
    const failure: AuthDependencyFailure = {
      dependencyClass: 'provider',
      dependencyId: 'claude',
      displayName: 'Claude',
      failureClass: 'quota_exceeded',
      recovery: { kind: 'provider_terminal', provider: 'claude' },
    };
    expect(isValidAuthDependencyFailure(failure)).toBe(false);
  });

  it('accepts a non-recoverable class with recovery kind none', () => {
    const failure: AuthDependencyFailure = {
      dependencyClass: 'provider',
      dependencyId: 'claude',
      displayName: 'Claude',
      failureClass: 'quota_exceeded',
      recovery: { kind: 'none' },
    };
    expect(isValidAuthDependencyFailure(failure)).toBe(true);
  });

  it('accepts a recoverable class with a real recovery action', () => {
    const failure: AuthDependencyFailure = {
      dependencyClass: 'mcp',
      dependencyId: 'srv-1:cfg-1',
      displayName: 'Prod MCP server',
      failureClass: 'expired',
      recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
    };
    expect(isValidAuthDependencyFailure(failure)).toBe(true);
  });
});

describe('isAuthDependencyFailure', () => {
  const valid: AuthDependencyFailure = {
    dependencyClass: 'mcp',
    dependencyId: 'srv-1:cfg-1',
    displayName: 'Prod MCP server',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
  };

  it('accepts a well-formed failure', () => {
    expect(isAuthDependencyFailure(valid)).toBe(true);
  });

  it.each([
    ['not a record', 'nope'],
    ['null', null],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    expect(isAuthDependencyFailure(value)).toBe(false);
  });

  it('rejects an unknown dependencyClass', () => {
    expect(
      isAuthDependencyFailure({ ...valid, dependencyClass: 'database' }),
    ).toBe(false);
  });

  it('rejects an unknown failureClass', () => {
    expect(isAuthDependencyFailure({ ...valid, failureClass: 'weird' })).toBe(
      false,
    );
  });

  it('rejects a non-string detail', () => {
    expect(isAuthDependencyFailure({ ...valid, detail: 42 })).toBe(false);
  });

  it('rejects a shape-valid payload that violates the recoverability invariant', () => {
    expect(
      isAuthDependencyFailure({ ...valid, failureClass: 'quota_exceeded' }),
    ).toBe(false);
  });

  it('rejects a settings_deeplink whose target has no known page', () => {
    // The guard used to accept ANY record as `target`, so a payload with a
    // bogus (or absent) `page` deserialized into an `AuthSettingsTarget` the
    // deep-link dispatcher cannot route.
    expect(
      isAuthDependencyFailure({
        ...valid,
        recovery: { kind: 'settings_deeplink', target: {} },
      }),
    ).toBe(false);
    expect(
      isAuthDependencyFailure({
        ...valid,
        recovery: { kind: 'settings_deeplink', target: { page: 'billing' } },
      }),
    ).toBe(false);
  });

  it('rejects a settings_deeplink target missing its page-specific field', () => {
    expect(
      isAuthDependencyFailure({
        ...valid,
        recovery: {
          kind: 'settings_deeplink',
          target: { page: 'integrations' },
        },
      }),
    ).toBe(false);
    expect(
      isAuthDependencyFailure({
        ...valid,
        recovery: {
          kind: 'settings_deeplink',
          target: { page: 'provider-accounts', provider: 'ollama' },
        },
      }),
    ).toBe(false);
  });

  it('accepts every well-formed settings_deeplink target', () => {
    const targets: AuthSettingsTarget[] = [
      { page: 'mcp-servers' },
      { page: 'mcp-servers', serverId: 'srv-1' },
      { page: 'integrations', integration: 'linear' },
      { page: 'provider-accounts', provider: 'codex' },
    ];
    for (const target of targets) {
      expect(
        isAuthDependencyFailure({
          ...valid,
          recovery: { kind: 'settings_deeplink', target },
        }),
      ).toBe(true);
    }
  });
});

describe('isCanopyAuthFailureEventData', () => {
  const failure: AuthDependencyFailure = {
    dependencyClass: 'provider',
    dependencyId: 'claude',
    displayName: 'Claude',
    failureClass: 'unauthenticated',
    recovery: { kind: 'provider_terminal', provider: 'claude' },
  };

  it('accepts an event with and without a toolUseId', () => {
    expect(
      isCanopyAuthFailureEventData({
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        failure,
      }),
    ).toBe(true);
    expect(
      isCanopyAuthFailureEventData({
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        toolUseId: 'tu-1',
        failure,
      }),
    ).toBe(true);
  });

  it('rejects a different event type or a malformed failure', () => {
    expect(isCanopyAuthFailureEventData({ type: 'result', failure })).toBe(
      false,
    );
    expect(
      isCanopyAuthFailureEventData({
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        failure: { dependencyClass: 'mcp' },
      }),
    ).toBe(false);
    expect(
      isCanopyAuthFailureEventData({
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        toolUseId: 7,
        failure,
      }),
    ).toBe(false);
  });
});

describe('readAuthDependencyFailures', () => {
  const mcp: AuthDependencyFailure = {
    dependencyClass: 'mcp',
    dependencyId: 'srv-1:cfg-1',
    displayName: 'Prod MCP server',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
  };
  const other: AuthDependencyFailure = {
    ...mcp,
    dependencyId: 'srv-2:cfg-1',
    displayName: 'Docs MCP server',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-2', configId: 'cfg-1' },
  };

  it('reads a block that carries only the pre-checklist singular field', () => {
    expect(readAuthDependencyFailures({ authFailure: mcp })).toEqual({
      failures: [mcp],
      hasVerdict: true,
    });
  });

  it('reads the array and drops the duplicate singular field', () => {
    // The writer sets both, with `authFailure` repeated as `authFailures[0]`.
    expect(
      readAuthDependencyFailures({
        authFailure: mcp,
        authFailures: [mcp, other],
      }),
    ).toEqual({ failures: [mcp, other], hasVerdict: true });
  });

  it('reports an empty read for a block with nothing attached', () => {
    expect(readAuthDependencyFailures({})).toEqual({
      failures: [],
      hasVerdict: false,
    });
  });

  it('records a verdict for a shape-valid entry that breaks the invariant', () => {
    // Main reached a readable conclusion — "reconnecting does not fix this" —
    // so a text heuristic must not overrule it. Distinguished from garbage by
    // `hasVerdict`, which is the whole reason the flag exists.
    expect(
      readAuthDependencyFailures({
        authFailure: { ...mcp, failureClass: 'quota_exceeded' },
      }),
    ).toEqual({ failures: [], hasVerdict: true });
  });

  it('records no verdict for an entry that is not even shape-valid', () => {
    expect(
      readAuthDependencyFailures({ authFailure: { dependencyClass: 'mcp' } }),
    ).toEqual({ failures: [], hasVerdict: false });
    expect(readAuthDependencyFailures({ authFailures: 'nope' })).toEqual({
      failures: [],
      hasVerdict: false,
    });
  });

  it('keeps the first entry for a repeated dependencyId', () => {
    const stale: AuthDependencyFailure = { ...mcp, displayName: 'Stale name' };
    expect(
      readAuthDependencyFailures({ authFailures: [mcp, stale] }).failures,
    ).toEqual([mcp]);
  });
});

describe('isCanopyAuthFailureEventData failures array', () => {
  const failure: AuthDependencyFailure = {
    dependencyClass: 'mcp',
    dependencyId: 'srv-1:cfg-1',
    displayName: 'Prod MCP server',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
  };

  it('accepts an event carrying the full dependency set', () => {
    expect(
      isCanopyAuthFailureEventData({
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        toolUseId: 'tu-1',
        failure,
        failures: [failure],
      }),
    ).toBe(true);
  });

  it('rejects a failures value that is not an array of valid failures', () => {
    expect(
      isCanopyAuthFailureEventData({
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        failure,
        failures: failure,
      }),
    ).toBe(false);
    expect(
      isCanopyAuthFailureEventData({
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        failure,
        failures: [failure, { dependencyClass: 'mcp' }],
      }),
    ).toBe(false);
  });
});
