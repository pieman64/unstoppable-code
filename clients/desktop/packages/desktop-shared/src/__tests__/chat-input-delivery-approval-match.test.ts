import {
  inputSettingsKey,
  inputSettingsKeyMatchesNonApproval,
  inputRequestMatchesNonApprovalSettings,
  inputRequestMatchesSettings,
} from '../chat-input-delivery';
import {
  limitAllowRules,
  narrowApprovalMode,
  narrowSessionApprovalRules,
  sendDenyRulesBeyond,
  sessionApprovalRulesWithin,
  sessionApprovalWithinTurn,
  turnSessionApprovalRules,
  type TurnApproval,
} from '../lib/send-approval-narrowing';
import type {
  ApprovalMode,
  ApprovalRule,
  ChatSendMessageRequest,
  PersistedChatTab,
} from '../types';
import { initModelAliases } from '../types';

const REQUEST: ChatSendMessageRequest = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  userMessageId: 'queued',
  text: 'Next',
  providerType: 'claude',
};

const TAB: PersistedChatTab = {
  id: 'chat-1',
  title: 'Chat',
  createdAt: '2026-10-23',
  messages: [],
  providerType: 'claude',
};

const ALLOW_TESTS: ApprovalRule = {
  id: 'allow-tests',
  behavior: 'allow',
  target: { kind: 'command', pattern: 'npm test' },
  createdAt: '2026-10-23T00:00:00.000Z',
  origin: 'prompt',
};

const DENY_RM: ApprovalRule = {
  id: 'deny-rm',
  behavior: 'deny',
  target: { kind: 'command', pattern: 'rm -rf *' },
  createdAt: '2026-10-23T00:00:00.000Z',
  origin: 'prompt',
};

/**
 * The approval `request`'s own turn starts with in `tab`, as the turn-start
 * read computes it (without the live-mode bound, which only the host holds).
 */
function turnFor(
  request: ChatSendMessageRequest,
  tab: PersistedChatTab,
  defaultMode: ApprovalMode,
): TurnApproval {
  const admitted = request.admittedApproval;
  return {
    approvalMode: narrowApprovalMode(
      narrowApprovalMode(tab.approvalMode ?? defaultMode, request.approvalMode),
      admitted?.approvalMode,
    ),
    sessionApprovalRules: turnSessionApprovalRules(
      tab.sessionApprovalRules ?? [],
      request.sessionApprovalRules,
      admitted?.sessionApprovalRules,
    ),
  };
}

/** Whether `request` may steer into a session that applied `mode` and `rules`. */
function matches(
  request: ChatSendMessageRequest,
  tab: PersistedChatTab,
  mode?: ApprovalMode,
  rules?: readonly ApprovalRule[],
  defaultMode: ApprovalMode = 'full-access',
): boolean {
  return inputRequestMatchesSettings(
    request,
    tab,
    turnFor(request, tab, defaultMode),
    mode,
    rules,
  );
}

describe('queued input settings check, approval fields compared in one direction', () => {
  it('keeps a queued message narrower than the live session out of its turn', () => {
    // Saved at Ask, the session now runs Full Access: steering it in would
    // run the message with more authority than it was sent with.
    expect(
      matches(
        { ...REQUEST, approvalMode: 'ask' },
        { ...TAB, approvalMode: 'full-access' },
        'full-access',
      ),
    ).toBe(false);
    expect(
      matches(
        { ...REQUEST, approvalMode: 'auto' },
        { ...TAB, approvalMode: 'full-access' },
        'full-access',
      ),
    ).toBe(false);
    // A deny rule the chat does not hold.
    expect(matches({ ...REQUEST, sessionApprovalRules: [DENY_RM] }, TAB)).toBe(
      false,
    );
  });

  it('lets a queued message that asks for no more than the live chat steer in', () => {
    // A wider mode is not authority: the live chat's mode governs.
    expect(
      matches(
        { ...REQUEST, approvalMode: 'full-access' },
        { ...TAB, approvalMode: 'ask' },
        'ask',
      ),
    ).toBe(true);
    expect(matches(REQUEST, { ...TAB, approvalMode: 'auto' }, 'auto')).toBe(
      true,
    );
    expect(
      matches(
        { ...REQUEST, approvalMode: 'auto' },
        { ...TAB, approvalMode: 'auto' },
        'auto',
      ),
    ).toBe(true);
    // Allow rules carry no authority, so one the chat lacks is ignored.
    expect(
      matches({ ...REQUEST, sessionApprovalRules: [ALLOW_TESTS] }, TAB),
    ).toBe(true);
    // The chat's own rules, including deny rules the request does not repeat.
    expect(
      matches(REQUEST, {
        ...TAB,
        sessionApprovalRules: [ALLOW_TESTS, DENY_RM],
      }),
    ).toBe(true);
    // A deny rule the chat already holds, under another id and key order.
    expect(
      matches(
        {
          ...REQUEST,
          sessionApprovalRules: [
            {
              ...DENY_RM,
              id: 'renderer-copy',
              target: { pattern: 'rm -rf *', kind: 'command' },
            },
          ],
        },
        { ...TAB, sessionApprovalRules: [DENY_RM] },
      ),
    ).toBe(true);
  });

  it('compares the mode with the one the receiving session applied, not the tab or the default', () => {
    // The session still runs at Full Access although the tab, or the
    // default a tab without a saved mode follows, now says Auto.
    expect(
      matches(
        { ...REQUEST, approvalMode: 'auto' },
        { ...TAB, approvalMode: 'auto' },
        'full-access',
      ),
    ).toBe(false);
    expect(
      matches({ ...REQUEST, approvalMode: 'auto' }, TAB, 'full-access'),
    ).toBe(false);
    // The session already runs at Auto, or stricter than the tab says.
    expect(matches({ ...REQUEST, approvalMode: 'auto' }, TAB, 'auto')).toBe(
      true,
    );
    expect(
      matches(
        { ...REQUEST, approvalMode: 'auto' },
        { ...TAB, approvalMode: 'full-access' },
        'ask',
      ),
    ).toBe(true);
    // An unknown session mode counts as Full Access: only a request that
    // narrows nothing steers in.
    expect(matches({ ...REQUEST, approvalMode: 'auto' }, TAB)).toBe(false);
    expect(
      matches(
        { ...REQUEST, approvalMode: 'ask' },
        { ...TAB, approvalMode: 'ask' },
      ),
    ).toBe(false);
    expect(matches({ ...REQUEST, approvalMode: 'full-access' }, TAB)).toBe(
      true,
    );
    expect(matches(REQUEST, TAB)).toBe(true);
  });

  it('keeps a message without its own mode out of a session wider than its turn would start with', () => {
    // A Portal send carries no approval fields; its turn starts at the
    // tab's mode, or the default when the tab has none.
    expect(
      matches(REQUEST, { ...TAB, approvalMode: 'auto' }, 'full-access'),
    ).toBe(false);
    expect(
      matches(REQUEST, { ...TAB, approvalMode: 'ask' }, 'full-access'),
    ).toBe(false);
    expect(matches(REQUEST, TAB, 'full-access', undefined, 'auto')).toBe(false);
    expect(matches(REQUEST, TAB, 'auto', undefined, 'ask')).toBe(false);
    // An unknown session mode counts as Full Access.
    expect(matches(REQUEST, TAB, undefined, undefined, 'auto')).toBe(false);
    // The session runs at, or stricter than, the turn's mode.
    expect(matches(REQUEST, TAB, 'auto', undefined, 'auto')).toBe(true);
    expect(matches(REQUEST, { ...TAB, approvalMode: 'auto' }, 'ask')).toBe(
      true,
    );
  });

  it('keeps an admitted agent message out of a chat that gained authority since it was admitted', () => {
    const admitted = (
      approvalMode: ChatSendMessageRequest['approvalMode'] & string,
      sessionApprovalRules: ApprovalRule[],
    ): ChatSendMessageRequest => ({
      ...REQUEST,
      admittedApproval: { approvalMode, sessionApprovalRules },
    });
    // The chat's mode widened after admission.
    expect(
      matches(admitted('ask', []), {
        ...TAB,
        approvalMode: 'full-access',
      }),
    ).toBe(false);
    // The session runs wider than admitted, whatever the tab says.
    expect(matches(admitted('auto', []), TAB, 'full-access')).toBe(false);
    expect(
      matches(
        admitted('auto', []),
        { ...TAB, approvalMode: 'auto' },
        'full-access',
      ),
    ).toBe(false);
    // The chat gained a grant, or lost a deny rule, after admission.
    expect(
      matches(admitted('ask', []), {
        ...TAB,
        approvalMode: 'ask',
        sessionApprovalRules: [ALLOW_TESTS],
      }),
    ).toBe(false);
    expect(
      matches(admitted('ask', [DENY_RM]), {
        ...TAB,
        approvalMode: 'ask',
      }),
    ).toBe(false);
    // Unchanged, or narrowed since: it steers in.
    expect(
      matches(
        admitted('auto', [ALLOW_TESTS, DENY_RM]),
        {
          ...TAB,
          approvalMode: 'auto',
          sessionApprovalRules: [
            { ...ALLOW_TESTS, id: 'same-effect' },
            DENY_RM,
          ],
        },
        'auto',
      ),
    ).toBe(true);
    expect(
      matches(
        admitted('full-access', [ALLOW_TESTS]),
        {
          ...TAB,
          approvalMode: 'ask',
          sessionApprovalRules: [DENY_RM],
        },
        'ask',
      ),
    ).toBe(true);
  });

  it('compares the rules with the ones the receiving session applied, not the tab', () => {
    const tab = { ...TAB, approvalMode: 'ask' as const };
    // The tab lost a grant the running session still evaluates.
    expect(
      matches({ ...REQUEST, sessionApprovalRules: [ALLOW_TESTS] }, tab, 'ask', [
        ALLOW_TESTS,
      ]),
    ).toBe(false);
    expect(matches(REQUEST, tab, 'ask', [ALLOW_TESTS])).toBe(false);
    // The tab gained a deny rule the running session lacks.
    expect(
      matches(REQUEST, { ...tab, sessionApprovalRules: [DENY_RM] }, 'ask', []),
    ).toBe(false);
    // A deny rule the request adds, which the session already applies.
    expect(
      matches(
        { ...REQUEST, sessionApprovalRules: [{ ...DENY_RM, id: 'copy' }] },
        tab,
        'ask',
        [DENY_RM],
      ),
    ).toBe(true);
    // An admitted message: the session holds a grant the chat had at
    // admission but the message was not admitted with.
    expect(
      matches(
        {
          ...REQUEST,
          admittedApproval: { approvalMode: 'ask', sessionApprovalRules: [] },
        },
        { ...tab, sessionApprovalRules: [ALLOW_TESTS] },
        'ask',
        [ALLOW_TESTS],
      ),
    ).toBe(false);
    // The session holds no more than the turn would: it steers in, including
    // when it already lost a grant the tab still holds.
    expect(
      matches(
        REQUEST,
        { ...tab, sessionApprovalRules: [ALLOW_TESTS, DENY_RM] },
        'ask',
        [{ ...DENY_RM, id: 'same-effect' }],
      ),
    ).toBe(true);
    expect(
      matches(REQUEST, { ...tab, sessionApprovalRules: [ALLOW_TESTS] }, 'ask', [
        ALLOW_TESTS,
      ]),
    ).toBe(true);
  });

  it('with unknown applied rules, steers only a message whose rules equal the tab rules', () => {
    const tab = {
      ...TAB,
      approvalMode: 'ask' as const,
      sessionApprovalRules: [ALLOW_TESTS],
    };
    expect(matches(REQUEST, tab, 'ask')).toBe(true);
    expect(
      matches({ ...REQUEST, sessionApprovalRules: [DENY_RM] }, tab, 'ask'),
    ).toBe(false);
    expect(
      matches(
        {
          ...REQUEST,
          admittedApproval: { approvalMode: 'ask', sessionApprovalRules: [] },
        },
        tab,
        'ask',
      ),
    ).toBe(false);
  });

  it('still compares the non-approval settings exactly', () => {
    expect(
      matches(
        { ...REQUEST, approvalMode: 'full-access', planMode: true },
        { ...TAB, approvalMode: 'ask' },
      ),
    ).toBe(false);
  });

  it('splits into a non-approval comparison and the one-direction approval check', () => {
    const narrower: ChatSendMessageRequest = {
      ...REQUEST,
      approvalMode: 'ask',
      sessionApprovalRules: [DENY_RM],
    };
    // Ordinary delivery re-reads authority, so only the other settings
    // decide whether a refused steer may fall back to it.
    expect(inputRequestMatchesNonApprovalSettings(narrower, TAB)).toBe(true);
    expect(
      inputRequestMatchesNonApprovalSettings(
        { ...narrower, planMode: true },
        TAB,
      ),
    ).toBe(false);
    const askOnly = { ...REQUEST, approvalMode: 'ask' as const };
    expect(
      sessionApprovalWithinTurn(
        'ask',
        undefined,
        turnFor(narrower, TAB, 'full-access'),
        [],
      ),
    ).toBe(false);
    expect(
      sessionApprovalWithinTurn(
        'ask',
        undefined,
        turnFor(askOnly, TAB, 'full-access'),
        [],
      ),
    ).toBe(true);
    expect(
      sessionApprovalWithinTurn(
        undefined,
        undefined,
        turnFor(askOnly, TAB, 'full-access'),
        [],
      ),
    ).toBe(false);
  });
});

describe('send approval narrowing', () => {
  it('takes the stricter mode and never the wider one', () => {
    expect(narrowApprovalMode('full-access', 'ask')).toBe('ask');
    expect(narrowApprovalMode('full-access', 'auto')).toBe('auto');
    expect(narrowApprovalMode('ask', 'full-access')).toBe('ask');
    expect(narrowApprovalMode('auto', undefined)).toBe('auto');
  });

  it('keeps the saved rules, adds only new deny rules and drops request allow rules', () => {
    expect(
      narrowSessionApprovalRules([ALLOW_TESTS], [DENY_RM, ALLOW_TESTS]),
    ).toEqual([ALLOW_TESTS, DENY_RM]);
    expect(narrowSessionApprovalRules([], [ALLOW_TESTS])).toEqual([]);
    expect(
      narrowSessionApprovalRules([DENY_RM], [{ ...DENY_RM, id: 'same' }]),
    ).toEqual([DENY_RM]);
    expect(
      sendDenyRulesBeyond([], [DENY_RM, { ...DENY_RM, id: 'dup' }]),
    ).toEqual([DENY_RM]);
    expect(sendDenyRulesBeyond([], undefined)).toEqual([]);
  });

  it('limits allow rules to those a limit holds, by effect, and keeps every deny rule', () => {
    expect(
      limitAllowRules(
        [ALLOW_TESTS, DENY_RM],
        [{ ...ALLOW_TESTS, id: 'same-effect' }],
      ),
    ).toEqual([ALLOW_TESTS, DENY_RM]);
    expect(limitAllowRules([ALLOW_TESTS, DENY_RM], [DENY_RM])).toEqual([
      DENY_RM,
    ]);
    expect(limitAllowRules([], [ALLOW_TESTS])).toEqual([]);
  });

  it('starts a turn with the chat rules and the send deny rules, bounded by what it was admitted against', () => {
    const ALLOW_LINT: ApprovalRule = {
      ...ALLOW_TESTS,
      id: 'allow-lint',
      target: { kind: 'command', pattern: 'npm run lint' },
    };
    expect(
      turnSessionApprovalRules([ALLOW_TESTS], [DENY_RM, ALLOW_LINT], undefined),
    ).toEqual([ALLOW_TESTS, DENY_RM]);
    expect(
      turnSessionApprovalRules([ALLOW_TESTS, ALLOW_LINT], undefined, [
        { ...ALLOW_LINT, id: 'same-effect' },
        DENY_RM,
      ]),
    ).toEqual([ALLOW_LINT, DENY_RM]);
    expect(turnSessionApprovalRules([ALLOW_TESTS], [], [])).toEqual([]);
  });

  it('holds a session within a turn only when its mode is not wider and its rules are within', () => {
    const turn = (
      approvalMode: ApprovalMode,
      sessionApprovalRules: ApprovalRule[] = [],
    ): TurnApproval => ({ approvalMode, sessionApprovalRules });
    expect(sessionApprovalWithinTurn('auto', [], turn('auto'), [])).toBe(true);
    expect(sessionApprovalWithinTurn('ask', [], turn('auto'), [])).toBe(true);
    expect(sessionApprovalWithinTurn('full-access', [], turn('auto'), [])).toBe(
      false,
    );
    expect(sessionApprovalWithinTurn(undefined, [], turn('auto'), [])).toBe(
      false,
    );
    expect(
      sessionApprovalWithinTurn(undefined, [], turn('full-access'), []),
    ).toBe(true);
    expect(
      sessionApprovalWithinTurn('ask', [ALLOW_TESTS], turn('ask'), []),
    ).toBe(false);
    expect(
      sessionApprovalWithinTurn('ask', [], turn('ask', [DENY_RM]), []),
    ).toBe(false);
    // Unknown rules are presumed to be the tab's and must equal the turn's.
    expect(
      sessionApprovalWithinTurn('ask', undefined, turn('ask', [DENY_RM]), [
        DENY_RM,
      ]),
    ).toBe(true);
    expect(
      sessionApprovalWithinTurn('ask', undefined, turn('ask'), [ALLOW_TESTS]),
    ).toBe(false);
  });

  it('holds session rules within a rule set only when they grant nothing more and miss none of its deny rules', () => {
    expect(sessionApprovalRulesWithin([ALLOW_TESTS], [ALLOW_TESTS])).toBe(true);
    expect(sessionApprovalRulesWithin([], [ALLOW_TESTS])).toBe(true);
    expect(sessionApprovalRulesWithin([ALLOW_TESTS], [])).toBe(false);
    expect(sessionApprovalRulesWithin([], [DENY_RM])).toBe(false);
    expect(sessionApprovalRulesWithin([DENY_RM, ALLOW_TESTS], [DENY_RM])).toBe(
      false,
    );
    expect(
      sessionApprovalRulesWithin([DENY_RM], [{ ...DENY_RM, id: 'same' }]),
    ).toBe(true);
  });
});

describe('persisted non-approval settings check', () => {
  const settings = {
    model: 'layout-model',
    providerType: 'codex',
    planMode: true,
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'low', speed: 'fast' },
    pluginSelections: {
      collectionIds: ['collection'],
      skillRefs: [],
      pluginRefs: [],
    },
    deferredToolsAllowed: false,
    interfaceMode: 'canopy',
    subscriptionBillingOverride: true,
    aiCreditsRouted: false,
    aiCreditsRouting: { active: true, scope: 'session', activatedAt: 123 },
    executionHarness: 'codex',
    selectedRepoId: 'repo',
    globalInstructionsSnapshot: 'instructions',
    disabledGlobalPluginSelections: { collectionIds: ['disabled'] },
    codexFastModeEnabled: false,
    proposalMode: 'required',
  } satisfies Partial<PersistedChatTab>;

  it('preserves the persisted key layout, including absent-field encoding', () => {
    expect(inputSettingsKey(TAB)).toBe(
      '[null,"claude",null,null,[],null,null,null,null,null,null,null,null,null,null,null,null,null,null]',
    );
    const tab: PersistedChatTab = {
      ...TAB,
      ...settings,
      approvalMode: 'ask',
      sessionApprovalRules: [DENY_RM],
    };
    expect(inputSettingsKey(tab)).toBe(
      JSON.stringify([
        settings.model,
        settings.providerType,
        settings.planMode,
        'ask',
        [DENY_RM],
        settings.thinkingLevel,
        settings.modelConfig,
        settings.pluginSelections,
        settings.deferredToolsAllowed,
        settings.interfaceMode,
        settings.subscriptionBillingOverride,
        settings.aiCreditsRouted,
        settings.aiCreditsRouting,
        settings.executionHarness,
        settings.selectedRepoId,
        settings.globalInstructionsSnapshot,
        settings.disabledGlobalPluginSelections,
        settings.codexFastModeEnabled,
        settings.proposalMode,
      ]),
    );
    expect(
      inputSettingsKeyMatchesNonApproval(
        { ...tab, approvalMode: 'full-access', sessionApprovalRules: [] },
        inputSettingsKey(tab),
      ),
    ).toBe(true);
  });

  it.each(Object.entries(settings))(
    'does not ignore the non-approval field %s in either direction',
    (field, value) => {
      const tab = { ...TAB, [field]: value };
      expect(
        inputSettingsKeyMatchesNonApproval(tab, inputSettingsKey(TAB)),
      ).toBe(false);
      expect(
        inputSettingsKeyMatchesNonApproval(TAB, inputSettingsKey(tab)),
      ).toBe(false);
    },
  );

  it.each([
    [
      'legacy-model',
      '["canonical-model","claude",null,null,[],null,null,null,null,null,null,null,null,null,null,null,null,null,null]',
    ],
    [
      'canonical-model',
      '["canonical-model","claude",null,null,[],null,null,null,null,null,null,null,null,null,null,null,null,null,null]',
    ],
    [
      '',
      '["","claude",null,null,[],null,null,null,null,null,null,null,null,null,null,null,null,null,null]',
    ],
  ])('keeps legacy persisted-key bytes for model %j', (model, legacyKey) => {
    initModelAliases({ 'legacy-model': 'canonical-model' });
    try {
      const tab: PersistedChatTab = { ...TAB, model };
      expect(inputSettingsKey(tab)).toBe(legacyKey);
      expect(inputSettingsKeyMatchesNonApproval(tab, legacyKey)).toBe(true);
      expect(
        inputSettingsKeyMatchesNonApproval(
          { ...tab, approvalMode: 'ask', sessionApprovalRules: [DENY_RM] },
          legacyKey,
        ),
      ).toBe(true);
    } finally {
      initModelAliases({});
    }
  });

  it('ignores only approval changes, not raw non-approval settings changes', () => {
    const key = inputSettingsKey(TAB);
    expect(
      inputSettingsKeyMatchesNonApproval(
        { ...TAB, approvalMode: 'ask', sessionApprovalRules: [DENY_RM] },
        key,
      ),
    ).toBe(true);
    // Effective thinking defaults to high, but an explicit setting still changes the key.
    expect(
      inputSettingsKeyMatchesNonApproval(
        { ...TAB, thinkingLevel: 'high' },
        key,
      ),
    ).toBe(false);
    expect(
      inputSettingsKeyMatchesNonApproval(
        {
          ...TAB,
          disabledGlobalPluginSelections: { collectionIds: ['disabled'] },
        },
        key,
      ),
    ).toBe(false);
    expect(inputSettingsKeyMatchesNonApproval(TAB, 'unreadable')).toBe(false);
    expect(inputSettingsKeyMatchesNonApproval(TAB, '{}')).toBe(false);
  });
});
