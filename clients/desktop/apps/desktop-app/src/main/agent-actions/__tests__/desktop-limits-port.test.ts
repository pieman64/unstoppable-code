import {
  AGENT_ACTION_LIMITS,
  type AgentActionLimitRequest,
} from '@canopy/agent-actions';
import {
  DESKTOP_AGENT_ACTOR_KEY,
  desktopAgentActionLimits,
} from '../desktop-limits-port';

function request(
  index: number,
  overrides: Partial<AgentActionLimitRequest> = {},
): AgentActionLimitRequest {
  return {
    kind: 'chat.send_message',
    turnKey: 'turn-1',
    actorKey: DESKTOP_AGENT_ACTOR_KEY,
    parentChatId: 'chat-parent',
    parentDepth: 0,
    idempotencyKey: `key-${index}`,
    attemptId: `attempt-${index}`,
    ...overrides,
  };
}

describe('desktop agent action limits', () => {
  it('caps writes neither per turn nor per hour', async () => {
    const { perParentTurn, perUserPerHour } = AGENT_ACTION_LIMITS;
    const writes = Math.max(perParentTurn, perUserPerHour) * 2;
    for (let index = 0; index < writes; index += 1) {
      const reservation = await desktopAgentActionLimits.reserve(
        request(index),
      );
      expect(reservation.ok).toBe(true);
      if (reservation.ok) await reservation.commit();
    }
  });

  it('still caps how deep agent-started chats nest', async () => {
    await expect(
      desktopAgentActionLimits.reserve(
        request(-1, {
          kind: 'chat.create',
          parentDepth: AGENT_ACTION_LIMITS.maxDepth,
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'depth',
      limit: AGENT_ACTION_LIMITS.maxDepth,
    });
  });
});
