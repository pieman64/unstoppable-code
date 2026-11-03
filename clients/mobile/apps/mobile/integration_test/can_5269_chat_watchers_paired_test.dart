// CAN-5269: the phone half of portal/chat-watchers-paired-device.spec.mjs.
// Run through that headless host spec with CAN5269_DEVICE_ID. It serves a
// short-lived loopback fixture, pairs this production repository to a seeded
// desktop, and checks the desktop list and deletion notification afterward.
// The remote-control repository and HTTP transport are real.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

const _fixtureUrl = String.fromEnvironment('CAN5269_FIXTURE_URL');

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> until(WidgetTester tester, bool Function() ready) async {
    final deadline = DateTime.now().add(const Duration(seconds: 90));
    while (!ready()) {
      if (DateTime.now().isAfter(deadline)) {
        fail('Paired watcher state timed out');
      }
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.pump(const Duration(milliseconds: 400));
  }

  testWidgets('paired chat watcher rows match desktop and delete with notice', (
    tester,
  ) async {
    expect(_fixtureUrl, isNotEmpty);
    final response = await http.get(Uri.parse(_fixtureUrl));
    expect(response.statusCode, 200);
    final fixture = jsonDecode(response.body) as Map<String, dynamic>;
    final token = fixture['sessionToken'] as String;
    final api = ApiClient(
      baseUrl: fixture['apiBaseUrl'] as String,
      tokenProvider: () => token,
    );
    final vm = RemoteControlViewModel(
      repository: HttpRemoteControlRepository.fromApiClient(api),
      draftStore: InMemoryChatDraftStore(),
    );
    final workspace = fixture['workspaceLocalId'] as String;
    final worktree = fixture['worktreeLocalId'] as String;
    final chat = fixture['chatId'] as String;
    final removedId = fixture['deleteWatcherId'] as String;
    final stage = fixture['stage'] as String;
    final theme = fixture['theme'] as String;
    final ids = (fixture['watcherIds'] as List).cast<String>();
    List<String> currentIds() =>
        vm
            .watchersForChat(worktree, chat, workspaceLocalId: workspace)
            .map((watcher) => watcher.id)
            .toList()
          ..sort();
    Future<void> shot(String subject) async {
      // Give the native raster surface time to display the settled widget
      // frame. Advancing the test clock once can still capture the old frame.
      final readyAt = DateTime.now().add(const Duration(milliseconds: 600));
      while (DateTime.now().isBefore(readyAt)) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      await binding.takeScreenshot('$subject-mobile-$stage-$theme');
    }

    try {
      await vm.connect(fixture['pairingCode'] as String);
      expect(vm.isConnected, isTrue);
      expect(vm.supportsChatWatchers, isTrue);
      // The baseline predates the chip's self-hydration. Fetch its data without
      // substituting UI or changing what that version renders.
      if (stage == 'before') {
        await vm.refreshWorktreeActivity(
          workspaceLocalId: workspace,
          worktreeLocalId: worktree,
        );
      }
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider.value(value: vm),
            ChangeNotifierProvider.value(
              value: ChatDraftStoreHolder(InMemoryChatDraftStore()),
            ),
            ChangeNotifierProvider(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: theme == 'dark' ? ThemeMode.dark : ThemeMode.light,
            home: RemoteChatScreen.worktree(
              worktree: vm
                  .worktreesFor(workspace)
                  .singleWhere((row) => row.localId == worktree),
              initialChatId: chat,
            ),
          ),
        ),
      );
      if (Platform.isAndroid) await binding.convertFlutterSurfaceToImage();
      await until(tester, () => currentIds().length == 2);
      expect(currentIds(), ids);
      await until(
        tester,
        () => find
            .text('The PR watcher and wakeup are armed.')
            .evaluate()
            .isNotEmpty,
      );
      final chip = key('composer-watchers');
      if (stage == 'before') {
        expect(chip, findsNothing);
        await shot('chat-watchers');
      } else {
        await until(tester, () => chip.evaluate().isNotEmpty);
        expect(
          find.descendant(of: chip, matching: find.text('2')),
          findsOneWidget,
        );
        final button = tester.widget<TextButton>(
          find.descendant(of: chip, matching: find.byType(TextButton)),
        );
        final info = StatusColors.of(tester.element(chip)).unread;
        expect(
          button.style!.backgroundColor?.resolve({}),
          info.withValues(alpha: 0.16),
        );
        expect(button.style!.foregroundColor?.resolve({}), info);
        expect(button.style!.shape?.resolve({}), isA<StadiumBorder>());
        await shot('chat-watchers-chip');
        await tester.tap(chip);
        await until(
          tester,
          () => key('chat-watchers-sheet').evaluate().isNotEmpty,
        );
        for (final id in ids) {
          expect(key('chat-watcher-$id'), findsOneWidget);
        }
        expect(find.text('Chat watchers'), findsOneWidget);
        expect(
          find.textContaining(fixture['followUp'] as String),
          findsOneWidget,
        );
        expect(find.text('Jump to chat'), findsNothing);
        await shot('chat-watchers');
      }
      final ready = await http.post(
        Uri.parse(_fixtureUrl).replace(path: '/ready'),
        body: jsonEncode({'watcherIds': currentIds()}),
      );
      expect(ready.statusCode, 200);
      if (stage == 'before') return;

      await tester.ensureVisible(key('chat-watcher-delete-$removedId'));
      await tester.tap(key('chat-watcher-delete-$removedId'));
      await tester.pump(const Duration(milliseconds: 400));
      final notify = key('chat-watcher-notify-$removedId');
      await tester.ensureVisible(notify);
      expect(tester.widget<CheckboxListTile>(notify).value, isFalse);
      await tester.tap(notify);
      await tester.pump();
      expect(tester.widget<CheckboxListTile>(notify).value, isTrue);
      await shot('chat-watchers-delete-confirm');
      final confirm = key('chat-watcher-confirm-delete-$removedId');
      await tester.ensureVisible(confirm);
      await tester.tap(confirm);
      await until(tester, () => !currentIds().contains(removedId));
      expect(currentIds(), ids.where((id) => id != removedId).toList());
      expect(key('chat-watcher-$removedId'), findsNothing);
      await shot('chat-watchers-deleted');
      await tester.binding.handlePopRoute();
      await tester.pump(const Duration(milliseconds: 500));
      await until(
        tester,
        () => find.textContaining('watcher deleted').evaluate().isNotEmpty,
      );
      await shot('watcher-deleted-message');
      expect(tester.takeException(), isNull);
      binding.reportData = {
        ...?binding.reportData,
        'can5269': {'watcherIds': ids, 'deletedId': removedId, 'theme': theme},
      };
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    }
  });
}
