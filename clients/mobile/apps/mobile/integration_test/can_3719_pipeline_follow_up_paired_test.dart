// CAN-3719 — Chat follow-up over real transport with a paired desktop.
//
// The phone half of apps/desktop-app/tests/electron/portal/
// portal-pipeline-chat-follow-up.spec.mjs. That spec seeds the desktop run,
// arms a pairing code and publishes a private fixture on a loopback URL; this
// test reads it, pairs through the real Portal API with the production
// repository, sends the report follow-up from the run screen and waits for
// the desktop agent's reply. The spec then checks the desktop chats. Run it
// only from that handshake (apps/mobile):
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3719_pipeline_follow_up_paired_test.dart \
//     --dart-define=CAN3719_FIXTURE_URL=http://127.0.0.1:<port>/fixture \
//     -d <device-id>
//
// The fixture URL carries no credential; the fixture body does, so it is
// served only on loopback for the duration of one run. The fixture also
// names the theme (`light` or `dark`), so one build serves both runs.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';
import 'package:provider/provider.dart';

const String _fixtureUrl = String.fromEnvironment('CAN3719_FIXTURE_URL');

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final platform = Platform.isIOS ? 'ios' : 'android';

  Future<void> hold(WidgetTester tester, [int milliseconds = 600]) async {
    final end = DateTime.now().add(Duration(milliseconds: milliseconds));
    while (DateTime.now().isBefore(end)) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  Future<void> pumpUntil(
    WidgetTester tester,
    Finder finder, {
    Duration timeout = const Duration(seconds: 60),
  }) async {
    final end = DateTime.now().add(timeout);
    while (finder.evaluate().isEmpty) {
      if (DateTime.now().isAfter(end)) fail('Timed out waiting for $finder');
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  testWidgets('a report follow-up reaches the run owner chat on the desktop', (
    tester,
  ) async {
    expect(_fixtureUrl, isNotEmpty, reason: 'CAN3719_FIXTURE_URL is required');
    final response = await http.get(Uri.parse(_fixtureUrl));
    expect(response.statusCode, 200);
    final fixture = jsonDecode(response.body) as Map<String, dynamic>;
    final token = fixture['sessionToken'] as String;
    final prompt = fixture['prompt'] as String;
    final theme = fixture['theme'] == 'dark' ? 'dark' : 'light';
    Future<void> shot(String name) async {
      await hold(tester, 400);
      await binding.takeScreenshot('can-3719-$platform-paired-$name-$theme');
    }

    final viewModel = RemoteControlViewModel(
      repository: HttpRemoteControlRepository.fromApiClient(
        ApiClient(
          baseUrl: fixture['apiBaseUrl'] as String,
          tokenProvider: () => token,
        ),
      ),
      draftStore: InMemoryChatDraftStore(),
    );
    await viewModel.connect(fixture['pairingCode'] as String);
    expect(viewModel.isConnected, isTrue);
    expect(viewModel.supportsPipelineChatFollowUp, isTrue);

    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: ChatDraftStoreHolder(InMemoryChatDraftStore()),
        child: ChangeNotifierProvider.value(
          value: viewModel,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: theme == 'dark' ? ThemeMode.dark : ThemeMode.light,
            home: RemotePipelineRunScreen(
              workspaceLocalId: fixture['workspaceLocalId'] as String,
              worktreeLocalId: fixture['worktreeLocalId'] as String,
              executionId: fixture['executionId'] as String,
              pipelineName: 'CAN-3719 plan and review',
            ),
          ),
        ),
      ),
    );
    if (Platform.isAndroid) await binding.convertFlutterSurfaceToImage();

    final button = find.byKey(const ValueKey('pipeline-run-chat-follow-up'));
    await pumpUntil(tester, button);
    await tester.tap(find.text('Draft plan'));
    await pumpUntil(tester, find.byKey(const ValueKey('pipeline-run-log')));
    await shot('run');

    await tester.tap(button);
    await pumpUntil(tester, find.text('Review report'));
    await shot('choice');
    await tester.tap(find.text('Review report'));

    await pumpUntil(tester, find.byType(RemoteChatScreen));
    await pumpUntil(tester, find.text(prompt));
    await shot('receiving');
    await pumpUntil(
      tester,
      find.textContaining(fixture['reply'] as String),
      timeout: const Duration(seconds: 150),
    );
    expect(find.text(prompt), findsOneWidget);
    await shot('reply');

    await tester.pageBack();
    await pumpUntil(tester, find.byKey(const ValueKey('pipeline-run-log')));
    // The run log is on stage as soon as the pop starts; let it finish.
    await hold(tester, 1200);
    expect(find.byType(RemoteChatScreen), findsNothing);
    await shot('restored');

    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await hold(tester, 200);
    viewModel.dispose();
  });
}
