// Long-press archive visual evidence. Run from apps/mobile:
// WORKTREE_ARCHIVE_STAGE=before/after flutter test test/capture/worktree_archive_capture_test.dart --update-goldens
// Fixed local fixtures and bundled fonts; no desktop, agents, or network.
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/workspaces_list_view.dart';
import 'package:provider/provider.dart';
import '../support/fake_remote_control_repository.dart';

void main() {
  final stage = Platform.environment['WORKTREE_ARCHIVE_STAGE'];
  final unavailable =
      Platform.environment['WORKTREE_ARCHIVE_UNAVAILABLE'] == '1';
  final attention = Platform.environment['WORKTREE_ARCHIVE_ATTENTION'] == '1';
  for (final dark in [false, true]) {
    testWidgets('archive ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 650);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final font = FontLoader('Inter')
        ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'));
      await font.load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
      final repo = FakeRemoteControlRepository()
        ..canArchiveWorktrees = !unavailable
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [
            {'localId': 'ws', 'name': 'Mobile app', 'type': 'single-repo'},
          ],
          'worktrees': [
            {
              'localId': 'oarfish',
              'workspaceLocalId': 'ws',
              'branch': 'feature/mobile-archive',
              'label': 'Archive worktrees',
              if (attention) 'hasUnread': true,
            },
          ],
        });
      final vm = RemoteControlViewModel(repository: repo);
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: vm,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const Scaffold(body: WorkspacesListView()),
          ),
        ),
      );
      if (!attention) await tester.tap(find.text('Mobile app'));
      await tester.pumpAndSettle();
      Future<void> capture(String name) async {
        if (stage == null) return;
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(
            '../../../../.playwright/worktree-menu/${unavailable ? 'unavailable-' : ''}${attention ? 'attention-' : ''}$name-$stage-${dark ? 'dark' : 'light'}.png',
          ),
        );
      }

      await capture('row');
      await tester.longPress(find.text('Archive worktrees'));
      await tester.pumpAndSettle();
      await capture('menu');
      if (stage == 'after' && !unavailable) {
        await tester.tap(find.text('Archive', skipOffstage: false).first);
        await tester.pumpAndSettle();
        await capture('confirmation');
      }
      await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
    }, skip: stage == null);
  }
}
