// CAN-2823: deterministic mobile merge progress before/after evidence.
// From apps/mobile, run CAN2823_STAGE=before (then after production edits, after)
// flutter test tool/pr_merge/capture_test.dart --update-goldens.
// Both themes use bundled fonts, fixed JSON fixtures and fixed animation time.
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/views/widgets/worktree_row.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final stage = Platform.environment['CAN2823_STAGE'] == 'before'
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
    testWidgets('merge progress ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: Scaffold(
            body: RepaintBoundary(
              key: const ValueKey('capture'),
              child: ColoredBox(
                color: dark
                    ? AppTheme.dark.scaffoldBackgroundColor
                    : AppTheme.light.scaffoldBackgroundColor,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (final phase in [
                        'queued',
                        'checking_mergeability',
                        'waiting_mergeability',
                        'merging',
                        'refreshing_pr_status',
                        'done',
                        'failed',
                      ])
                        WorktreeRow(
                          worktree: RemoteWorktree.fromJson({
                            'localId': 'sardine',
                            'workspaceLocalId': 'workspace',
                            'branch': 'Show PR merge progress',
                            'mergingPr': phase != 'done' && phase != 'failed',
                            'mergePrPhase': phase,
                            'lastKnownPrStatus': {
                              'repos': [
                                {
                                  'status': {
                                    'state': phase == 'done'
                                        ? 'merged'
                                        : 'open',
                                    'prNumber': 2823,
                                  },
                                },
                              ],
                            },
                          }),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
      Directory('../../.playwright/can-2823').createSync(recursive: true);
      await expectLater(
        find.byKey(const ValueKey('capture')),
        matchesGoldenFile(
          '../../../../.playwright/can-2823/rows-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      expect(tester.takeException(), isNull);
    });
  }
}
