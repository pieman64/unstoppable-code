// CAN-2870 review: locale-aware worktree ties survive cached refreshes.
// Before: code-unit ordering puts Beta before Álpha. After: collation puts
// Álpha first, including after a reversed cached refresh.
// Deterministic fake repository, no network or live agents. From apps/mobile:
// CAN2870_CAPTURE=1 CAN2870_STAGE=before flutter test test/capture/can_2870_worktree_order_capture_test.dart --update-goldens
// Repeat with CAN2870_STAGE=after (default). Each run captures light and dark.
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
  final enabled = Platform.environment['CAN2870_CAPTURE'] == '1';
  final stage = Platform.environment['CAN2870_STAGE'] == 'before'
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
    testWidgets('worktree refresh ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      var rows = <Map<String, dynamic>>[
        {
          'localId': 'z-first',
          'workspaceLocalId': 'ws',
          'branch': 'feature/first',
          'label': 'Álpha',
          'order': 0,
        },
        {
          'localId': 'a-second',
          'workspaceLocalId': 'ws',
          'branch': 'feature/second',
          'label': 'Beta',
          'order': 0,
        },
      ];
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [
            {'localId': 'ws', 'name': 'Repository', 'type': 'single-repo'},
          ],
          'worktrees': rows,
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
      await tester.tap(find.text('Repository'));
      await tester.pumpAndSettle();
      Directory(
        '../../.playwright/can-2870-collation',
      ).createSync(recursive: true);
      Future<void> capture(String state) => expectLater(
        find.byKey(const ValueKey('capture')),
        matchesGoldenFile(
          '../../../../.playwright/can-2870-collation/$state-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      await capture('initial');
      rows = rows.reversed.toList();
      await vm.refresh();
      await tester.pumpAndSettle();
      await capture('refreshed');
      await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
    }, skip: !enabled);
  }
}
