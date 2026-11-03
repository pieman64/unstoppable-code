// Visual evidence for CAN-3556: durable drafts and unsent sends on mobile.
// @capture-keep: Retains deterministic mobile unsent-message visual evidence.
// @capture-reference: .playwright/can-3556/REPORT.md
//
// What changed: a user message that was not delivered stays in the transcript
// with `Not sent` or `Delivery uncertain`, its reason, and Resend/Discard; a
// composer reopens with its saved draft.
//
// Run from apps/mobile (before stage on a clean origin/develop worktree):
//   CAN3556_STAGE=before flutter test test/capture/can_3556_unsent_messages_capture_test.dart --update-goldens
//   CAN3556_STAGE=after  flutter test test/capture/can_3556_unsent_messages_capture_test.dart --update-goldens
//
// Deterministic: fake repositories with zero latency and an in-memory draft
// store; no desktop, agents, or network. Output goes to the gitignored
// `<repo>/.playwright/can-3556/`.
//
// Before stage: the draft store and the delivery footer do not exist on the old
// code, so the copy run there drops every `after-only:begin` ... `after-only:end`
// block and uncomments every `before-only:` line:
//   awk '/^\/\/ after-only:begin$/{skip=1;next} /^\/\/ after-only:end$/{skip=0;next} !skip{ sub(/^\/\/ before-only: ?/,""); print }' <this file> > <worktree copy>
// The flows, fixtures, and capture names stay identical, so each
// before/after pair shows the same screen: the row disappears and the text
// returns to the composer (RC), the failed send moves to a banner (cloud), and
// the remounted composer is empty.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';

// after-only:begin
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
// after-only:end

import '../support/fake_cloud_chat_repository.dart';
import '../support/fake_remote_control_repository.dart';

final String? _requestedStage = Platform.environment['CAN3556_STAGE'];
final String _stage = switch (_requestedStage) {
  null => 'after',
  'before' => 'before',
  'after' => 'after',
  final value => throw ArgumentError.value(
    value,
    'CAN3556_STAGE',
    'must be either "before" or "after"',
  ),
};

String _capture(String name, {required bool dark}) =>
    '../../../../.playwright/can-3556/$name-$_stage-${dark ? 'dark' : 'light'}.png';

// after-only:begin
typedef Drafts = ChatDraftStore;
Drafts _newDrafts() => InMemoryChatDraftStore();
List<SingleChildWidget> _draftProviders(Drafts drafts) => [
  ChangeNotifierProvider<ChatDraftStoreHolder>.value(
    value: ChatDraftStoreHolder(drafts),
  ),
];
CloudChatViewModel _cloudSession(
  FakeCloudChatRepository repository,
  Drafts drafts,
  List<StreamController<CloudSseFrame>> streams,
) => CloudChatViewModel(
  repository: repository,
  openStream: (_, {after}) {
    final controller = StreamController<CloudSseFrame>();
    streams.add(controller);
    return controller.stream;
  },
  observeLifecycle: false,
)..attachDraftStore(drafts);
// after-only:end
// before-only: typedef Drafts = Object;
// before-only: Drafts _newDrafts() => Object();
// before-only: List<SingleChildWidget> _draftProviders(Drafts drafts) => const [];
// before-only: CloudChatViewModel _cloudSession(
// before-only:   FakeCloudChatRepository repository,
// before-only:   Drafts drafts,
// before-only:   List<StreamController<CloudSseFrame>> streams,
// before-only: ) => CloudChatViewModel(
// before-only:   repository: repository,
// before-only:   openStream: (_, {after}) {
// before-only:     final controller = StreamController<CloudSseFrame>();
// before-only:     streams.add(controller);
// before-only:     return controller.stream;
// before-only:   },
// before-only:   observeLifecycle: false,
// before-only: );

Future<void> _loadFonts() async {
  await (FontLoader(
    'Inter',
  )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
}

void _usePhoneViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Future<void> _captureSurface(String name, {required bool dark}) async {
  final surface = find.byType(MaterialApp);
  expect(surface, findsOneWidget);
  if (_requestedStage == null) return;
  // No explicit directory creation: `--update-goldens` creates the parent
  // directories itself, and `matchesGoldenFile` resolves its path against the
  // *test file's* directory.
  await expectLater(surface, matchesGoldenFile(_capture(name, dark: dark)));
}

// ---------------------------------------------------------------------------
// Remote Control
// ---------------------------------------------------------------------------

const _models = [
  ModelOption(
    id: 'claude-sonnet',
    label: 'Claude Sonnet 4.5',
    provider: 'claude',
    vendor: 'anthropic',
    kind: 'model',
    available: true,
  ),
];

RemoteSessionSnapshot _rcSnapshot() => RemoteSessionSnapshot(
  workspaces: const [],
  worktrees: const [
    RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature/oauth',
    ),
  ],
  standaloneChats: const [],
  chatSummaries: [
    RemoteChatSummary(
      chatId: 'chat-1',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'OAuth work',
      active: true,
      providerType: 'claude',
      model: 'claude-sonnet',
      modelLabel: 'Claude Sonnet 4.5',
      thinkingLevel: 'off',
      providerAvailability: const ProviderAvailability(
        claude: true,
        codex: true,
      ),
      availableModels: _models,
      modelCatalogProjected: true,
    ),
  ],
  chatMessages: const [
    RemoteChatMessage(
      messageId: 'm-1',
      chatId: 'chat-1',
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: 'Wired the callback route and added a test.',
    ),
  ],
);

class _RcHarness {
  _RcHarness(this.repository, this.viewModel, this.drafts);

  final FakeRemoteControlRepository repository;
  final RemoteControlViewModel viewModel;
  final Drafts drafts;

  Widget app(bool dark, Widget home) => MultiProvider(
    providers: [
      ChangeNotifierProvider<RemoteControlViewModel>.value(value: viewModel),
      ChangeNotifierProvider<TurnFeedbackController>(
        create: (_) =>
            TurnFeedbackController(repository: MockTurnFeedbackRepository()),
      ),
      ..._draftProviders(drafts),
    ],
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: dark ? ThemeMode.dark : ThemeMode.light,
      home: home,
    ),
  );

  Widget get screen => RemoteChatScreen.worktree(
    worktree: viewModel.worktreesFor('ws-1').single,
  );
}

Future<_RcHarness> _pumpRc(WidgetTester tester, {required bool dark}) async {
  _usePhoneViewport(tester);
  final repository = FakeRemoteControlRepository()
    ..snapshotBuilder = _rcSnapshot;
  final viewModel = RemoteControlViewModel(
    repository: repository,
    stateRefreshDebounce: Duration.zero,
  );
  await tester.runAsync(() => viewModel.connect('123456'));
  final harness = _RcHarness(repository, viewModel, _newDrafts());
  await tester.pumpWidget(harness.app(dark, harness.screen));
  await tester.pumpAndSettle();
  return harness;
}

Future<void> _typeAndSend(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(const ValueKey('composer-draft')), text);
  await tester.pump();
  await tester.tap(find.byKey(const ValueKey('composer-send')));
  await tester.pumpAndSettle();
}

/// Tears the tree down and disposes the view model so its recovery and
/// hydration timers are cancelled before the pending-timer invariant runs.
Future<void> _finishRc(WidgetTester tester, _RcHarness rc) async {
  await tester.pumpWidget(const SizedBox.shrink());
  rc.viewModel.dispose();
}

String _composerText(WidgetTester tester) => tester
    .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
    .controller!
    .text;

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

class _CloudHarness {
  _CloudHarness(this.repository, this.list, this.chat, this.streams);

  final FakeCloudChatRepository repository;
  final CloudChatsViewModel list;
  final CloudChatViewModel chat;
  final List<StreamController<CloudSseFrame>> streams;

  Future<void> dispose() async {
    chat.dispose();
    list.dispose();
    for (final stream in streams) {
      await stream.close();
    }
  }
}

Future<_CloudHarness> _pumpCloud(
  WidgetTester tester, {
  required bool dark,
}) async {
  _usePhoneViewport(tester);
  final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
  final list = CloudChatsViewModel(repository: repository);
  final streams = <StreamController<CloudSseFrame>>[];
  final harness = _CloudHarness(
    repository,
    list,
    _cloudSession(repository, _newDrafts(), streams),
    streams,
  );
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
        ChangeNotifierProvider<CloudChatViewModel>.value(value: harness.chat),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: dark ? ThemeMode.dark : ThemeMode.light,
        home: const CloudChatScreen(chatId: 'chat-1'),
      ),
    ),
  );
  await list.load();
  await list.ensureModels();
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump();
  return harness;
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFonts();
  });

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';

    group('CAN-3556 captures ($mode)', () {
      testWidgets('RC worktree chat: send while the desktop is offline', (
        tester,
      ) async {
        final rc = await _pumpRc(tester, dark: dark);
        // A real disconnect resets the session and clears the transcript, so
        // the host row would vanish. The same row is produced by a rejected
        // send; the reason below is the exact offline copy the app uses.
        rc.repository.sendChatMessageHandler = () async =>
            throw const RemoteControlException('Your desktop is offline.');
        await _typeAndSend(tester, 'Run the OAuth tests again');

        if (_stage == 'after') {
          expect(find.text('Not sent'), findsOneWidget);
          expect(find.text('Your desktop is offline.'), findsOneWidget);
          expect(find.text('Resend'), findsOneWidget);
          expect(find.text('Discard'), findsOneWidget);
          expect(_composerText(tester), '');
        } else {
          // Before: no row; the text goes back to the composer.
          expect(find.text('Not sent'), findsNothing);
          expect(_composerText(tester), 'Run the OAuth tests again');
        }
        await _captureSurface('rc-not-sent', dark: dark);
        await _finishRc(tester, rc);
      });

      testWidgets('RC chat: delivery outcome unknown', (tester) async {
        final rc = await _pumpRc(tester, dark: dark);
        // The send is accepted by the transport but its outcome is lost, and
        // the host never echoes the message back.
        rc.repository.sendChatMessageHandler = () async =>
            throw const RemoteChatSendOutcomeUnknownException(
              'Connection interrupted',
            );
        await _typeAndSend(tester, 'Ship the callback route');
        // Let the bounded background recovery give up.
        await tester.pump(const Duration(seconds: 30));
        await tester.pumpAndSettle();

        if (_stage == 'after') {
          expect(find.text('Delivery uncertain'), findsOneWidget);
          expect(find.text('Resend'), findsOneWidget);
          expect(find.text('Discard'), findsOneWidget);
        } else {
          expect(find.text('Delivery uncertain'), findsNothing);
        }
        await _captureSurface('rc-uncertain', dark: dark);
        await _finishRc(tester, rc);
      });

      testWidgets('Cloud chat: a rejected send', (tester) async {
        final cloud = await _pumpCloud(tester, dark: dark);
        addTearDown(cloud.dispose);
        cloud.repository.postError = const CloudSendError(
          kind: CloudSendErrorKind.definitive,
          status: 400,
          message: 'bad request',
        );
        await _typeAndSend(tester, 'Draft the launch checklist');

        if (_stage == 'after') {
          expect(find.text('Not sent'), findsOneWidget);
          expect(find.text('bad request'), findsOneWidget);
          expect(find.text('Resend'), findsOneWidget);
          expect(find.text('Discard'), findsOneWidget);
        } else {
          expect(find.text('Not sent'), findsNothing);
        }
        await _captureSurface('cloud-not-sent', dark: dark);
      });

      testWidgets('RC chat reopened with the typed draft', (tester) async {
        final rc = await _pumpRc(tester, dark: dark);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Also cover the token refresh path',
        );
        await tester.pump();
        // Leave the chat, then open it again over the same view model and
        // draft store, as the app does after a chat switch or a restart.
        await tester.pumpWidget(rc.app(dark, const SizedBox()));
        await tester.pumpWidget(rc.app(dark, rc.screen));
        await tester.pumpAndSettle();

        if (_stage == 'after') {
          expect(_composerText(tester), 'Also cover the token refresh path');
        } else {
          expect(_composerText(tester), '');
        }
        await _captureSurface('rc-restored-draft', dark: dark);
        await _finishRc(tester, rc);
      });
    });
  }
}
