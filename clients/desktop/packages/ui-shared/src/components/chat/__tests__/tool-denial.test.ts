import {
  APPROVAL_CANCELLED_MESSAGE,
  APPROVAL_CHECK_FAILED_MESSAGE,
  FAIL_CLOSED_MESSAGE,
  POLICY_DENIED_FALLBACK_MESSAGE,
  USER_DENIED_MESSAGE,
  safetyDeniedMessage,
  savedRuleDeniedMessage,
  userDeniedMessage,
} from '@canopy/protocol/approvals';
import {
  HOOK_FAILURE_FALLBACK_MESSAGE,
  classifyToolDenial,
  stripHookErrorPrefix,
  toolDenialDetail,
  toolDenialHeading,
} from '../tool-denial';

const SAFETY = safetyDeniedMessage('force-push');

describe('stripHookErrorPrefix', () => {
  it('removes the PreToolUse wrapper from the ticket transcript', () => {
    expect(
      stripHookErrorPrefix(
        'PreToolUse:Bash hook error: The user denied this tool call.',
      ),
    ).toBe(USER_DENIED_MESSAGE);
  });

  it.each(['Bash', 'mcp__canopy__RunScript', 'Edit'])(
    'supports the %s tool name',
    (tool) => {
      expect(stripHookErrorPrefix(`PreToolUse:${tool} hook error: boom`)).toBe(
        'boom',
      );
    },
  );

  it('keeps multiline bodies and wrapper-like text inside them', () => {
    const body = 'line one\nPreToolUse:Bash hook error: line two';
    expect(stripHookErrorPrefix(`PreToolUse:Bash hook error: ${body}`)).toBe(
      body,
    );
    expect(stripHookErrorPrefix(`note: ${body}`)).toBe(`note: ${body}`);
  });

  it('names a hook failure when the wrapper carries nothing', () => {
    expect(stripHookErrorPrefix('PreToolUse:Bash hook error:')).toBe(
      HOOK_FAILURE_FALLBACK_MESSAGE,
    );
    expect(stripHookErrorPrefix('PreToolUse:Bash hook error:   \n')).toBe(
      HOOK_FAILURE_FALLBACK_MESSAGE,
    );
  });

  it.each([
    'PreToolUse: Bash hook error: x',
    'PreToolUse:Bash hook-error: x',
    'PostToolUse:Bash hook error: x',
    'preToolUse:Bash hook error: x',
  ])('leaves a near-match unchanged: %s', (output) => {
    expect(stripHookErrorPrefix(output)).toBe(output);
  });
});

describe('classifyToolDenial', () => {
  it('attributes the wrapped safety denial to the safety rule', () => {
    const denial = classifyToolDenial(`PreToolUse:Bash hook error: ${SAFETY}`);
    expect(denial).toEqual({
      attribution: 'safety-rule',
      message: SAFETY,
      safetyLabel: 'force-push',
    });
    expect(denial?.message).not.toContain('user denied');
  });

  it.each(['session', 'project', 'global', 'repository'] as const)(
    'attributes a %s saved deny rule',
    (scope) => {
      expect(classifyToolDenial(savedRuleDeniedMessage(scope))).toEqual({
        attribution: 'saved-rule',
        message: savedRuleDeniedMessage(scope),
        savedRuleScope: scope,
      });
    },
  );

  it('attributes the user sentence with and without a reason', () => {
    expect(classifyToolDenial(USER_DENIED_MESSAGE)).toEqual({
      attribution: 'user',
      message: USER_DENIED_MESSAGE,
    });
    const reason = 'Not on this branch.\nUse a PR instead.';
    expect(
      classifyToolDenial(
        `PreToolUse:Bash hook error: ${userDeniedMessage(reason)}`,
      ),
    ).toEqual({
      attribution: 'user',
      message: userDeniedMessage(reason),
      userReason: reason,
    });
  });

  it('preserves the complete meaningful user reason as display text', () => {
    const reason = '  Not on this branch.\nKeep this detail.  \n';
    expect(
      classifyToolDenial(
        `PreToolUse:Bash hook error: ${userDeniedMessage(reason)}`,
      ),
    ).toEqual({
      attribution: 'user',
      message: userDeniedMessage(reason),
      userReason: reason,
    });
  });

  it.each([
    POLICY_DENIED_FALLBACK_MESSAGE,
    FAIL_CLOSED_MESSAGE,
    APPROVAL_CANCELLED_MESSAGE,
    APPROVAL_CHECK_FAILED_MESSAGE,
  ])('attributes %s to the approval system', (message) => {
    expect(classifyToolDenial(`${message}\n`)?.attribution).toBe('policy');
  });

  it.each([
    '',
    'PreToolUse:Bash hook error:',
    'PreToolUse:Bash hook error: hook script crashed',
    'command not found: git',
    'The user denied this tool call',
    'The user denied this tool call:   ',
    'Error: The user denied this tool call.',
    'Blocked by a safety rule (force-push).',
    'Blocked by a safety rule (force-push). Something else entirely.',
    `${SAFETY} Extra.`,
    savedRuleDeniedMessage('session').replace('session', 'team'),
    `${POLICY_DENIED_FALLBACK_MESSAGE} Retry later.`,
  ])('leaves an unrecognized error unclassified: %p', (output) => {
    expect(classifyToolDenial(output)).toBeNull();
  });
});

describe('toolDenial copy', () => {
  it('names each source in headings and clean details', () => {
    const cases = [
      [SAFETY, 'Blocked by safety rule', 'blocked by safety rule · force-push'],
      [
        savedRuleDeniedMessage('project'),
        'Blocked by saved rule',
        'blocked by saved rule · project scope',
      ],
      [userDeniedMessage('No.'), 'Denied by you', 'denied by you'],
      [
        FAIL_CLOSED_MESSAGE,
        'Blocked by approval system',
        'blocked by approval system',
      ],
    ] as const;
    for (const [message, heading, detail] of cases) {
      const denial = classifyToolDenial(message);
      if (denial == null) throw new Error(`unclassified: ${message}`);
      expect(toolDenialHeading(denial)).toBe(heading);
      expect(toolDenialDetail(denial)).toBe(detail);
    }
  });
});
