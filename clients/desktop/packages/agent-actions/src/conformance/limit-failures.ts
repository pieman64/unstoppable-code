import type {
  AgentActionLimitReservation,
  AgentActionLimitsPort,
} from '../limits';

/**
 * Conformance support for `control.failNextLimitCommit`: wraps a limits port
 * so the next reservation commit rejects without committing, as a lost
 * limits-store write would after the write it covers happened.
 */
export function createLimitCommitFailures(): {
  failNextCommit: () => void;
  wrap: (port: AgentActionLimitsPort) => AgentActionLimitsPort;
} {
  let failNext = false;
  return {
    failNextCommit: (): void => {
      failNext = true;
    },
    wrap: (port: AgentActionLimitsPort): AgentActionLimitsPort => ({
      reserve: async (request): Promise<AgentActionLimitReservation> => {
        const reservation = await port.reserve(request);
        if (!reservation.ok) return reservation;
        return {
          ok: true,
          ownerAttemptId: reservation.ownerAttemptId,
          commit: (): Promise<void> => {
            if (failNext) {
              failNext = false;
              return Promise.reject(
                new Error('The limits store did not record the commit.'),
              );
            }
            return reservation.commit();
          },
          markUncertain: () => reservation.markUncertain(),
          release: () => reservation.release(),
        };
      },
    }),
  };
}
