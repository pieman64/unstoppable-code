/// Synthetic Portal PR `get_actions` payloads with per-check CI rows
/// (CAN-3618). Names, numbers and URLs are fixed and fake; the shapes mirror
/// `PortalPullRequestRepoStatus.checkDetails` as the desktop sends them, in
/// the desktop's name order.
library;

const prChecksJobUrl = 'https://github.com/acme/app/actions/runs/7/job/';

Map<String, dynamic> prCheckDetail(
  String name, {
  required String status,
  String? executionState,
  Object? detailsUrl = '',
}) => {
  'name': name,
  'status': status,
  'executionState': ?executionState,
  'detailsUrl': detailsUrl == '' ? '$prChecksJobUrl$name' : detailsUrl,
};

/// One check in each of the nine detailed states; exactly one succeeded.
List<Map<String, dynamic>> nineStatePrChecks() => [
  prCheckDetail(
    'a11y-audit',
    status: 'neutral',
    executionState: 'action_required',
  ),
  prCheckDetail('build-android', status: 'pending', executionState: 'running'),
  prCheckDetail('build-ios', status: 'pending', executionState: 'queued'),
  prCheckDetail('deploy-preview', status: 'neutral', executionState: 'skipped'),
  prCheckDetail('e2e', status: 'failure', executionState: 'timed_out'),
  prCheckDetail('license-scan', status: 'neutral', executionState: 'neutral'),
  prCheckDetail('lint', status: 'success', executionState: 'success'),
  prCheckDetail('typecheck', status: 'failure', executionState: 'cancelled'),
  prCheckDetail('unit-tests', status: 'failure', executionState: 'failure'),
];

/// Everything passed or was neutral: the list starts collapsed.
List<Map<String, dynamic>> settledPrChecks() => [
  prCheckDetail('build', status: 'success', executionState: 'success'),
  prCheckDetail('docs', status: 'neutral', executionState: 'skipped'),
  prCheckDetail('lint', status: 'success', executionState: 'success'),
  prCheckDetail('unit-tests', status: 'success', executionState: 'success'),
];

/// An older desktop: four coarse statuses only, one row without a link.
List<Map<String, dynamic>> legacyPrChecks() => [
  prCheckDetail('build', status: 'success'),
  prCheckDetail('coverage', status: 'neutral', detailsUrl: null),
  prCheckDetail('lint', status: 'pending'),
  prCheckDetail('tests', status: 'failure'),
];

Map<String, dynamic> prChecksRepo({
  String repoId = 'repo-app',
  String repoName = 'App',
  int number = 42,
  String checkStatus = 'failing',
  String title = 'Show CI checks on the phone',
  Object? checks,
  String? reviewStatus,
}) => {
  'repoId': repoId,
  'repoName': repoName,
  'canCreate': false,
  'canMerge': false,
  'baseBranch': 'develop',
  'headBranch': 'feature',
  'status': {
    'number': number,
    'state': 'open',
    'url':
        'https://github.com/acme/${repoId.replaceFirst('repo-', '')}/pull/'
        '$number',
    'title': title,
    'checkStatus': checkStatus,
    'checkDetails': ?checks,
    'reviewStatus': ?reviewStatus,
  },
};

Map<String, dynamic> prChecksState(List<Map<String, dynamic>> repos) => {
  'busy': false,
  'repos': repos,
};
