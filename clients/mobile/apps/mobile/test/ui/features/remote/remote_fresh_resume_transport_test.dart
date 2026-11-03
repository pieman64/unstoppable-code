// A resume after a long background, through the production repository and
// event stream against a server that pages the event log from the cursor.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show kRemoteFreshResumeAfter;

import '../../../support/cursor_portal_server.dart';

const _chat = RemoteStandaloneChatTarget(
  chatId: CursorPortalServer.chatId,
  projectLocalId: CursorPortalServer.projectId,
);

Map<String, dynamic> _reply(String text, {bool done = false}) => {
  'messageId': 'a2',
  'chatId': CursorPortalServer.chatId,
  'scope': 'standalone',
  'role': 'assistant',
  'status': done ? 'complete' : 'streaming',
  'text': text,
  'createdAtMs': 1792760000000,
};

void main() {
  late CursorPortalServer server;
  late RemoteControlViewModel vm;
  late DateTime now;

  String? replyText() => vm
      .messagesFor(_chat)
      .where((message) => message.messageId == 'a2')
      .firstOrNull
      ?.text;

  Future<void> settle(bool Function() done) async {
    for (var i = 0; i < 400 && !done(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(done(), isTrue);
  }

  setUp(() async {
    now = DateTime(2026, 10, 23, 12);
    server = CursorPortalServer()..upsertMessage(_reply('Progress update 0'));
    vm = RemoteControlViewModel(
      repository: server.repository(),
      clock: () => now,
    );
    await vm.restoreIfIdle();
    vm.ensureChatTranscript(_chat);
    await settle(() => replyText() == 'Progress update 0');
  });

  tearDown(() {
    vm.dispose();
    server.close();
  });

  /// The desktop keeps streaming while the phone is away.
  void streamWhileAway(int revisions) {
    for (var i = 1; i <= revisions; i++) {
      server.upsertMessage(_reply('Progress update $i'));
    }
    server.upsertMessage(_reply('Done: all $revisions steps.', done: true));
  }

  test('a long background reads the current transcript, skipping the '
      'backlog', () async {
    vm.onAppBackgrounded();
    streamWhileAway(300);
    final backlogEnd = server.cursor;
    final pollsBefore = server.pollCursors.length;
    now = now.add(kRemoteFreshResumeAfter);

    await vm.onAppForegrounded();
    // The open chat screen asks again on its next repaint.
    vm.ensureChatTranscript(_chat);
    await settle(() => replyText() == 'Done: all 300 steps.');

    final polls = server.pollCursors.sublist(pollsBefore);
    expect(polls, everyElement(greaterThanOrEqualTo(backlogEnd)));
    expect(server.transcriptRequests, 2);
  });

  test(
    'a late warm foreground cannot restart delivery during fresh recovery',
    () async {
      vm.setRemoteVisible(false);
      vm.onAppBackgrounded();
      now = now.add(const Duration(seconds: 10));
      final metadata = server.sessionReadGate = Completer<void>();
      final readsBefore = server.sessionReads;
      final warm = vm.onAppForegrounded();
      await settle(() => server.sessionReads > readsBefore);

      vm.onAppBackgrounded();
      streamWhileAway(300);
      now = now.add(kRemoteFreshResumeAfter);
      final overview = server.overviewReadGate = Completer<void>();
      final statesBefore = server.stateReads;
      final fresh = vm.onAppForegrounded();
      await settle(() => server.stateReads > statesBefore);
      final pollsBefore = server.pollCursors.length;
      metadata.complete();
      await warm;
      await Future<void>.delayed(const Duration(milliseconds: 30));
      final pollsWhileFresh = server.pollCursors.sublist(pollsBefore);

      final backlogEnd = server.cursor;
      overview.complete();
      await fresh;
      await settle(() => server.pollCursors.length > pollsBefore);
      expect(pollsWhileFresh, isEmpty);
      expect(
        server.pollCursors.sublist(pollsBefore),
        everyElement(greaterThanOrEqualTo(backlogEnd)),
      );
    },
  );

  test('a short background replays the backlog page by page', () async {
    vm.onAppBackgrounded();
    streamWhileAway(300);
    final pollsBefore = server.pollCursors.length;
    now = now.add(const Duration(seconds: 30));

    await vm.onAppForegrounded();
    // The open chat screen asks again on its next repaint.
    vm.ensureChatTranscript(_chat);
    await settle(() => replyText() == 'Done: all 300 steps.');

    expect(
      server.pollCursors.sublist(pollsBefore).length,
      greaterThanOrEqualTo(301 ~/ server.pageSize),
    );
    expect(server.transcriptRequests, 1);
  });
}
