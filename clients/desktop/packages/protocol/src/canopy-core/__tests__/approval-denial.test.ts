import {
  APPROVAL_CANCELLED_MESSAGE,
  APPROVAL_CHECK_FAILED_MESSAGE,
  FAIL_CLOSED_MESSAGE,
  POLICY_DENIED_FALLBACK_MESSAGE,
  SAFETY_DENIED_MESSAGE_PREFIX,
  USER_DENIED_MESSAGE,
  safetyDeniedMessage,
  savedRuleDeniedMessage,
  userDeniedMessage,
} from '../approval-denial';

describe('approval denial messages', () => {
  it.each([undefined, '', ' \n\t '])(
    'omits absent or blank user reason %p',
    (reason) => {
      expect(userDeniedMessage(reason)).toBe(USER_DENIED_MESSAGE);
      expect(USER_DENIED_MESSAGE).toBe('The user denied this tool call.');
    },
  );

  it('preserves meaningful reason text including whitespace and newlines', () => {
    expect(
      userDeniedMessage('  Not on this branch.\nKeep this detail.  '),
    ).toBe(
      'The user denied this tool call:   Not on this branch.\nKeep this detail.  ',
    );
  });

  it.each(['session', 'project', 'global', 'repository'] as const)(
    'names saved-rule %s scope',
    (scope) => {
      expect(savedRuleDeniedMessage(scope)).toBe(
        `Blocked by a saved deny rule (${scope} scope). This call cannot be approved from a prompt while the rule exists. Do not retry or repackage the blocked operation.`,
      );
    },
  );

  it('preserves the CAN-4811 safety message byte-for-byte', () => {
    expect(safetyDeniedMessage('force-push')).toBe(
      'Blocked by a safety rule (force-push). This call cannot be approved from a prompt. Do not retry or repackage the blocked operation. Choose a safe alternative or explain the block to the user.',
    );
    expect(SAFETY_DENIED_MESSAGE_PREFIX).toBe('Blocked by a safety rule (');
  });

  it.each(['destructive delete', 'disk write', 'unverifiable command'])(
    'accepts the existing safety label %s',
    (label) => {
      expect(safetyDeniedMessage(label)).toBe(
        `Blocked by a safety rule (${label}). This call cannot be approved from a prompt. Do not retry or repackage the blocked operation. Choose a safe alternative or explain the block to the user.`,
      );
    },
  );

  it('exports the existing system messages and a neutral fallback', () => {
    expect(FAIL_CLOSED_MESSAGE).toBe(
      'Approval prompt unavailable; denied by default.',
    );
    expect(APPROVAL_CANCELLED_MESSAGE).toBe(
      'Approval request cancelled; denied by default.',
    );
    expect(APPROVAL_CHECK_FAILED_MESSAGE).toBe(
      'Approval check failed; denied by default.',
    );
    expect(POLICY_DENIED_FALLBACK_MESSAGE).toBe(
      'Denied by the approval policy.',
    );
  });
});
