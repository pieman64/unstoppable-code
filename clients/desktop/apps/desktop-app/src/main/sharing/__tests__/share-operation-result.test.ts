import { parseShareFailure } from '@canopy/protocol/sharing';

const mockLogWarn = jest.fn();
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): unknown => mockLogWarn(...args),
}));

import { CanopyCloudClientError } from '../../canopy-cloud/client';
import { noteCloudWriteSent } from '../../canopy-cloud/cloud-write-tracking';
import {
  ShareOperationError,
  shareFailureFromError,
  toShareOperationResult,
  withShareStage,
} from '../share-operation-result';

function httpError(
  status: number,
  options: {
    message?: string;
    serverCode?: string;
    serverReason?: string;
    serverOrganizationId?: string;
    validated?: boolean;
    requestId?: string;
  } = {},
): CanopyCloudClientError {
  return new CanopyCloudClientError(
    'http-error',
    options.message ?? 'Refused',
    status,
    options.serverCode,
    undefined,
    options.validated ?? true,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    options.serverReason,
    options.requestId,
    options.serverOrganizationId,
  );
}

describe('shareFailureFromError', () => {
  it('classifies an org_teams_lapsed refusal as an organization plan problem', () => {
    const failure = shareFailureFromError(
      httpError(403, {
        message: 'Subscribe to Business.',
        serverCode: 'telemetry_scope_prohibited',
        serverReason: 'org_teams_lapsed',
        serverOrganizationId: 'org-ext-10',
        requestId: 'req_1',
      }),
      'publish',
      { writeSent: false },
    );

    expect(failure).toEqual({
      version: 1,
      kind: 'organization-plan',
      stage: 'publish',
      message: 'Subscribe to Business.',
      commitState: 'not-committed',
      retryable: false,
      httpStatus: 403,
      serverCode: 'telemetry_scope_prohibited',
      requestId: 'req_1',
      organizationId: 'org-ext-10',
      reason: 'org_teams_lapsed',
    });
    expect(parseShareFailure(failure)).toEqual(failure);
  });

  it('names a publisher-role refusal so the dialog explains the role', () => {
    const failure = shareFailureFromError(
      httpError(403, {
        message: 'You do not have permission to publish shared resources',
        serverReason: 'publisher_role_required',
      }),
      'publish',
      { writeSent: false },
    );

    expect(failure).toMatchObject({
      kind: 'permission',
      reason: 'publisher_role_required',
      commitState: 'not-committed',
      retryable: false,
    });
    expect(parseShareFailure(failure)).toEqual(failure);
  });

  it('never infers a plan problem from the shared policy code alone', () => {
    const failure = shareFailureFromError(
      httpError(403, {
        message: 'Your organization prohibits sharing plans',
        serverCode: 'telemetry_scope_prohibited',
      }),
      'publish',
      { writeSent: false },
    );

    expect(failure.kind).toBe('permission');
  });

  it.each([
    [401, 'authentication'],
    [403, 'permission'],
    [409, 'conflict'],
    [404, 'unavailable'],
    [422, 'unknown'],
  ] as const)('maps a validated %s to %s', (status, kind) => {
    expect(
      shareFailureFromError(httpError(status), 'publish', { writeSent: false }),
    ).toMatchObject({
      kind,
      commitState: 'not-committed',
      retryable: false,
    });
  });

  it('treats an unvalidated 403 as a connection problem', () => {
    expect(
      shareFailureFromError(httpError(403, { validated: false }), 'prepare', {
        writeSent: false,
      }),
    ).toMatchObject({ kind: 'connection', retryable: true });
  });

  it.each([
    ['prepare', 'not-committed', true],
    ['upload', 'not-committed', true],
    ['commit', 'not-committed', true],
    ['publish', 'unknown', false],
    ['finish', 'committed', false],
  ] as const)(
    'reports a %s connection failure as %s (retryable %s)',
    (stage, commitState, retryable) => {
      const failure = shareFailureFromError(
        new CanopyCloudClientError('network-error', 'socket hang up'),
        stage,
        { writeSent: false },
      );
      expect(failure).toMatchObject({
        kind: 'connection',
        stage,
        commitState,
        retryable,
      });
    },
  );

  it('reports 5xx and 429 as connection failures', () => {
    expect(
      shareFailureFromError(httpError(503), 'commit', { writeSent: false })
        .kind,
    ).toBe('connection');
    expect(
      shareFailureFromError(httpError(429), 'commit', { writeSent: false })
        .kind,
    ).toBe('connection');
  });

  it('reports a failed read during publication as a definite pre-flight failure', () => {
    const read = new CanopyCloudClientError('network-error', 'socket hang up');
    read.failedRead = true;

    expect(
      shareFailureFromError(read, 'publish', { writeSent: false }),
    ).toMatchObject({
      kind: 'connection',
      stage: 'access',
      commitState: 'not-committed',
      retryable: true,
    });
    // The same failure from a write keeps its outcome uncertain.
    expect(
      shareFailureFromError(
        new CanopyCloudClientError('network-error', 'socket hang up'),
        'publish',
        { writeSent: false },
      ),
    ).toMatchObject({ stage: 'publish', commitState: 'unknown' });
  });

  it('never forwards the raw message of a non-Cloud error', () => {
    const failure = shareFailureFromError(
      new Error("ENOENT: no such file '/Users/alex/.canopy/secret.yaml'"),
      'publish',
      { writeSent: true },
    );

    expect(failure.kind).toBe('unknown');
    expect(failure.message).not.toContain('/Users/');
    // After a write, the publication may have landed.
    expect(failure.commitState).toBe('unknown');
  });

  it('reports a local failure before any Cloud write as not shared', () => {
    // e.g. a run's diff or a plan's sync file failing before publication.
    expect(
      shareFailureFromError(new Error('ENOENT'), 'publish', {
        writeSent: false,
      }),
    ).toMatchObject({
      kind: 'unknown',
      stage: 'publish',
      commitState: 'not-committed',
      retryable: false,
    });
  });

  it('keeps a resource-context refusal so the dialog can explain it', () => {
    expect(
      shareFailureFromError(
        new Error('Resource unavailable (context-mismatch)'),
        'publish',
        { writeSent: false },
      ),
    ).toMatchObject({
      kind: 'unavailable',
      message: 'Resource unavailable (context-mismatch)',
      commitState: 'not-committed',
    });
  });

  it('keeps a pre-publication refusal readable after an earlier write', () => {
    // e.g. a context check tagged `access` after a package prepare POST.
    expect(
      shareFailureFromError(
        new Error('Workflow unavailable (context-mismatch)'),
        'access',
        { writeSent: true },
      ),
    ).toMatchObject({
      kind: 'unavailable',
      message: 'Workflow unavailable (context-mismatch)',
      commitState: 'not-committed',
    });
  });

  it('still reads the pre-rename pipeline refusal', () => {
    expect(
      shareFailureFromError(
        new Error('Pipeline unavailable (context-mismatch)'),
        'access',
        { writeSent: true },
      ),
    ).toMatchObject({
      kind: 'unavailable',
      message: 'Pipeline unavailable (context-mismatch)',
      commitState: 'not-committed',
    });
  });

  it('never marks a landed share as safe to repeat', () => {
    expect(
      shareFailureFromError(
        new CanopyCloudClientError('network-error', 'socket hang up'),
        'finish',
        { writeSent: true },
      ),
    ).toMatchObject({
      kind: 'connection',
      stage: 'finish',
      commitState: 'committed',
      retryable: false,
    });
  });

  it('keeps the message and category of a ShareOperationError', () => {
    expect(
      shareFailureFromError(
        new ShareOperationError(
          'dependency-review',
          'Dependency analysis expired.',
          'prepare',
        ),
        'publish',
        { writeSent: false },
      ),
    ).toMatchObject({
      kind: 'dependency-review',
      stage: 'prepare',
      message: 'Dependency analysis expired.',
      commitState: 'not-committed',
    });
  });

  it('uses the innermost stage a failure was tagged with', async () => {
    const error: unknown = await withShareStage('commit', () =>
      withShareStage('upload', () =>
        Promise.reject(
          new CanopyCloudClientError('network-error', 'socket hang up'),
        ),
      ),
    ).catch((caught: unknown) => caught);

    expect(
      shareFailureFromError(error, 'publish', { writeSent: false }),
    ).toMatchObject({
      kind: 'connection',
      stage: 'upload',
      retryable: true,
    });
  });
});

describe('toShareOperationResult', () => {
  it('wraps a resolved value', async () => {
    await expect(
      toShareOperationResult(() => Promise.resolve({ id: 's1' })),
    ).resolves.toEqual({ ok: true, value: { id: 's1' } });
  });

  it('keeps a failed read after a Cloud write uncertain', async () => {
    // A rollback's pre-read or a public-link read that follows publication
    // cannot prove the share was not published.
    const read = new CanopyCloudClientError('network-error', 'socket hang up');
    read.failedRead = true;

    const result = await toShareOperationResult(() => {
      noteCloudWriteSent();
      return Promise.reject(read);
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: 'connection',
        stage: 'publish',
        commitState: 'unknown',
        retryable: false,
      },
    });
  });

  it('still treats a failed read before any write as a pre-flight failure', async () => {
    const read = new CanopyCloudClientError('network-error', 'socket hang up');
    read.failedRead = true;

    const result = await toShareOperationResult(() => Promise.reject(read));

    expect(result).toMatchObject({
      ok: false,
      failure: { stage: 'access', commitState: 'not-committed' },
    });
  });

  it('keeps a resource-context refusal after a Cloud write uncertain', async () => {
    // e.g. recording a shared agent's install after createSharedAgent.
    const result = await toShareOperationResult(() => {
      noteCloudWriteSent();
      return Promise.reject(new Error('Agent unavailable (context-mismatch)'));
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { stage: 'publish', commitState: 'unknown' },
    });
  });

  it('logs a sanitized diagnostic for a failed share', async () => {
    mockLogWarn.mockClear();
    await toShareOperationResult(() => {
      noteCloudWriteSent();
      return Promise.reject(
        new Error("ENOENT: no such file '/Users/alex/.canopy/plan.md'"),
      );
    });

    expect(mockLogWarn).toHaveBeenCalledWith('[sharing] Share failed', {
      stage: 'publish',
      kind: 'unknown',
      commitState: 'unknown',
      writeSent: true,
      errorName: 'Error',
    });
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain('/Users/');
  });

  it('wraps a rejection as a parsed failure', async () => {
    const result = await toShareOperationResult(() =>
      Promise.reject(httpError(401)),
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'authentication', stage: 'publish' },
    });
  });
});
