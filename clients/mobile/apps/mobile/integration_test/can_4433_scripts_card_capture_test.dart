// CAN-4433 capture spec: visual evidence only, not regression coverage. The
// durable coverage is test/data/models/remote_activity_test.dart and
// test/ui/features/remote/remote_activity_sidebar_test.dart.
//
// CAN-4433 makes the Activity drawer's Scripts card list every configured
// script (`scriptDescriptors`) with the status of its latest run, instead of
// one line per run. Before the change the same synthetic worktree shows only
// the two `setup` runs; after it shows setup, launch, teardown and the custom
// scripts, with a status only on setup. Run once per stage on the unchanged
// and changed trees from apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_4433_scripts_card_capture_test.dart \
//     --dart-define=CAN4433_STAGE=before -d <device-id>
//
// Deterministic: synthetic shell state, forced theme mode, no desktop,
// account or network. Captures land in
// build/promo_screenshots/can-4433-scripts-card-<stage>-<theme>.png.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/views/widgets/activity_sidebar.dart';

const _stage = String.fromEnvironment('CAN4433_STAGE', defaultValue: 'after');

Map<String, dynamic> _descriptor(String scriptKey, String name) => {
  'worktreeLocalId': 'wt-1',
  'scriptKey': scriptKey,
  'scriptName': scriptKey.split(':').last,
  'name': name,
  'target': 'project',
};

Map<String, dynamic> _setupRun(String status, String startedAt) => {
  'worktreeLocalId': 'wt-1',
  'scriptKey': 'project:setup',
  'scriptName': 'setup',
  'name': 'setup',
  'target': 'project',
  'status': status,
  'startedAt': startedAt,
};

final _state = <String, dynamic>{
  'scriptDescriptors': [
    _descriptor('project:Storybook', 'Storybook'),
    _descriptor('project:setup', 'setup'),
    _descriptor('project:launch', 'launch'),
    _descriptor('project:teardown', 'teardown'),
    _descriptor('project:Electron-Tests', 'Electron-Tests'),
    _descriptor('project:Launch-Web', 'Launch-Web'),
  ],
  'scriptRuns': [
    _setupRun('failed', '2026-10-17T09:00:00Z'),
    _setupRun('completed', '2026-10-17T10:00:00Z'),
  ],
};

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  for (final (theme, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('Scripts card ($theme)', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: mode,
          home: Scaffold(
            body: SafeArea(
              child: RemoteActivitySidebar(
                worktree: const RemoteWorktree(
                  localId: 'wt-1',
                  workspaceLocalId: 'ws-1',
                  branch: 'feature/scripts',
                ),
                activity: RemoteWorktreeActivity.fromState(
                  worktreeLocalId: 'wt-1',
                  state: _state,
                ),
              ),
            ),
          ),
        ),
      );
      if (Platform.isAndroid) {
        // Per-test teardown reverts the conversion, so every test converts.
        await binding.convertFlutterSurfaceToImage();
      }
      await tester.pumpAndSettle();
      // Frame the Scripts card at the top of the drawer.
      final title = find.text('Scripts');
      await tester.scrollUntilVisible(
        title,
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await Scrollable.ensureVisible(tester.element(title));
      await tester.pumpAndSettle();
      expect(title, findsOneWidget);
      await tester.pump(const Duration(milliseconds: 300));
      await binding.takeScreenshot('can-4433-scripts-card-$_stage-$theme');
    });
  }
}
