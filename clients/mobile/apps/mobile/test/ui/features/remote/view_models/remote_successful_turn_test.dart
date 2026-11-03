import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../../support/fake_remote_control_repository.dart';

RemoteChatMessage _msg(
  String id,
  ChatRole role, {
  ChatMessageStatus status = ChatMessageStatus.complete,
  List<ChatPart> parts = const [],
  int at = 0,
}) => RemoteChatMessage(
  messageId: id,
  chatId: 'chat-1',
  role: role,
  status: status,
  text: id,
  parts: parts,
  updatedAt: DateTime.utc(2026, 9, 1).add(Duration(seconds: at)),
);

/// The live timer row as the desktop emits it: a system row that streams while
/// the turn runs and completes (keeping its id) when the turn ends.
RemoteChatMessage _timer({bool done = false, String? endReason, int at = 0}) =>
    _msg(
      'u1:turn-timer',
      ChatRole.system,
      status: done ? ChatMessageStatus.complete : ChatMessageStatus.streaming,
      at: at,
      parts: [
        ChatPart(
          kind: 'turn_timer',
          data: {
            'startedAt': 1000,
            'completedAt': done ? 9000 : null,
            'endReason': ?endReason,
          },
        ),
      ],
    );

RemotePortalEventBatch _batch(
  List<RemoteChatMessage> messages, {
  RemotePortalConnectionStatus? connectionStatus,
}) => RemotePortalEventBatch(
  connectionStatus: connectionStatus,
  events: [
    for (final m in messages)
      RemoteChatMessageEvent(
        chatId: 'chat-1',
        scope: RemoteChatScope.worktree,
        message: m,
      ),
  ],
  nextCursor: 1,
);

Future<void> _pump() => Future<void>.delayed(Duration.zero);

void main() {
  late FakeRemoteControlRepository repository;
  late List<String> keys;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<RemoteControlViewModel> connected() async {
    repository = FakeRemoteControlRepository();
    keys = [];
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      onSuccessfulTurn: keys.add,
    );
    await vm.connect('123456');
    return vm;
  }

  test('reports once when a watched turn timer completes cleanly', () async {
    await connected();
    repository.eventsController.add(
      _batch([
        _msg('u1', ChatRole.user),
        _timer(at: 1),
        _msg('a1', ChatRole.assistant, at: 2),
      ]),
    );
    await _pump();
    expect(keys, isEmpty);

    repository.eventsController.add(_batch([_timer(done: true, at: 3)]));
    await _pump();
    expect(keys, ['remote:chat-1:u1:turn-timer']);

    // A replayed completion is not a second success.
    repository.eventsController.add(_batch([_timer(done: true, at: 4)]));
    await _pump();
    expect(keys, ['remote:chat-1:u1:turn-timer']);
  });

  for (final reason in ['cancelled', 'failed']) {
    test('a turn the desktop ended as $reason is not counted', () async {
      await connected();
      repository.eventsController.add(
        _batch([
          _msg('u1', ChatRole.user),
          _timer(at: 1),
          _msg('a1', ChatRole.assistant, at: 2),
        ]),
      );
      await _pump();
      repository.eventsController.add(
        _batch([_timer(done: true, endReason: reason, at: 3)]),
      );
      await _pump();
      expect(keys, isEmpty);
    });
  }

  test('first sighting of an already-completed timer is not counted', () async {
    await connected();
    repository.eventsController.add(
      _batch([
        _msg('u1', ChatRole.user),
        _msg('a1', ChatRole.assistant, at: 1),
        _timer(done: true, at: 2),
      ]),
    );
    await _pump();
    expect(keys, isEmpty);
  });

  for (final status in [
    ChatMessageStatus.failed,
    ChatMessageStatus.cancelled,
  ]) {
    test('a $status turn is not counted', () async {
      await connected();
      repository.eventsController.add(
        _batch([
          _msg('u1', ChatRole.user),
          _timer(at: 1),
          _msg('a1', ChatRole.assistant, status: status, at: 2),
        ]),
      );
      await _pump();
      repository.eventsController.add(_batch([_timer(done: true, at: 3)]));
      await _pump();
      expect(keys, isEmpty);
    });
  }

  test(
    'a completion while the desktop link is degraded is not counted',
    () async {
      await connected();
      repository.eventsController.add(
        _batch([
          _msg('u1', ChatRole.user),
          _timer(at: 1),
          _msg('a1', ChatRole.assistant, at: 2),
        ]),
      );
      await _pump();
      repository.eventsController.add(
        _batch([
          _timer(done: true, at: 3),
        ], connectionStatus: RemotePortalConnectionStatus.reconnecting),
      );
      await _pump();
      expect(keys, isEmpty);
    },
  );
}
