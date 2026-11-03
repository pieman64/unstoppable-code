import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_stream.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

void main() {
  late Completer<http.Response> submission;
  late HttpRemoteControlRepository repo;
  late int sends;
  late String sessionId;
  late StreamController<List<int>> sse;
  late Completer<void> outageWait;

  setUp(() {
    submission = Completer<http.Response>();
    sse = StreamController<List<int>>();
    outageWait = Completer<void>();
    sends = 0;
    sessionId = 'sess-1';
    final client = MockClient((request) async {
      if (request.url.path.endsWith('/session')) {
        return http.Response(
          jsonEncode({
            'session': {
              'id': sessionId,
              'status': 'active',
              'connectionStatus': 'active',
              'capabilities': {'chat_watchers': true},
            },
          }),
          200,
        );
      }
      if (request.url.path.endsWith('/connect')) {
        sessionId = 'sess-2';
        return http.Response(jsonEncode({'sessionId': sessionId}), 200);
      }
      expect(request.url.path, endsWith('/sessions/$sessionId/commands'));
      sends++;
      return sends == 1 ? submission.future : _success();
    });
    final api = ApiClient(
      baseUrl: 'https://example.test',
      tokenProvider: () => 'token',
      httpClient: client,
    );
    var eventConnections = 0;
    var waits = 0;
    repo = HttpRemoteControlRepository(
      recoveryClientFactory: () => client,
      service: RemoteControlApiService(apiClient: api),
      eventStream: PortalEventStream(
        baseUrl: 'https://example.test$portalBrowserBasePath',
        headersProvider: api.buildHeaders,
        clientFactory: () => MockClient.streaming((_, _) async {
          eventConnections++;
          return eventConnections == 1
              ? http.StreamedResponse(sse.stream, 200)
              : http.StreamedResponse(const Stream.empty(), 503);
        }),
        retryDelay: const Duration(milliseconds: 1),
        wait: (_) => ++waits == 1 ? Future.value() : outageWait.future,
      ),
    );
  });

  tearDown(() async {
    repo.clearLocalSession();
    if (!submission.isCompleted) submission.complete(_success());
    if (!outageWait.isCompleted) outageWait.complete();
    // No event transport is opened in the session-only tests.
    unawaited(sse.close());
    await pumpEventQueue();
  });

  Future<void> delete() => repo.watchers.deleteWatcher(
    sessionId,
    'watch-1',
    notifySubscriber: false,
  );

  Future<void> refusesPromptly(
    Future<void> pending,
    RemoteWatcherDeleteFailure failure,
    FutureOr<void> Function() interrupt,
  ) async {
    try {
      final expectation = expectLater(
        pending.timeout(const Duration(seconds: 1)),
        throwsA(
          isA<RemoteWatcherDeleteException>().having(
            (e) => e.failure,
            'failure',
            failure,
          ),
        ),
      );
      await interrupt();
      await expectation;
      expect(submission.isCompleted, isFalse);
    } finally {
      // A late inline success must neither change the outcome nor retry.
      submission.complete(_success());
      await pending.catchError((Object _) {});
    }
    expect(sends, 1);
  }

  for (final replace in [false, true]) {
    test(
      'watcher delete observes local session ${replace ? 'replacement' : 'clear'}',
      () async {
        await repo.restoreSession();
        final pending = delete();
        await pumpEventQueue();
        expect(sends, 1);
        await refusesPromptly(
          pending,
          RemoteWatcherDeleteFailure.forbidden,
          () async {
            if (replace) {
              await repo.connect('123456');
            } else {
              repo.clearLocalSession();
            }
          },
        );
        if (replace) {
          await delete();
          expect(sends, 2);
        }
      },
    );
  }

  test('watcher delete observes real event delivery outage', () async {
    await repo.restoreSession();
    final live = Completer<void>();
    final lost = Completer<void>();
    final liveness = repo.eventsLive.listen((value) {
      if (value && !live.isCompleted) live.complete();
      if (!value && !lost.isCompleted) lost.complete();
    });
    addTearDown(liveness.cancel);
    repo.resumeEvents();
    sse.add(utf8.encode(': connected\n\n'));
    await live.future;
    final pending = delete();
    await pumpEventQueue();
    await refusesPromptly(pending, RemoteWatcherDeleteFailure.failed, () async {
      await sse.close();
      // The next connection returns 503. The real repository keeps its public
      // events stream open and reports the outage through eventsLive instead.
      await lost.future;
    });
  });
}

http.Response _success() => http.Response(
  jsonEncode({
    'commandId': 'delete-1',
    'result': {'ok': true},
  }),
  200,
);
