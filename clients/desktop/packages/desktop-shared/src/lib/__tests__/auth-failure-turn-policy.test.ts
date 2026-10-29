import type {
  AuthDependencyFailure,
  AuthFailureClass,
  CanopyAuthFailureEventData,
} from '@canopy/protocol/auth-recovery';
import { CANOPY_AUTH_FAILURE_EVENT_TYPE } from '@canopy/protocol/auth-recovery';
import {
  isAutoResumeSafeToolName,
  isBackgroundInitiationSource,
  isForegroundInitiationSource,
  selectRecoverableAuthFailures,
  shouldStopTurnForAuthFailure,
} from '../auth-failure-turn-policy';

function mcpFailure(
  overrides: Partial<AuthDependencyFailure> = {},
): AuthDependencyFailure {
  return {
    dependencyClass: 'mcp',
    dependencyId: 'srv-1:cfg-1',
    displayName: 'Prod MCP server',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
    ...overrides,
  };
}

function event(
  failures: readonly AuthDependencyFailure[],
): CanopyAuthFailureEventData {
  const [primary] = failures;
  if (!primary) throw new Error('at least one failure is required');
  return {
    type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
    toolUseId: 'tu-1',
    failure: primary,
    failures: [...failures],
  };
}

describe('shouldStopTurnForAuthFailure', () => {
  it('stops the turn for a recoverable MCP OAuth failure', () => {
    expect(shouldStopTurnForAuthFailure(event([mcpFailure()]))).toBe(true);
  });

  it.each([
    'provider_terminal',
    'github_login',
    'linear_login',
    'settings_deeplink',
  ])('stops the turn for a %s recovery kind', (kind) => {
    const recovery: AuthDependencyFailure['recovery'] =
      kind === 'provider_terminal'
        ? { kind: 'provider_terminal', provider: 'claude' }
        : kind === 'github_login'
          ? { kind: 'github_login' }
          : kind === 'linear_login'
            ? { kind: 'linear_login' }
            : {
                kind: 'settings_deeplink',
                target: { page: 'mcp-servers', serverId: 'srv-1' },
              };
    expect(
      shouldStopTurnForAuthFailure(
        event([mcpFailure({ failureClass: 'unauthenticated', recovery })]),
      ),
    ).toBe(true);
  });

  // The load-bearing rule: gate on `recovery.kind`, never on `failureClass`.
  // Nothing the user can click fixes these, so stopping would strand them.
  const NON_RECOVERABLE: readonly AuthFailureClass[] = [
    'quota_exceeded',
    'provider_outage',
    'network_error',
    'insufficient_scope',
    'misconfigured',
    'unsupported_auth_method',
  ];
  it.each(NON_RECOVERABLE)(
    'does NOT stop the turn for %s (recovery: none)',
    (failureClass) => {
      expect(
        shouldStopTurnForAuthFailure(
          event([mcpFailure({ failureClass, recovery: { kind: 'none' } })]),
        ),
      ).toBe(false);
    },
  );

  it('stops when any dependency in the checklist is recoverable', () => {
    expect(
      shouldStopTurnForAuthFailure(
        event([
          mcpFailure({
            dependencyId: 'srv-0:cfg-0',
            failureClass: 'quota_exceeded',
            recovery: { kind: 'none' },
          }),
          mcpFailure(),
        ]),
      ),
    ).toBe(true);
  });

  it('reads the singular `failure` when no array is carried', () => {
    expect(
      shouldStopTurnForAuthFailure({
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        failure: mcpFailure(),
      }),
    ).toBe(true);
  });

  it('ignores a shape-valid failure that breaks the recoverable-class invariant', () => {
    expect(
      shouldStopTurnForAuthFailure(
        event([mcpFailure({ failureClass: 'quota_exceeded' })]),
      ),
    ).toBe(false);
  });
});

describe('selectRecoverableAuthFailures', () => {
  it('returns only the recoverable dependencies, deduped by id', () => {
    const recoverable = mcpFailure();
    const selected = selectRecoverableAuthFailures(
      event([
        recoverable,
        recoverable,
        mcpFailure({
          dependencyId: 'srv-2:cfg-2',
          failureClass: 'insufficient_scope',
          recovery: { kind: 'none' },
        }),
      ]),
    );
    expect(selected.map((entry) => entry.dependencyId)).toEqual([
      'srv-1:cfg-1',
    ]);
  });
});

describe('isAutoResumeSafeToolName', () => {
  it.each([
    'mcp__prod__list_records',
    'mcp__prod__get-issue',
    'mcp__prod__search_threads',
    'mcp__prod__read_file_content',
    'mcp__prod__lookup-records',
    'mcp__prod__query_gcp_logs',
    'mcp__prod__describe_table',
  ])('treats %s as auto-resume safe', (toolName) => {
    expect(isAutoResumeSafeToolName(toolName)).toBe(true);
  });

  it.each([
    'mcp__prod__create_issue',
    'mcp__prod__send_message',
    'mcp__prod__delete_record',
    'mcp__prod__update-project',
    'mcp__prod__trash_message',
    // Denylist wins over a read-only prefix: a name can start read-only and
    // still mutate.
    'mcp__prod__get_and_delete_record',
    'mcp__prod__search_and_replace',
    // Unknown verbs are not assumed safe.
    'mcp__prod__frobnicate',
    'mcp__prod__do_the_thing',
  ])('treats %s as NOT auto-resume safe', (toolName) => {
    expect(isAutoResumeSafeToolName(toolName)).toBe(false);
  });

  it('is not safe for a missing or non-MCP tool name', () => {
    expect(isAutoResumeSafeToolName(undefined)).toBe(false);
    expect(isAutoResumeSafeToolName('Bash')).toBe(false);
    expect(isAutoResumeSafeToolName('Read')).toBe(false);
  });

  // CAN-1814 PR 4 made a Canopy-injected tool a possible interruption point.
  // `WatchGitHubItems` creates a durable watcher, so it must never be
  // auto-resumed — under either brand namespace, only one of which
  // `parseMcpToolName` even accepts.
  it.each([
    'WatchGitHubItems',
    'mcp__canopy__WatchGitHubItems',
    'mcp__unstoppable-code__WatchGitHubItems',
    'unstoppable-code_watch_github_items',
  ])('treats the injected tool %s as NOT auto-resume safe', (toolName) => {
    expect(isAutoResumeSafeToolName(toolName)).toBe(false);
  });

  // CAN-1814 review. The verb "resolve" reads as a lookup and was on the
  // read-only prefix list, so `resolve_diff_thread` — a REAL Linear MCP tool
  // that marks a review thread resolved — auto-resumed a mutation without
  // asking. That is the one unrecoverable failure mode this policy exists to
  // prevent, and the ticket names it explicitly: "Potentially completed
  // external writes are never repeated without explicit user confirmation."
  //
  // An ambiguous verb must fall through to "needs an explicit retry" rather
  // than being guessed safe.
  it.each([
    'mcp__linear__resolve_diff_thread',
    'mcp__srv__resolve_ticket',
    'mcp__srv__resolve_conflict',
  ])('does not auto-resume the mutating verb "resolve": %s', (toolName) => {
    expect(isAutoResumeSafeToolName(toolName)).toBe(false);
  });

  it.each([
    'mcp__linear__get_issue',
    'mcp__srv__list_records',
    'mcp__srv__search_documents',
  ])('still auto-resumes a genuine read: %s', (toolName) => {
    expect(isAutoResumeSafeToolName(toolName)).toBe(true);
  });
});

describe('initiation source gating', () => {
  it.each([undefined, 'user', 'app_advisor'] as const)(
    'treats %s as foreground',
    (source) => {
      expect(isForegroundInitiationSource(source)).toBe(true);
      expect(isBackgroundInitiationSource(source)).toBe(false);
    },
  );

  it.each(['hook', 'automation'] as const)(
    'treats %s as background (CAN-492: never open a browser here)',
    (source) => {
      expect(isForegroundInitiationSource(source)).toBe(false);
      expect(isBackgroundInitiationSource(source)).toBe(true);
    },
  );

  it.each(['portal', 'unknown'] as const)(
    'treats %s as neither foreground nor a local background notification target',
    (source) => {
      expect(isForegroundInitiationSource(source)).toBe(false);
      expect(isBackgroundInitiationSource(source)).toBe(false);
    },
  );

  // CAN-1814 review (important). Removing 'resolve' fixed one INSTANCE. The
  // class stayed open: a first-token allowlist paired with a finite mutation
  // denylist assumes safe unless a listed word appears, while the ticket
  // requires "known to be safe and idempotent". Every name below opened with an
  // allowed read verb, contained no denylisted token, and auto-resumed a
  // mutation.
  //
  // A compound name has to JOIN its two actions, and the joiners — coordinating
  // conjunctions and verb particles — are a CLOSED vocabulary, unlike the
  // unbounded space of mutating verbs. That is what makes rejecting them a
  // class-level fix rather than another instance patch.
  it.each([
    'mcp__srv__find_and_purge',
    'mcp__srv__query_and_charge',
    'mcp__srv__fetch_and_confirm_order',
    'mcp__srv__read_and_ack',
    'mcp__srv__search_then_terminate',
    'mcp__srv__get_or_create_page',
    'mcp__srv__list_and_dismiss_alerts',
  ])('does not auto-resume a compound action: %s', (toolName) => {
    expect(isAutoResumeSafeToolName(toolName)).toBe(false);
  });

  // A verb particle turns a read verb into an action of its own, with no
  // conjunction to give it away.
  it.each([
    'mcp__srv__check_in',
    'mcp__srv__check_out',
    'mcp__srv__read_back',
    'mcp__srv__list_off',
  ])('does not auto-resume a phrasal verb: %s', (toolName) => {
    expect(isAutoResumeSafeToolName(toolName)).toBe(false);
  });

  // Juxtaposition without a conjunction is the residual case the structural
  // rule cannot see, so the mutation denylist stays as defence in depth and
  // carries the verbs this review named.
  it.each([
    'mcp__srv__find_purge',
    'mcp__srv__get_refund_order',
    'mcp__srv__list_transfer_targets',
  ])('does not auto-resume a juxtaposed mutation: %s', (toolName) => {
    expect(isAutoResumeSafeToolName(toolName)).toBe(false);
  });

  // Multi-word object names are the dominant real shape (Linear ships
  // `list_issue_statuses`; the UD admin server ships
  // `get-domain-dns-provider-records`), so the rule must not require the object
  // to be a single known token — that would reject nearly every genuine read
  // and leave auto-resume dead code.
  it.each([
    'mcp__linear__list_issue_statuses',
    'mcp__linear__list_release_notes',
    'mcp__srv__get_domain_dns_provider_records',
    'mcp__srv__describe_table_schema',
  ])('still auto-resumes a multi-word read: %s', (toolName) => {
    expect(isAutoResumeSafeToolName(toolName)).toBe(true);
  });
});
