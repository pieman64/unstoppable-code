import 'package:mobile/data/models/remote_session.dart';

// Synthetic GitHub merge queue data for CAN-4454 (no desktop, GitHub or
// network). Rows use the Portal's `lastKnownPrStatus` wire shape, so the
// same fixtures render on builds that do not read `mergeQueue`.

const mergeQueueWorkspaceId = 'ws-queue';

String mergeQueuePrUrl(int number, {String repo = 'app'}) =>
    'https://github.com/acme/$repo/pull/$number';

/// One `lastKnownPrStatus.repos[]` entry.
Map<String, dynamic> mergeQueueRepo(
  int number, {
  String repoId = 'repo-app',
  String repo = 'app',
  String state = 'open',
  String checkStatus = 'passing',
  Map<String, dynamic>? mergeQueue,
}) => {
  'repoId': repoId,
  'repoName': repo,
  'status': {
    'prNumber': number,
    'prUrl': mergeQueuePrUrl(number, repo: repo),
    'state': state,
    'title': 'Show merge queue state',
    'checkStatus': checkStatus,
    'mergeQueue': ?mergeQueue,
  },
};

Map<String, dynamic> queued({int? position, String? phase}) => {
  'inQueue': true,
  'position': position,
  'phase': ?phase,
};

RemoteWorktree mergeQueueWorktree(
  String localId,
  List<Map<String, dynamic>> repos, {
  bool mergingPr = false,
  String? mergePrPhase,
}) => RemoteWorktree.fromJson({
  'localId': localId,
  'workspaceLocalId': mergeQueueWorkspaceId,
  'branch': 'feature/$localId',
  'mergingPr': mergingPr,
  'mergePrPhase': ?mergePrPhase,
  'lastKnownPrStatus': {
    'repos': repos,
    'lastCheckedAt': '2026-10-19T08:00:00Z',
  },
});

/// Every row state the capture specs show, top to bottom.
List<RemoteWorktree> mergeQueueCaptureRows() => [
  mergeQueueWorktree('koala', [
    mergeQueueRepo(
      4454,
      mergeQueue: queued(position: 2, phase: 'awaiting_checks'),
    ),
  ]),
  mergeQueueWorktree('otter', [mergeQueueRepo(4460, mergeQueue: queued())]),
  for (final (id, phase, number) in const [
    ('heron', 'queued', 4461),
    ('lynx', 'mergeable', 4462),
    ('marten', 'locked', 4463),
    ('newt', 'unmergeable', 4464),
    ('quail', 'future_state', 4465),
  ])
    mergeQueueWorktree(id, [
      mergeQueueRepo(number, mergeQueue: queued(position: 1, phase: phase)),
    ]),
  mergeQueueWorktree('plain', [
    mergeQueueRepo(4466, mergeQueue: const {'inQueue': false}),
  ]),
  mergeQueueWorktree('done', [
    mergeQueueRepo(4467, state: 'merged', mergeQueue: queued(position: 1)),
  ]),
  mergeQueueWorktree('shut', [
    mergeQueueRepo(4468, state: 'closed', mergeQueue: queued(position: 1)),
  ]),
  mergeQueueWorktree('split', [
    mergeQueueRepo(4469, mergeQueue: queued(position: 1)),
    mergeQueueRepo(18, repoId: 'repo-web', repo: 'web'),
  ]),
  mergeQueueWorktree('pair', [
    mergeQueueRepo(4470, mergeQueue: queued(position: 1)),
    mergeQueueRepo(
      19,
      repoId: 'repo-web',
      repo: 'web',
      mergeQueue: queued(position: 3),
    ),
  ]),
  mergeQueueWorktree(
    'busy',
    [mergeQueueRepo(4471, mergeQueue: queued(position: 1))],
    mergingPr: true,
    mergePrPhase: 'merging',
  ),
];

/// A two-repository worktree: `app` is queued, `web` is open and mergeable.
RemoteWorktree mergeQueueDrawerWorktree() => mergeQueueWorktree('koala', [
  mergeQueueRepo(
    4454,
    mergeQueue: queued(position: 2, phase: 'awaiting_checks'),
  ),
  mergeQueueRepo(4455, repoId: 'repo-web', repo: 'web'),
]);

/// The drawer's `get_actions` answer for [mergeQueueDrawerWorktree]. Action
/// statuses carry no queue fields; the desktop still offers Merge for both.
Map<String, dynamic> mergeQueuePrState() => {
  'busy': false,
  'repos': [
    for (final (repoId, repo, number) in const [
      ('repo-app', 'app', 4454),
      ('repo-web', 'web', 4455),
    ])
      {
        'repoId': repoId,
        'repoName': repo,
        'canCreate': false,
        'canMerge': true,
        'baseBranch': 'develop',
        'headBranch': 'feature/koala',
        'status': {
          'number': number,
          'url': mergeQueuePrUrl(number, repo: repo),
          'state': 'open',
          'title': 'Show merge queue state',
          'checkStatus': 'passing',
        },
      },
  ],
};
