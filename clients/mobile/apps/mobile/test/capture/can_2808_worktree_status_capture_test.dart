// Visual-evidence capture for CAN-2808: mobile overview worktree status.
//
// What changes:
//  1. A worktree with an active agent turn AND a running pipeline no longer
//     renders two indistinguishable accent spinners — pipeline-running is a
//     static gray glyph (desktop vocabulary), only the agent animates.
//  2. Merely-working worktrees (streaming agent, running pipeline) move out
//     of "NEEDS ATTENTION" into a separate "IN PROGRESS" group.
//
// SUPERSEDED (point 2 only): the "IN PROGRESS" group was later cut entirely —
// merely-working worktrees are no longer pinned above the navigator at all,
// and are reached through their project. Point 1 (the status-glyph vocabulary)
// still describes current behavior, which is why this capture is retained.
// The `after` stage now renders only the NEEDS ATTENTION group.
//
// Run both stages from `apps/mobile` (light is default; repeat with
// CAN2808_MODE=dark for the dark variants):
//
//   CAN2808_CAPTURE=1 CAN2808_STAGE=before flutter test test/capture/can_2808_worktree_status_capture_test.dart --update-goldens
//   CAN2808_CAPTURE=1 CAN2808_STAGE=after  flutter test test/capture/can_2808_worktree_status_capture_test.dart --update-goldens
//
// Captures are deterministic: fixed in-memory worktree fixtures, no live
// desktop/agent/network, and every frame is pumped to a fixed animation
// timestamp. Output lands in the gitignored `<repo>/.playwright/can-2808/`.

import 'dart:io';
import 'package:provider/provider.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import '../support/fake_remote_control_repository.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_overview_sections.dart';
import 'package:mobile/ui/features/remote/views/widgets/attention_sections.dart';
import 'package:mobile/ui/features/remote/views/widgets/worktree_row.dart';

final String _stage = switch (Platform.environment['CAN2808_STAGE']) {
  null || 'after' => 'after',
  'before' => 'before',
  final value => throw ArgumentError.value(
    value,
    'CAN2808_STAGE',
    'must be either "before" or "after"',
  ),
};

final bool _captureEnabled = Platform.environment['CAN2808_CAPTURE'] == '1';

final bool _darkMode = Platform.environment['CAN2808_MODE'] == 'dark';

String _capture(String name) =>
    '../../../../.playwright/can-2808/'
    '$name-$_stage-${_darkMode ? 'dark' : 'light'}.png';

Future<void> _loadFont(String family, List<String> candidates) async {
  for (final path in candidates) {
    if (path.isEmpty) continue;
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader(family)..addFont(Future.value(bytes))).load();
    return;
  }
}

const _streamingWithPipeline = RemoteWorktree(
  localId: 'wt-2807',
  workspaceLocalId: 'ws-canopy',
  branch: 'qrtp/can-2807',
  label: 'can-2807',
  isStreaming: true,
  pipelineStatus: RemoteWorktreePipelineStatus.running,
  insertions: 42,
  deletions: 7,
);

const _unreadWithPipeline = RemoteWorktree(
  localId: 'wt-2806',
  workspaceLocalId: 'ws-canopy',
  branch: 'qrtp/can-2806',
  label: 'can-2806',
  hasUnread: true,
  pipelineStatus: RemoteWorktreePipelineStatus.running,
);

const _awaitingApproval = RemoteWorktree(
  localId: 'wt-plan',
  workspaceLocalId: 'ws-canopy',
  branch: 'feat/review-me',
  label: 'review-me',
  awaitingApproval: true,
);

Future<void> _pumpCapture(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = const Size(390, 500);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: _darkMode ? ThemeMode.dark : ThemeMode.light,
      home: Scaffold(
        body: Padding(padding: const EdgeInsets.all(16), child: child),
      ),
    ),
  );
  // A fixed animation timestamp keeps the spinners deterministic.
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> _snap(WidgetTester tester, Finder finder, String name) async {
  if (!_captureEnabled) return;
  Directory('../../.playwright/can-2808').createSync(recursive: true);
  await expectLater(finder, matchesGoldenFile(_capture(name)));
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFont('Roboto', const [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Supplemental/Verdana.ttf',
    ]);
    // `flutter test` exports FLUTTER_ROOT, so this works regardless of where
    // the SDK is installed (the older harness hardcoded /opt/homebrew).
    final flutterRoot = Platform.environment['FLUTTER_ROOT'] ?? '';
    final flutter = File('/opt/homebrew/bin/flutter');
    await _loadFont('MaterialIcons', [
      if (flutterRoot.isNotEmpty)
        '$flutterRoot/bin/cache/artifacts/material_fonts/'
            'MaterialIcons-Regular.otf',
      if (flutter.existsSync())
        '${flutter.resolveSymbolicLinksSync().replaceFirst(RegExp(r'/flutter$'), '')}/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    ]);
  });

  testWidgets('worktree row streaming with a running pipeline', (tester) async {
    await _pumpCapture(
      tester,
      const Column(
        mainAxisSize: MainAxisSize.min,
        children: [WorktreeRow(worktree: _streamingWithPipeline)],
      ),
    );
    await _snap(tester, find.byType(WorktreeRow), 'row-streaming-pipeline');
    expect(tester.takeException(), isNull);
  });

  testWidgets('overview queue mixing attention and activity', (tester) async {
    final repo = FakeRemoteControlRepository();
    final vm = RemoteControlViewModel(repository: repo);
    addTearDown(vm.dispose);
    addTearDown(repo.eventsController.close);
    final data = computeAttentionSections(
      workspaces: const [
        RemoteWorkspace(
          localId: 'ws-canopy',
          name: 'canopy',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktreesFor: (_) => [
        _streamingWithPipeline,
        _unreadWithPipeline,
        _awaitingApproval,
      ],
    );
    await _pumpCapture(
      tester,
      ChangeNotifierProvider.value(
        value: vm,
        child: AttentionSections(data: data, onOpenWorktree: (_) {}),
      ),
    );
    // Both stages render the same fixture under one NEEDS ATTENTION header.
    // At the time of CAN-2808 `after` split attention vs IN PROGRESS; that
    // group has since been cut, so the two stages differ only in row styling.
    // `wt-2807` is streaming-only, so it is no longer pinned at all; the
    // attention-bearing rows are what the queue still shows.
    expect(
      find.byKey(const ValueKey('attention-row-ws-canopy-wt-2807')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('attention-row-ws-canopy-wt-2806')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('attention-row-ws-canopy-wt-plan')),
      findsOneWidget,
    );
    await _snap(
      tester,
      find.byKey(const ValueKey('attention-sections')),
      'overview-groups',
    );
    expect(tester.takeException(), isNull);
  });
}
