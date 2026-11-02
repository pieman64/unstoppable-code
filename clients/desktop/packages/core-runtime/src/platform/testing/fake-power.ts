import type {
  PlatformPowerAcquireResult,
  PlatformPowerAssertion,
  PlatformPowerAssertionEnd,
  PlatformPowerMechanism,
  PlatformPowerServices,
} from '../platform-services';

/** How the fake answers the next `preventSystemSleep`. */
export type FakePowerOutcome =
  | 'held'
  | 'pending'
  | 'unavailable'
  | 'failed'
  | 'throws';

export interface FakePowerAssertion extends PlatformPowerAssertion {
  readonly reason: string;
  /** A pending assertion becomes held. */
  hold(): void;
  /** Ends it as the OS would without a release request. */
  lose(reason: string): void;
  /** Makes the next `release` throw without releasing. */
  refuseNextRelease(message: string): void;
  /** Makes the next `release` reject later, still held. */
  failNextRelease(message: string): void;
  /** Makes the next `release` stay pending, still held, until `settleRelease`. */
  holdNextRelease(): void;
  settleRelease(): void;
  readonly state: 'pending' | 'held' | 'released' | 'lost';
}

export interface FakePlatformPowerServices extends PlatformPowerServices {
  /** Every acquired assertion, in request order. */
  readonly assertions: readonly FakePowerAssertion[];
  /** Assertions still pending or held. */
  live(): FakePowerAssertion[];
  /** Answers for later requests, consumed in order; `held` once empty. */
  readonly outcomes: FakePowerOutcome[];
}

/** An in-memory power backend for policy and composition tests. */
export function createFakePlatformPowerServices(
  mechanism: PlatformPowerMechanism = 'power-assertion',
): FakePlatformPowerServices {
  const assertions: FakePowerAssertion[] = [];
  const outcomes: FakePowerOutcome[] = [];
  let nextId = 1;

  function create(reason: string, held: boolean): FakePowerAssertion {
    let state: FakePowerAssertion['state'] = held ? 'held' : 'pending';
    let settleHeld: (held: boolean) => void = () => undefined;
    let settleEnded: (end: PlatformPowerAssertionEnd) => void = () => undefined;
    let refusal: string | null = null;
    let failure: string | null = null;
    let holdRelease = false;
    let settlePending: () => void = () => undefined;
    const heldPromise = new Promise<boolean>((resolve) => {
      settleHeld = resolve;
    });
    const ended = new Promise<PlatformPowerAssertionEnd>((resolve) => {
      settleEnded = resolve;
    });
    if (held) settleHeld(true);
    const finish = (end: PlatformPowerAssertionEnd): void => {
      if (state === 'released' || state === 'lost') return;
      state = end.kind;
      settleHeld(false);
      settleEnded(end);
    };
    return {
      id: nextId++,
      reason,
      get state(): FakePowerAssertion['state'] {
        return state;
      },
      held: heldPromise,
      ended,
      isHeld: () => state === 'held',
      hold: (): void => {
        if (state !== 'pending') return;
        state = 'held';
        settleHeld(true);
      },
      lose: (lost): void => finish({ kind: 'lost', reason: lost }),
      refuseNextRelease: (message): void => {
        refusal = message;
      },
      failNextRelease: (message): void => {
        failure = message;
      },
      holdNextRelease: (): void => {
        holdRelease = true;
      },
      settleRelease: (): void => settlePending(),
      release: (): Promise<void> => {
        if (refusal !== null) {
          const message = refusal;
          refusal = null;
          throw new Error(message);
        }
        if (failure !== null) {
          const message = failure;
          failure = null;
          return Promise.reject(new Error(message));
        }
        if (holdRelease) {
          holdRelease = false;
          return new Promise<void>((resolve) => {
            settlePending = (): void => {
              finish({ kind: 'released' });
              resolve();
            };
          });
        }
        finish({ kind: 'released' });
        return Promise.resolve();
      },
    };
  }

  return {
    mechanism,
    assertions,
    outcomes,
    live: () =>
      assertions.filter(({ state }) => state === 'held' || state === 'pending'),
    preventSystemSleep: ({ reason }): PlatformPowerAcquireResult => {
      const outcome = outcomes.shift() ?? 'held';
      if (outcome === 'throws') throw new Error('power request refused');
      if (outcome === 'unavailable')
        return { kind: 'unavailable', reason: 'power unavailable' };
      if (outcome === 'failed')
        return { kind: 'failed', reason: 'power request failed' };
      const assertion = create(reason, outcome === 'held');
      assertions.push(assertion);
      return { kind: 'acquired', assertion };
    },
  };
}
