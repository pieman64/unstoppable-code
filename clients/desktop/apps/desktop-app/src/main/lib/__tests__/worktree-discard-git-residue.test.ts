import {
  gitCleanupOutcomeOf,
  gitCleanupRuns,
  gitCleanupWarning,
  gitResidueAfter,
  gitResidueOf,
  predictedGitCleanupFacts,
  publicGitCleanupStatus,
  type GitCleanupFacts,
  type GitCleanupOutcome,
  type GitRefEvidence,
  type GitResidue,
  type GitSourceObservation,
} from '../worktree-discard-git-residue';

const EVIDENCE: readonly [string, GitRefEvidence][] = [
  ['read, naming its ref', { state: 'read', repoIds: ['r'] }],
  ['read, naming none for it', { state: 'read', repoIds: ['other'] }],
  ['absent', { state: 'absent' }],
  ['unreadable', { state: 'unknown' }],
];
const PHASES = [
  'fresh',
  'interrupted before the Git cleanup',
  'interrupted after the Git cleanup',
  'interrupted after the recovery data was removed',
] as const;
/** What happens at run time, which no description can predict. */
const RUNTIME = [
  'ok',
  'the registration removal fails',
  'a ref deletion fails',
  'a registration remains after the removal',
] as const;

/** The world one source `r` is in: what a look shows, and what Git then does. */
interface Cell {
  label: string;
  evidence: GitRefEvidence;
  /** Available at its classified Git common directory. */
  reachable: boolean;
  /** The descriptor's recorded repository is the one at the source now. */
  recordedHere: boolean;
  /** This repository holds Git's entry for the worktree's checkout path. */
  registered: boolean;
  /** Its named ref was moved to another commit. */
  refMoved: boolean;
  /** Its named ref is not this worktree's snapshot ref, e.g. a branch (review r8). */
  refForeign: boolean;
  /** A read-only Git command fails, for the description and the cleanup alike. */
  lookFails: boolean;
  runtime: (typeof RUNTIME)[number];
  phase: (typeof PHASES)[number];
}

const refsNamedBy = (evidence: GitRefEvidence): number =>
  evidence.state === 'read' && evidence.repoIds.includes('r') ? 1 : 0;

const CELLS: Cell[] = EVIDENCE.flatMap(([evidenceLabel, evidence]) => {
  const named = refsNamedBy(evidence) > 0;
  return [true, false].flatMap((reachable) =>
    (named && reachable ? [true, false] : [true]).flatMap((recordedHere) =>
      (named && reachable && recordedHere ? [false, true] : [false]).flatMap(
        (refMoved) =>
          (named && reachable && recordedHere && !refMoved
            ? [false, true]
            : [false]
          ).flatMap((refForeign) =>
            (reachable ? [false, true] : [false]).flatMap((lookFails) =>
              (reachable && !lookFails ? [true, false] : [false]).flatMap(
                (registered) =>
                  (reachable && recordedHere && !lookFails
                    ? RUNTIME
                    : ['ok' as const]
                  )
                    .filter(
                      (runtime) =>
                        ((named && !refForeign) ||
                          runtime !== 'a ref deletion fails') &&
                        (registered ||
                          runtime !==
                            'a registration remains after the removal'),
                    )
                    .flatMap((runtime) =>
                      PHASES.map((phase) => ({
                        label: [
                          evidenceLabel,
                          reachable ? 'available' : 'unavailable',
                          ...(recordedHere
                            ? []
                            : ['another repository recorded']),
                          ...(reachable && !lookFails && !registered
                            ? ['no registration here']
                            : []),
                          ...(refMoved ? ['its ref moved'] : []),
                          ...(refForeign ? ['its ref is not its own'] : []),
                          ...(lookFails ? ['Git fails while looking'] : []),
                          ...(runtime === 'ok' ? [] : [runtime]),
                          phase,
                        ].join(' × '),
                        evidence,
                        reachable,
                        recordedHere,
                        registered,
                        refMoved,
                        refForeign,
                        lookFails,
                        runtime,
                        phase,
                      })),
                    ),
              ),
            ),
          ),
      ),
    ),
  );
});

/** What `observeGitSource` reports for the cell. */
function observe(cell: Cell): GitSourceObservation {
  const refsNamed = refsNamedBy(cell.evidence);
  // A name comparison, made before any Git read.
  const refsForeign = cell.refForeign ? refsNamed : 0;
  if (!cell.reachable)
    return {
      reachable: false,
      recordedHere: true,
      registered: false,
      refsNamed,
      refsForeign,
      refsDeletable: 0,
      gitFailed: false,
    };
  if (cell.lookFails)
    return {
      reachable: true,
      recordedHere: true,
      registered: false,
      refsNamed,
      refsForeign,
      refsDeletable: 0,
      gitFailed: true,
    };
  return {
    reachable: true,
    recordedHere: cell.recordedHere,
    registered: cell.registered,
    refsNamed,
    refsForeign,
    refsDeletable: cell.refMoved || cell.refForeign ? 0 : refsNamed,
    gitFailed: false,
  };
}

/** What `cleanUpGitMetadata` collects for the cell, step by step. */
function execute(cell: Cell): GitCleanupFacts {
  const observed = observe(cell);
  const { refsDeletable: _refsDeletable, ...seen } = observed;
  void _refsDeletable;
  const facts: GitCleanupFacts = {
    ...seen,
    registrationsRemoved: false,
    refsDeleted: 0,
  };
  if (!gitCleanupRuns(observed)) return facts;
  if (cell.runtime === 'the registration removal fails') {
    facts.gitFailed = true;
    return facts;
  }
  facts.registrationsRemoved =
    cell.runtime !== 'a registration remains after the removal';
  // Only the worktree's own refs are deleted; a foreign one is never touched.
  for (let ref = 0; ref < observed.refsNamed - observed.refsForeign; ref++) {
    // A moved ref is never deleted: the deletion refuses an unexpected object.
    if (cell.refMoved || cell.runtime === 'a ref deletion fails') {
      facts.gitFailed = true;
      return facts;
    }
    facts.refsDeleted += 1;
  }
  return facts;
}

/**
 * What physically remains, stated from the world, not the model: the
 * registration unless it was removed where it is, and a ref the descriptor
 * may name unless it was deleted there. An unreadable descriptor cannot say
 * which repository it recorded. With no registration here, it is gone if the
 * descriptor records this repository, and otherwise may be in a repository
 * moved away (round 7).
 */
function leftBehind(cell: Cell, facts: GitCleanupFacts): GitResidue[] {
  const knownHere =
    cell.evidence.state !== 'unknown' && cell.reachable && cell.recordedHere;
  const registrationGone =
    knownHere &&
    (cell.registered
      ? facts.registrationsRemoved
      : refsNamedBy(cell.evidence) > 0 && !cell.refForeign);
  const mayNameRef =
    cell.evidence.state === 'unknown' || refsNamedBy(cell.evidence) > 0;
  const refsGone =
    cell.evidence.state !== 'unknown' &&
    cell.reachable &&
    cell.recordedHere &&
    !cell.refForeign &&
    facts.refsDeleted === refsNamedBy(cell.evidence);
  return [
    ...(registrationGone
      ? []
      : [{ kind: 'git-registration' as const, repoId: 'r' }]),
    ...(mayNameRef && !refsGone
      ? [{ kind: 'git-ref' as const, repoId: 'r' }]
      : []),
  ];
}

function play(cell: Cell): {
  description: GitResidue[];
  outcome: GitCleanupOutcome;
  facts: GitCleanupFacts;
} {
  const facts = execute(cell);
  const outcome = gitCleanupOutcomeOf(cell.evidence, facts);
  const predicted = [
    { repoId: 'r', facts: predictedGitCleanupFacts(observe(cell)) },
  ];
  const recorded = new Map([['r', outcome]]);
  const description =
    cell.phase === 'fresh' ||
    cell.phase === 'interrupted before the Git cleanup'
      ? gitResidueOf(predicted, cell.evidence)
      : gitResidueOf(
          predicted,
          cell.phase === 'interrupted after the recovery data was removed'
            ? { state: 'unknown' }
            : cell.evidence,
          recorded,
        );
  return { description, outcome, facts };
}

const key = (residue: GitResidue): string =>
  `${residue.kind}:${residue.repoId}`;

describe('CAN-5334 Git residue model', () => {
  it(`covers every cell (${CELLS.length})`, () => {
    // read naming r: available (here × ref kept or moved: 2 × (registered
    // 4 runtimes + unregistered 3 + Git fails looking 1); here × ref not its
    // own (review r8): registered 3 runtimes + unregistered 2 + Git fails
    // looking 1; elsewhere: registered or not + Git fails looking) +
    // unavailable = 26; the other three: available (registered 3 runtimes +
    // unregistered 2 + Git fails looking) + unavailable = 7 each. Each × 4
    // phases.
    expect(CELLS).toHaveLength((26 + 3 * 7) * 4);
  });

  it.each(CELLS.map((cell) => [cell.label, cell] as const))(
    '%s: the description never under-reports, and cleaned means its refs were deleted where recorded',
    (_label, cell) => {
      const { description, outcome, facts } = play(cell);
      const remains = leftBehind(cell, facts);
      const predictable =
        cell.runtime === 'ok' ||
        (cell.phase !== 'fresh' &&
          cell.phase !== 'interrupted before the Git cleanup');
      if (predictable)
        expect(description.map(key)).toEqual(
          expect.arrayContaining(remains.map(key)),
        );
      else
        expect(gitCleanupWarning(outcome, 'r')).toBe(
          'Git metadata cleanup for repository r did not finish; its registrations or refs may remain.',
        );
      // What a later description lists from the recorded outcome.
      expect(gitResidueAfter(outcome, cell.evidence, 'r').map(key)).toEqual(
        expect.arrayContaining(remains.map(key)),
      );
      if (publicGitCleanupStatus(outcome) === 'cleaned') {
        expect(cell.evidence.state).not.toBe('unknown');
        expect(facts).toMatchObject({
          reachable: true,
          recordedHere: true,
          registrationsRemoved: true,
          gitFailed: false,
          refsForeign: 0,
          refsDeleted: refsNamedBy(cell.evidence),
        });
        // Round 7: a recorded repository or an observed registration ties it.
        expect(facts.registered || refsNamedBy(cell.evidence) > 0).toBe(true);
        expect(remains).toEqual([]);
      }
      expect(gitCleanupWarning(outcome, 'r') !== null).toBe(
        publicGitCleanupStatus(outcome) === 'failed',
      );
    },
  );

  const look = (
    overrides: Partial<GitSourceObservation> = {},
  ): GitSourceObservation => ({
    reachable: true,
    recordedHere: true,
    registered: true,
    refsNamed: 1,
    refsForeign: 0,
    refsDeletable: 1,
    gitFailed: false,
    ...overrides,
  });

  it.each([
    [
      'review r4 finding 1 (round 6): an unreadable descriptor with an available source lists its registration and ref, and the result is failed',
      { state: 'unknown' } as const,
      look({ refsNamed: 0, refsDeletable: 0 }),
      [
        { kind: 'git-registration', repoId: 'r' },
        { kind: 'git-ref', repoId: 'r' },
      ],
      'failed',
    ],
    [
      'review r3 finding 2: an unreadable descriptor with an unavailable source lists its registration and ref',
      { state: 'unknown' } as const,
      look({ reachable: false, refsNamed: 0, refsDeletable: 0 }),
      [
        { kind: 'git-registration', repoId: 'r' },
        { kind: 'git-ref', repoId: 'r' },
      ],
      'skipped',
    ],
    [
      'a read descriptor with its recorded repository available lists nothing and is cleaned',
      { state: 'read', repoIds: ['r'] } as const,
      look(),
      [],
      'cleaned',
    ],
    [
      'round 6: another repository at the source lists the registration and ref of the recorded one, and is skipped',
      { state: 'read', repoIds: ['r'] } as const,
      look({ recordedHere: false }),
      [
        { kind: 'git-registration', repoId: 'r' },
        { kind: 'git-ref', repoId: 'r' },
      ],
      'skipped',
    ],
    [
      'round 6: a ref moved to another commit lists it and is failed',
      { state: 'read', repoIds: ['r'] } as const,
      look({ refsDeletable: 0 }),
      [
        { kind: 'git-registration', repoId: 'r' },
        { kind: 'git-ref', repoId: 'r' },
      ],
      'failed',
    ],
    [
      "review r8: a descriptor naming a ref that is not this worktree's (a branch) keeps and lists it, and is failed",
      { state: 'read', repoIds: ['r'] } as const,
      look({ refsForeign: 1, refsDeletable: 0 }),
      [
        { kind: 'git-registration', repoId: 'r' },
        { kind: 'git-ref', repoId: 'r' },
      ],
      'failed',
    ],
    [
      "review r8: a foreign ref beside the worktree's own is failed even when its own was deleted",
      { state: 'read', repoIds: ['r'] } as const,
      look({ refsNamed: 2, refsForeign: 1, refsDeletable: 1 }),
      [
        { kind: 'git-registration', repoId: 'r' },
        { kind: 'git-ref', repoId: 'r' },
      ],
      'failed',
    ],
    [
      'round 7: an absent descriptor with no registration at the source (another repository there) lists the registration and is skipped',
      { state: 'absent' } as const,
      look({ registered: false, refsNamed: 0, refsDeletable: 0 }),
      [{ kind: 'git-registration', repoId: 'r' }],
      'skipped',
    ],
    [
      'round 7: an absent descriptor with its registration observed at the source lists nothing and is cleaned',
      { state: 'absent' } as const,
      look({ refsNamed: 0, refsDeletable: 0 }),
      [],
      'cleaned',
    ],
    [
      'round 7: a descriptor recording no repository for the source, with no registration there, lists the registration and is skipped',
      { state: 'read', repoIds: ['other'] } as const,
      look({ registered: false, refsNamed: 0, refsDeletable: 0 }),
      [{ kind: 'git-registration', repoId: 'r' }],
      'skipped',
    ],
    [
      'an absent descriptor with an unavailable source lists only its registration',
      { state: 'absent' } as const,
      look({ reachable: false, refsNamed: 0, refsDeletable: 0 }),
      [{ kind: 'git-registration', repoId: 'r' }],
      'skipped',
    ],
  ] as const)('%s', (_label, evidence, observed, mayRemain, status) => {
    const facts = predictedGitCleanupFacts(observed);
    expect(gitResidueOf([{ repoId: 'r', facts }], evidence)).toEqual(mayRemain);
    // Review r3 finding 3: an unreadable descriptor is never reported cleaned.
    expect(publicGitCleanupStatus(gitCleanupOutcomeOf(evidence, facts))).toBe(
      status,
    );
  });

  it('review r8: a foreign ref is never cleaned, whatever the deletion count says', () => {
    const facts: GitCleanupFacts = {
      ...predictedGitCleanupFacts(look()),
      refsForeign: 1,
    };
    expect(facts.refsDeleted).toBe(facts.refsNamed);
    expect(gitCleanupOutcomeOf({ state: 'read', repoIds: ['r'] }, facts)).toBe(
      'failed',
    );
  });

  it('review r1 finding 2: a finished cleanup is described from its recorded outcomes; one it did not record counts as failed', () => {
    const recorded = new Map<string, GitCleanupOutcome>([
      ['cleaned', 'cleaned'],
      ['unlisted', 'refs-unlisted'],
    ]);
    const facts = predictedGitCleanupFacts(
      look({ refsNamed: 0, refsDeletable: 0 }),
    );
    expect(
      gitResidueOf(
        [
          { repoId: 'cleaned', facts },
          { repoId: 'unlisted', facts },
          { repoId: 'unrecorded', facts },
        ],
        { state: 'read', repoIds: [] },
        recorded,
      ),
    ).toEqual([
      { kind: 'git-registration', repoId: 'unlisted' },
      { kind: 'git-ref', repoId: 'unlisted' },
      { kind: 'git-registration', repoId: 'unrecorded' },
    ]);
  });
});
