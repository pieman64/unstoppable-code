// Worktree file diff viewer: deterministic light/dark evidence for the Files
// tab row tap → RemoteFileDiffScreen flow.
//
// FILE_DIFF_STAGE=before (or after) flutter test tool/file_diff/capture_test.dart
// --update-goldens, from apps/mobile. Writes to
// .playwright/mobile-file-diff/ at the repo root.
//
// Deterministic: fake repository with a fixed changed-file roster and a fixed
// patch, bundled fonts, no network or live agents.
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import '../../test/support/fake_remote_control_repository.dart';

final _patch =
    'diff --git a/apps/mobile/lib/data/repositories/remote_control_repository.dart '
    'b/apps/mobile/lib/data/repositories/remote_control_repository.dart\n'
    'index 3f1c2a9..8b7d4e1 100644\n'
    '--- a/apps/mobile/lib/data/repositories/remote_control_repository.dart\n'
    '+++ b/apps/mobile/lib/data/repositories/remote_control_repository.dart\n'
    '@@ -180,6 +180,18 @@ abstract interface class RemoteControlRepository {\n'
    '     String? before,\n'
    '     int? limitTurns,\n'
    '   });\n'
    '+\n'
    '+  /// Reads one changed file\'s unified diff from the paired desktop\n'
    '+  /// (`POST .../diff/read` → `portal.diff.read`).\n'
    '+  Future<RemoteFileDiff> readFileDiff({\n'
    '+    required String workspaceLocalId,\n'
    '+    required String worktreeLocalId,\n'
    '+    required String path,\n'
    '+    required RemoteDiffSource source,\n'
    '+    String? repoId,\n'
    '+  });\n'
    ' }\n'
    ' \n'
    '@@ -1500,7 +1512,7 @@ final class HttpRemoteControlRepository {\n'
    '     } on ApiException catch (e) {\n'
    '       throw RemoteControlException(\n'
    '-        apiErrorMessage(e) ?? \'Could not load older messages.\',\n'
    '+        apiErrorMessage(e) ?? \'Could not load the diff.\',\n'
    '       );\n'
    '     } catch (_) {\n'
    '       throw const RemoteControlException(\n'
    '+${'x' * 1100}\n';

void main() {
  final stage = Platform.environment['FILE_DIFF_STAGE'] == 'before'
      ? 'before'
      : 'after';
  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader('JetBrainsMono')..addFont(
          rootBundle.load(
            'assets/fonts/jetbrains-mono/JetBrainsMonoVariable.ttf',
          ),
        ))
        .load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    testWidgets('file diff $mode', (tester) async {
      tester.view.physicalSize = const Size(440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final repo = FakeRemoteControlRepository();
      repo.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'gvoltr/mobile-file-diff',
            insertions: 12,
            deletions: 1,
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Diff viewer',
            active: true,
          ),
        ],
        chatMessages: const [],
        raw: const {
          'changedFiles': {
            'wt-1': {
              'worktreeLocalId': 'wt-1',
              'uncommitted': [
                {
                  'filePath':
                      'apps/mobile/lib/ui/features/remote/views/remote_file_diff_screen.dart',
                  'status': 'untracked',
                  'insertions': 310,
                },
                {
                  'filePath':
                      'apps/mobile/lib/ui/features/remote/views/widgets/activity_sidebar.dart',
                  'status': 'modified',
                  'insertions': 39,
                  'deletions': 6,
                },
                {
                  'filePath':
                      'apps/mobile/lib/ui/features/remote/view_models/unified_diff_lines.dart',
                  'status': 'untracked',
                  'insertions': 88,
                },
                {
                  'filePath':
                      'apps/mobile/test/ui/features/remote/remote_file_diff_screen_test.dart',
                  'status': 'untracked',
                  'insertions': 240,
                },
                {
                  'filePath':
                      'apps/mobile/test/support/fake_remote_control_repository.dart',
                  'status': 'modified',
                  'insertions': 37,
                },
                {
                  'filePath': 'docs/parity/registry.yaml',
                  'status': 'modified',
                  'insertions': 10,
                },
                {
                  'filePath': 'docs/parity/FEATURE-PARITY.md',
                  'status': 'modified',
                  'insertions': 1,
                },
                {'filePath': 'README.md', 'status': 'deleted', 'deletions': 12},
              ],
              'committed': [
                {
                  'filePath':
                      'apps/mobile/lib/data/repositories/remote_control_repository.dart',
                  'status': 'modified',
                  'insertions': 12,
                  'deletions': 1,
                },
                {
                  'filePath':
                      'apps/mobile/lib/data/services/remote_control_api_service.dart',
                  'status': 'modified',
                  'insertions': 26,
                },
                {
                  'filePath':
                      'apps/mobile/lib/data/models/remote_file_diff.dart',
                  'status': 'added',
                  'insertions': 74,
                },
              ],
            },
          },
        },
      );
      repo.readFileDiffHandler = (path, source) async => RemoteFileDiff(
        filePath: path,
        patch: _patch,
        rangeLabel: 'develop..HEAD',
        insertions: 12,
        deletions: 1,
      );
      final vm = RemoteControlViewModel(
        repository: repo,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
            ChangeNotifierProvider(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: RepaintBoundary(
              key: const ValueKey('capture'),
              child: RemoteChatScreen.worktree(
                worktree: vm.allWorktrees.single,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Files'));
      await tester.pumpAndSettle();

      Directory(
        '../../.playwright/mobile-file-diff',
      ).createSync(recursive: true);
      await expectLater(
        find.byKey(const ValueKey('capture')),
        matchesGoldenFile(
          '../../../../.playwright/mobile-file-diff/files-tab-$stage-$mode.png',
        ),
      );

      // Exact match on either the full path (before) or basename (after) so
      // the sibling `fake_remote_control_repository.dart` row is not hit.
      await tester.tap(
        find.byWidgetPredicate(
          (widget) =>
              widget is Text &&
              (widget.data == 'remote_control_repository.dart' ||
                  widget.data ==
                      'apps/mobile/lib/data/repositories/remote_control_repository.dart'),
        ),
      );
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(
          '../../../../.playwright/mobile-file-diff/diff-screen-$stage-$mode.png',
        ),
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
      await repo.eventsController.close();
    });
  }
}
