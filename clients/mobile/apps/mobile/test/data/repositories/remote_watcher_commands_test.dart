import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

void main() {
  late StreamController<RemotePortalEventBatch> events;
  late bool supported;
  late List<({String sessionId, String type, Map<String, dynamic> payload})>
  calls;
  late Future<RemotePortalCommandResult> Function() answer;

  RemoteWatcherCommands commands({
    Duration timeout = const Duration(seconds: 2),
  }) => RemoteWatcherCommands(
    hasCapability: (capability) => capability == 'chat_watchers' && supported,
    events: events.stream,
    completionTimeout: timeout,
    submit: (sessionId, {required type, required payload}) {
      calls.add((sessionId: sessionId, type: type, payload: payload));
      return answer();
    },
  );
  Future<void> remove({bool notify = false}) => commands().deleteWatcher(
    'session-1',
    'watch-1',
    notifySubscriber: notify,
  );
  void emit(RemotePortalEvent event) =>
      events.add(RemotePortalEventBatch(events: [event], nextCursor: 0));
  Matcher failure(RemoteWatcherDeleteFailure kind) => throwsA(
    isA<RemoteWatcherDeleteException>().having(
      (e) => e.failure,
      'failure',
      kind,
    ),
  );

  setUp(() {
    events = StreamController.broadcast(sync: true);
    supported = true;
    calls = [];
    answer = () async => const RemotePortalCommandResult(
      commandId: 'delete-1',
      result: {'ok': true},
    );
  });
  tearDown(() async {
    await events.close();
  });

  test(
    'sends a payload-only delete with the explicit notification choice',
    () async {
      await remove(notify: true);
      expect(calls.single.sessionId, 'session-1');
      expect(calls.single.type, 'portal.watcher.delete');
      expect(calls.single.payload, {
        'watcherId': 'watch-1',
        'notifySubscriber': true,
      });
      expect(events.hasListener, isFalse);
      await remove();
      expect(calls.last.payload['notifySubscriber'], isFalse);
    },
  );

  test('missing capability returns unsupported before sending', () async {
    supported = false;
    expect(commands().supportsChatWatchers, isFalse);
    await expectLater(
      remove(),
      failure(RemoteWatcherDeleteFailure.unsupported),
    );
    expect(calls, isEmpty);
    expect(events.hasListener, isFalse);
  });

  test(
    'queued is pending until this command completes, including an early event',
    () async {
      answer = () async {
        emit(
          const RemoteCommandCompletedEvent(
            commandId: 'delete-1',
            result: {'ok': true},
          ),
        );
        return const RemotePortalCommandResult(commandId: 'delete-1');
      };
      await remove();
      expect(events.hasListener, isFalse);
    },
  );

  test('another command completion cannot acknowledge this delete', () async {
    answer = () async => const RemotePortalCommandResult(commandId: 'delete-1');
    var done = false;
    final pending = remove().then((_) => done = true);
    await Future<void>.delayed(Duration.zero);
    emit(
      const RemoteCommandCompletedEvent(
        commandId: 'other',
        result: {'ok': true},
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(done, isFalse);
    emit(
      const RemoteCommandCompletedEvent(
        commandId: 'delete-1',
        result: {'ok': true},
      ),
    );
    await pending;
    expect(done, isTrue);
    expect(events.hasListener, isFalse);
  });

  for (final (code, kind) in [
    ('not_found_or_firing', RemoteWatcherDeleteFailure.notFoundOrFiring),
    ('forbidden', RemoteWatcherDeleteFailure.forbidden),
    ('unsupported_type', RemoteWatcherDeleteFailure.unsupported),
    ('execution_failed', RemoteWatcherDeleteFailure.failed),
    ('future_failure', RemoteWatcherDeleteFailure.failed),
  ]) {
    test('maps the typed $code refusal', () async {
      answer = () async {
        emit(
          RemoteCommandFailedEvent(
            commandId: 'delete-1',
            code: code,
            message: 'Refused',
          ),
        );
        return const RemotePortalCommandResult(commandId: 'delete-1');
      };
      await expectLater(remove(), failure(kind));
      expect(events.hasListener, isFalse);
    });
  }

  test('session end refuses the pending delete', () async {
    answer = () async {
      emit(const RemoteSessionEndedEvent());
      return const RemotePortalCommandResult(commandId: 'delete-1');
    };
    await expectLater(remove(), failure(RemoteWatcherDeleteFailure.forbidden));
  });

  test('an ended batch without events refuses the pending delete', () async {
    answer = () async => const RemotePortalCommandResult(commandId: 'delete-1');
    final expectation = expectLater(
      remove(),
      failure(RemoteWatcherDeleteFailure.forbidden),
    );
    await Future<void>.delayed(Duration.zero);
    events.add(
      const RemotePortalEventBatch(
        events: [],
        nextCursor: 0,
        connectionStatus: RemotePortalConnectionStatus.ended,
      ),
    );
    await expectation;
    expect(events.hasListener, isFalse);
  });

  for (final endsWithBatch in [false, true]) {
    test(
      'session end interrupts a pending submit (batch: $endsWithBatch)',
      () async {
        final submission = Completer<RemotePortalCommandResult>();
        answer = () => submission.future;
        final expectation = expectLater(
          remove(),
          failure(RemoteWatcherDeleteFailure.forbidden),
        );
        if (endsWithBatch) {
          events.add(
            const RemotePortalEventBatch(
              events: [],
              nextCursor: 0,
              connectionStatus: RemotePortalConnectionStatus.ended,
            ),
          );
        } else {
          emit(const RemoteSessionEndedEvent());
        }
        await expectation;
        expect(events.hasListener, isFalse);
        expect(calls, hasLength(1));
        // A late transport failure is handled after the caller has returned.
        submission.completeError(const ApiException(statusCode: 403, body: ''));
        await Future<void>.delayed(Duration.zero);
      },
    );
  }

  test('delivery stopping interrupts a pending submit', () async {
    final submission = Completer<RemotePortalCommandResult>();
    answer = () => submission.future;
    final expectation = expectLater(
      remove(),
      failure(RemoteWatcherDeleteFailure.failed),
    );
    await events.close();
    await expectation;
    expect(events.hasListener, isFalse);
    submission.complete(
      const RemotePortalCommandResult(
        commandId: 'delete-1',
        result: {'ok': true},
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(calls, hasLength(1));
  });

  test('HTTP authorization refusal is typed', () async {
    answer = () async => throw const ApiException(
      statusCode: 403,
      body: '{"error":"Forbidden"}',
    );
    await expectLater(remove(), failure(RemoteWatcherDeleteFailure.forbidden));
    expect(events.hasListener, isFalse);
  });

  test('a server that predates the command returns unsupported', () async {
    answer = () async => throw const ApiException(
      statusCode: 422,
      body: '{"error":"Unsupported portal command type"}',
    );
    await expectLater(
      remove(),
      failure(RemoteWatcherDeleteFailure.unsupported),
    );
    expect(events.hasListener, isFalse);
  });

  test(
    'no completion times out as unconfirmed, without retrying the delete',
    () async {
      answer = () async =>
          const RemotePortalCommandResult(commandId: 'delete-1');
      await expectLater(
        commands(
          timeout: Duration.zero,
        ).deleteWatcher('session-1', 'watch-1', notifySubscriber: false),
        failure(RemoteWatcherDeleteFailure.unconfirmed),
      );
      expect(calls, hasLength(1));
      expect(events.hasListener, isFalse);
    },
  );
}
