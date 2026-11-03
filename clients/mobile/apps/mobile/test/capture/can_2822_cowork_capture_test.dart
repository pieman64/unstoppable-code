// CAN-2822: deterministic cowork archive and row parity evidence.
// From apps/mobile, run both before and after production edits:
// CAN2822_CAPTURE=1 CAN2822_STAGE=before flutter test test/capture/can_2822_cowork_capture_test.dart --update-goldens
// CAN2822_CAPTURE=1 CAN2822_STAGE=after flutter test test/capture/can_2822_cowork_capture_test.dart --update-goldens
// Both color modes use bundled fonts, in-memory payloads and fixed frames.
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
  final enabled = Platform.environment['CAN2822_CAPTURE'] == '1';
  final stage = Platform.environment['CAN2822_STAGE'] ?? 'after';
  setUpAll(() async {
    final loader = FontLoader('Inter')
      ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'));
    await loader.load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final dark in [false, true]) {
    testWidgets('cowork ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [
            {'localId': 'default', 'name': 'Default', 'type': 'cowork'},
          ],
          'worktrees': [],
          'standaloneChats': [
            {
              'localId': 'active',
              'projectLocalId': 'default',
              'title': 'ping',
              'description': 'Network connectivity test',
              'modelLabel': 'GPT 5.6 Luna',
            },
            {
              'localId': 'archived',
              'projectLocalId': 'default',
              'title': 'New Chat',
              'archived': true,
              'modelLabel': 'Opus 5 1M',
            },
          ],
        });
      final vm = RemoteControlViewModel(repository: repository);
      await vm.connect('123456');
      addTearDown(vm.dispose);
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: vm,
          child: MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const Scaffold(body: WorkspacesListView()),
          ),
        ),
      );
      await tester.tap(find.text('Default'));
      await tester.pump(const Duration(milliseconds: 400));
      if (enabled) {
        await expectLater(
          find.byType(Scaffold),
          matchesGoldenFile(
            '../../../../.playwright/can-2822/cowork-$stage-${dark ? 'dark' : 'light'}.png',
          ),
        );
      }
      expect(tester.takeException(), isNull);
    }, skip: !enabled);
  }
}
