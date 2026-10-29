import type {
  AgentActionLimitRequest,
  AgentActionLimitValues,
  AgentActionLimitsPort,
} from '../limits';
import { check, checkEqual } from './assert';
import type { AgentConformanceTestApi } from './suite';

/** A fresh, empty limits port with these caps. */
export type MakeAgentConformanceLimits = (
  limits: AgentActionLimitValues,
) => AgentActionLimitsPort | Promise<AgentActionLimitsPort>;

const CAPS: AgentActionLimitValues = {
  perParentTurn: 1,
  perUserPerHour: 1,
  maxDepth: 2,
};

function request(
  overrides: Partial<AgentActionLimitRequest>,
): AgentActionLimitRequest {
  return {
    kind: 'chat.create',
    turnKey: 'turn-1',
    actorKey: 'actor-1',
    parentChatId: 'chat-1',
    parentDepth: 0,
    idempotencyKey: 'write-1',
    attemptId: 'attempt-1',
    ...overrides,
  };
}

/**
 * Holds a host's limits port to the reservation ownership rules: a retry
 * that reserves a held key takes the reservation over, so the superseded
 * attempt can no longer free it, and only the current owner's release
 * returns the slot. A reservation marked uncertain stays counted through
 * any takeover and release, and a commit counts it once.
 */
export function runAgentActionLimitsConformance(
  t: AgentConformanceTestApi,
  makeLimits: MakeAgentConformanceLimits,
): void {
  t.describe('agent action limits conformance', () => {
    t.it(
      'moves a held reservation to the retry that takes it over',
      async () => {
        const limits = await makeLimits(CAPS);
        const original = await limits.reserve(
          request({ attemptId: 'original' }),
        );
        const retry = await limits.reserve(request({ attemptId: 'retry' }));
        check(original.ok && retry.ok, 'both attempts hold the reservation');
        if (!original.ok || !retry.ok) return;
        checkEqual(retry.ownerAttemptId, 'retry', 'the owner after takeover');
        await original.release();
        await retry.commit();
        checkEqual(
          await limits.reserve(
            request({ idempotencyKey: 'write-2', attemptId: 'other' }),
          ),
          { ok: false, reason: 'per_turn', limit: 1 },
          'a distinct write in the same turn after the takeover committed',
        );
        checkEqual(
          await limits.reserve(
            request({
              idempotencyKey: 'write-3',
              attemptId: 'other-turn',
              turnKey: 'turn-2',
            }),
          ),
          { ok: false, reason: 'per_hour', limit: 1 },
          'a distinct write in another turn after the takeover committed',
        );
      },
    );

    t.it(
      'counts a write the superseded attempt commits after the retry released',
      async () => {
        const limits = await makeLimits(CAPS);
        const original = await limits.reserve(
          request({ attemptId: 'original' }),
        );
        const retry = await limits.reserve(request({ attemptId: 'retry' }));
        if (!original.ok || !retry.ok) {
          check(false, 'both attempts hold the reservation');
          return;
        }
        await retry.release();
        await original.commit();
        checkEqual(
          await limits.reserve(
            request({ idempotencyKey: 'write-2', attemptId: 'other' }),
          ),
          { ok: false, reason: 'per_turn', limit: 1 },
          'a distinct write in the same turn after the late commit',
        );
        checkEqual(
          await limits.reserve(
            request({
              idempotencyKey: 'write-3',
              attemptId: 'other-turn',
              turnKey: 'turn-2',
            }),
          ),
          { ok: false, reason: 'per_hour', limit: 1 },
          'a distinct write in another turn after the late commit',
        );
      },
    );

    t.it(
      'frees a taken-over reservation only when the retry releases it',
      async () => {
        const limits = await makeLimits(CAPS);
        const original = await limits.reserve(
          request({ attemptId: 'original' }),
        );
        const retry = await limits.reserve(request({ attemptId: 'retry' }));
        if (!original.ok || !retry.ok) {
          check(false, 'both attempts hold the reservation');
          return;
        }
        await original.release();
        checkEqual(
          await limits.reserve(
            request({ idempotencyKey: 'write-2', attemptId: 'other' }),
          ),
          { ok: false, reason: 'per_turn', limit: 1 },
          'a distinct write after the superseded attempt released',
        );
        await retry.release();
        const next = await limits.reserve(
          request({ idempotencyKey: 'write-3', attemptId: 'next' }),
        );
        check(next.ok, 'a distinct write after the retry released');
      },
    );

    t.it(
      'keeps an uncertain reservation counted after the retry that took it over releases',
      async () => {
        const limits = await makeLimits(CAPS);
        const original = await limits.reserve(
          request({ attemptId: 'original' }),
        );
        if (!original.ok) {
          check(false, 'the original attempt holds the reservation');
          return;
        }
        await original.markUncertain();
        const retry = await limits.reserve(request({ attemptId: 'retry' }));
        if (!retry.ok) {
          check(false, 'the retry takes the reservation over');
          return;
        }
        checkEqual(retry.ownerAttemptId, 'retry', 'the owner after takeover');
        await retry.release();
        await original.release();
        checkEqual(
          await limits.reserve(
            request({ idempotencyKey: 'write-2', attemptId: 'other' }),
          ),
          { ok: false, reason: 'per_turn', limit: 1 },
          'a distinct write in the same turn after the uncertain key was released',
        );
        checkEqual(
          await limits.reserve(
            request({
              idempotencyKey: 'write-3',
              attemptId: 'other-turn',
              turnKey: 'turn-2',
            }),
          ),
          { ok: false, reason: 'per_hour', limit: 1 },
          'a distinct write in another turn after the uncertain key was released',
        );
      },
    );

    t.it(
      'counts an uncertain write marked after the retry that took it over released',
      async () => {
        const limits = await makeLimits(CAPS);
        const original = await limits.reserve(
          request({ attemptId: 'original' }),
        );
        const retry = await limits.reserve(request({ attemptId: 'retry' }));
        if (!original.ok || !retry.ok) {
          check(false, 'both attempts hold the reservation');
          return;
        }
        await retry.release();
        await original.markUncertain();
        await retry.release();
        checkEqual(
          await limits.reserve(
            request({ idempotencyKey: 'write-2', attemptId: 'other' }),
          ),
          { ok: false, reason: 'per_turn', limit: 1 },
          'a distinct write in the same turn after the late uncertain mark',
        );
      },
    );

    t.it('counts an uncertain write once when a retry commits it', async () => {
      const limits = await makeLimits({
        ...CAPS,
        perParentTurn: 2,
        perUserPerHour: 2,
      });
      const original = await limits.reserve(request({ attemptId: 'original' }));
      if (!original.ok) {
        check(false, 'the original attempt holds the reservation');
        return;
      }
      await original.markUncertain();
      const retry = await limits.reserve(request({ attemptId: 'retry' }));
      if (!retry.ok) {
        check(false, 'the retry takes the reservation over');
        return;
      }
      await retry.commit();
      await original.markUncertain();
      const second = await limits.reserve(
        request({ idempotencyKey: 'write-2', attemptId: 'second' }),
      );
      check(second.ok, 'a second distinct write fits beside the committed one');
      checkEqual(
        await limits.reserve(
          request({ idempotencyKey: 'write-3', attemptId: 'third' }),
        ),
        { ok: false, reason: 'per_turn', limit: 2 },
        'a third distinct write past the cap',
      );
    });

    t.it(
      'counts a write once when the attempt that committed it also marks it uncertain',
      async () => {
        const limits = await makeLimits({
          ...CAPS,
          perParentTurn: 2,
          perUserPerHour: 2,
        });
        const original = await limits.reserve(
          request({ attemptId: 'original' }),
        );
        if (!original.ok) {
          check(false, 'the original attempt holds the reservation');
          return;
        }
        await original.commit();
        await original.markUncertain();
        const retry = await limits.reserve(request({ attemptId: 'retry' }));
        if (!retry.ok) {
          check(false, 'the retry finds the held reservation');
          return;
        }
        await retry.release();
        const second = await limits.reserve(
          request({ idempotencyKey: 'write-2', attemptId: 'second' }),
        );
        check(
          second.ok,
          'a second distinct write fits beside the write counted once',
        );
        checkEqual(
          await limits.reserve(
            request({ idempotencyKey: 'write-3', attemptId: 'third' }),
          ),
          { ok: false, reason: 'per_turn', limit: 2 },
          'a third distinct write past the cap',
        );
      },
    );
  });
}
