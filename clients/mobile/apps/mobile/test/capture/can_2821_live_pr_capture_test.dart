// CAN-2821: capture the row after the same pushed merge snapshot, before/after
// the fix. Seeded repository, real wire parser, no network or desktop required.
// From apps/mobile, run for STAGE=before/after and MODE=light/dark:
// CAN2821_CAPTURE=1 CAN2821_STAGE=before CAN2821_MODE=light flutter test
// test/capture/can_2821_live_pr_capture_test.dart --update-goldens
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/worktree_row.dart';
import '../support/fake_remote_control_repository.dart';
import '../support/overview_snapshot_fixture.dart';

void main() {
  testWidgets('row after pushed PR merge', (tester) async {
    final stage = Platform.environment['CAN2821_STAGE'] ?? 'after';
    final mode = Platform.environment['CAN2821_MODE'] ?? 'light';
    final font = FontLoader('Inter')
      ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'));
    await font.load();
    tester.view.physicalSize = const Size(430, 150);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final repository = FakeRemoteControlRepository()
      ..snapshotBuilder = initialOverview;
    final vm = RemoteControlViewModel(repository: repository);
    addTearDown(vm.dispose);
    addTearDown(repository.eventsController.close);
    await vm.connect('123456');
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: mode == 'dark' ? AppTheme.dark : AppTheme.light,
        home: Scaffold(
          body: ListenableBuilder(
            listenable: vm,
            builder: (context, _) =>
                WorktreeRow(worktree: vm.allWorktrees.single),
          ),
        ),
      ),
    );
    repository.eventsController.add(overviewBatch());
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    Directory('../../.playwright/can-2821').createSync(recursive: true);
    await expectLater(
      find.byType(Scaffold),
      matchesGoldenFile(
        '../../../../.playwright/can-2821/pr-merge-$stage-$mode.png',
      ),
    );
  }, skip: Platform.environment['CAN2821_CAPTURE'] != '1');
}
