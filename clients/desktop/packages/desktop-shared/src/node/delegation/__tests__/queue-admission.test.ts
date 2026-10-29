import {
  DELEGATION_ADMISSION_LIMITS,
  createDelegationAdmissionController,
  type DelegationAdmissionBucket,
  type DelegationAdmissionControllerOptions,
  type DelegationAdmissionDecision,
  type DelegationAdmissionLease,
  type DelegationAdmissionTicket,
} from '../queue-admission';

interface AdmissionHarness {
  readonly controller: ReturnType<typeof createDelegationAdmissionController>;
  flush(): void;
  flushOne(): boolean;
}

const noOpGrant = (): void => {};

function makeBucket(chatId: string): DelegationAdmissionBucket {
  return { projectId: 'project', worktreeId: 'worktree', chatId };
}

function makeRequest(
  ticketId: string,
  bucket: DelegationAdmissionBucket,
  queuedAt: number,
  onGranted: (lease: DelegationAdmissionLease) => void = noOpGrant,
  workerId?: string,
): {
  readonly ticketId: string;
  readonly bucket: DelegationAdmissionBucket;
  readonly ifBusy: 'queue';
  readonly queuedAt: number;
  readonly workerId?: string;
  readonly onGranted: (lease: DelegationAdmissionLease) => void;
} {
  return {
    ticketId,
    bucket,
    ifBusy: 'queue',
    queuedAt,
    ...(workerId === undefined ? {} : { workerId }),
    onGranted,
  };
}

function createHarness(
  options: DelegationAdmissionControllerOptions = {},
): AdmissionHarness {
  const scheduled: Array<() => void> = [];
  const controller = createDelegationAdmissionController({
    ...options,
    schedule: (callback: () => void): void => {
      scheduled.push(callback);
    },
  });
  const flushOne = (): boolean => {
    const callback = scheduled.shift();
    if (!callback) return false;
    callback();
    return true;
  };
  const flush = (): void => {
    let iterations = 0;
    while (flushOne()) {
      iterations += 1;
      if (iterations > 2048)
        throw new Error('Admission scheduler did not settle');
    }
  };
  return { controller, flush, flushOne };
}

function grantedLease(
  decision: DelegationAdmissionDecision,
): DelegationAdmissionLease {
  if (decision.kind !== 'granted')
    throw new Error(`Expected a grant, got ${decision.kind}`);
  return decision.lease;
}

function waitingTicket(
  decision: DelegationAdmissionDecision,
): DelegationAdmissionTicket {
  if (decision.kind !== 'waiting')
    throw new Error(`Expected a waiter, got ${decision.kind}`);
  return decision.ticket;
}

describe('delegation queue admission', (): void => {
  it('grants immediately under the bucket and host limits', (): void => {
    const harness = createHarness({
      limitForBucket: (): number => 2,
      hostCapacity: (): number => 2,
    });
    const bucket = makeBucket('chat-a');
    const lease = grantedLease(
      harness.controller.request(makeRequest('first', bucket, 1)),
    );

    expect(harness.controller.activeCount).toBe(1);
    expect(harness.controller.waitingCount).toBe(0);
    expect(harness.controller.bucketState(bucket)).toEqual({
      running: 1,
      waiting: 0,
      limit: 2,
    });
    expect(harness.flushOne()).toBe(false);
    lease.release();
  });

  it('uses the 64-run ceiling and clamps bucket limits to 64', (): void => {
    const harness = createHarness({ limitForBucket: (): number => 100 });
    const bucket = makeBucket('chat-a');

    expect(DELEGATION_ADMISSION_LIMITS.hostCapacity).toBe(64);
    expect(harness.controller.bucketState(bucket).limit).toBe(64);
  });

  it('queues at the limit and grants waiters in FIFO order on release', (): void => {
    const harness = createHarness({ limitForBucket: (): number => 1 });
    const bucket = makeBucket('chat-a');
    const initial = grantedLease(
      harness.controller.request(makeRequest('initial', bucket, 1)),
    );
    const grants: string[] = [];
    const second = waitingTicket(
      harness.controller.request(
        makeRequest(
          'second',
          bucket,
          2,
          (lease: DelegationAdmissionLease): void => {
            grants.push(lease.ticketId);
          },
        ),
      ),
    );
    const third = waitingTicket(
      harness.controller.request(
        makeRequest(
          'third',
          bucket,
          3,
          (lease: DelegationAdmissionLease): void => {
            grants.push(lease.ticketId);
          },
        ),
      ),
    );

    initial.release();
    expect(grants).toEqual([]);
    harness.flush();
    expect(grants).toEqual(['second']);
    expect(second.position()).toBeUndefined();
    expect(third.position()).toEqual({ position: 1, waitingFor: 'queue' });
    expect(harness.controller.activeCount).toBe(1);
    expect(harness.controller.waitingCount).toBe(1);
  });

  it('rejects busy work without creating a ticket', (): void => {
    const harness = createHarness({ limitForBucket: (): number => 1 });
    const bucket = makeBucket('chat-a');
    const lease = grantedLease(
      harness.controller.request(makeRequest('initial', bucket, 1)),
    );
    const decision = harness.controller.request({
      ...makeRequest('rejected', bucket, 2),
      ifBusy: 'reject',
    });

    expect(decision).toEqual({ kind: 'rejected', reason: 'busy' });
    expect(harness.controller.waitingCount).toBe(0);
    lease.release();
  });

  it('enforces queue limits per bucket and per application', (): void => {
    const perBucket = createHarness({ limitForBucket: (): number => 1 });
    const bucket = makeBucket('bucket-limit');
    const active = grantedLease(
      perBucket.controller.request(makeRequest('bucket-active', bucket, 0)),
    );
    for (let index = 0; index < 128; index += 1) {
      const decision = perBucket.controller.request(
        makeRequest(`bucket-waiter-${index}`, bucket, index + 1),
      );
      expect(decision.kind).toBe('waiting');
    }
    expect(
      perBucket.controller.request(makeRequest('bucket-overflow', bucket, 200)),
    ).toEqual({ kind: 'rejected', reason: 'queue_full' });
    active.release();

    const perApplication = createHarness({
      limitForBucket: (): number => 1,
      hostCapacity: (): number => 5,
    });
    const applicationBuckets: DelegationAdmissionBucket[] = [];
    for (let index = 0; index < 5; index += 1) {
      applicationBuckets.push(makeBucket(`application-${index}`));
    }
    const activeLeases: DelegationAdmissionLease[] = [];
    for (let index = 0; index < applicationBuckets.length; index += 1) {
      const currentBucket = applicationBuckets[index];
      if (!currentBucket) throw new Error('Missing test bucket');
      activeLeases.push(
        grantedLease(
          perApplication.controller.request(
            makeRequest(`application-active-${index}`, currentBucket, index),
          ),
        ),
      );
    }
    for (let bucketIndex = 0; bucketIndex < 4; bucketIndex += 1) {
      const currentBucket = applicationBuckets[bucketIndex];
      if (!currentBucket) throw new Error('Missing test bucket');
      for (let index = 0; index < 128; index += 1) {
        const decision = perApplication.controller.request(
          makeRequest(
            `application-waiter-${bucketIndex}-${index}`,
            currentBucket,
            index + 1,
          ),
        );
        expect(decision.kind).toBe('waiting');
      }
    }
    const finalBucket = applicationBuckets[4];
    if (!finalBucket) throw new Error('Missing test bucket');
    expect(
      perApplication.controller.request(
        makeRequest('application-overflow', finalBucket, 600),
      ),
    ).toEqual({ kind: 'rejected', reason: 'queue_full' });
    expect(perApplication.controller.waitingCount).toBe(512);
    for (const lease of activeLeases) lease.release();
  });

  it('gives a freed host slot to the oldest eligible waiter across buckets', (): void => {
    const harness = createHarness({
      limitForBucket: (): number => 5,
      hostCapacity: (): number => 1,
    });
    const firstBucket = makeBucket('first');
    const olderBucket = makeBucket('older');
    const newerBucket = makeBucket('newer');
    const active = grantedLease(
      harness.controller.request(
        makeRequest('host-active', firstBucket, 0, noOpGrant, 'worker-a'),
      ),
    );
    const grants: string[] = [];
    waitingTicket(
      harness.controller.request(
        makeRequest(
          'newer-waiter',
          newerBucket,
          20,
          (lease: DelegationAdmissionLease): void => {
            grants.push(lease.ticketId);
          },
          'worker-a',
        ),
      ),
    );
    waitingTicket(
      harness.controller.request(
        makeRequest(
          'older-waiter',
          olderBucket,
          10,
          (lease: DelegationAdmissionLease): void => {
            grants.push(lease.ticketId);
          },
          'worker-a',
        ),
      ),
    );

    active.release();
    harness.flush();
    expect(grants).toEqual(['older-waiter']);
  });

  it('does not let a full bucket block immediate work in another bucket', (): void => {
    const harness = createHarness({
      limitForBucket: (): number => 1,
      hostCapacity: (): number => 4,
    });
    const fullBucket = makeBucket('full');
    const otherBucket = makeBucket('other');
    const first = grantedLease(
      harness.controller.request(makeRequest('full-active', fullBucket, 1)),
    );
    waitingTicket(
      harness.controller.request(makeRequest('full-waiter', fullBucket, 2)),
    );
    const other = harness.controller.request(
      makeRequest('other-active', otherBucket, 3),
    );

    expect(other.kind).toBe('granted');
    first.release();
    grantedLease(other).release();
  });

  it('removes cancelled waiters and updates later positions', (): void => {
    const harness = createHarness({ limitForBucket: (): number => 1 });
    const bucket = makeBucket('chat-a');
    const active = grantedLease(
      harness.controller.request(makeRequest('active', bucket, 0)),
    );
    waitingTicket(harness.controller.request(makeRequest('one', bucket, 1)));
    const two = waitingTicket(
      harness.controller.request(makeRequest('two', bucket, 2)),
    );
    const three = waitingTicket(
      harness.controller.request(makeRequest('three', bucket, 3)),
    );

    expect(three.position()).toEqual({ position: 3, waitingFor: 'queue' });
    two.cancel();
    two.cancel();
    expect(harness.controller.waitingCount).toBe(2);
    expect(two.position()).toBeUndefined();
    expect(three.position()).toEqual({ position: 2, waitingFor: 'queue' });
    active.release();
    harness.flush();
  });

  it('reports queue position within a full bucket and app position across buckets', (): void => {
    const harness = createHarness({
      limitForBucket: (): number => 1,
      hostCapacity: (): number => 1,
    });
    const activeBucket = makeBucket('active');
    const appBucket = makeBucket('app');
    const otherAppBucket = makeBucket('other-app');
    const active = grantedLease(
      harness.controller.request(
        makeRequest('active', activeBucket, 0, noOpGrant, 'worker-a'),
      ),
    );
    const queuePosition = waitingTicket(
      harness.controller.request(
        makeRequest('same-bucket', activeBucket, 5, noOpGrant, 'worker-a'),
      ),
    );
    const appPosition = waitingTicket(
      harness.controller.request(
        makeRequest('app-waiter', appBucket, 20, noOpGrant, 'worker-a'),
      ),
    );
    const earlierAppPosition = waitingTicket(
      harness.controller.request(
        makeRequest(
          'earlier-app-waiter',
          otherAppBucket,
          10,
          noOpGrant,
          'worker-a',
        ),
      ),
    );

    expect(queuePosition.position()).toEqual({
      position: 1,
      waitingFor: 'queue',
    });
    expect(earlierAppPosition.position()).toEqual({
      position: 1,
      waitingFor: 'app',
    });
    expect(appPosition.position()).toEqual({
      position: 2,
      waitingFor: 'app',
    });
    active.release();
    harness.flush();
  });

  it('transfers a lease without releasing its slot when within the bucket limit', (): void => {
    const harness = createHarness({ limitForBucket: (): number => 2 });
    const bucket = makeBucket('chat-a');
    const oldLease = grantedLease(
      harness.controller.request(makeRequest('old', bucket, 1)),
    );
    const transfer = oldLease.transfer({
      ticketId: 'next',
      queuedAt: 2,
      onGranted: noOpGrant,
    });
    const newLease = grantedLease(transfer);

    expect(newLease.ticketId).toBe('next');
    expect(harness.controller.activeCount).toBe(1);
    expect(harness.controller.bucketState(bucket).running).toBe(1);
    oldLease.release();
    expect(harness.controller.activeCount).toBe(1);
    newLease.release();
    expect(harness.controller.activeCount).toBe(0);
  });

  it('releases a transferred lease and queues the next run when the limit dropped', (): void => {
    let limit = 2;
    const harness = createHarness({ limitForBucket: (): number => limit });
    const bucket = makeBucket('chat-a');
    const oldLease = grantedLease(
      harness.controller.request(makeRequest('old', bucket, 1)),
    );
    const otherLease = grantedLease(
      harness.controller.request(makeRequest('other', bucket, 2)),
    );
    let queuedLease: DelegationAdmissionLease | undefined;
    limit = 1;
    const transfer = oldLease.transfer({
      ticketId: 'next',
      queuedAt: 3,
      onGranted: (lease: DelegationAdmissionLease): void => {
        queuedLease = lease;
      },
    });

    expect(transfer.kind).toBe('waiting');
    expect(harness.controller.bucketState(bucket)).toEqual({
      running: 1,
      waiting: 1,
      limit: 1,
    });
    expect(harness.controller.activeCount).toBe(1);
    otherLease.release();
    harness.flush();
    if (!queuedLease) throw new Error('Transferred waiter was not granted');
    queuedLease.release();
  });

  it('grants queued work after a limit is raised and refreshed', (): void => {
    let limit = 1;
    const harness = createHarness({ limitForBucket: (): number => limit });
    const bucket = makeBucket('chat-a');
    const active = grantedLease(
      harness.controller.request(makeRequest('active', bucket, 1)),
    );
    const grants: string[] = [];
    waitingTicket(
      harness.controller.request(
        makeRequest(
          'waiter',
          bucket,
          2,
          (lease: DelegationAdmissionLease): void => {
            grants.push(lease.ticketId);
          },
        ),
      ),
    );
    limit = 2;
    harness.controller.refresh();
    harness.flush();

    expect(grants).toEqual(['waiter']);
    expect(harness.controller.bucketState(bucket).running).toBe(2);
    active.release();
  });

  it('does not preempt active leases when a limit is lowered', (): void => {
    let limit = 2;
    const harness = createHarness({ limitForBucket: (): number => limit });
    const bucket = makeBucket('chat-a');
    const first = grantedLease(
      harness.controller.request(makeRequest('first', bucket, 1)),
    );
    const second = grantedLease(
      harness.controller.request(makeRequest('second', bucket, 2)),
    );
    limit = 1;
    harness.controller.refresh();
    harness.flush();

    expect(harness.controller.activeCount).toBe(2);
    expect(harness.controller.bucketState(bucket).running).toBe(2);
    first.release();
    second.release();
  });

  it('makes release and cancel idempotent, including release inside onGranted', (): void => {
    const harness = createHarness({ limitForBucket: (): number => 1 });
    const bucket = makeBucket('chat-a');
    const active = grantedLease(
      harness.controller.request(makeRequest('active', bucket, 1)),
    );
    const cancelled = waitingTicket(
      harness.controller.request(makeRequest('cancelled', bucket, 2)),
    );
    cancelled.cancel();
    cancelled.cancel();
    active.release();
    active.release();
    harness.flush();
    expect(harness.controller.activeCount).toBe(0);
    expect(harness.controller.waitingCount).toBe(0);

    const secondHarness = createHarness({ limitForBucket: (): number => 1 });
    const secondActive = grantedLease(
      secondHarness.controller.request(makeRequest('initial', bucket, 1)),
    );
    const followUp: DelegationAdmissionTicket = waitingTicket(
      secondHarness.controller.request(
        makeRequest(
          'follow-up',
          bucket,
          2,
          (lease: DelegationAdmissionLease): void => {
            lease.release();
            lease.release();
            followUp.cancel();
            followUp.cancel();
          },
        ),
      ),
    );
    secondActive.release();
    secondHarness.flush();
    expect(followUp.position()).toBeUndefined();
    expect(secondHarness.controller.activeCount).toBe(0);
  });

  it('never invokes a grant callback re-entrantly', async (): Promise<void> => {
    let insideRelease = false;
    let wasReentrant: boolean | undefined;
    const controller = createDelegationAdmissionController({
      limitForBucket: (): number => 1,
      schedule: (callback: () => void): void => callback(),
    });
    const bucket = makeBucket('chat-a');
    const active = grantedLease(
      controller.request(makeRequest('active', bucket, 1)),
    );
    controller.request(
      makeRequest('waiting', bucket, 2, (): void => {
        wasReentrant = insideRelease;
      }),
    );
    insideRelease = true;
    active.release();
    insideRelease = false;
    await Promise.resolve();
    await Promise.resolve();

    expect(wasReentrant).toBe(false);
  });

  it('throws when a ticket id is already waiting or held', (): void => {
    const harness = createHarness({ limitForBucket: (): number => 1 });
    const bucket = makeBucket('chat-a');
    const active = grantedLease(
      harness.controller.request(makeRequest('duplicate', bucket, 1)),
    );
    expect(
      (): DelegationAdmissionDecision =>
        harness.controller.request(makeRequest('duplicate', bucket, 2)),
    ).toThrow('Duplicate admission ticket: duplicate');
    const transfer = active.transfer({
      ticketId: 'transferred',
      queuedAt: 2,
      onGranted: noOpGrant,
    });
    const nextLease = grantedLease(transfer);
    expect(
      (): DelegationAdmissionDecision =>
        harness.controller.request(makeRequest('transferred', bucket, 3)),
    ).toThrow('Duplicate admission ticket: transferred');
    nextLease.release();

    const secondActive = grantedLease(
      harness.controller.request(makeRequest('second-active', bucket, 4)),
    );
    waitingTicket(
      harness.controller.request(makeRequest('waiting-id', bucket, 5)),
    );
    expect(
      (): DelegationAdmissionDecision =>
        harness.controller.request(makeRequest('waiting-id', bucket, 6)),
    ).toThrow('Duplicate admission ticket: waiting-id');
    secondActive.release();
    harness.flush();
  });
});
