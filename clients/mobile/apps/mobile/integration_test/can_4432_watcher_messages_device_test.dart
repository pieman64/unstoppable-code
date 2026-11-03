// CAN-4432 — device verification that watcher messages show the watcher
// title, icon and info tint in Remote Control and cloud chats, that a merged
// message opens its details sheet without moving the transcript, and that a
// Remote Control watcher row keeps its style after a cold start.
//
// Real process death takes two runs from apps/mobile; the second must keep
// the app's data (no uninstall or data clear in between):
//
//   flutter drive --no-pub --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_4432_watcher_messages_device_test.dart \
//     --dart-define=CAN4432_PHASE=seed --keep-app-running -d <device-id>
//   adb -s <device-id> shell am force-stop com.unstoppabledomains.canopy
//   flutter drive ... --dart-define=CAN4432_PHASE=reopen -d <device-id>
//
// Without a phase both run in one process with fresh view models: durable
// coverage of the flow, but not proof of a cold process. Every repository is
// a synthetic fixture: no pairing, desktop, cloud service, or network. Each
// phase reports its process id and the checked layout in the response data.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/services/remote_transcript_file_storage.dart';
import 'package:mobile/services/remote_transcript_cache_directory.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import '../test/support/conversation_v2_fixtures.dart';
import '../test/support/fake_cloud_chat_repository.dart';
import '../test/support/remote_transcript_cache_fixture.dart';

const _phase = String.fromEnvironment('CAN4432_PHASE', defaultValue: 'both');
const _chat = Can3373Chat.worktree;
const _sentinel = 'PRIVATE-PAYLOAD-SENTINEL-4432';
const _singleTitle = 'Pipeline completion (Code Review) watcher has fired';
const _cloudLabel = 'Chat completion: Plan the mobile launch';

final _epoch = DateTime.utc(2026, 10, 23, 9).millisecondsSinceEpoch;

RemoteChatMessage _wire(
  String id,
  int second,
  String text, {
  String role = 'user',
  Map<String, dynamic>? watcherFired,
  List<Map<String, dynamic>> parts = const [],
}) => RemoteChatMessage.fromWireJson({
  'messageId': id,
  'chatId': _chat.chatId,
  'scope': _chat.scope.wire,
  'role': role,
  'status': 'complete',
  'text': text,
  'createdAtMs': _epoch + second * 1000,
  'watcherFired': ?watcherFired,
  'parts': parts,
});

/// Older turns to scroll past, a single watcher, a merged watcher carried
/// only in its cached part, and the unchanged controls.
List<RemoteChatMessage> _remoteRows() => [
  for (var i = 0; i < 12; i++)
    _wire(
      'older-$i',
      i,
      'Synthetic turn $i with enough text to wrap on a phone.',
      role: i.isEven ? 'user' : 'assistant',
    ),
  _wire(
    'single',
    20,
    'Canopy watcher fired.\n'
        'Worktree pipeline completion: Code Review (Multi-Provider)',
    watcherFired: {'kind': 'Pipeline completion (Code Review)'},
  ),
  _wire('answer-1', 21, 'The review finished.', role: 'assistant'),
  _wire(
    'merged',
    22,
    'Two watchers fired.',
    parts: [
      {
        'kind': 'prompt_source',
        'data': {
          'source': 'automated',
          'watcherFired': {
            'kind': 'Multiple watchers fired (2)',
            'combinedWatchers': [
              {
                'kind': 'Pipeline completion (Deploy)',
                'text': 'Canopy watcher fired.\nDeploy finished.',
              },
              {
                'kind': 'Chat completion: Release notes',
                'text': 'Canopy watcher fired.\nRelease notes finished.',
              },
            ],
          },
        },
      },
    ],
  ),
  _wire('answer-2', 23, 'Deploy is green.', role: 'assistant'),
  _wire('legacy', 24, 'Canopy watcher fired.\nWorktree pipeline: Lint'),
  _wire('continue', 25, 'Continue'),
  _wire('answer-3', 26, 'Lint passed.', role: 'assistant'),
];

String _cloudEnvelope() => [
  '<system_instruction>',
  'Canopy watcher internal event details.',
  '',
  '<canopy_watcher_event>',
  '{"label": "$_cloudLabel", "secret": "$_sentinel"}',
  '</canopy_watcher_event>',
  '</system_instruction>',
  '',
  'Canopy watcher fired.',
  _cloudLabel,
].join('\n');

Finder _key(String key) => find.byKey(ValueKey(key));

Finder get _transcript => find
    .descendant(
      of: _key('remote-chat-transcript'),
      matching: find.byType(Scrollable),
    )
    .first;

void _expectNoPrivateText() {
  for (final hidden in ['<system_instruction>', 'watcher_event', _sentinel]) {
    expect(
      find.textContaining(hidden, findRichText: true),
      findsNothing,
      reason: hidden,
    );
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final report = <String, Object?>{'phase': _phase};

  RemoteControlViewModel launch(Can3373Repository repository) =>
      RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        transcriptCache: RemoteTranscriptCache(
          storage: FileRemoteTranscriptStorage(
            directory: remoteTranscriptCacheDirectory,
          ),
          accountScope: kCan3373AccountScope,
        ),
      );

  Future<void> remote(WidgetTester tester) async {
    await FileRemoteTranscriptStorage(
      directory: remoteTranscriptCacheDirectory,
    ).clear();
    final repository = Can3373Repository();
    final vm = launch(repository);
    await vm.connect('123456');
    final layout = <String, Object?>{};
    for (final theme in [ThemeMode.light, ThemeMode.dark]) {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(can3373ChatHost(vm, _chat, themeMode: theme));
      await tester.pump();
      if (theme == ThemeMode.light) {
        repository
          ..releaseServerTail(_chat, const [])
          ..deliverSnapshot(_chat, _remoteRows(), cursor: 1);
      }
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        _key('watcher-title-merged'),
        -200,
        scrollable: _transcript,
      );
      await tester.pumpAndSettle();
      expect(find.text(_singleTitle), findsOneWidget);
      expect(_key('watcher-bubble-single'), findsOneWidget);
      expect(_key('user-bubble-legacy'), findsOneWidget);
      expect(_key('watcher-bubble-legacy'), findsNothing);
      expect(_key('user-bubble-continue'), findsOneWidget);

      // The merged title is a 48dp button; its sheet lists each watcher and
      // closing it leaves the transcript where it was.
      final title = _key('watcher-title-merged');
      final hit = tester.getRect(title);
      expect(hit.height, greaterThanOrEqualTo(48));
      final position = tester.state<ScrollableState>(_transcript).position;
      final offset = position.pixels;
      final row = tester.getRect(_key('message-merged'));
      await tester.tap(title);
      await tester.pumpAndSettle();
      expect(_key('watcher-details-sheet'), findsOneWidget);
      expect(
        find.text('Pipeline completion (Deploy) watcher has fired'),
        findsOneWidget,
      );
      expect(
        find.text('Chat completion: Release notes watcher has fired'),
        findsOneWidget,
      );
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(_key('watcher-details-sheet'), findsNothing);
      expect(position.pixels, offset);
      expect(tester.getRect(_key('message-merged')), row);
      layout[theme.name] = {
        'mergedTitleHeight': hit.height,
        'mergedTitleWidth': hit.width,
        'scrollOffset': offset,
      };
    }

    // A live watcher revision arrives as a portal chat event.
    repository.deliverLive(
      _chat,
      _wire(
        'live',
        30,
        'Canopy watcher fired.\nWorktree pipeline completion: Deploy',
        watcherFired: {'kind': 'Pipeline completion (Deploy)'},
      ),
      2,
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      _key('watcher-title-live'),
      200,
      scrollable: _transcript,
    );
    expect(
      find.text('Pipeline completion (Deploy) watcher has fired'),
      findsOneWidget,
    );

    // The largest Android text scale at 390dp: nothing overflows.
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(
      Align(
        alignment: Alignment.topCenter,
        child: SizedBox(width: 390, child: can3373ChatHost(vm, _chat)),
      ),
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      _key('watcher-title-single'),
      -200,
      scrollable: _transcript,
    );
    expect(tester.takeException(), isNull);
    layout['largeTextTitleHeight'] = tester
        .getRect(_key('watcher-title-single'))
        .height;
    tester.platformDispatcher.clearTextScaleFactorTestValue();
    report['remoteLayout'] = layout;

    vm.onAppBackgrounded();
    await vm.transcriptCache!.flush();
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
    report['seed'] = {'pid': pid};
  }

  Future<void> cloud(WidgetTester tester, {required bool v2}) async {
    final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
    if (v2) {
      repository.conversation = v2Snapshot(
        messages: [
          v2Message(id: 'human', text: 'Watch the release chat.'),
          v2Message(
            id: 'watcher',
            request: 'r2',
            seq: 2,
            text: _cloudEnvelope(),
          ),
        ],
      );
    } else {
      repository.bootstraps['chat-1'] = CloudChatBootstrap(
        messages: [
          for (final (id, text) in [
            ('human', 'Watch the release chat.'),
            ('watcher', _cloudEnvelope()),
          ])
            CloudCoreMessage(
              id: id,
              role: 'USER',
              text: text,
              cost: const CloudCoreCost(kind: CloudCoreCostKind.zero),
              costBilledViaLlmProxy: false,
              createdAtMs: id == 'human' ? 1789890000000 : 1789890001000,
              artifacts: const [],
            ),
        ],
        toolActivity: const [],
      );
    }
    final list = CloudChatsViewModel(repository: repository);
    final chat = CloudChatViewModel(
      repository: repository,
      openStream: (_, {after}) => const Stream.empty(),
      observeLifecycle: false,
    );
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
          ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
          ChangeNotifierProvider<ChatDraftStoreHolder>.value(
            value: ChatDraftStoreHolder(InMemoryChatDraftStore()),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: const CloudChatScreen(chatId: 'chat-1'),
        ),
      ),
    );
    await list.load();
    await list.ensureModels();
    await tester.pumpAndSettle();
    expect(find.text('$_cloudLabel watcher has fired'), findsOneWidget);
    expect(_key('watcher-bubble-watcher'), findsOneWidget);
    expect(_key('user-bubble-human'), findsOneWidget);
    _expectNoPrivateText();
    await tester.pumpWidget(const SizedBox.shrink());
    chat.dispose();
    list.dispose();
    report[v2 ? 'cloudV2' : 'cloudV1'] = 'watcher title shown';
  }

  Future<void> reopen(WidgetTester tester) async {
    final repository = Can3373Repository();
    final vm = launch(repository);
    await vm.connect('123456');
    await vm.transcriptCache!.restoreSession(kCan3373SessionId);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(can3373ChatHost(vm, _chat));
    await tester.pumpAndSettle();
    // The persisted tail paints before the server or desktop answers.
    expect(vm.isChatTranscriptLoading(_chat.target), isFalse);
    await tester.scrollUntilVisible(
      _key('watcher-title-single'),
      -200,
      scrollable: _transcript,
    );
    expect(find.text(_singleTitle), findsOneWidget);
    expect(_key('watcher-bubble-merged'), findsOneWidget);
    expect(_key('user-bubble-legacy'), findsOneWidget);
    await tester.tap(_key('watcher-title-merged'));
    await tester.pumpAndSettle();
    expect(_key('watcher-details-sheet'), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    report['reopen'] = {
      'pid': pid,
      'rows': [for (final row in vm.messagesFor(_chat.target)) row.messageId],
    };
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  }

  tearDownAll(() {
    binding.reportData = {...?binding.reportData, 'can4432': report};
    // ignore: avoid_print
    print('CAN4432_REPORT ${jsonEncode(report)}');
  });

  testWidgets('CAN-4432 watcher messages ($_phase)', (tester) async {
    if (_phase != 'reopen') {
      await remote(tester);
      await cloud(tester, v2: false);
      await cloud(tester, v2: true);
    }
    if (_phase != 'seed') await reopen(tester);
  });
}
