import type { ShareFailure } from '@canopy/protocol/sharing';
import {
  ShareFailureError,
  classifyShareFailure,
  shareFailureCopy,
  shareFailureRecovery,
} from '../share-errors';

function failure(overrides: Partial<ShareFailure> = {}): ShareFailure {
  return {
    version: 1,
    kind: 'connection',
    stage: 'upload',
    message: 'Network down',
    commitState: 'not-committed',
    retryable: true,
    ...overrides,
  };
}

describe('classifyShareFailure', () => {
  it('reads a ShareFailureError, a bare failure and a failed envelope', () => {
    const value = failure();
    expect(classifyShareFailure(new ShareFailureError(value))).toBe(value);
    expect(classifyShareFailure(value)).toEqual(value);
    expect(classifyShareFailure({ ok: false, failure: value })).toEqual(value);
  });

  it('returns null for unstructured errors', () => {
    expect(classifyShareFailure(new Error('HTTP 403: nope'))).toBeNull();
    expect(classifyShareFailure('failed')).toBeNull();
    expect(
      classifyShareFailure({ ok: false, failure: { kind: 'quota' } }),
    ).toBeNull();
  });
});

describe('shareFailureCopy', () => {
  it('explains an upload connection failure', () => {
    expect(shareFailureCopy('skill', failure())).toBe(
      "Couldn't upload the included files. Check your connection and try again.",
    );
  });

  it('never claims a safe retry for an uncertain publication', () => {
    const uncertain = failure({
      stage: 'publish',
      commitState: 'unknown',
      retryable: false,
    });
    expect(shareFailureCopy('pipeline', uncertain)).toBe(
      "Couldn't confirm whether this pipeline was shared. Check its current sharing status before trying again.",
    );
    expect(shareFailureRecovery(uncertain)).toBe('none');
  });

  it('phrases authentication and permission refusals for the noun', () => {
    expect(
      shareFailureCopy(
        'agent',
        failure({ kind: 'authentication', retryable: false }),
      ),
    ).toBe('Sign in again to share this agent.');
    expect(
      shareFailureCopy(
        'agent',
        failure({ kind: 'permission', retryable: false }),
      ),
    ).toBe("You don't have permission to share this agent with this audience.");
    expect(
      shareFailureCopy(
        'agent',
        failure({
          kind: 'permission',
          retryable: false,
          reason: 'publisher_role_required',
        }),
      ),
    ).toBe("Your account can view shared items but can't publish them.");
  });

  it('preserves the server explanation for a conflict', () => {
    expect(
      shareFailureCopy(
        'skill',
        failure({
          kind: 'conflict',
          message: 'A teammate already shared different files.',
        }),
      ),
    ).toBe('A teammate already shared different files.');
  });

  it('keeps the server explanation for a validation refusal', () => {
    const refusal = failure({
      kind: 'unknown',
      stage: 'publish',
      message: 'Skill name is too long.',
      retryable: false,
      httpStatus: 422,
    });
    expect(shareFailureCopy('skill', refusal)).toBe(
      "Couldn't share this skill. Skill name is too long.",
    );
    expect(shareFailureRecovery(refusal)).toBe('none');
  });

  it('says the share landed when only finishing up failed', () => {
    // e.g. a collection update whose local link could not be stored.
    const finish = failure({
      kind: 'unknown',
      stage: 'finish',
      message: "Couldn't share. Try again.",
      commitState: 'committed',
      retryable: false,
    });
    expect(shareFailureCopy('collection', finish)).toBe(
      'Collection shared, but finishing up failed.',
    );
    // Sharing again could duplicate a create, so no retry is offered.
    expect(shareFailureRecovery(finish)).toBe('none');
  });
});

describe('landed shares', () => {
  it('says the share landed whatever the failure kind', () => {
    const landed = failure({
      kind: 'authentication',
      stage: 'finish',
      commitState: 'committed',
      retryable: false,
    });
    expect(shareFailureCopy('skill', landed)).toBe(
      'Skill shared, but finishing up failed.',
    );
    expect(shareFailureRecovery(landed)).toBe('none');
  });
});

describe('shareFailureRecovery', () => {
  it('never offers a retry once a share has landed', () => {
    const finish = failure({
      stage: 'finish',
      commitState: 'committed',
      retryable: true,
    });
    expect(shareFailureCopy('skill', finish)).toBe(
      'Skill shared, but finishing up failed.',
    );
    expect(shareFailureRecovery(finish)).toBe('none');
  });

  it.each([
    ['authentication', 'sign-in'],
    ['organization-plan', 'choose-plan'],
    ['dependency-review', 'review-files'],
    ['connection', 'try-again'],
    ['permission', 'none'],
  ] as const)('offers %s recovery as %s', (kind, recovery) => {
    expect(shareFailureRecovery(failure({ kind }))).toBe(recovery);
  });
});
