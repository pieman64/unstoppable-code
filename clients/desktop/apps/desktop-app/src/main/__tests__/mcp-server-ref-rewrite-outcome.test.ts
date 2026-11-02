import { CanopyErrorPayloadSchema } from '@canopy/protocol/canopy-core';
import { McpRefRewriteResultSchema } from '@canopy/protocol/canopy-core/core';
import {
  captureMcpRefRewriteOutcome,
  inMcpRefRewritePhase,
  unwrapMcpRefRewriteOutcome,
} from '../mcp/server-ref-rewrite-outcome';

const result = { globalDefaults: false, workspaces: 0, chats: 0 };

it.each([-1, 0.5, Infinity, NaN])(
  'rejects invalid explicit counters: %p',
  (count) => {
    expect(
      McpRefRewriteResultSchema.safeParse({ ...result, chats: count }).success,
    ).toBe(false);
  },
);
it('validates the result once after execution without replaying an effect', async () => {
  let writes = 0;
  const outcome = await captureMcpRefRewriteOutcome(() => {
    writes += 1;
    return Promise.resolve({ ...result, chats: -1 });
  });
  expect(writes).toBe(1);
  expect(outcome).toMatchObject({
    ok: false,
    error: {
      kind: 'internal',
      details: { phase: 'result', effects: 'unknown' },
      retry: { kind: 'never' },
    },
  });
  if (outcome.ok) throw new Error('Expected failure');
  expect(CanopyErrorPayloadSchema.safeParse(outcome.error).success).toBe(true);
  expect(unwrapMcpRefRewriteOutcome(outcome)).toEqual({ ...result, chats: -1 });
  expect(writes).toBe(1);
});
it('keeps a lost-response failure uncertain and does not replay writes', async () => {
  let writes = 0;
  const error = new Error('response lost');
  const outcome = await captureMcpRefRewriteOutcome(() => {
    writes += 1;
    return inMcpRefRewritePhase('result', () => Promise.reject(error));
  });
  expect(outcome).toMatchObject({
    ok: false,
    legacyError: error,
    error: { kind: 'internal', details: { effects: 'unknown' } },
  });
  expect(writes).toBe(1);
});
it('isolates simultaneous outcomes and retains the original legacy rejection', async () => {
  const error = Object.assign(new Error('/private/path'), { code: 'EACCES' });
  const [failed, succeeded] = await Promise.all([
    captureMcpRefRewriteOutcome(() =>
      inMcpRefRewritePhase('globalDefaults', () => Promise.reject(error)),
    ),
    captureMcpRefRewriteOutcome(() => Promise.resolve(result)),
  ]);
  expect(succeeded).toEqual({ ok: true, value: result });
  expect(unwrapMcpRefRewriteOutcome(succeeded)).toBe(result);
  if (failed.ok || !('legacyError' in failed))
    throw new Error('Expected rejection');
  expect(failed.legacyError).toBe(error);
  expect(CanopyErrorPayloadSchema.safeParse(failed.error).success).toBe(true);
  expect(failed.error).toMatchObject({
    kind: 'unavailable',
    code: 'core.catalog.mcpServer.rewriteFailed',
  });
  expect(JSON.stringify(failed.error)).not.toContain('/private/path');
});

it('classifies the propagated error, not an earlier swallowed failure', async () => {
  const propagated = Object.assign(new Error('later read failed'), {
    code: 'EIO',
  });
  const outcome = await captureMcpRefRewriteOutcome(async () => {
    await inMcpRefRewritePhase('chatRewrite', () =>
      Promise.reject(new Error('swallowed')),
    ).catch(() => undefined);
    return inMcpRefRewritePhase('workspaceRead', () =>
      Promise.reject(propagated),
    );
  });
  expect(outcome).toMatchObject({
    ok: false,
    legacyError: propagated,
    error: {
      kind: 'unavailable',
      code: 'core.catalog.mcpServer.rewriteFailed',
      details: { phase: 'workspaceRead' },
    },
  });
});

it('does not let a concurrent caught failure mask a nested propagated failure', async () => {
  const propagated = Object.assign(new Error('commit failed'), { code: 'EIO' });
  const outcome = await captureMcpRefRewriteOutcome(() =>
    inMcpRefRewritePhase('workspaceDefaults', async () => {
      await Promise.all([
        inMcpRefRewritePhase('normalization', () =>
          Promise.reject(new Error('background')),
        ).catch(() => undefined),
        Promise.resolve(),
      ]);
      return inMcpRefRewritePhase('manifestCommit', () =>
        Promise.reject(propagated),
      );
    }),
  );
  expect(outcome).toMatchObject({
    ok: false,
    legacyError: propagated,
    error: {
      code: 'core.catalog.mcpServer.rewriteFailed',
      details: { phase: 'manifestCommit' },
    },
  });
});

it('is a passthrough outside a rewrite execution', async () => {
  const error = new Error('original');
  await expect(
    inMcpRefRewritePhase('normalization', () => Promise.reject(error)),
  ).rejects.toBe(error);
  await expect(
    inMcpRefRewritePhase('manifestCommit', () => Promise.resolve(result)),
  ).resolves.toBe(result);
});

it('keeps nested captures and late queued work isolated', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let late: Promise<unknown> | undefined;
  const outerError = Object.assign(new Error('outer'), { code: 'EIO' });
  const outer = await captureMcpRefRewriteOutcome(async () => {
    late = gate
      .then(() =>
        inMcpRefRewritePhase('indexUpdate', () => Promise.reject(outerError)),
      )
      .catch((error: unknown) => error);
    const inner = await captureMcpRefRewriteOutcome(() =>
      inMcpRefRewritePhase('tokenClear', () => Promise.reject(outerError)),
    );
    expect(inner).toMatchObject({
      ok: false,
      error: { code: 'core.catalog.mcpServer.retirementFailed' },
    });
    return inMcpRefRewritePhase('globalDefaults', () =>
      Promise.reject(outerError),
    );
  });
  expect(outer).toMatchObject({
    ok: false,
    error: {
      code: 'core.catalog.mcpServer.rewriteFailed',
      details: { phase: 'globalDefaults' },
    },
  });
  release?.();
  expect(await late).toBe(outerError);
  const next = await captureMcpRefRewriteOutcome(() =>
    Promise.reject(outerError),
  );
  expect(next).toMatchObject({
    ok: false,
    error: { kind: 'internal', details: { phase: 'rewrite' } },
  });
});
