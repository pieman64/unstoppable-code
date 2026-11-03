// CAN-2858: saved workspace order survives cached refreshes.
// Deterministic fake repository, no network or live agents. From apps/mobile:
// CAN2858_CAPTURE=1 CAN2858_STAGE=before flutter test test/capture/can_2858_workspace_order_capture_test.dart --update-goldens
// Repeat with CAN2858_STAGE=after (default). Each run captures light and dark.
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/workspaces_list_view.dart';
import '../support/fake_remote_control_repository.dart';

void main() {
  final enabled = Platform.environment['CAN2858_CAPTURE'] == '1';
  final stage = Platform.environment['CAN2858_STAGE'] == 'before'
      ? 'before'
      : 'after';
  setUpAll(() async {
    if (!enabled) return;
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    final flutterRoot = Platform.environment['FLUTTER_ROOT']!;
    final icons = await File(
      '$flutterRoot/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    ).readAsBytes();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(Future.value(ByteData.sublistView(icons)))).load();
  });
  for (final dark in [false, true]) {
    testWidgets('workspace refresh ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      var rows = <Map<String, dynamic>>[
        {
          'localId': 'z-default',
          'name': 'Default',
          'type': 'cowork',
          'order': 0,
        },
        {
          'localId': 'a-canopy',
          'name': 'canopy',
          'type': 'single-repo',
          'order': 1,
        },
      ];
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': rows,
          'standaloneChats': [
            {
              'localId': 'chat',
              'projectLocalId': 'z-default',
              'title': 'Expanded chat',
            },
          ],
        });
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: vm,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const RepaintBoundary(
              key: ValueKey('capture'),
              child: Scaffold(body: WorkspacesListView()),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Default'));
      await tester.pumpAndSettle();
      Directory('../../.playwright/can-2858').createSync(recursive: true);
      Future<void> capture(String state) => expectLater(
        find.byKey(const ValueKey('capture')),
        matchesGoldenFile(
          '../../../../.playwright/can-2858/$state-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      await capture('initial');
      rows = rows.reversed.toList();
      await vm.refresh();
      await tester.pumpAndSettle();
      await capture('refreshed');
    }, skip: !enabled);
  }
}
