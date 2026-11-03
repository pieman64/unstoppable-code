// CAN-2820: independent title/progress and identifier/PR/diff lines.
// Deterministic fixtures, fixed animation time, no network or live agents.
// From apps/mobile, run both stages and modes:
// CAN2820_CAPTURE=1 CAN2820_STAGE=before CAN2820_MODE=light flutter test test/capture/can_2820_workspace_rows_capture_test.dart --update-goldens
// Repeat with CAN2820_STAGE=after and CAN2820_MODE=dark (stage defaults to after).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/views/widgets/worktree_row.dart';

final String _stage = switch (Platform.environment['CAN2820_STAGE']) {
  null || 'after' => 'after',
  'before' => 'before',
  final value => throw ArgumentError.value(
    value,
    'CAN2820_STAGE',
    'must be either "before" or "after"',
  ),
};

final bool _captureEnabled = Platform.environment['CAN2820_CAPTURE'] == '1';

final bool _darkMode = Platform.environment['CAN2820_MODE'] == 'dark';

String _capture(String name) =>
    '../../../../.playwright/can-2820/'
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

const _rows = [
  RemoteWorktree(
    localId: 'koala',
    workspaceLocalId: 'ws',
    branch: 'feature/oauth-pkce-and-session-refresh',
    isStreaming: true,
    insertions: 1170,
    deletions: 13,
    prStatuses: [
      RemoteWorktreePr(prNumber: 3061, state: 'open', checkStatus: 'passing'),
    ],
  ),
  RemoteWorktree(
    localId: 'zebra',
    workspaceLocalId: 'ws',
    branch: 'fix/overflow',
    label: 'Fix narrow workspace layout',
    hasUnread: true,
    insertions: 12345678,
    deletions: 9876543,
  ),
  RemoteWorktree(
    localId: 'kiwi',
    workspaceLocalId: 'ws',
    branch: 'feature/plain-idle-row',
  ),
  RemoteWorktree(
    localId: 'otter',
    workspaceLocalId: 'ws',
    branch: 'feature/pipeline',
    isStreaming: true,
    pipelineStatus: RemoteWorktreePipelineStatus.unseenFailure,
    scriptStatus: 'running',
    hookStatus: 'running',
    terminalStatus: 'unseen-failure',
  ),
  RemoteWorktree(
    localId: 'lion',
    workspaceLocalId: 'ws',
    branch: 'feature/review',
    awaitingApproval: true,
    prStatuses: [RemoteWorktreePr(prNumber: 72, state: 'draft')],
  ),
  RemoteWorktree(
    localId: 'panda',
    workspaceLocalId: 'ws',
    branch: 'feature/complete',
    prStatuses: [RemoteWorktreePr(prNumber: 73, state: 'merged')],
  ),
];
double _width = 390;
Future<void> _pumpCapture(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = Size(_width, 600);
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
  Directory('../../.playwright/can-2820').createSync(recursive: true);
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

  for (final width in [390.0, 280.0]) {
    testWidgets('workspace rows at $width', (tester) async {
      _width = width;
      await _pumpCapture(
        tester,
        RepaintBoundary(
          key: const ValueKey('rows'),
          child: Material(
            color: (_darkMode ? AppTheme.dark : AppTheme.light)
                .colorScheme
                .surface,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final row in _rows)
                  WorktreeRow(worktree: row, onTap: () {}),
              ],
            ),
          ),
        ),
      );
      await _snap(
        tester,
        find.byKey(const ValueKey('rows')),
        'rows-${width.toInt()}',
      );
      expect(tester.takeException(), isNull);
    });
  }
}
