// Mobile PR actions: deterministic Activity drawer evidence, no network.
// Run PR_ACTIONS_STAGE=before/after flutter test tool/pr_actions/capture_test.dart
// --update-goldens from apps/mobile. Both color modes are captured together.
//
// `blocked-create`, `blocked-merge` and `unsupported` cover CAN-2982's
// unavailable states; they have no `before` counterpart because the earlier
// build rendered nothing at all for them.
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/views/widgets/activity_sidebar.dart';

void main() {
  final stage = Platform.environment['PR_ACTIONS_STAGE'] == 'before'
      ? 'before'
      : 'after';
  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final dark in [false, true]) {
    for (final scenario in [
      'none',
      'open',
      'merged',
      'closed',
      'draft',
      'confirmation',
      'blocked-create',
      'blocked-merge',
      'unsupported',
    ]) {
      testWidgets('$scenario ${dark ? 'dark' : 'light'}', (tester) async {
        final state = switch (scenario) {
          'blocked-create' || 'unsupported' => 'none',
          'blocked-merge' || 'confirmation' => 'open',
          _ => scenario,
        };
        final canCreate = state == 'none' && scenario != 'blocked-create';
        final canMerge = state == 'open' && scenario != 'blocked-merge';
        final createBlockedReason = switch (scenario) {
          'blocked-create' => 'no_changes',
          _ => state == 'none' ? null : 'pr_open',
        };
        final mergeBlockedReason = switch (scenario) {
          'blocked-merge' => 'checks_failing',
          'draft' => 'draft',
          _ => state == 'open' ? null : 'no_pr',
        };
        final RemotePrActionRunner? runner = scenario == 'unsupported'
            ? null
            : (
                action, {
                repoId,
                identity,
                confirmUnresolvedComments = false,
              }) async {
                if (scenario == 'confirmation' &&
                    action == RemotePrAction.merge &&
                    !confirmUnresolvedComments) {
                  return {
                    'requiresUnresolvedConfirmation': [
                      {'repoId': repoId},
                    ],
                  };
                }
                return {
                  'busy': false,
                  'repos': [
                    {
                      'repoId': 'app',
                      'repoName': 'App',
                      'baseBranch': 'develop',
                      'headBranch': 'feature/mobile-pr',
                      'canCreate': canCreate,
                      'canMerge': canMerge,
                      'mergeWarning': scenario == 'confirmation',
                      'createBlockedReason': createBlockedReason,
                      'mergeBlockedReason': mergeBlockedReason,
                      'status': state == 'none'
                          ? null
                          : {
                              'number': 42,
                              'state': state,
                              'title': 'Add mobile PR actions',
                              'url': 'https://github.com/acme/repo/pull/42',
                              'checkStatus': scenario == 'blocked-merge'
                                  ? 'failing'
                                  : 'passing',
                              'reviewStatus': 'approved',
                              'unresolvedReviewThreadCount':
                                  scenario == 'confirmation' ? 2 : 0,
                            },
                    },
                  ],
                };
              };
        final cached = runner == null
            ? null
            : await runner(RemotePrAction.refresh);
        tester.view.physicalSize = const Size(390, 640);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: Scaffold(
              body: RepaintBoundary(
                key: const ValueKey('capture'),
                child: RemoteActivitySidebar(
                  worktree: RemoteWorktree(
                    localId: 'task',
                    workspaceLocalId: 'workspace',
                    branch: 'feature/mobile-pr',
                    prStatuses: [
                      if (state != 'none')
                        RemoteWorktreePr(
                          prNumber: 42,
                          state: state,
                          title: 'Add mobile PR actions',
                          checkStatus: scenario == 'blocked-merge'
                              ? 'failing'
                              : 'passing',
                          reviewStatus: 'approved',
                          unresolvedReviewThreadCount:
                              scenario == 'confirmation' ? 2 : 0,
                        ),
                    ],
                  ),
                  activity: const RemoteWorktreeActivity(),
                  runPrAction: runner,
                  cachedPrRepos: cached == null
                      ? null
                      : (cached['repos'] as List? ?? const [])
                            .whereType<Map<String, dynamic>>()
                            .map(RemotePrRepo.fromJson)
                            .toList(),
                  cachedPrBusy: cached?['busy'] == true,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        if (canCreate && scenario != 'unsupported') {
          expect(find.byKey(const ValueKey('create-pr-app')), findsOneWidget);
        }
        if (canMerge) {
          expect(find.byKey(const ValueKey('merge-pr-app')), findsOneWidget);
        }
        if (scenario == 'confirmation') {
          await tester.tap(find.byKey(const ValueKey('merge-pr-app')));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
          expect(find.text('Merge with unresolved comments?'), findsOneWidget);
        }
        Directory(
          '../../.playwright/mobile-pr-actions',
        ).createSync(recursive: true);
        await expectLater(
          scenario == 'confirmation'
              ? find.byType(Overlay).first
              : find.byKey(const ValueKey('capture')),
          matchesGoldenFile(
            '../../../../.playwright/mobile-pr-actions/$scenario-$stage-${dark ? 'dark' : 'light'}.png',
          ),
        );
        expect(tester.takeException(), isNull);
      });
    }
  }
}
