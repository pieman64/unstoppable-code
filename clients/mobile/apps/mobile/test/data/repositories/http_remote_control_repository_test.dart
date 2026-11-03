import 'dart:async';
import 'package:mobile/data/models/remote_pr.dart';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_pairing_failure.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_decoder.dart';
import 'package:mobile/data/services/portal_event_stream.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

import '../../support/portal_event_workloads.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/data/repositories/remote_project_commands.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';

const _origin = 'https://example.test';

typedef _Handler = Future<http.Response> Function(http.Request request);

/// Builds a repository whose service AND event stream share one [MockClient].
HttpRemoteControlRepository _repository(_Handler handler) {
  final client = MockClient(handler);
  final apiClient = ApiClient(
    baseUrl: _origin,
    tokenProvider: () => 'token-1',
    httpClient: client,
  );
  return HttpRemoteControlRepository(
    recoveryClientFactory: () => client,
    service: RemoteControlApiService(apiClient: apiClient),
    eventStream: PortalEventStream(
      baseUrl: '$_origin$portalBrowserBasePath',
      headersProvider: apiClient.buildHeaders,
      clientFactory: () => client,
      confirmationClientFactory: () => client,
      retryDelay: Duration.zero,
    ),
  );
}

/// Shared state for [_StallableClient]s: answers normally until [stalled],
/// then holds every new request open the way a half-open socket does, with
/// no response and no error until its client is closed.
final class _StallableNetwork {
  bool stalled = false;
  final openRequests = <Completer<http.StreamedResponse>>[];
}

final class _StallableClient extends http.BaseClient {
  _StallableClient(this.network);

  final _StallableNetwork network;
  final _mine = <Completer<http.StreamedResponse>>[];
  var _closed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    // Matches IOClient, which rejects requests once closed.
    if (_closed) throw http.ClientException('Client is already closed.');
    if (!network.stalled) {
      final path = request.url.path;
      final body = path.endsWith('/session')
          ? _activeSessionJson()
          : path.endsWith('/connect')
          ? {'sessionId': 'sess-1', 'status': 'active'}
          : {
              'state': {
                'workspaces': [],
                'worktrees': [],
                'standaloneChats': [],
              },
              'connectionStatus': 'active',
              'eventCursor': 0,
            };
      return http.StreamedResponse(
        Stream.value(utf8.encode(jsonEncode(body))),
        200,
      );
    }
    final pending = Completer<http.StreamedResponse>();
    network.openRequests.add(pending);
    _mine.add(pending);
    // Like IOClient on an established connection, an aborted request
    // releases its own socket. A connection still being established ignores
    // the abort; portal_read_client_test.dart covers that on a real IOClient.
    if (request case http.Abortable(:final abortTrigger?)) {
      unawaited(abortTrigger.whenComplete(() => _release(pending)));
    }
    return pending.future;
  }

  void _release(Completer<http.StreamedResponse> pending) {
    network.openRequests.remove(pending);
    _mine.remove(pending);
    if (!pending.isCompleted) {
      pending.completeError(http.RequestAbortedException());
    }
  }

  @override
  void close() {
    _closed = true;
    for (final pending in _mine) {
      network.openRequests.remove(pending);
      if (!pending.isCompleted) {
        pending.completeError(http.ClientException('Connection closed'));
      }
    }
    _mine.clear();
  }
}

/// Forwards to [inner], counting sends and whether the owner closed it.
final class _CountingClient extends http.BaseClient {
  _CountingClient(this.inner);

  final http.Client inner;
  var sends = 0;
  var closed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    sends += 1;
    return inner.send(request);
  }

  @override
  void close() => closed = true;
}

HttpRemoteControlRepository _stallableRepository(_StallableNetwork network) {
  final apiClient = ApiClient(
    baseUrl: _origin,
    tokenProvider: () => 'token-1',
    httpClient: _StallableClient(network),
  );
  return HttpRemoteControlRepository(
    recoveryClientFactory: () => _StallableClient(network),
    service: RemoteControlApiService(apiClient: apiClient),
    eventStream: PortalEventStream(
      baseUrl: '$_origin$portalBrowserBasePath',
      headersProvider: apiClient.buildHeaders,
      clientFactory: () => _StallableClient(network),
      confirmationClientFactory: () => _StallableClient(network),
    ),
  );
}

Map<String, dynamic> _activeSessionJson() => {
  // Explicitly dynamic so tests can add non-string fields (capabilities).
  'session': <String, dynamic>{
    'id': 'sess-1',
    'status': 'active',
    'connectionStatus': 'active',
    'clientName': "Alex's MacBook Pro",
    'activatedAt': '2026-07-16T09:00:00Z',
  },
};

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status);

/// Holds every offloaded event decode until the test releases it.
final class _GatedDecodes {
  final gates = <Completer<void>>[];

  Future<R> run<R>(
    FutureOr<R> Function() computation, {
    String? debugName,
  }) async {
    final gate = Completer<void>();
    gates.add(gate);
    await gate.future;
    return computation();
  }
}

/// A repository whose `/session` read reports [sessionId] and whose event
/// stream answers through [events]; batches of 1 KiB or more decode through
/// [decodes].
HttpRemoteControlRepository _decodingRepository({
  required String Function() sessionId,
  required Future<http.StreamedResponse> Function(http.BaseRequest request)
  events,
  required _GatedDecodes decodes,
}) {
  final client = MockClient.streaming((request, _) async {
    if (request.url.path.endsWith('/session')) {
      final body = _activeSessionJson();
      (body['session'] as Map<String, dynamic>)['id'] = sessionId();
      return http.StreamedResponse(
        Stream.value(utf8.encode(jsonEncode(body))),
        200,
      );
    }
    return events(request);
  });
  final apiClient = ApiClient(
    baseUrl: _origin,
    tokenProvider: () => 'token-1',
    httpClient: client,
  );
  return HttpRemoteControlRepository(
    recoveryClientFactory: () => client,
    service: RemoteControlApiService(apiClient: apiClient),
    eventStream: PortalEventStream(
      baseUrl: '$_origin$portalBrowserBasePath',
      headersProvider: apiClient.buildHeaders,
      clientFactory: () => client,
      confirmationClientFactory: () => client,
      retryDelay: Duration.zero,
      wait: (_) async {},
      decoder: PortalEventDecoder(offloadThreshold: 1024, runner: decodes.run),
    ),
  );
}

void main() {
  test(
    'watcher commands use session capabilities and the payload-only Portal route',
    () async {
      var support = true;
      final requests = <Map<String, dynamic>>[];
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/session')) {
          final body = _activeSessionJson();
          (body['session'] as Map<String, dynamic>)['capabilities'] = {
            'chat_watchers': support,
          };
          return _json(body);
        }
        expect(request.url.path, endsWith('/sessions/sess-1/commands'));
        requests.add(jsonDecode(request.body) as Map<String, dynamic>);
        return _json({
          'commandId': 'delete-1',
          'result': {'ok': true},
        });
      });
      expect(repo.watchers.supportsChatWatchers, isFalse);
      await repo.restoreSession();
      expect(repo.watchers.supportsChatWatchers, isTrue);
      await repo.watchers.deleteWatcher(
        'sess-1',
        'watch-1',
        notifySubscriber: true,
      );
      expect(requests.single, {
        'type': 'portal.watcher.delete',
        'payload': {'watcherId': 'watch-1', 'notifySubscriber': true},
      });
      await expectLater(
        repo.watchers.deleteWatcher(
          'other-session',
          'watch-1',
          notifySubscriber: false,
        ),
        throwsA(
          isA<RemoteWatcherDeleteException>().having(
            (e) => e.failure,
            'failure',
            RemoteWatcherDeleteFailure.forbidden,
          ),
        ),
      );
      expect(requests, hasLength(1));
      support = false;
      await repo.refreshSessionMetadata();
      expect(repo.watchers.supportsChatWatchers, isFalse);
      await expectLater(
        repo.watchers.deleteWatcher(
          'sess-1',
          'watch-1',
          notifySubscriber: false,
        ),
        throwsA(
          isA<RemoteWatcherDeleteException>().having(
            (e) => e.failure,
            'failure',
            RemoteWatcherDeleteFailure.unsupported,
          ),
        ),
      );
      expect(requests, hasLength(1));
      repo.clearLocalSession();
      expect(repo.watchers.supportsChatWatchers, isFalse);
    },
  );

  test('archive uses server permission and exact worktree target', () async {
    var allowed = true;
    final commands = <Map<String, dynamic>>[];
    final repo = _repository((request) async {
      if (request.url.path.endsWith('/session')) {
        final body = _activeSessionJson();
        (body['session'] as Map<String, dynamic>).addAll({
          if (allowed) 'destructiveActionsEnabled': true,
          'capabilities': {'portal-v1': true, 'worktree_actions_scope': true},
        });
        return _json(body);
      }
      commands.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json({'commandId': 'archive-1'});
    });
    await repo.restoreSession();
    expect(repo.canArchiveWorktrees, isTrue);
    expect(
      await repo.archiveWorktree(workspaceLocalId: 'ws', worktreeLocalId: 'wt'),
      'archive-1',
    );
    expect(commands.single, {
      'type': 'portal.worktree.archive',
      'target': {'workspaceLocalId': 'ws', 'worktreeLocalId': 'wt'},
      'payload': {'workspaceId': 'ws', 'worktreeId': 'wt'},
    });
    allowed = false;
    await repo.restoreSession();
    expect(repo.canArchiveWorktrees, isFalse);
    expect(
      () => repo.archiveWorktree(workspaceLocalId: 'ws', worktreeLocalId: 'wt'),
      throwsA(isA<RemoteControlException>()),
    );
    expect(commands, hasLength(1));
  });

  test('the connection carries the space notification gate', () async {
    var enabled = true;
    final repo = _repository((request) async {
      final body = _activeSessionJson();
      if (enabled) {
        (body['session']
                as Map<String, dynamic>)['spaceNotificationSettingsEnabled'] =
            true;
      }
      return _json(body);
    });
    expect(
      (await repo.restoreSession())?.spaceNotificationSettingsEnabled,
      isTrue,
    );
    expect(
      (await repo.refreshSessionMetadata())?.spaceNotificationSettingsEnabled,
      isTrue,
    );
    enabled = false;
    expect(
      (await repo.refreshSessionMetadata())?.spaceNotificationSettingsEnabled,
      isFalse,
    );
  });

  test(
    'archive does not depend on unrelated batched-snapshot capabilities',
    () async {
      for (final capabilities in [
        <String, bool>{},
        {'portal-v1': true, 'worktree_actions_scope': false},
      ]) {
        final repo = _repository(
          (request) async => _json({
            'session': {
              'id': 'sess-1',
              'status': 'active',
              'connectionStatus': 'active',
              'destructiveActionsEnabled': true,
              'capabilities': capabilities,
            },
          }),
        );
        await repo.restoreSession();
        expect(repo.canArchiveWorktrees, isTrue);
      }
    },
  );

  group('event transport recovery', () {
    test(
      'keeps retrying the paired session when another session is newer',
      () async {
        var eventReads = 0;
        var sessionReads = 0;
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            sessionReads++;
            final session = _activeSessionJson();
            if (sessionReads > 1) {
              (session['session'] as Map<String, dynamic>)['id'] = 'sess-2';
            }
            return _json(session);
          }
          eventReads++;
          if (eventReads == 1) {
            return _json({'error': 'unavailable'}, 401);
          }
          return http.Response(
            'event: batch\ndata: {"events":[],"nextCursor":7,"connectionStatus":"active"}\n\n',
            200,
          );
        });
        await repo.restoreSession();
        final batch = repo.events.first;
        repo.resumeEvents();
        final recovered = await batch.timeout(const Duration(seconds: 2));
        repo.pauseEvents();

        expect(recovered.events.whereType<RemoteSessionEndedEvent>(), isEmpty);
        expect(recovered.nextCursor, 7);
        expect(eventReads, 2);
        expect(sessionReads, 2);
      },
    );

    for (final transportStatus in [401, 403, 404]) {
      for (final probeStatus in [200, 404, 503]) {
        test(
          'reconnects after gated events with session probe $probeStatus and transport $transportStatus',
          () async {
            var eventReads = 0;
            var sessionReads = 0;
            final repo = _repository((request) async {
              if (request.url.path.endsWith('/session')) {
                sessionReads++;
                return sessionReads == 1 || probeStatus == 200
                    ? _json(_activeSessionJson())
                    : _json({'error': 'temporarily unavailable'}, probeStatus);
              }
              eventReads++;
              if (eventReads <= (transportStatus == 404 ? 2 : 1)) {
                return _json({'error': 'unavailable'}, transportStatus);
              }
              if (request.url.path.endsWith('/stream')) {
                return http.Response(
                  'event: batch\ndata: {"events":[],"nextCursor":7,"connectionStatus":"active"}\n\n',
                  200,
                );
              }
              return _json({
                'events': [],
                'nextCursor': 7,
                'connectionStatus': 'active',
              });
            });
            await repo.restoreSession();
            final batch = repo.events.first;
            repo.resumeEvents();
            final recovered = await batch.timeout(const Duration(seconds: 2));
            repo.pauseEvents();
            expect(
              recovered.events.whereType<RemoteSessionEndedEvent>(),
              isEmpty,
            );
            expect(recovered.nextCursor, 7);
            expect(sessionReads, 2);
          },
        );
      }
    }
  });

  group('mobile pull requests', () {
    test(
      'advertised capability enables repo-scoped commands without losing acknowledgement ids',
      () async {
        final commands = <Map<String, dynamic>>[];
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/commands')) {
            commands.add(jsonDecode(request.body) as Map<String, dynamic>);
            return _json({'commandId': 'pr-command'}, 202);
          }
          final session = _activeSessionJson();
          (session['session'] as Map<String, dynamic>)['capabilities'] = {
            'pr_worktree_actions': true,
            'pr_status_push_v1': true,
          };
          return _json(session);
        });
        await repo.restoreSession();
        expect(repo.supportsPrActions, isTrue);
        expect(repo.supportsPrStatusPush, isTrue);
        final result = await repo.runPrAction(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          action: RemotePrAction.merge,
          repoId: 'app',
          identity: const RemotePrActionIdentity(
            baseBranch: 'develop',
            headBranch: 'feature',
            prNumber: 42,
          ),
          confirmUnresolvedComments: true,
        );
        expect(result.commandId, 'pr-command');
        expect(result.result, isNull);
        expect(commands.single, {
          'type': 'portal.pr.action',
          'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
          'payload': {
            'workspaceLocalId': 'ws-1',
            'worktreeLocalId': 'wt-1',
            'action': 'merge',
            'repoIds': ['app'],
            'expectedBaseBranch': 'develop',
            'expectedHeadBranch': 'feature',
            'expectedPrNumber': 42,
            'confirmUnresolvedComments': true,
          },
        });
      },
    );
    test('older desktops cannot receive a PR mutation', () async {
      var commands = 0;
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/commands')) commands++;
        return _json(_activeSessionJson());
      });
      await repo.restoreSession();
      expect(repo.supportsPrActions, isFalse);
      await expectLater(
        repo.runPrAction(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          action: RemotePrAction.create,
          repoId: 'app',
        ),
        throwsA(isA<RemoteControlException>()),
      );
      expect(commands, 0);
    });
  });

  group('mobile read acknowledgement', () {
    for (final capable in [false, true]) {
      test('gates read commands on desktop capability: $capable', () async {
        final commands = <Map<String, dynamic>>[];
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/commands')) {
            commands.add(jsonDecode(request.body) as Map<String, dynamic>);
            return _json({'commandId': 'read-1'}, 202);
          }
          final session = _activeSessionJson();
          (session['session'] as Map<String, dynamic>)['capabilities'] = {
            'chat_mark_read': capable,
          };
          return _json(session);
        });
        await repo.restoreSession();
        const target = RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          chatId: 'chat-1',
        );
        await repo.markChatRead(target, 'reply-1');
        expect(commands, hasLength(capable ? 1 : 0));
        if (capable) {
          expect(commands.single, {
            'type': 'portal.chat.mark_read',
            'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
            'payload': {
              'scope': 'worktree',
              'projectId': 'ws-1',
              'worktreeId': 'wt-1',
              'chatId': 'chat-1',
              'lastMessageId': 'reply-1',
            },
          });
          await repo.markChatRead(
            const RemoteStandaloneChatTarget(
              projectLocalId: 'cowork-1',
              chatId: 'chat-2',
            ),
            'reply-2',
          );
          expect(commands.last['payload'], {
            'scope': 'standalone',
            'projectLocalId': 'cowork-1',
            'chatId': 'chat-2',
            'lastMessageId': 'reply-2',
          });
        }
      });
    }
  });

  group('connect', () {
    test(
      'rejects a malformed code locally without hitting the network',
      () async {
        var requests = 0;
        final repo = _repository((request) async {
          requests += 1;
          return _json(const {});
        });

        await expectLater(
          repo.connect('12345'),
          throwsA(isA<RemoteControlException>()),
        );
        expect(requests, 0);
      },
    );

    test('redeems the code and reads session metadata', () async {
      final paths = <String>[];
      final repo = _repository((request) async {
        paths.add(request.url.path);
        if (request.url.path.endsWith('/connect')) {
          expect(jsonDecode(request.body), {'code': '123456'});
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        return _json(_activeSessionJson());
      });

      final connection = await repo.connect('123456');
      expect(connection.deviceLabel, "Alex's MacBook Pro");
      expect(paths, [
        '$portalBrowserBasePath/connect',
        '$portalBrowserBasePath/session',
      ]);
    });

    test('maps a rejection to a user-presentable message', () async {
      final repo = _repository(
        (request) async => _json({'error': 'Code not recognized.'}, 401),
      );

      await expectLater(
        repo.connect('654321'),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'Code not recognized.',
          ),
        ),
      );
    });
  });

  group('connect failures', () {
    const noDesktopError =
        'No pending remote control session was found for this account.';

    Future<RemoteControlException> failure(int status, String body) async {
      final repo = _repository((request) async => http.Response(body, status));
      try {
        await repo.connect('123456');
      } on RemoteControlException catch (error) {
        return error;
      }
      fail('connect succeeded');
    }

    Future<String> failureMessage(int status, String body) async =>
        (await failure(status, body)).message;

    // CAN-4426: no desktop is pending or heartbeating, so no code can work
    // until one is opened. Keyed off the code, never the message text.
    test('maps no_eligible_desktop to instructions for the desktop', () async {
      final error = await failure(
        404,
        jsonEncode({'error': noDesktopError, 'code': 'no_eligible_desktop'}),
      );

      expect(error, isA<RemoteNoDesktopForCodeException>());
      expect(error.message, isNot(contains('No pending')));
    });

    test('keeps every other failure as before', () async {
      final cases = <(int, String, String)>[
        // An older server without the code.
        (404, jsonEncode({'error': noDesktopError}), noDesktopError),
        // An unknown code.
        (
          404,
          jsonEncode({'error': noDesktopError, 'code': 'something_else'}),
          noDesktopError,
        ),
        // The code on an unexpected status.
        (
          400,
          jsonEncode({
            'error': 'Code must be 6 digits.',
            'code': 'no_eligible_desktop',
          }),
          'Code must be 6 digits.',
        ),
        // Bodies without a usable message.
        (404, '[]', 'Remote Control is not available for your account yet.'),
        (
          404,
          'not json',
          'Remote Control is not available for your account yet.',
        ),
        (
          401,
          '',
          'That code was not recognized. Check your desktop and try again.',
        ),
        (
          403,
          '',
          'That code was not recognized. Check your desktop and try again.',
        ),
        (429, '', 'Too many attempts. Wait a few minutes and try again.'),
        (500, '', 'Pairing failed. Check your desktop and try again.'),
        (
          404,
          jsonEncode({
            'error':
                'That code did not match. Check the code in Canopy and try '
                'again.',
          }),
          'That code did not match. Check the code in Canopy and try again.',
        ),
      ];
      for (final (status, body, message) in cases) {
        expect(
          await failureMessage(status, body),
          message,
          reason: '$status $body',
        );
      }
    });
  });

  group('restoreSession', () {
    test('restores an active session', () async {
      final repo = _repository((request) async => _json(_activeSessionJson()));
      final connection = await repo.restoreSession();
      expect(connection, isNotNull);
      expect(connection?.deviceLabel, "Alex's MacBook Pro");
    });

    test('returns null when there is no session', () async {
      final repo = _repository((request) async => _json({'session': null}));
      expect(await repo.restoreSession(), isNull);
    });

    test('returns null for a pending_auth session', () async {
      final repo = _repository(
        (request) async => _json({
          'session': {'id': 'sess-1', 'status': 'pending_auth'},
        }),
      );
      expect(await repo.restoreSession(), isNull);
    });

    test(
      'restores a stale-but-revivable inactive session (CAN-2651)',
      () async {
        // The server sweep flags a session whose desktop heartbeat lapsed past
        // 90s as inactive while leaving it revivable. Rejecting it here dropped
        // the user to the pairing form for a session about to heal on its own.
        final repo = _repository(
          (request) async => _json({
            'session': {
              'id': 'sess-1',
              'status': 'inactive',
              'connectionStatus': 'inactive',
              'clientName': "Alex's MacBook Pro",
              'activatedAt': '2026-07-16T09:00:00Z',
              'lastSeenAt': '2026-07-16T09:05:00Z',
            },
          }),
        );

        final connection = await repo.restoreSession();

        expect(connection, isNotNull);
        expect(connection?.deviceLabel, "Alex's MacBook Pro");
        // Carried through so the shell can render its degraded banner at once.
        expect(
          connection?.connectionStatus,
          RemotePortalConnectionStatus.inactive,
        );
        expect(connection?.lastSeenAt, DateTime.parse('2026-07-16T09:05:00Z'));
      },
    );

    test('returns null for an ended session', () async {
      final repo = _repository(
        (request) async => _json({
          'session': {
            'id': 'sess-1',
            'status': 'inactive',
            'connectionStatus': 'ended',
          },
        }),
      );
      expect(await repo.restoreSession(), isNull);
    });

    test('returns null when the route errors (signed out / gated)', () async {
      final repo = _repository((request) async => _json(const {}, 404));
      expect(await repo.restoreSession(), isNull);
    });
  });

  group('large event decodes across session changes (CAN-3372)', () {
    final largeFrame = sseFrame(
      chatSnapshotBatchJson(messages: 2, targetChars: 4096, nextCursor: 50),
    );

    test('a replaced session never receives the old decode', () async {
      final decodes = _GatedDecodes();
      var current = 'sess-1';
      final held = StreamController<List<int>>();
      final eventRequests = <Uri>[];
      final repo = _decodingRepository(
        sessionId: () => current,
        decodes: decodes,
        events: (request) async {
          eventRequests.add(request.url);
          if (request.url.path.contains('/sessions/sess-1/')) {
            return http.StreamedResponse(
              Stream.value(utf8.encode(largeFrame)),
              200,
            );
          }
          held.add(
            utf8.encode(sseFrame(streamingMessageBatchJson(nextCursor: 3))),
          );
          return http.StreamedResponse(held.stream, 200);
        },
      );
      final cursors = <int>[];
      final subscription = repo.events.listen(
        (batch) => cursors.add(batch.nextCursor),
      );
      await repo.restoreSession();
      repo.resumeEvents();
      await pumpEventQueue();
      expect(decodes.gates, hasLength(1));

      // A local reset and restore adopt the replacement session while the
      // old session's snapshot is still decoding.
      repo.clearLocalSession();
      current = 'sess-2';
      await repo.restoreSession();
      repo.resumeEvents();
      await pumpEventQueue();
      decodes.gates.single.complete();
      await pumpEventQueue();

      expect(cursors, [3]);
      final replacement = eventRequests.where(
        (uri) => uri.path.contains('/sessions/sess-2/'),
      );
      expect(replacement.single.queryParameters['after'], '0');
      expect(
        eventRequests.where((uri) => uri.path.contains('/sessions/sess-1/')),
        hasLength(1),
      );
      repo.pauseEvents();
      await subscription.cancel();
      await held.close();
    });

    test(
      'pausing during a decode resumes from the last delivered cursor',
      () async {
        final decodes = _GatedDecodes();
        final held = StreamController<List<int>>();
        final eventRequests = <Uri>[];
        final repo = _decodingRepository(
          sessionId: () => 'sess-1',
          decodes: decodes,
          events: (request) async {
            eventRequests.add(request.url);
            if (eventRequests.length == 1) {
              return http.StreamedResponse(
                Stream.value(
                  utf8.encode(
                    sseFrame(streamingMessageBatchJson(nextCursor: 7)) +
                        largeFrame,
                  ),
                ),
                200,
              );
            }
            held.add(
              utf8.encode(sseFrame(streamingMessageBatchJson(nextCursor: 51))),
            );
            return http.StreamedResponse(held.stream, 200);
          },
        );
        final cursors = <int>[];
        final subscription = repo.events.listen(
          (batch) => cursors.add(batch.nextCursor),
        );
        await repo.restoreSession();
        repo.resumeEvents();
        await pumpEventQueue();
        expect(cursors, [7]);
        expect(decodes.gates, hasLength(1));

        // Backgrounding pauses the channel mid-decode; the late result is
        // dropped and the resumed channel replays from the last delivery.
        repo.pauseEvents();
        decodes.gates.single.complete();
        await pumpEventQueue();
        expect(cursors, [7]);
        repo.resumeEvents();
        await pumpEventQueue();

        expect(cursors, [7, 51]);
        expect(eventRequests, hasLength(2));
        expect(eventRequests.last.queryParameters['after'], '7');
        repo.pauseEvents();
        await subscription.cancel();
        await held.close();
      },
    );
  });

  group('eventsLive', () {
    test('reports the subscription answering and stops on pause', () async {
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/session')) {
          return _json(_activeSessionJson());
        }
        return http.Response(': connected\n\n', 200);
      });
      await repo.restoreSession();
      final live = <bool>[];
      final subscription = repo.eventsLive.listen(live.add);

      repo.resumeEvents();
      await pumpEventQueue();
      repo.pauseEvents();
      await pumpEventQueue();

      expect(live.first, isTrue);
      await subscription.cancel();
    });
  });

  group('pooled reads (CAN-4873)', () {
    const chat = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );
    final stateBody = {
      'state': {
        'workspaces': [],
        'worktrees': [],
        'standaloneChats': [],
        'chatMessages': [],
      },
      'connectionStatus': 'active',
      'refreshing': false,
      'eventCursor': 3,
    };

    test('session, overview and chat-cache reads share one client', () async {
      final created = <_CountingClient>[];
      final inner = MockClient((request) async {
        if (request.url.path.endsWith('/session')) {
          return _json(_activeSessionJson());
        }
        return _json(stateBody);
      });
      final apiClient = ApiClient(
        baseUrl: _origin,
        tokenProvider: () => 'token-1',
        httpClient: inner,
      );
      final repo = HttpRemoteControlRepository(
        recoveryClientFactory: () {
          final client = _CountingClient(inner);
          created.add(client);
          return client;
        },
        service: RemoteControlApiService(apiClient: apiClient),
        eventStream: PortalEventStream(
          baseUrl: '$_origin$portalBrowserBasePath',
          headersProvider: apiClient.buildHeaders,
          clientFactory: () => inner,
        ),
      );

      await repo.restoreSession();
      await repo.fetchSnapshot();
      await repo.fetchCachedChatMessages(chat);
      await repo.refreshSessionMetadata();

      expect(created, hasLength(1));
      expect(created.single.sends, 4);
      expect(created.single.closed, isFalse);

      // Backgrounding retires the pool; the next read opens a fresh one.
      repo.pauseEvents();
      expect(created.single.closed, isTrue);
      await repo.fetchSnapshot();
      expect(created, hasLength(2));
      repo.clearLocalSession();
      expect(created.last.closed, isTrue);
    });

    test('consecutive reads reuse one real connection', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final connections = <int>[];
      server.listen((request) {
        connections.add(request.connectionInfo!.remotePort);
        final body = request.uri.path.endsWith('/session')
            ? _activeSessionJson()
            : stateBody;
        request.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(body));
        unawaited(request.response.close());
      });
      final apiClient = ApiClient(
        baseUrl: 'http://127.0.0.1:${server.port}',
        tokenProvider: () => 'token-1',
      );
      // Production transports: the default read pool and event stream.
      final repo = HttpRemoteControlRepository(
        service: RemoteControlApiService(apiClient: apiClient),
        eventStream: PortalEventStream(
          baseUrl: '${apiClient.baseUrl}$portalBrowserBasePath',
          headersProvider: apiClient.buildHeaders,
        ),
      );
      addTearDown(repo.clearLocalSession);

      await repo.restoreSession();
      await repo.fetchSnapshot();
      await repo.fetchCachedChatMessages(chat);
      await repo.refreshSessionMetadata();

      expect(connections, hasLength(4));
      expect(connections.toSet(), hasLength(1));
    });

    for (final (name, sessionId, wakes) in [
      ('the held session', 'sess-1', true),
      ('another session', 'sess-2', false),
    ]) {
      test('active metadata for $name ${wakes ? 'wakes' : 'does not wake'} '
          'a pending reconnect', () async {
        var streams = 0;
        var connectionStatus = 'inactive';
        var currentSessionId = 'sess-1';
        final waits = <Duration>[];
        final client = MockClient((request) async {
          if (request.url.path.endsWith('/session')) {
            final body = _activeSessionJson();
            (body['session'] as Map<String, dynamic>)
              ..['id'] = currentSessionId
              ..['connectionStatus'] = connectionStatus;
            return _json(body);
          }
          streams += 1;
          return http.Response(
            'event: batch\ndata: {"events":[],"nextCursor":4,'
            '"connectionStatus":"$connectionStatus"}\n\n',
            200,
          );
        });
        final apiClient = ApiClient(
          baseUrl: _origin,
          tokenProvider: () => 'token-1',
          httpClient: client,
        );
        final repo = HttpRemoteControlRepository(
          recoveryClientFactory: () => client,
          service: RemoteControlApiService(apiClient: apiClient),
          eventStream: PortalEventStream(
            baseUrl: '$_origin$portalBrowserBasePath',
            headersProvider: apiClient.buildHeaders,
            clientFactory: () => client,
            confirmationClientFactory: () => client,
            random: () => 1.0,
            // Only a wake can end a wait.
            wait: (delay) {
              waits.add(delay);
              return Completer<void>().future;
            },
          ),
        );
        await repo.restoreSession();
        repo.resumeEvents();
        await pumpEventQueue();
        expect(streams, 1);
        expect(waits, const [Duration(seconds: 4)]);

        // The next metadata read reports a desktop active.
        connectionStatus = 'active';
        currentSessionId = sessionId;
        await repo.refreshSessionMetadata();
        await pumpEventQueue();

        expect(streams, wakes ? 2 : 1);
        repo.pauseEvents();
      });
    }

    // A metadata read that started for an earlier subscription answers about
    // that subscription; it must not wake its replacement.
    group('a stale metadata read', () {
      late Completer<http.Response> heldRead;
      late Completer<http.StreamedResponse> firstStream;
      late int streams;
      late int sessionReads;
      late List<Duration> waits;
      late HttpRemoteControlRepository repo;

      http.Response session(String connectionStatus) {
        final body = _activeSessionJson();
        (body['session'] as Map<String, dynamic>)['connectionStatus'] =
            connectionStatus;
        return _json(body);
      }

      setUp(() {
        heldRead = Completer();
        firstStream = Completer();
        streams = 0;
        sessionReads = 0;
        waits = [];
        final client = MockClient.streaming((request, _) async {
          if (request.url.path.endsWith('/session')) {
            sessionReads += 1;
            final response = sessionReads == 1
                ? session('inactive')
                : await heldRead.future;
            return http.StreamedResponse(
              Stream.value(response.bodyBytes),
              response.statusCode,
            );
          }
          streams += 1;
          if (streams == 1) return firstStream.future;
          return http.StreamedResponse(
            Stream.value(
              utf8.encode(
                'event: batch\ndata: {"events":[],"nextCursor":4,'
                '"connectionStatus":"inactive"}\n\n',
              ),
            ),
            200,
          );
        });
        final apiClient = ApiClient(
          baseUrl: _origin,
          tokenProvider: () => 'token-1',
          httpClient: client,
        );
        repo = HttpRemoteControlRepository(
          recoveryClientFactory: () => client,
          service: RemoteControlApiService(apiClient: apiClient),
          eventStream: PortalEventStream(
            baseUrl: '$_origin$portalBrowserBasePath',
            headersProvider: apiClient.buildHeaders,
            clientFactory: () => client,
            // The ended pairing's probe finds no live session.
            confirmationClientFactory: () =>
                MockClient((_) async => _json(const {'session': null})),
            random: () => 1.0,
            // Only a wake can end a wait.
            wait: (delay) {
              waits.add(delay);
              return Completer<void>().future;
            },
          ),
        );
      });

      tearDown(() => repo.pauseEvents());

      test('pending across pause and resume is rejected', () async {
        await repo.restoreSession();
        repo.resumeEvents();
        await pumpEventQueue();
        firstStream.complete(
          http.StreamedResponse(
            Stream.value(
              utf8.encode(
                'event: batch\ndata: {"events":[],"nextCursor":4,'
                '"connectionStatus":"inactive"}\n\n',
              ),
            ),
            200,
          ),
        );
        await pumpEventQueue();
        expect(waits, const [Duration(seconds: 4)]);
        final refresh = repo.refreshSessionMetadata();
        await pumpEventQueue();

        // The app backgrounds and returns while the read is in flight.
        repo.pauseEvents();
        repo.resumeEvents();
        await pumpEventQueue();
        expect(streams, 2);

        heldRead.complete(session('active'));
        expect(await refresh, isNull);
        await pumpEventQueue();
        expect(streams, 2);
      });

      test('pending across a replaced subscription does not wake it', () async {
        await repo.restoreSession();
        repo.resumeEvents();
        await pumpEventQueue();
        final refresh = repo.refreshSessionMetadata();
        await pumpEventQueue();

        // The first subscription ends on its own; a new one for the same
        // session starts and waits on the sleeping desktop.
        firstStream.complete(http.StreamedResponse(const Stream.empty(), 401));
        await pumpEventQueue();
        repo.resumeEvents();
        await pumpEventQueue();
        expect(streams, 2);
        expect(waits, const [Duration(seconds: 4)]);

        heldRead.complete(session('active'));
        await refresh;
        await pumpEventQueue();
        expect(streams, 2);
      });
    });
  });

  group('stalled session reads', () {
    // CAN-3557: after Android resumes the app, a pooled connection can be dead
    // without being closed. A request on it neither answers nor fails, and a
    // session read that never settles leaves Remote Control stuck restoring.

    test('a stalled probe reports unknown and releases its socket', () {
      fakeAsync((async) {
        final network = _StallableNetwork()..stalled = true;
        final repo = _stallableRepository(network);
        RemoteSessionProbe? probe;

        unawaited(repo.probeSession().then((result) => probe = result));
        async.elapse(const Duration(minutes: 1));

        expect(probe?.outcome, RemoteSessionProbeOutcome.unknown);
        expect(network.openRequests, isEmpty);
      });
    });

    test('a stalled metadata read gives up and releases its socket', () {
      fakeAsync((async) {
        final network = _StallableNetwork();
        final repo = _stallableRepository(network);
        unawaited(repo.probeSession());
        async.flushMicrotasks();
        network.stalled = true;
        var settled = false;

        unawaited(repo.refreshSessionMetadata().then((_) => settled = true));
        async.elapse(const Duration(minutes: 1));

        expect(settled, isTrue);
        expect(network.openRequests, isEmpty);
      });
    });

    test('a stalled snapshot read fails and releases its socket', () {
      fakeAsync((async) {
        final network = _StallableNetwork();
        final repo = _stallableRepository(network);
        unawaited(repo.probeSession());
        async.flushMicrotasks();
        network.stalled = true;
        Object? error;

        unawaited(
          repo.fetchSnapshot().then<void>(
            (_) {},
            onError: (Object e) => error = e,
          ),
        );
        async.elapse(const Duration(minutes: 1));

        expect(error, isA<RemoteControlException>());
        expect(network.openRequests, isEmpty);
      });
    });
  });

  group('refreshSessionMetadata', () {
    test('does not adopt a different current session', () async {
      var sessionReads = 0;
      final statePaths = <String>[];
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) {
          final body = _activeSessionJson();
          if (++sessionReads > 1) {
            (body['session'] as Map<String, dynamic>)['id'] = 'sess-2';
          }
          return _json(body);
        }
        if (path.endsWith('/state')) {
          statePaths.add(path);
          return _json({
            'state': {'workspaces': [], 'worktrees': [], 'standaloneChats': []},
            'connectionStatus': 'active',
            'refreshing': false,
            'eventCursor': 0,
          });
        }
        fail('unexpected request: $path');
      });

      await repo.restoreSession();
      final refreshed = await repo.refreshSessionMetadata();
      await repo.fetchSnapshot();

      expect(refreshed, isNull);
      expect(statePaths, ['$portalBrowserBasePath/sessions/sess-1/state']);
    });
  });

  group('fetchSnapshot', () {
    test(
      'warm overview refresh cannot skip unseen chat events on resume',
      () async {
        var reads = 0;
        final cursors = <String?>[];
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            return http.Response(jsonEncode(_activeSessionJson()), 200);
          }
          if (request.url.path.endsWith('/state')) {
            return http.Response(
              jsonEncode({'state': {}, 'eventCursor': ++reads == 1 ? 7 : 900}),
              200,
            );
          }
          if (request.url.path.endsWith('/events/stream')) {
            cursors.add(request.url.queryParameters['after']);
            return http.Response('event: error\ndata: {"status":403}\n\n', 200);
          }
          throw StateError('Unexpected ${request.url}');
        });
        await repo.restoreSession();
        await repo.fetchSnapshot();
        await repo.fetchSnapshot();
        repo.resumeEvents();
        await Future<void>.delayed(const Duration(milliseconds: 20));
        repo.pauseEvents();
        expect(cursors.first, '7');
      },
    );

    test(
      'a discarded cursor resumes after the next read, not the backlog',
      () async {
        var reads = 0;
        final cursors = <String?>[];
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            return http.Response(jsonEncode(_activeSessionJson()), 200);
          }
          if (request.url.path.endsWith('/state')) {
            return http.Response(
              jsonEncode({'state': {}, 'eventCursor': ++reads == 1 ? 7 : 900}),
              200,
            );
          }
          if (request.url.path.endsWith('/events/stream')) {
            cursors.add(request.url.queryParameters['after']);
            return http.Response('event: error\ndata: {"status":403}\n\n', 200);
          }
          throw StateError('Unexpected ${request.url}');
        });
        await repo.restoreSession();
        await repo.fetchSnapshot();

        repo.discardEventCursor();
        await repo.fetchSnapshot();
        repo.resumeEvents();
        await Future<void>.delayed(const Duration(milliseconds: 20));
        repo.pauseEvents();

        expect(cursors.first, '900');
      },
    );

    test(
      'a snapshot started before discard cannot seed the fresh cursor',
      () async {
        final oldResponse = Completer<http.Response>();
        final freshResponse = Completer<http.Response>();
        final cursors = <String?>[];
        var reads = 0;
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            return _json(_activeSessionJson());
          }
          if (request.url.path.endsWith('/state')) {
            reads++;
            if (reads == 1) return _json({'state': {}, 'eventCursor': 7});
            return reads == 2 ? oldResponse.future : freshResponse.future;
          }
          if (request.url.path.endsWith('/events/stream')) {
            cursors.add(request.url.queryParameters['after']);
            return http.Response('event: error\ndata: {"status":403}\n\n', 200);
          }
          throw StateError('Unexpected ${request.url}');
        });
        await repo.restoreSession();
        await repo.fetchSnapshot();
        final oldRead = repo.fetchSnapshot();
        await pumpEventQueue();
        repo.discardEventCursor();
        final freshRead = repo.fetchSnapshot();
        await pumpEventQueue();
        oldResponse.complete(_json({'state': {}, 'eventCursor': 100}));
        await oldRead;
        freshResponse.complete(_json({'state': {}, 'eventCursor': 900}));
        await freshRead;
        repo.resumeEvents();
        await pumpEventQueue();
        repo.pauseEvents();
        expect(cursors.first, '900');
      },
    );

    test('every overview read reports the cursor its shell covers', () async {
      var reads = 0;
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/session')) {
          return http.Response(jsonEncode(_activeSessionJson()), 200);
        }
        if (request.url.path.endsWith('/state')) {
          return http.Response(
            jsonEncode({'state': {}, 'eventCursor': ++reads == 1 ? 7 : 900}),
            200,
          );
        }
        throw StateError('Unexpected ${request.url}');
      });
      await repo.restoreSession();
      expect((await repo.fetchSnapshot()).eventCursor, 7);
      // A warm refresh does not move the replay cursor, but its shell still
      // covers every event up to its own cursor.
      expect((await repo.fetchSnapshot()).eventCursor, 900);
    });

    test(
      'a pipeline read asks only for the worktree pipelines scope',
      () async {
        final queries = <Map<String, String>>[];
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            return _json(_activeSessionJson());
          }
          if (request.url.path.endsWith('/state')) {
            queries.add(request.url.queryParameters);
            return _json({
              'state': {
                'pipelineRuns': [
                  {'localId': 'exec-1', 'worktreeLocalId': 'wt-1'},
                ],
              },
              'refreshing': false,
            });
          }
          fail('unexpected request: ${request.url}');
        });
        await repo.restoreSession();

        final result = await repo.fetchWorktreePipelineSlices(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );

        expect(queries, [
          {
            'scope': 'pipelines',
            'workspaceLocalId': 'ws-1',
            'worktreeLocalId': 'wt-1',
          },
        ]);
        expect(result.refreshing, isFalse);
        expect(result.slices['pipelineRuns'], hasLength(1));
      },
    );

    test('throws when not connected', () async {
      final repo = _repository((request) async => _json(const {}));
      await expectLater(
        repo.fetchSnapshot(),
        throwsA(isA<RemoteControlException>()),
      );
    });

    test('reads state and seeds the event cursor for resumeEvents', () async {
      final streamAfters = <String?>[];
      var sessionReads = 0;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) {
          return _json(
            ++sessionReads == 1 ? _activeSessionJson() : {'session': null},
          );
        }
        if (path.endsWith('/state')) {
          return _json({
            'state': {
              'workspaces': [
                {'localId': 'ws-1', 'name': 'app', 'type': 'single-repo'},
              ],
              'worktrees': [],
              'standaloneChats': [],
            },
            'connectionStatus': 'active',
            'refreshing': false,
            'eventCursor': 41,
          });
        }
        if (path.endsWith('/events/stream')) {
          streamAfters.add(request.url.queryParameters['after']);
          // The authoritative probe confirms the session is gone.
          return _json(const {}, 403);
        }
        fail('unexpected request: $path');
      });

      await repo.restoreSession();
      final snapshot = await repo.fetchSnapshot();
      expect(snapshot.workspaces.single.localId, 'ws-1');

      final batches = <RemotePortalEventBatch>[];
      final done = Completer<void>();
      repo.events.listen(batches.add, onDone: done.complete);
      repo.resumeEvents();
      // Wait for the synthetic session-ended batch to arrive.
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(streamAfters, ['41']);
      expect(batches, hasLength(1));
      expect(batches.single.events.single, isA<RemoteSessionEndedEvent>());
    });
  });

  group('sendChatMessage', () {
    for (final failure in [
      'socket',
      'timeout',
      '500',
      '408',
      '403',
      'unavailable',
    ]) {
      test('classifies send outcome after $failure', () async {
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            return _json(_activeSessionJson());
          }
          if (failure == 'socket') throw const SocketException('suspended');
          if (failure == 'timeout') throw TimeoutException('suspended');
          if (failure == 'unavailable') {
            return _json({
              'error': 'Secure command delivery is unavailable.',
            }, 503);
          }
          return _json({'error': 'Request failed'}, int.parse(failure));
        });
        await repo.restoreSession();
        final uncertain = !['403', 'unavailable'].contains(failure);
        await expectLater(
          repo.sendChatMessage(
            const RemoteStandaloneChatTarget(chatId: 'chat-1'),
            'hello',
          ),
          throwsA(
            uncertain
                ? isA<RemoteChatSendOutcomeUnknownException>()
                : isA<RemoteControlException>().having(
                    (e) => e is RemoteChatSendOutcomeUnknownException,
                    'unknown outcome',
                    false,
                  ),
          ),
        );
      });
    }

    test('submits a worktree chat send and echoes the chatId', () async {
      late Map<String, dynamic> submitted;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/commands')) {
          final decoded = jsonDecode(request.body);
          submitted = decoded is Map<String, dynamic> ? decoded : {};
          return _json({
            'commandId': 'cmd-1',
            'queuedWhileReconnecting': false,
            'chatId': 'chat-real',
          }, 202);
        }
        fail('unexpected request: $path');
      });

      await repo.restoreSession();
      final result = await repo.sendChatMessage(
        const RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        'run the tests',
      );

      expect(result.chatId, 'chat-real');
      expect(submitted['type'], 'portal.chat.send');
      expect(submitted['target'], {
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
      });
      final payload = submitted['payload'];
      payload as Map<String, dynamic>;
      expect(payload['projectId'], 'ws-1');
      expect(payload['worktreeId'], 'wt-1');
      expect(payload.containsKey('chatId'), isFalse);
      expect(payload['text'], 'run the tests');
      expect(payload.containsKey('userMessageId'), isFalse);
    });

    test('forwards composer options in the web payload shape', () async {
      late Map<String, dynamic> submitted;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/commands')) {
          final decoded = jsonDecode(request.body);
          submitted = decoded is Map<String, dynamic> ? decoded : {};
          return _json({'commandId': 'cmd-1'}, 202);
        }
        fail('unexpected request: $path');
      });

      await repo.restoreSession();
      await repo.sendChatMessage(
        const RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        'first task message',
        options: const RemoteChatSendOptions(
          userMessageId: 'msg-client-1',
          model: 'gpt-6-codex',
          providerType: 'codex',
          planMode: true,
          thinkingLevel: 'high',
          fastMode: true,
        ),
      );

      final payload = submitted['payload'];
      payload as Map<String, dynamic>;
      expect(payload['userMessageId'], 'msg-client-1');
      expect(payload['model'], 'gpt-6-codex');
      expect(payload['providerType'], 'codex');
      expect(payload['planMode'], isTrue);
      expect(payload['modelConfig'], {
        'thinkingLevel': 'high',
        'fastMode': true,
      });
    });

    test('omits composer fields the user never set', () async {
      late Map<String, dynamic> submitted;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/commands')) {
          final decoded = jsonDecode(request.body);
          submitted = decoded is Map<String, dynamic> ? decoded : {};
          return _json({'commandId': 'cmd-1'}, 202);
        }
        fail('unexpected request: $path');
      });

      await repo.restoreSession();
      await repo.sendChatMessage(
        const RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        'plain send',
      );

      final payload = submitted['payload'];
      payload as Map<String, dynamic>;
      // Untouched controls stay off the wire so the desktop tab's persisted
      // defaults keep applying.
      expect(payload.containsKey('model'), isFalse);
      expect(payload.containsKey('providerType'), isFalse);
      expect(payload.containsKey('planMode'), isFalse);
      expect(payload.containsKey('modelConfig'), isFalse);
    });

    test(
      'forwards a voice inputMode on worktree and standalone sends',
      () async {
        final submissions = <Map<String, dynamic>>[];
        final repo = _repository((request) async {
          final path = request.url.path;
          if (path.endsWith('/session')) return _json(_activeSessionJson());
          if (path.endsWith('/commands')) {
            final decoded = jsonDecode(request.body);
            submissions.add(decoded is Map<String, dynamic> ? decoded : {});
            return _json({'commandId': 'cmd-1'}, 202);
          }
          fail('unexpected request: $path');
        });

        await repo.restoreSession();
        await repo.sendChatMessage(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          'dictated',
          options: const RemoteChatSendOptions(inputMode: 'voice'),
        );
        await repo.sendChatMessage(
          const RemoteStandaloneChatTarget(chatId: 'chat-s'),
          'dictated',
          options: const RemoteChatSendOptions(inputMode: 'voice'),
        );

        for (final submitted in submissions) {
          final payload = submitted['payload'];
          payload as Map<String, dynamic>;
          expect(payload['inputMode'], 'voice');
          // Only the voice marker was set; the rest stays off the wire.
          expect(payload.containsKey('model'), isFalse);
          expect(payload.containsKey('modelConfig'), isFalse);
        }
      },
    );

    test('submits an authoritative standalone chat creation', () async {
      late Map<String, dynamic> submitted;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/commands')) {
          final decoded = jsonDecode(request.body);
          submitted = decoded is Map<String, dynamic> ? decoded : {};
          return _json({'commandId': 'standalone-create'}, 202);
        }
        fail('unexpected request: $path');
      });
      await repo.restoreSession();
      final commandId = await repo.createStandaloneChat(
        const RemoteStandaloneChatTarget(
          chatId: 'chat-first-file',
          projectLocalId: 'ws-cowork',
        ),
      );
      expect(commandId, 'standalone-create');
      expect(submitted['type'], 'portal.standalone_chat.create');
      expect(submitted['target'], {'standaloneChatLocalId': 'chat-first-file'});
      expect(submitted['payload'], {
        'projectLocalId': 'ws-cowork',
        'chatId': 'chat-first-file',
      });
    });

    test(
      'standalone creation rejects a missing project before submission',
      () async {
        final repo = _repository((request) async {
          fail('unexpected request: ${request.url.path}');
        });
        expect(
          () => repo.createStandaloneChat(
            const RemoteStandaloneChatTarget(chatId: 'chat-first-file'),
          ),
          throwsA(isA<RemoteControlException>()),
        );
      },
    );

    test('submits a standalone chat send', () async {
      late Map<String, dynamic> submitted;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/commands')) {
          final decoded = jsonDecode(request.body);
          submitted = decoded is Map<String, dynamic> ? decoded : {};
          return _json({
            'commandId': 'cmd-2',
            'queuedWhileReconnecting': true,
          }, 202);
        }
        fail('unexpected request: $path');
      });

      await repo.restoreSession();
      final result = await repo.sendChatMessage(
        const RemoteStandaloneChatTarget(
          chatId: 'chat-arch',
          projectLocalId: 'ws-app',
        ),
        'summarize the plan',
      );

      // No echoed chatId → falls back to the target's id.
      expect(result.chatId, 'chat-arch');
      expect(result.queuedWhileReconnecting, isTrue);
      expect(submitted['type'], 'portal.standalone_chat.send');
      expect(submitted['target'], {'standaloneChatLocalId': 'chat-arch'});
      expect(submitted['payload'], {
        'projectLocalId': 'ws-app',
        'chatId': 'chat-arch',
        'message': 'summarize the plan',
      });
    });

    test('surfaces a synchronous command failure message', () async {
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        return _json({
          'commandId': 'cmd-3',
          'queuedWhileReconnecting': false,
          'error': 'The desktop rejected the send.',
        }, 202);
      });

      await repo.restoreSession();
      await expectLater(
        repo.sendChatMessage(
          const RemoteStandaloneChatTarget(chatId: 'chat-arch'),
          'hello',
        ),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'The desktop rejected the send.',
          ),
        ),
      );
    });

    test('emits cloudAttachments only when refs are present', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/session')) {
          return _json(_activeSessionJson());
        }
        if (request.url.path.endsWith('/commands')) {
          commands.add(jsonDecode(request.body) as Map<String, dynamic>);
          return _json({'commandId': 'cmd-1', 'chatId': 'chat-1'});
        }
        return _json({});
      });
      await repo.restoreSession();
      const target = RemoteWorktreeChatTarget(
        workspaceLocalId: 'w',
        worktreeLocalId: 't',
        chatId: 'chat-1',
      );
      await repo.sendChatMessage(target, 'plain');
      await repo.sendChatMessage(
        target,
        'with file',
        options: const RemoteChatSendOptions(
          attachments: [
            ChatAttachmentRef(
              attachmentId: 'a',
              filename: 'p.png',
              mediaType: 'image/png',
              size: 1,
              contentSha256: 'x',
              storageKind: 'blob',
              source: '/c',
            ),
          ],
        ),
      );
      expect(commands[0]['payload'], isNot(contains('cloudAttachments')));
      expect(commands[1]['payload']['cloudAttachments'], [
        {
          'attachmentId': 'a',
          'filename': 'p.png',
          'mediaType': 'image/png',
          'size': 1,
          'contentSha256': 'x',
          'storageKind': 'blob',
          'source': '/c',
        },
      ]);
    });

    test(
      'standalone attachment-only sends preserve refs and retry identity',
      () async {
        final commands = <Map<String, dynamic>>[];
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            return _json(_activeSessionJson());
          }
          if (request.url.path.endsWith('/commands')) {
            commands.add(jsonDecode(request.body) as Map<String, dynamic>);
            return _json({'commandId': 'cmd-1', 'chatId': 'chat-1'}, 202);
          }
          fail('unexpected request: ${request.url.path}');
        });
        await repo.restoreSession();
        const target = RemoteStandaloneChatTarget(
          projectLocalId: 'workspace-1',
          chatId: 'chat-1',
        );
        await repo.sendChatMessage(target, 'plain');
        await repo.sendChatMessage(
          target,
          'no files',
          options: const RemoteChatSendOptions(attachments: []),
        );
        const options = RemoteChatSendOptions(
          userMessageId: 'msg-mobile-cowork',
          attachments: [
            ChatAttachmentRef(
              attachmentId: 'image-1',
              filename: 'phone-camera-日本語.png',
              mediaType: 'image/png',
              size: 4096,
              contentSha256:
                  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              storageKind: 'blob',
              source:
                  '/api/v1/portal/sessions/sess-1/attachments/image-1/content',
            ),
            ChatAttachmentRef(
              attachmentId: 'file-1',
              filename: 'phone-brief-é.pdf',
              mediaType: 'application/pdf',
              size: 8192,
              contentSha256:
                  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              storageKind: 'blob',
              source:
                  '/api/v1/portal/sessions/sess-1/attachments/file-1/content',
            ),
          ],
        );
        await repo.sendChatMessage(target, '', options: options);
        await repo.sendChatMessage(target, '', options: options);

        expect(commands[0]['payload'], isNot(contains('cloudAttachments')));
        expect(commands[1]['payload'], isNot(contains('cloudAttachments')));
        expect(commands[2], {
          'type': 'portal.standalone_chat.send',
          'target': {'standaloneChatLocalId': 'chat-1'},
          'payload': {
            'projectLocalId': 'workspace-1',
            'chatId': 'chat-1',
            'userMessageId': 'msg-mobile-cowork',
            'message': '',
            'cloudAttachments': [
              for (final attachment in options.attachments!)
                attachment.toJson(),
            ],
          },
        });
        expect(commands[3], commands[2]);
      },
    );
  });

  group('requestChatTranscript', () {
    test(
      'cached chat reads stay scoped and preserve the live event cursor',
      () async {
        final requests = <Uri>[];
        final repo = _repository((request) async {
          requests.add(request.url);
          if (request.url.path.endsWith('/session')) {
            return http.Response(jsonEncode(_activeSessionJson()), 200);
          }
          if (request.url.path.endsWith('/state')) {
            expect(request.url.queryParameters, {
              'scope': 'chat',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'chatLocalId': 'chat-1',
            });
            return http.Response(
              jsonEncode({
                'eventCursor': 900,
                'state': {
                  'chatMessages': [
                    {
                      'localMessageId': 'msg-1',
                      'localChatId': 'chat-1',
                      'scope': 'worktree',
                      'role': 'assistant',
                      'status': 'complete',
                      'content': 'Cached answer',
                    },
                  ],
                },
              }),
              200,
            );
          }
          if (request.url.path.endsWith('/events/stream')) {
            expect(request.url.queryParameters['after'], '0');
            return http.Response('event: error\ndata: {"status":403}\n\n', 200);
          }
          throw StateError('Unexpected ${request.url}');
        });
        await repo.restoreSession();
        final messages = await repo.fetchCachedChatMessages(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            chatId: 'chat-1',
          ),
        );
        expect(messages.single.text, 'Cached answer');
        repo.resumeEvents();
        await Future<void>.delayed(const Duration(milliseconds: 20));
        repo.pauseEvents();
        expect(
          requests.any((url) => url.path.endsWith('/events/stream')),
          isTrue,
        );
      },
    );

    for (final capable in [false, true]) {
      test('foreground hydration is negotiated: $capable', () async {
        Map<String, dynamic>? command;
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            final session = _activeSessionJson();
            (session['session'] as Map<String, dynamic>)['capabilities'] = {
              'foreground_worktree_chat': capable,
            };
            return _json(session);
          }
          command = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({'commandId': 'foreground-1'});
        });
        await repo.restoreSession();
        expect(repo.supportsForegroundChat, capable);
        await repo.requestChatTranscript(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
        );
        expect(command!['payload'], {
          'scope': 'chat',
          'target': {'workspaceLocalId': 'ws', 'worktreeLocalId': 'wt'},
          if (capable) 'selectedChatOnly': true,
        });
      });
    }

    test('submits a chat-scoped state request for a worktree chat', () async {
      late Map<String, dynamic> submitted;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/commands')) {
          final decoded = jsonDecode(request.body);
          submitted = decoded is Map<String, dynamic> ? decoded : {};
          return _json({
            'commandId': 'cmd-4',
            'queuedWhileReconnecting': false,
          }, 202);
        }
        fail('unexpected request: $path');
      });

      await repo.restoreSession();
      await repo.requestChatTranscript(
        const RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          chatId: 'chat-1',
        ),
      );

      expect(submitted['type'], 'portal.state.request');
      final expectedTarget = {
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
        'chatLocalId': 'chat-1',
      };
      expect(submitted['target'], expectedTarget);
      expect(submitted['payload'], {'scope': 'chat', 'target': expectedTarget});
    });

    test('surfaces command-level state-request failures immediately', () async {
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/session')) {
          return _json(_activeSessionJson());
        }
        return _json({
          'commandId': 'cmd-state',
          'error': 'The state request expired.',
        }, 202);
      });
      await repo.restoreSession();

      await expectLater(
        repo.requestWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        throwsA(isA<RemoteControlException>()),
      );
      await expectLater(
        repo.requestChatTranscript(
          const RemoteStandaloneChatTarget(chatId: 'chat-1'),
        ),
        throwsA(isA<RemoteControlException>()),
      );
    });
  });

  group('composer controls', () {
    Future<Map<String, dynamic>> capture(
      Future<void> Function(HttpRemoteControlRepository repo) act,
    ) async {
      late Map<String, dynamic> submitted;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/commands')) {
          final decoded = jsonDecode(request.body);
          submitted = decoded is Map<String, dynamic> ? decoded : {};
          return _json({
            'commandId': 'cmd',
            'queuedWhileReconnecting': false,
          }, 202);
        }
        fail('unexpected request: $path');
      });
      await repo.restoreSession();
      await act(repo);
      return submitted;
    }

    const worktree = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );

    test(
      'close_tab routes the worktree and chat without extra payload',
      () async {
        final submitted = await capture((repo) => repo.closeChatTab(worktree));
        expect(submitted['type'], 'portal.chat.close_tab');
        expect(submitted['payload'], {
          'projectId': 'ws-1',
          'worktreeId': 'wt-1',
          'chatId': 'chat-1',
        });
      },
    );

    test('set_model for a worktree chat', () async {
      final submitted = await capture(
        (repo) => repo.setChatModel(worktree, 'gpt-5-codex'),
      );
      expect(submitted['type'], 'portal.chat.set_model');
      expect(submitted['payload'], {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
        'model': 'gpt-5-codex',
      });
    });

    test('set_model turns on Auto without a model id', () async {
      final submitted = await capture(
        (repo) => repo.setChatAutoModel(worktree),
      );
      expect(submitted['type'], 'portal.chat.set_model');
      expect(submitted['payload'], {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
        'selectionMode': 'auto',
      });
    });

    test('set_model for a standalone chat', () async {
      final submitted = await capture(
        (repo) => repo.setChatModel(
          const RemoteStandaloneChatTarget(
            chatId: 'chat-arch',
            projectLocalId: 'ws-app',
          ),
          'claude-sonnet',
        ),
      );
      expect(submitted['type'], 'portal.standalone_chat.set_model');
      expect(submitted['payload'], {
        'projectLocalId': 'ws-app',
        'chatId': 'chat-arch',
        'model': 'claude-sonnet',
      });
    });

    test('set_plan_mode', () async {
      final submitted = await capture(
        (repo) => repo.setChatPlanMode(worktree, true),
      );
      expect(submitted['type'], 'portal.chat.set_plan_mode');
      expect(submitted['payload'], {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
        'planMode': true,
      });
    });

    test('set_thinking_level', () async {
      final submitted = await capture(
        (repo) => repo.setChatThinkingLevel(worktree, 'high'),
      );
      expect(submitted['type'], 'portal.chat.set_thinking_level');
      expect(submitted['payload'], {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
        'thinkingLevel': 'high',
      });
    });

    test('set_fast_mode', () async {
      final submitted = await capture(
        (repo) => repo.setChatFastMode(worktree, true),
      );
      expect(submitted['type'], 'portal.chat.set_fast_mode');
      expect(submitted['payload'], {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
        'fastMode': true,
      });
    });

    test('cancel for a worktree chat', () async {
      String? commandId;
      final submitted = await capture((repo) async {
        commandId = await repo.cancelChat(worktree);
      });
      expect(commandId, 'cmd');
      expect(submitted['type'], 'portal.chat.cancel');
      expect(submitted['payload'], {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
      });
    });

    test('cancel for a standalone chat', () async {
      String? commandId;
      final submitted = await capture((repo) async {
        commandId = await repo.cancelChat(
          const RemoteStandaloneChatTarget(
            chatId: 'chat-arch',
            projectLocalId: 'ws-app',
          ),
        );
      });
      expect(commandId, 'cmd');
      expect(submitted['type'], 'portal.standalone_chat.cancel');
      expect(submitted['payload'], {
        'projectLocalId': 'ws-app',
        'chatId': 'chat-arch',
      });
    });

    test('answer_question carries requestId and raw answers', () async {
      final submitted = await capture(
        (repo) => repo.answerChatQuestion(
          worktree,
          requestId: 'req-1',
          answers: const [
            AskUserQuestionAnswer(
              questionId: 'q-1',
              question: 'Ship it?',
              selectedOptions: ['Yes'],
              freeformText: 'now',
            ),
          ],
        ),
      );
      expect(submitted['type'], 'portal.chat.answer_question');
      expect(submitted['target'], {
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
      });
      expect(submitted['payload'], {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
        'requestId': 'req-1',
        'answers': [
          {
            'questionId': 'q-1',
            'question': 'Ship it?',
            'selectedOptions': ['Yes'],
            'freeformText': 'now',
          },
        ],
      });
    });

    test('dismiss_question carries the requestId', () async {
      final submitted = await capture(
        (repo) => repo.dismissChatQuestion(worktree, requestId: 'req-9'),
      );
      expect(submitted['type'], 'portal.chat.dismiss_question');
      expect(submitted['payload'], {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
        'requestId': 'req-9',
      });
    });

    test('setHooksPaused(paused: true) submits portal.hook.pause', () async {
      final submitted = await capture(
        (repo) => repo.setHooksPaused(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          paused: true,
          hookKey: 'hook-lint',
        ),
      );
      expect(submitted['type'], 'portal.hook.pause');
      expect(submitted['target'], {
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
      });
      expect(submitted['payload'], {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'hookKey': 'hook-lint',
      });
    });

    test(
      'setHooksPaused(paused: false, all: true) submits portal.hook.resume',
      () async {
        final submitted = await capture(
          (repo) => repo.setHooksPaused(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            paused: false,
            all: true,
          ),
        );
        expect(submitted['type'], 'portal.hook.resume');
        expect(submitted['payload'], {
          'projectId': 'ws-1',
          'worktreeId': 'wt-1',
          'all': true,
        });
      },
    );

    test('setHooksPaused rejects missing or conflicting targets', () async {
      final repo = _repository(
        (_) async => http.Response('{"commandId":"unused"}', 200),
      );

      expect(
        () => repo.setHooksPaused(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          paused: true,
        ),
        throwsArgumentError,
      );
      expect(
        () => repo.setHooksPaused(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          paused: true,
          hookKey: 'hook-lint',
          all: true,
        ),
        throwsArgumentError,
      );
    });

    test('surfaces a command-level error', () async {
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        return _json({'commandId': 'cmd', 'error': 'Unknown model.'}, 202);
      });
      await repo.restoreSession();
      await expectLater(
        repo.setChatModel(worktree, 'bogus'),
        throwsA(isA<RemoteControlException>()),
      );
    });
  });

  group('createWorktree', () {
    /// Runs a create against a commands endpoint returning [commandResponse],
    /// yielding both the wire payload and the parsed result.
    Future<(Map<String, dynamic> submitted, RemoteWorktreeCreateResult result)>
    createWith(
      Map<String, dynamic> commandResponse, {
      String? baseWorktreeId,
      bool forkOpenTabs = false,
      List<String> existingWorktreeIds = const ['wt-1'],
    }) async {
      late Map<String, dynamic> submitted;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/commands')) {
          final decoded = jsonDecode(request.body);
          submitted = decoded is Map<String, dynamic> ? decoded : {};
          return _json(commandResponse, 202);
        }
        fail('unexpected request: $path');
      });
      await repo.restoreSession();
      final result = await repo.createWorktree(
        workspaceLocalId: 'ws-1',
        existingWorktreeIds: existingWorktreeIds,
        baseWorktreeId: baseWorktreeId,
        forkOpenTabs: forkOpenTabs,
      );
      return (submitted, result);
    }

    test('submits portal.worktree.create and reads the created id', () async {
      final (submitted, result) = await createWith({
        'commandId': 'cmd-1',
        'result': {'id': 'wt-2', 'branchName': 'canopy/otter'},
      });

      expect(submitted['type'], 'portal.worktree.create');
      expect(submitted['target'], {'workspaceLocalId': 'ws-1'});
      expect(submitted['payload'], {
        'workspaceId': 'ws-1',
        'existingWorktreeIds': ['wt-1'],
      });
      expect(result.worktreeLocalId, 'wt-2');
      expect(result.isPending, isFalse);
    });

    test('carries the branch base and fork flag when branching', () async {
      final (submitted, _) = await createWith(
        {
          'commandId': 'cmd-1',
          'result': {'id': 'wt-2'},
        },
        baseWorktreeId: 'wt-1',
        forkOpenTabs: true,
      );

      expect(submitted['payload'], {
        'workspaceId': 'ws-1',
        'existingWorktreeIds': ['wt-1'],
        'baseWorktreeId': 'wt-1',
        'forkOpenTabs': true,
      });
    });

    test('omits forkOpenTabs without a base worktree', () async {
      final (submitted, _) = await createWith({
        'commandId': 'cmd-1',
        'result': {'id': 'wt-2'},
      }, forkOpenTabs: true);

      expect(submitted['payload'], isNot(contains('forkOpenTabs')));
      expect(submitted['payload'], isNot(contains('baseWorktreeId')));
    });

    test('omits an empty existingWorktreeIds list', () async {
      final (submitted, _) = await createWith({
        'commandId': 'cmd-1',
        'result': {'id': 'wt-2'},
      }, existingWorktreeIds: const []);

      expect(submitted['payload'], {'workspaceId': 'ws-1'});
    });

    test('treats a result-less response as pending, not failed', () async {
      // The server's create wait window elapsed; the desktop is still working.
      final (_, result) = await createWith({'commandId': 'cmd-1'});

      expect(result.isPending, isTrue);
      expect(result.commandId, 'cmd-1');
    });

    test('throws the desktop error when the create failed', () async {
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        return _json({
          'commandId': 'cmd-1',
          'error': 'Cannot create a worktree in a cowork workspace.',
        }, 202);
      });
      await repo.restoreSession();

      await expectLater(
        repo.createWorktree(workspaceLocalId: 'ws-cowork'),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            contains('cowork'),
          ),
        ),
      );
    });

    test('marks a server failure as an unknown create outcome', () async {
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        return _json({'error': 'Gateway lost the response.'}, 502);
      });
      await repo.restoreSession();

      await expectLater(
        repo.createWorktree(workspaceLocalId: 'ws-1'),
        throwsA(isA<RemoteWorktreeCreateOutcomeUnknownException>()),
      );
    });

    test(
      'keeps a pre-enqueue encryption 503 as a definitive failure',
      () async {
        final repo = _repository((request) async {
          final path = request.url.path;
          if (path.endsWith('/session')) return _json(_activeSessionJson());
          return _json({
            'error': 'Secure command delivery is unavailable.',
          }, 503);
        });
        await repo.restoreSession();

        await expectLater(
          repo.createWorktree(workspaceLocalId: 'ws-1'),
          throwsA(
            isA<RemoteControlException>()
                .having(
                  (error) => error,
                  'type',
                  isNot(isA<RemoteWorktreeCreateOutcomeUnknownException>()),
                )
                .having(
                  (error) => error.message,
                  'message',
                  'Secure command delivery is unavailable.',
                ),
          ),
        );
      },
    );

    test('keeps a client rejection as a definitive create failure', () async {
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        return _json({'error': 'Invalid workspace.'}, 400);
      });
      await repo.restoreSession();

      await expectLater(
        repo.createWorktree(workspaceLocalId: 'missing'),
        throwsA(
          isA<RemoteControlException>().having(
            (error) => error,
            'type',
            isNot(isA<RemoteWorktreeCreateOutcomeUnknownException>()),
          ),
        ),
      );
    });
  });

  group('requestOverviewState', () {
    test('asks the desktop to re-project the overview', () async {
      late Map<String, dynamic> submitted;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        final decoded = jsonDecode(request.body);
        submitted = decoded is Map<String, dynamic> ? decoded : {};
        return _json({
          'commandId': 'cmd-1',
          'result': {'ok': true},
        }, 202);
      });
      await repo.restoreSession();
      final completed = await repo.requestOverviewState();

      expect(submitted['type'], 'portal.state.request');
      expect(submitted['payload'], {'scope': 'overview', 'refresh': true});
      expect(completed, isTrue);
    });

    test(
      'reports an overview command that did not complete while waited',
      () async {
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            return _json(_activeSessionJson());
          }
          return _json({'commandId': 'cmd-pending'}, 202);
        });
        await repo.restoreSession();

        expect(await repo.requestOverviewState(), isFalse);
      },
    );

    test(
      'identifies the authoritative missing-active-session response',
      () async {
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            return _json(_activeSessionJson());
          }
          return _json({
            'error': 'Active remote control session not found',
          }, 404);
        });
        await repo.restoreSession();

        try {
          await repo.requestOverviewState();
          fail('expected the overview request to fail');
        } on Object catch (error) {
          expect(isRemoteSessionUnavailableError(error), isTrue);
        }
      },
    );
  });

  group('probeSession', () {
    // The teardown this gates ends the server session irreversibly, so the
    // difference between "the server says there is no session" and "the server
    // could not be asked" is load-bearing. `restoreSession` deliberately
    // collapses both into `null`; the probe must not.
    test('reports a renderable session with its metadata', () async {
      final repo = _repository((request) async => _json(_activeSessionJson()));

      final probe = await repo.probeSession();

      expect(probe.outcome, RemoteSessionProbeOutcome.renderable);
      expect(probe.connection?.deviceLabel, "Alex's MacBook Pro");
    });

    test(
      'reports gone when the route has no session for this client',
      () async {
        // The route reports an absent session as 200 with a null body, never
        // as a 404.
        final repo = _repository(
          (request) async => _json(const {'session': null}),
        );

        expect(
          (await repo.probeSession()).outcome,
          RemoteSessionProbeOutcome.gone,
        );
        expect(await repo.restoreSession(), isNull);
      },
    );

    test('reports unknown for the feature gate rather than gone', () async {
      // The route's only 404 is its feature/entitlement gate, and both halves
      // of that gate fail closed on a transient resolution failure. Ending the
      // pairing on it would let a LaunchDarkly blip kill a live session — and
      // the end route is not feature-gated, so that destructive call would
      // succeed while the read gate was still failing.
      final repo = _repository(
        (request) async =>
            _json(const {'error': 'Remote Control is not available.'}, 404),
      );

      expect(
        (await repo.probeSession()).outcome,
        RemoteSessionProbeOutcome.unknown,
      );
    });

    test('reports gone for a session the shell may not render', () async {
      final repo = _repository(
        (request) async => _json({
          'session': {
            'id': 'sess-1',
            'status': 'active',
            'connectionStatus': 'ended',
          },
        }),
      );

      expect(
        (await repo.probeSession()).outcome,
        RemoteSessionProbeOutcome.gone,
      );
    });

    test('reports unknown on a server error rather than gone', () async {
      final repo = _repository((request) async => _json(const {}, 500));

      // The regression this guards: a 5xx read reported as `gone` would let
      // the caller end a pairing that was about to heal (CAN-2651).
      expect(
        (await repo.probeSession()).outcome,
        RemoteSessionProbeOutcome.unknown,
      );
      expect(await repo.restoreSession(), isNull);
    });

    test('reports unknown when the request never reaches the server', () async {
      final repo = _repository(
        (request) async => throw const SocketException('offline'),
      );

      expect(
        (await repo.probeSession()).outcome,
        RemoteSessionProbeOutcome.unknown,
      );
    });

    test('reports unknown on an auth failure rather than gone', () async {
      final repo = _repository((request) async => _json(const {}, 401));

      expect(
        (await repo.probeSession()).outcome,
        RemoteSessionProbeOutcome.unknown,
      );
    });

    // CAN-3624: the read returns the account's current session, not the
    // paired one. Another desktop's row says nothing about whether this
    // pairing ended, and must not be adopted into it.
    group('while paired', () {
      Map<String, dynamic>? current;
      Completer<void>? holdSessionRead;
      late List<String> paths;
      late HttpRemoteControlRepository repo;

      setUp(() async {
        paths = [];
        holdSessionRead = null;
        current = {
          'id': 'sess-1',
          'status': 'inactive',
          'connectionStatus': 'inactive',
          'clientName': 'Desktop A',
          'destructiveActionsEnabled': true,
          'capabilities': {'foreground_worktree_chat': true},
        };
        repo = _repository((request) async {
          final path = request.url.path;
          paths.add(path);
          if (path.endsWith('/session')) {
            await holdSessionRead?.future;
            return _json({'session': current});
          }
          if (path.endsWith('/state')) {
            return _json({
              'state': {
                'workspaces': [],
                'worktrees': [],
                'standaloneChats': [],
              },
              'connectionStatus': 'inactive',
              'eventCursor': 40,
            });
          }
          if (path.endsWith('/end')) return _json({'ok': true});
          fail('unexpected request: $path');
        });
        expect(
          (await repo.probeSession()).outcome,
          RemoteSessionProbeOutcome.renderable,
        );
      });

      test(
        'reports unknown when another desktop awaits its pairing code',
        () async {
          current = {
            'id': 'sess-2',
            'status': 'pending_auth',
            'connectionStatus': 'pending',
            'clientName': 'Desktop B',
          };

          final probe = await repo.probeSession();

          expect(probe.outcome, RemoteSessionProbeOutcome.unknown);
          expect(probe.connection, isNull);
          expect(repo.canArchiveWorktrees, isTrue);
          expect(repo.supportsForegroundChat, isTrue);
        },
      );

      test('does not adopt another active desktop', () async {
        current = {
          'id': 'sess-2',
          'status': 'active',
          'connectionStatus': 'active',
          'clientName': 'Other Desktop',
          'destructiveActionsEnabled': false,
          'capabilities': {'foreground_worktree_chat': false},
        };

        final probe = await repo.probeSession();
        await repo.fetchSnapshot();

        expect(probe.outcome, RemoteSessionProbeOutcome.unknown);
        expect(probe.connection, isNull);
        expect(repo.canArchiveWorktrees, isTrue);
        expect(repo.supportsForegroundChat, isTrue);
        expect(paths.last, '$portalBrowserBasePath/sessions/sess-1/state');
      });

      // A probe already in flight when the user disconnects must not restore
      // the pairing they just left. Otherwise every later probe compares
      // against the ended session and never restores another desktop.
      for (final (name, reset, resetPaths)
          in <(String, Future<void> Function(), List<String>)>[
            (
              'disconnects',
              () => repo.disconnect(),
              ['$portalBrowserBasePath/sessions/sess-1/end'],
            ),
            (
              'clears the local session',
              () async => repo.clearLocalSession(),
              [],
            ),
          ]) {
        test('does not re-adopt its session when it $name mid-read', () async {
          final read = Completer<void>();
          holdSessionRead = read;
          final pending = repo.probeSession();
          await pumpEventQueue();
          expect(paths, hasLength(2));

          await reset();
          holdSessionRead = null;
          read.complete();
          final probe = await pending;

          expect(probe.outcome, RemoteSessionProbeOutcome.unknown);
          expect(probe.connection, isNull);
          expect(repo.canArchiveWorktrees, isFalse);
          expect(repo.supportsForegroundChat, isFalse);
          expect(paths.skip(2), resetPaths);

          current = {
            'id': 'sess-2',
            'status': 'active',
            'connectionStatus': 'active',
            'clientName': 'Desktop B',
          };
          expect(
            (await repo.probeSession()).outcome,
            RemoteSessionProbeOutcome.renderable,
          );
          await repo.fetchSnapshot();
          expect(paths.last, '$portalBrowserBasePath/sessions/sess-2/state');
        });
      }

      for (final (name, ownRead) in <(String, Map<String, dynamic>?)>[
        ('no session', null),
        (
          'its own ended row',
          {'id': 'sess-1', 'status': 'inactive', 'connectionStatus': 'ended'},
        ),
        (
          'its own pending row',
          {
            'id': 'sess-1',
            'status': 'pending_auth',
            'connectionStatus': 'pending',
          },
        ),
      ]) {
        test('reports gone for $name', () async {
          current = ownRead;

          expect(
            (await repo.probeSession()).outcome,
            RemoteSessionProbeOutcome.gone,
          );
        });
      }
    });
  });

  group('disconnect', () {
    test('ends the session best-effort and pauses events', () async {
      final paths = <String>[];
      final repo = _repository((request) async {
        paths.add(request.url.path);
        if (request.url.path.endsWith('/session')) {
          return _json(_activeSessionJson());
        }
        return _json({'ok': true});
      });

      await repo.restoreSession();
      await repo.disconnect();
      expect(paths.last, '$portalBrowserBasePath/sessions/sess-1/end');

      // A second disconnect is a no-op.
      await repo.disconnect();
      expect(paths.last, '$portalBrowserBasePath/sessions/sess-1/end');
    });

    test('a stalled end request gives up at the session-read bound', () {
      // CAN-4426: the end request rides a pooled connection that can be dead
      // without being closed, like the session reads in CAN-3557.
      fakeAsync((async) {
        final network = _StallableNetwork();
        final repo = _stallableRepository(network);
        unawaited(repo.probeSession());
        async.flushMicrotasks();
        network.stalled = true;
        var settled = false;

        unawaited(repo.disconnect().then((_) => settled = true));
        async.elapse(const Duration(seconds: 14));
        expect(settled, isFalse);
        async.elapse(const Duration(seconds: 1));

        expect(settled, isTrue);
        expect(network.openRequests, isEmpty);
      });
    });

    test('a code waits for a stalled end before it is submitted', () {
      // CAN-4426: the desktop can re-arm a code on the session being ended.
      // An end that lands after that pairing would end it on the server.
      fakeAsync((async) {
        final network = _StallableNetwork();
        final repo = _stallableRepository(network);
        unawaited(repo.probeSession());
        async.flushMicrotasks();
        network.stalled = true;
        final settled = <String>[];

        unawaited(repo.disconnect().then((_) => settled.add('disconnect')));
        async.flushMicrotasks();
        unawaited(
          repo
              .connect('123456')
              .then((c) => settled.add('paired ${c.sessionId}')),
        );
        async.flushMicrotasks();
        expect(
          network.openRequests,
          hasLength(1),
          reason: 'only the end request may be on the wire',
        );

        network.stalled = false;
        async.elapse(const Duration(seconds: 14));
        expect(settled, isEmpty);
        async.elapse(const Duration(seconds: 1));
        async.flushMicrotasks();

        expect(settled, ['disconnect', 'paired sess-1']);
        expect(network.openRequests, isEmpty);
      });
    });

    test('a restore does not adopt the session this phone ended', () async {
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/end')) {
          // The request never reached the server, which still reports it.
          throw http.ClientException('Connection reset');
        }
        return _json(_activeSessionJson());
      });
      await repo.restoreSession();

      await repo.disconnect();
      final probe = await repo.probeSession();

      expect(probe.outcome, RemoteSessionProbeOutcome.gone);
      expect(probe.connection, isNull);
      await expectLater(
        repo.fetchSnapshot(),
        throwsA(isA<RemoteControlException>()),
      );
    });

    test('a restore still adopts another desktop after a disconnect', () async {
      var current = _activeSessionJson();
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/end')) {
          throw http.ClientException('Connection reset');
        }
        return _json(current);
      });
      await repo.restoreSession();
      await repo.disconnect();

      current = _activeSessionJson();
      (current['session'] as Map<String, dynamic>)['id'] = 'sess-2';
      final probe = await repo.probeSession();

      expect(probe.outcome, RemoteSessionProbeOutcome.renderable);
      expect(probe.connection?.sessionId, 'sess-2');
    });

    test('a new code can pair the disconnected session again', () async {
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/end')) {
          throw http.ClientException('Connection reset');
        }
        if (request.url.path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        return _json(_activeSessionJson());
      });
      await repo.restoreSession();
      await repo.disconnect();

      final connection = await repo.connect('123456');
      final probe = await repo.probeSession();

      expect(connection.sessionId, 'sess-1');
      expect(probe.outcome, RemoteSessionProbeOutcome.renderable);
      expect(probe.connection?.sessionId, 'sess-1');
    });

    test('a local reset forgets the session without ending it', () async {
      final paths = <String>[];
      final repo = _repository((request) async {
        paths.add(request.url.path);
        final body = _activeSessionJson();
        (body['session'] as Map<String, dynamic>).addAll({
          'destructiveActionsEnabled': true,
          'capabilities': {'foreground_worktree_chat': true},
        });
        return _json(body);
      });
      await repo.restoreSession();
      expect(repo.canArchiveWorktrees, isTrue);

      repo.clearLocalSession();
      await repo.disconnect();

      expect(paths, ['$portalBrowserBasePath/session']);
      expect(repo.canArchiveWorktrees, isFalse);
      expect(repo.supportsForegroundChat, isFalse);
      await expectLater(
        repo.fetchSnapshot(),
        throwsA(isA<RemoteControlException>()),
      );
    });
  });

  group('fetchChatHistory', () {
    test('posts the target-derived history request and parses the '
        'chunk', () async {
      final bodies = <Map<String, dynamic>>[];
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/chat/history')) {
          final decoded = jsonDecode(request.body);
          if (decoded is Map<String, dynamic>) bodies.add(decoded);
          return _json({
            'chatId': 'chat-1',
            'scope': 'worktree',
            'segment': 'historical',
            'messages': [
              {
                'messageId': 'msg-old',
                'chatId': 'chat-1',
                'role': 'assistant',
                'status': 'complete',
                'text': 'from history',
                'createdAtMs': 1755500000000,
              },
            ],
            'nextCursor': 'cur-2',
          });
        }
        fail('unexpected request: $path');
      });
      await repo.connect('123456');

      final chunk = await repo.fetchChatHistory(
        const RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          chatId: 'chat-1',
        ),
      );
      expect(chunk.messages.single.messageId, 'msg-old');
      expect(chunk.nextCursor, 'cur-2');
      // The first page is requested with an explicit null cursor — the
      // server treats an absent/`null` `before` as "newest historical page".
      expect(bodies.single, {
        'scope': 'worktree',
        'chatId': 'chat-1',
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
        'before': null,
      });

      await repo.fetchChatHistory(
        const RemoteStandaloneChatTarget(
          chatId: 'chat-9',
          projectLocalId: 'ws-notes',
        ),
        before: 'cur-2',
        limitTurns: 40,
      );
      expect(bodies.last, {
        'scope': 'standalone',
        'chatId': 'chat-9',
        'before': 'cur-2',
        'limitTurns': 40,
      });
    });
  });

  group('worktree chat summaries scope', () {
    test('captures the session capability and requests the batched '
        'scope', () async {
      final commandBodies = <Map<String, dynamic>>[];
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        if (path.endsWith('/session')) {
          return _json({
            'session': {
              'id': 'sess-1',
              'status': 'active',
              'capabilities': {
                'worktree_chat_summaries_scope': true,
                'some_future_capability': false,
              },
            },
          });
        }
        if (path.endsWith('/commands')) {
          final decoded = jsonDecode(request.body);
          if (decoded is Map<String, dynamic>) commandBodies.add(decoded);
          return _json({'commandId': 'cmd-1'}, 202);
        }
        fail('unexpected request: $path');
      });

      await repo.connect('123456');
      expect(repo.supportsWorktreeChatSummariesScope, isTrue);

      await repo.requestWorktreeChatSummariesState();
      expect(commandBodies.single['type'], 'portal.state.request');
      expect(commandBodies.single['payload'], {
        'scope': 'worktree_chat_summaries',
      });
    });

    test(
      'a rejected summary batch remains retryable as a single request',
      () async {
        var requests = 0;
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/connect')) {
            return _json({'sessionId': 'sess-1', 'status': 'active'});
          }
          if (request.url.path.endsWith('/session')) {
            return _json(_activeSessionJson());
          }
          if (request.url.path.endsWith('/commands')) {
            requests++;
            expect(jsonDecode(request.body)['payload'], {
              'scope': 'worktree_chat_summaries',
            });
            if (requests == 1) {
              return _json({'error': 'temporarily unavailable'}, 503);
            }
            return _json({'commandId': 'cmd-retry'}, 202);
          }
          fail('unexpected request: ${request.url.path}');
        });
        await repo.connect('123456');
        await expectLater(
          repo.requestWorktreeChatSummariesState(),
          throwsA(isA<RemoteControlException>()),
        );
        await repo.requestWorktreeChatSummariesState();
        expect(requests, 2);
      },
    );

    test('the capability defaults to false when absent or after '
        'disconnect', () async {
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        if (path.endsWith('/end')) return _json(const {});
        return _json(_activeSessionJson());
      });

      await repo.connect('123456');
      expect(repo.supportsWorktreeChatSummariesScope, isFalse);
      await repo.disconnect();
      expect(repo.supportsWorktreeChatSummariesScope, isFalse);
    });
  });

  group('worktree file reads', () {
    const request = RemoteFileRequest(
      projectId: 'ws',
      worktreeId: 'wt',
      repoId: 'repo',
      relativePath: '.playwright/can-5128/report.md',
    );

    test('uses the paired session for text and link reads', () async {
      final repo = _repository((r) async {
        final path = r.url.path;
        if (path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/sessions/sess-1/file/read')) {
          expect(jsonDecode(r.body), request.toJson());
          return _json({'content': '# Report', 'truncated': false});
        }
        if (path.endsWith('/sessions/sess-1/file/resolve')) {
          return _json({
            'fileRootLocalId': 'repo',
            'relativePath': request.relativePath,
          });
        }
        fail('unexpected request: $path');
      });
      addTearDown(repo.pauseEvents);
      await repo.connect('123456');
      expect((await repo.readFile(request)).contents, '# Report');
      expect(
        (await repo.resolveLink(
          projectId: 'ws',
          worktreeId: 'wt',
          href: request.relativePath,
        ))?.fileRootLocalId,
        'repo',
      );
    });

    test('gates asset reads using negotiated desktop capabilities', () async {
      final repo = _repository((r) async {
        if (r.url.path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        if (r.url.path.endsWith('/session')) return _json(_activeSessionJson());
        fail('asset command must not be sent');
      });
      addTearDown(repo.pauseEvents);
      await repo.connect('123456');
      await expectLater(
        repo.readAsset(request),
        throwsA(
          isA<RemoteFileException>().having(
            (e) => e.failure,
            'failure',
            RemoteFileFailure.unsupportedDesktop,
          ),
        ),
      );
    });

    test('reads assets when the paired desktop advertises support', () async {
      final repo = _repository((r) async {
        if (r.url.path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        if (r.url.path.endsWith('/session')) {
          return _json({
            'session': {
              'id': 'sess-1',
              'status': 'active',
              'connectionStatus': 'active',
              'capabilities': {'chat_assets_v1': true},
            },
          });
        }
        expect(r.url.path, endsWith('/sessions/sess-1/commands'));
        expect((jsonDecode(r.body) as Map)['payload'], {
          ...request.toJson(),
          'offset': 0,
        });
        return _json({
          'result': {
            'assetId': 'asset',
            'filename': 'report.png',
            'mediaType': 'image/png',
            'size': 0,
            'version': 'v1',
            'offset': 0,
            'dataBase64': '',
            'contentSha256':
                'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            'nextOffset': null,
          },
        });
      });
      addTearDown(repo.pauseEvents);
      await repo.connect('123456');
      expect((await repo.readAsset(request)).bytes, isEmpty);
    });

    test('backgrounding interrupts a pending file read', () async {
      final started = Completer<void>();
      final pending = Completer<http.Response>();
      final repo = _repository((r) async {
        if (r.url.path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        if (r.url.path.endsWith('/session')) return _json(_activeSessionJson());
        started.complete();
        return pending.future;
      });
      addTearDown(repo.pauseEvents);
      await repo.connect('123456');
      final result = repo.readFile(request);
      final assertion = expectLater(
        result,
        throwsA(
          isA<RemoteFileException>().having(
            (e) => e.failure,
            'failure',
            RemoteFileFailure.unavailable,
          ),
        ),
      );
      await started.future;
      repo.pauseEvents();
      await assertion;
      pending.complete(_json({'content': 'stale', 'truncated': false}));
    });
  });

  group('readFileDiff', () {
    test('posts the per-file diff read for the active session', () async {
      final bodies = <Map<String, dynamic>>[];
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/sessions/sess-1/diff/read')) {
          final decoded = jsonDecode(request.body);
          if (decoded is Map<String, dynamic>) bodies.add(decoded);
          return _json({
            'workspaceLocalId': 'ws-1',
            'worktreeLocalId': 'wt-1',
            'filePath': 'lib/a.dart',
            'files': <Object>[],
            'patch': '@@ -1 +1 @@\n-a\n+b\n',
          });
        }
        fail('unexpected request: $path');
      });
      await repo.connect('123456');

      final diff = await repo.readFileDiff(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        path: 'lib/a.dart',
        source: RemoteDiffSource.committed,
      );
      expect(diff.patch, '@@ -1 +1 @@\n-a\n+b\n');
      expect(bodies.single, {
        'workspaceId': 'ws-1',
        'worktreeId': 'wt-1',
        'path': 'lib/a.dart',
        'source': 'committed',
      });
    });

    test('surfaces the server error message and a transport fallback', () async {
      var attempts = 0;
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/connect')) {
          return _json({'sessionId': 'sess-1', 'status': 'active'});
        }
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/diff/read')) {
          attempts += 1;
          if (attempts == 1) {
            return _json({'error': 'Desktop is offline.'}, 409);
          }
          throw const SocketException('down');
        }
        fail('unexpected request: $path');
      });
      await repo.connect('123456');

      Future<void> read() => repo.readFileDiff(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        path: 'lib/a.dart',
        source: RemoteDiffSource.uncommitted,
      );
      await expectLater(
        read(),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'Desktop is offline.',
          ),
        ),
      );
      await expectLater(
        read(),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'Could not reach the server. Check your connection and try again.',
          ),
        ),
      );
    });

    test('throws when not connected', () async {
      final repo = _repository((request) async => fail('no requests'));
      await expectLater(
        repo.readFileDiff(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          path: 'lib/a.dart',
          source: RemoteDiffSource.uncommitted,
        ),
        throwsA(isA<RemoteControlException>()),
      );
    });
  });

  group('chat attachments', () {
    test('supportsChatAttachments follows the session capability', () async {
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/session')) {
          final json = _activeSessionJson();
          json['session']['capabilities'] = {'chat_attachments': true};
          return _json(json);
        }
        return _json({});
      });
      await repo.restoreSession();
      expect(repo.supportsChatAttachments, isTrue);
      // An older desktop: `chat_attachments` predates the create handshake.
      expect(repo.supportsStandaloneChatCreate, isFalse);
    });

    test(
      'supportsStandaloneChatCreate follows its own session capability',
      () async {
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            final json = _activeSessionJson();
            json['session']['capabilities'] = {
              'chat_attachments': true,
              'standalone_chat_create': true,
            };
            return _json(json);
          }
          return _json({});
        });
        await repo.restoreSession();
        expect(repo.supportsStandaloneChatCreate, isTrue);
      },
    );

    test(
      'uploadChatAttachment targets the active session and deleteChatAttachment mirrors it',
      () async {
        final paths = <String>[];
        final repo = _repository((request) async {
          paths.add('${request.method} ${request.url.path}');
          if (request.url.path.endsWith('/session')) {
            return _json(_activeSessionJson());
          }
          if (request.url.path.endsWith('/attachments')) {
            return _json({
              'attachmentId': '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
              'filename': 'p.png',
              'mediaType': 'image/png',
              'size': 1,
              'contentSha256': 'a' * 64,
              'storageKind': 'blob',
              'source': '/c',
            }, 201);
          }
          return http.Response('', 204);
        });
        await repo.restoreSession();
        final ref = await repo.uploadChatAttachment(
          filename: 'p.png',
          mediaType: 'image/png',
          bytes: Uint8List(1),
        );
        await repo.deleteChatAttachment(ref.attachmentId);
        expect(
          paths,
          containsAllInOrder([
            'POST $portalAttachmentBasePath/sessions/sess-1/attachments',
            'DELETE $portalAttachmentBasePath/sessions/sess-1/attachments/${ref.attachmentId}',
          ]),
        );
      },
    );

    test(
      'uploadChatAttachment maps server errors to RemoteControlException',
      () async {
        final repo = _repository((request) async {
          if (request.url.path.endsWith('/session')) {
            return _json(_activeSessionJson());
          }
          return _json({'error': 'Attachment is too large'}, 413);
        });
        await repo.restoreSession();
        await expectLater(
          repo.uploadChatAttachment(
            filename: 'p.png',
            mediaType: 'image/png',
            bytes: Uint8List(1),
          ),
          throwsA(
            isA<RemoteControlException>().having(
              (e) => e.message,
              'message',
              'Attachment is too large',
            ),
          ),
        );
      },
    );
  });

  group('provider usage (CAN-3636)', () {
    HttpRemoteControlRepository repoWith({
      required List<Map<String, dynamic>> commands,
      bool capable = true,
      Map<String, dynamic> response = const {'commandId': 'cmd-usage'},
      int status = 200,
    }) => _repository((request) async {
      if (request.url.path.endsWith('/session')) {
        final body = _activeSessionJson();
        (body['session'] as Map<String, dynamic>)['capabilities'] = {
          'portal-v1': true,
          if (capable) 'provider_usage': true,
        };
        return _json(body);
      }
      commands.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json(response, status);
    });

    test('reads the capability from the session', () async {
      final repo = repoWith(commands: [], capable: false);
      await repo.restoreSession();
      expect(repo.providerUsage.isSupported, isFalse);
      final capableRepo = repoWith(commands: []);
      await capableRepo.restoreSession();
      expect(capableRepo.providerUsage.isSupported, isTrue);
    });

    test('refresh sends the untargeted provider command', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands);
      await repo.restoreSession();
      final commandId = await repo.providerUsage.refresh(
        PortalProviderUsageProvider.codex,
      );
      expect(commandId, 'cmd-usage');
      expect(commands.single, {
        'type': 'portal.provider_usage.refresh',
        'payload': {'provider': 'codex'},
      });
    });

    test('refresh fails without sending to an older desktop or on a '
        'command error', () async {
      final commands = <Map<String, dynamic>>[];
      final old = repoWith(commands: commands, capable: false);
      await old.restoreSession();
      await expectLater(
        old.providerUsage.refresh(PortalProviderUsageProvider.claude),
        throwsA(isA<RemoteControlException>()),
      );
      expect(commands, isEmpty);

      final failing = repoWith(
        commands: commands,
        response: {'commandId': 'cmd-usage', 'error': 'Claude is busy.'},
      );
      await failing.restoreSession();
      await expectLater(
        failing.providerUsage.refresh(PortalProviderUsageProvider.claude),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'Claude is busy.',
          ),
        ),
      );
    });
  });

  group('App Advisor (CAN-3989)', () {
    for (final status in [0, 408, 500, 403, 503]) {
      test(
        'Advisor send classifies transport outcome for status $status',
        () async {
          var posts = 0;
          final repo = _repository((request) async {
            if (request.url.path.endsWith('/session')) {
              final body = _activeSessionJson();
              body['session']['capabilities'] = {
                'portal-v1': true,
                'app_advisor': true,
              };
              return _json(body);
            }
            posts++;
            if (status == 0) throw const SocketException('Response lost');
            return _json({
              'error': status == 503
                  ? 'Secure command delivery is unavailable.'
                  : 'Rejected',
            }, status);
          });
          await repo.restoreSession();
          await expectLater(
            repo.appAdvisor.send(userMessageId: 'u1', text: 'Only once'),
            throwsA(
              status == 0 || status == 408 || status == 500
                  ? isA<RemoteChatSendOutcomeUnknownException>()
                  : isA<RemoteControlException>().having(
                      (error) => error is RemoteChatSendOutcomeUnknownException,
                      'uncertain',
                      false,
                    ),
            ),
          );
          expect(posts, 1);
        },
      );
    }

    HttpRemoteControlRepository repoWith({
      required List<Map<String, dynamic>> commands,
      bool capable = true,
      Map<String, dynamic> response = const {'commandId': 'cmd-advisor'},
    }) => _repository((request) async {
      if (request.url.path.endsWith('/session')) {
        final body = _activeSessionJson();
        (body['session'] as Map<String, dynamic>)['capabilities'] = {
          'portal-v1': true,
          if (capable) 'app_advisor': true,
        };
        return _json(body);
      }
      commands.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json(response);
    });

    test('reads the capability from the session', () async {
      final old = repoWith(commands: [], capable: false);
      await old.restoreSession();
      expect(old.appAdvisor.isSupported, isFalse);
      final current = repoWith(commands: []);
      await current.restoreSession();
      expect(current.appAdvisor.isSupported, isTrue);
    });

    test('sends every command without an envelope target', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands);
      await repo.restoreSession();

      expect(
        await repo.appAdvisor.send(userMessageId: 'u1', text: 'Hi'),
        'cmd-advisor',
      );
      await repo.appAdvisor.send(
        chatId: 'c1',
        userMessageId: 'u2',
        text: 'Again',
        workEntryId: 'e1',
      );
      await repo.appAdvisor.cancel('c1');
      await repo.appAdvisor.createTab(chatId: 'c2', workEntryId: 'e1');
      await repo.appAdvisor.answerQuestion(
        chatId: 'c1',
        requestId: 'q1',
        answers: const [
          AskUserQuestionAnswer(question: 'Pick', selectedOptions: ['A']),
        ],
      );
      await repo.appAdvisor.dismissQuestion(chatId: 'c1', requestId: 'q2');
      await repo.appAdvisor.requestState();

      expect(commands, [
        {
          'type': 'portal.app_advisor.send',
          'payload': {'userMessageId': 'u1', 'text': 'Hi'},
        },
        {
          'type': 'portal.app_advisor.send',
          'payload': {
            'chatId': 'c1',
            'userMessageId': 'u2',
            'text': 'Again',
            'workEntryId': 'e1',
          },
        },
        {
          'type': 'portal.app_advisor.cancel',
          'payload': {'chatId': 'c1'},
        },
        {
          'type': 'portal.app_advisor.create_tab',
          'payload': {'chatId': 'c2', 'workEntryId': 'e1'},
        },
        {
          'type': 'portal.app_advisor.answer_question',
          'payload': {
            'chatId': 'c1',
            'requestId': 'q1',
            'answers': [
              {
                'question': 'Pick',
                'selectedOptions': ['A'],
              },
            ],
          },
        },
        {
          'type': 'portal.app_advisor.dismiss_question',
          'payload': {'chatId': 'c1', 'requestId': 'q2'},
        },
        {
          'type': 'portal.state.request',
          'payload': {'scope': 'app_advisor'},
        },
      ]);
    });

    test('sets a chat model without an envelope target', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands);
      await repo.restoreSession();
      await repo.appAdvisor.setModel(chatId: 'c1', model: 'claude-opus-5-5');
      expect(commands.single, {
        'type': 'portal.app_advisor.set_model',
        'payload': {'chatId': 'c1', 'model': 'claude-opus-5-5'},
      });
    });

    test('a send can carry the chosen model', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands);
      await repo.restoreSession();
      await repo.appAdvisor.send(
        userMessageId: 'u1',
        text: 'Hi',
        model: 'claude-opus-5-5',
      );
      expect(commands.single, {
        'type': 'portal.app_advisor.send',
        'payload': {
          'userMessageId': 'u1',
          'text': 'Hi',
          'model': 'claude-opus-5-5',
        },
      });
    });

    test('reads the Advisor default model and catalog', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(
        commands: commands,
        response: {
          'commandId': 'cmd-settings',
          'result': {
            'model': 'claude-sonnet-5-5',
            'availableModels': [
              {'id': 'claude-sonnet-5-5', 'label': 'Claude Sonnet 5.5'},
            ],
          },
        },
      );
      await repo.restoreSession();
      final read = await repo.appAdvisor.readSettings();
      expect(commands.single, {
        'type': 'portal.app_advisor.settings.get',
        'payload': <String, dynamic>{},
      });
      expect(read.commandId, 'cmd-settings');
      expect(read.settings?.model, 'claude-sonnet-5-5');
      expect(read.settings?.availableModels.single.label, 'Claude Sonnet 5.5');
    });

    test(
      'a settings read the desktop has not answered yet has no settings',
      () async {
        final repo = repoWith(commands: []);
        await repo.restoreSession();
        final read = await repo.appAdvisor.readSettings();
        expect(read.commandId, 'cmd-advisor');
        expect(read.settings, isNull);
      },
    );

    test('one chat is requested with a chat target', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands);
      await repo.restoreSession();
      expect(await repo.appAdvisor.requestChatState('c1'), 'cmd-advisor');
      expect(commands.single, {
        'type': 'portal.state.request',
        'target': {'chatLocalId': 'c1'},
        'payload': {'scope': 'app_advisor'},
      });
    });

    test('sends nothing to an older desktop', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands, capable: false);
      await repo.restoreSession();
      await expectLater(
        repo.appAdvisor.send(userMessageId: 'u1', text: 'Hi'),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'Update the desktop app to use Orchestrator here.',
          ),
        ),
      );
      await expectLater(
        repo.appAdvisor.requestState(),
        throwsA(isA<RemoteControlException>()),
      );
      expect(commands, isEmpty);
    });

    test('surfaces a waited command error', () async {
      final repo = repoWith(
        commands: [],
        response: {
          'commandId': 'cmd-advisor',
          'error': 'Orchestrator is unavailable in this desktop build.',
        },
      );
      await repo.restoreSession();
      await expectLater(
        repo.appAdvisor.createTab(chatId: 'c2'),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'Orchestrator is unavailable in this desktop build.',
          ),
        ),
      );
    });
  });

  test(
    'reads the pipeline run chat links capability from the session',
    () async {
      HttpRemoteControlRepository repoWith(Object? capability) =>
          _repository((request) async {
            final body = _activeSessionJson();
            (body['session'] as Map<String, dynamic>)['capabilities'] = {
              'portal-v1': true,
              'pipeline_run_chat_links': ?capability,
            };
            return _json(body);
          });
      for (final (capability, expected) in [
        (null, false),
        (false, false),
        (true, true),
      ]) {
        final repo = repoWith(capability);
        await repo.restoreSession();
        expect(
          repo.supportsPipelineRunChatLinks,
          expected,
          reason: 'capability: $capability',
        );
      }
    },
  );

  group('pipeline chat follow-up (CAN-3719)', () {
    HttpRemoteControlRepository repoWith({
      required List<Map<String, dynamic>> commands,
      bool capable = true,
      Map<String, dynamic> response = const {'commandId': 'cmd-1'},
    }) => _repository((request) async {
      if (request.url.path.endsWith('/session')) {
        final body = _activeSessionJson();
        (body['session'] as Map<String, dynamic>)['capabilities'] = {
          'portal-v1': true,
          if (capable) 'pipeline_chat_follow_up': true,
        };
        return _json(body);
      }
      commands.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json(response);
    });

    test('prepares through the run owner without a path or prompt', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(
        commands: commands,
        response: {
          'commandId': 'cmd-1',
          'result': {'prompt': 'Review this plan: /p.md'},
        },
      );
      await repo.restoreSession();
      expect(repo.supportsPipelineChatFollowUp, isTrue);

      final result = await repo.preparePipelineChatFollowUp(
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        executionId: 'exec-1',
        output: RemotePipelineFollowUpOutput.plan,
      );

      expect(result.result?['prompt'], 'Review this plan: /p.md');
      expect(commands.single, {
        'type': 'portal.pipeline.chat_follow_up.prepare',
        'target': {'workspaceLocalId': 'ws', 'worktreeLocalId': 'wt'},
        'payload': {
          'projectId': 'ws',
          'worktreeId': 'wt',
          'executionId': 'exec-1',
          'output': 'plan',
        },
      });
    });

    test('surfaces the desktop rejection message', () async {
      final repo = repoWith(
        commands: [],
        response: {
          'commandId': 'cmd-1',
          'error': 'This pipeline run does not have a saved report file.',
        },
      );
      await repo.restoreSession();
      await expectLater(
        repo.preparePipelineChatFollowUp(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          executionId: 'exec-1',
          output: RemotePipelineFollowUpOutput.report,
        ),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'This pipeline run does not have a saved report file.',
          ),
        ),
      );
    });

    test('an older desktop is never asked', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands, capable: false);
      await repo.restoreSession();
      expect(repo.supportsPipelineChatFollowUp, isFalse);
      await expectLater(
        repo.preparePipelineChatFollowUp(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          executionId: 'exec-1',
          output: RemotePipelineFollowUpOutput.plan,
        ),
        throwsA(isA<RemoteControlException>()),
      );
      expect(commands, isEmpty);
    });
  });

  group('pipeline content reads (CAN-3717)', () {
    HttpRemoteControlRepository repoWith({
      required List<Map<String, dynamic>> commands,
      bool capable = true,
    }) => _repository((request) async {
      if (request.url.path.endsWith('/session')) {
        final body = _activeSessionJson();
        (body['session'] as Map<String, dynamic>)['capabilities'] = {
          'portal-v1': true,
          if (capable) 'pipeline_content': true,
        };
        return _json(body);
      }
      commands.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json({'commandId': 'cmd-1'});
    });

    test('reads a page through the run owner without a path', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands);
      await repo.restoreSession();
      expect(repo.pipelineContent.isSupported, isTrue);

      await repo.pipelineContent.readPage(
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        executionId: 'exec-1',
        source: const RemotePipelineStepOutputSource(
          jobId: 'test_0',
          stepId: 'run',
        ),
        offset: 10,
        revision: 'r1',
      );
      await repo.pipelineContent.readPage(
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        executionId: 'exec-1',
        source: const RemotePipelineReportSource(),
      );

      expect(commands, [
        {
          'type': 'portal.pipeline.content.read',
          'target': {'workspaceLocalId': 'ws', 'worktreeLocalId': 'wt'},
          'payload': {
            'projectId': 'ws',
            'worktreeId': 'wt',
            'executionId': 'exec-1',
            'source': {
              'kind': 'step_output',
              'jobId': 'test_0',
              'stepId': 'run',
            },
            'offset': 10,
            'revision': 'r1',
          },
        },
        {
          'type': 'portal.pipeline.content.read',
          'target': {'workspaceLocalId': 'ws', 'worktreeLocalId': 'wt'},
          'payload': {
            'projectId': 'ws',
            'worktreeId': 'wt',
            'executionId': 'exec-1',
            'source': {'kind': 'report'},
          },
        },
      ]);
    });

    test('an older desktop is never asked', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands, capable: false);
      await repo.restoreSession();
      expect(repo.pipelineContent.isSupported, isFalse);
      await expectLater(
        repo.pipelineContent.readPage(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          executionId: 'exec-1',
          source: const RemotePipelineReportSource(),
        ),
        throwsA(isA<RemoteControlException>()),
      );
      expect(commands, isEmpty);
    });
  });

  group('pipeline dispatch (CAN-3174)', () {
    HttpRemoteControlRepository repoWith({
      required List<Map<String, dynamic>> commands,
      bool capable = true,
      Map<String, dynamic> response = const {'commandId': 'cmd-1'},
      int status = 200,
    }) => _repository((request) async {
      if (request.url.path.endsWith('/session')) {
        final body = _activeSessionJson();
        (body['session'] as Map<String, dynamic>)['capabilities'] = {
          'portal-v1': true,
          if (capable) 'pipeline_dispatch': true,
        };
        return _json(body);
      }
      commands.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json(response, status);
    });

    test('reads the capability from the session', () async {
      final repo = repoWith(commands: [], capable: false);
      await repo.restoreSession();
      expect(repo.supportsPipelineDispatch, isFalse);
      final capableRepo = repoWith(commands: []);
      await capableRepo.restoreSession();
      expect(capableRepo.supportsPipelineDispatch, isTrue);
    });

    test(
      'form request targets the worktree and returns the inline result',
      () async {
        final commands = <Map<String, dynamic>>[];
        final repo = repoWith(
          commands: commands,
          response: {
            'commandId': 'cmd-1',
            'result': {
              'definition': {'name': 'Deploy'},
              'dispatchInputs': <String, dynamic>{},
            },
          },
        );
        await repo.restoreSession();
        final result = await repo.requestPipelineDispatchForm(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          pipelineId: 'deploy',
        );
        expect(result.result?['definition'], {'name': 'Deploy'});
        expect(commands.single, {
          'type': 'portal.pipeline.get',
          'target': {'workspaceLocalId': 'ws', 'worktreeLocalId': 'wt'},
          'payload': {
            'projectId': 'ws',
            'worktreeId': 'wt',
            'pipelineId': 'deploy',
          },
        });
      },
    );

    test(
      'dispatch sends the run with inputs and returns the command id',
      () async {
        final commands = <Map<String, dynamic>>[];
        final repo = repoWith(commands: commands);
        await repo.restoreSession();
        final commandId = await repo.dispatchPipeline(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          pipelineId: 'deploy',
          inputs: {'environment': 'staging'},
        );
        expect(commandId, 'cmd-1');
        expect(commands.single, {
          'type': 'portal.pipeline.run',
          'target': {'workspaceLocalId': 'ws', 'worktreeLocalId': 'wt'},
          'payload': {
            'projectId': 'ws',
            'worktreeId': 'wt',
            'pipelineId': 'deploy',
            'inputs': {'environment': 'staging'},
          },
        });
      },
    );

    test('dispatch omits empty inputs', () async {
      final commands = <Map<String, dynamic>>[];
      final repo = repoWith(commands: commands);
      await repo.restoreSession();
      await repo.dispatchPipeline(
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        pipelineId: 'lint',
        inputs: const {},
      );
      expect(
        (commands.single['payload'] as Map<String, dynamic>).containsKey(
          'inputs',
        ),
        isFalse,
      );
    });

    test('a relay-queued dispatch keeps its command id', () async {
      final repo = repoWith(
        commands: [],
        response: {'commandId': 'cmd-1', 'queuedWhileReconnecting': true},
      );
      await repo.restoreSession();
      await expectLater(
        repo.dispatchPipeline(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          pipelineId: 'deploy',
          inputs: const {},
        ),
        throwsA(
          isA<RemotePipelineDispatchQueuedException>().having(
            (error) => error.commandId,
            'commandId',
            'cmd-1',
          ),
        ),
      );
    });

    test(
      'a lost dispatch response is an unknown outcome, not a rejection',
      () async {
        final repo = repoWith(
          commands: [],
          status: 502,
          response: {'error': 'Bad gateway'},
        );
        await repo.restoreSession();
        await expectLater(
          repo.dispatchPipeline(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
            pipelineId: 'deploy',
            inputs: const {},
          ),
          throwsA(isA<RemotePipelineDispatchOutcomeUnknownException>()),
        );
      },
    );
  });

  test('composer slash commands use the waited editor command', () async {
    final commands = <Map<String, dynamic>>[];
    final repo = _repository((request) async {
      if (request.url.path.endsWith('/session')) {
        return _json(_activeSessionJson());
      }
      commands.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json({
        'commandId': 'cmd-slash',
        'result': {
          'commands': [
            {'name': 'review', 'description': 'Review changes'},
          ],
        },
      });
    });
    await repo.restoreSession();
    final rows = await repo.composerCommands.list(
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      providerType: 'claude',
    );
    expect(rows.single.name, 'review');
    expect(commands.single, {
      'type': 'portal.editor.list_slash_commands',
      'target': {'workspaceLocalId': 'ws', 'worktreeLocalId': 'wt'},
      'payload': {
        'projectId': 'ws',
        'worktreeId': 'wt',
        'providerType': 'claude',
      },
    });
  });

  group('CAN-3925 invocable inventory', () {
    (HttpRemoteControlRepository, List<Map<String, dynamic>>) repoWith(
      Map<String, bool> capabilities,
    ) {
      final posts = <Map<String, dynamic>>[];
      final repo = _repository((request) async {
        if (request.url.path.endsWith('/session')) {
          final json = _activeSessionJson();
          json['session']['capabilities'] = capabilities;
          return _json(json);
        }
        posts.add(jsonDecode(request.body) as Map<String, dynamic>);
        return _json({
          'commandId': 'cmd-${posts.length}',
          'result': {'commands': <Object?>[], 'stale': false},
        });
      });
      return (repo, posts);
    }

    test(
      'a capable desktop lists a chat and saves standalone plugins',
      () async {
        final (repo, posts) = repoWith({'invocable_inventory': true});
        await repo.restoreSession();
        expect(repo.composerCommands.supportsInvocableInventory, isTrue);

        await repo.composerCommands.invocables(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
            chatId: 'chat-1',
          ),
        );
        final commandId = await repo.setChatPluginSelections(
          const RemoteStandaloneChatTarget(
            chatId: 'chat-solo',
            projectLocalId: 'ws-notes',
          ),
          const {
            'collectionIds': ['kit'],
            'pluginRefs': <Object?>[],
          },
        );

        expect(commandId, 'cmd-2');
        expect(posts, [
          {
            'type': 'portal.editor.list_invocables',
            'target': {'workspaceLocalId': 'ws', 'worktreeLocalId': 'wt'},
            'payload': {
              'target': {
                'kind': 'worktree',
                'projectId': 'ws',
                'worktreeId': 'wt',
                'chatId': 'chat-1',
              },
            },
          },
          {
            'type': 'portal.standalone_chat.set_plugin_selections',
            'target': {'standaloneChatLocalId': 'chat-solo'},
            'payload': {
              'projectLocalId': 'ws-notes',
              'chatId': 'chat-solo',
              'selections': {
                'collectionIds': ['kit'],
                'pluginRefs': <Object?>[],
              },
            },
          },
        ]);
      },
    );

    test('an older desktop never receives the standalone selection', () async {
      final (repo, posts) = repoWith({'chat_attachments': true});
      await repo.restoreSession();
      expect(repo.composerCommands.supportsInvocableInventory, isFalse);
      await expectLater(
        repo.setChatPluginSelections(
          const RemoteStandaloneChatTarget(
            chatId: 'chat-solo',
            projectLocalId: 'ws-notes',
          ),
          const {},
        ),
        throwsA(isA<RemoteControlException>()),
      );
      expect(posts, isEmpty);
    });
  });

  group('add project by git URL (CAN-3988)', () {
    /// Submits one clone against a commands endpoint answered by [answer],
    /// recording every request body it receives.
    Future<(List<Map<String, dynamic>> posts, RemoteProjectCreateOutcome)>
    cloneWith(
      Future<http.Response> Function() answer, {
      String remoteUrl = 'https://github.com/org/repo.git',
      bool paired = true,
    }) async {
      final posts = <Map<String, dynamic>>[];
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        if (path.endsWith('/commands') && request.method == 'POST') {
          posts.add(jsonDecode(request.body) as Map<String, dynamic>);
          return answer();
        }
        fail('unexpected request: ${request.method} $path');
      });
      if (paired) await repo.restoreSession();
      final outcome = await repo.projects.createProjectFromGitUrl(remoteUrl);
      return (posts, outcome);
    }

    test(
      'sends one untargeted remote-clone command with the trimmed URL',
      () async {
        final (posts, _) = await cloneWith(
          () async => _json({'commandId': 'cmd-1'}, 202),
          remoteUrl: '  https://github.com/org/repo.git \n',
        );

        expect(posts, [
          {
            'type': 'portal.workspace.create',
            'payload': {
              'kind': 'remote-clone',
              'remoteUrl': 'https://github.com/org/repo.git',
            },
          },
        ]);
      },
    );

    test('maps a 202 with the created workspace to completed', () async {
      final (_, outcome) = await cloneWith(
        () async => _json({
          'commandId': 'cmd-1',
          'queuedWhileReconnecting': false,
          'result': {'workspaceId': 'ws-new'},
        }, 202),
      );

      expect(
        outcome,
        isA<RemoteProjectCreateCompleted>().having(
          (o) => o.workspaceId,
          'workspaceId',
          'ws-new',
        ),
      );
    });

    for (final queued in [false, true]) {
      test(
        'maps a 202 without a result to pending (queued: $queued)',
        () async {
          final (_, outcome) = await cloneWith(
            () async => _json({
              'commandId': 'cmd-1',
              'queuedWhileReconnecting': queued,
            }, 202),
          );

          expect(
            outcome,
            isA<RemoteProjectCreatePending>()
                .having((o) => o.commandId, 'commandId', 'cmd-1')
                .having(
                  (o) => o.queuedWhileReconnecting,
                  'queuedWhileReconnecting',
                  queued,
                ),
          );
        },
      );
    }

    test('maps a 202 carrying an error to failed with that message', () async {
      const message =
          'Failed to clone the repository. Check the URL and access, then try '
          'again.';
      final (_, outcome) = await cloneWith(
        () async => _json({'commandId': 'cmd-1', 'error': message}, 202),
      );

      expect(
        outcome,
        isA<RemoteProjectCreateFailed>().having(
          (o) => o.message,
          'message',
          message,
        ),
      );
    });

    for (final (status, error) in const [
      (400, 'Invalid project create payload.'),
      (403, 'Forbidden'),
      (503, 'Secure command delivery is unavailable.'),
    ]) {
      test('maps an explicit $status rejection to failed', () async {
        final (posts, outcome) = await cloneWith(
          () async => _json({'error': error}, status),
        );

        expect(posts, hasLength(1));
        expect(
          outcome,
          isA<RemoteProjectCreateFailed>().having(
            (o) => o.message,
            'message',
            error,
          ),
        );
      });
    }

    test('fails without sending when no desktop is paired', () async {
      final (posts, outcome) = await cloneWith(
        () async => _json({'commandId': 'cmd-1'}, 202),
        paired: false,
      );

      expect(posts, isEmpty);
      expect(outcome, isA<RemoteProjectCreateFailed>());
    });

    for (final (label, answer) in <(String, Future<http.Response> Function())>[
      (
        'a connection reset',
        () async => throw const SocketException('Connection reset by peer'),
      ),
      (
        'a dropped client connection',
        () async => throw http.ClientException('Connection closed'),
      ),
      ('a 408', () async => _json({'error': 'Request timeout'}, 408)),
      ('an ambiguous 502', () async => http.Response('Bad gateway', 502)),
      ('a 504', () async => _json({'error': 'Gateway timeout'}, 504)),
      ('a 202 without an id', () async => _json(<String, Object>{}, 202)),
      (
        'a result without a workspace id',
        () async => _json({'commandId': 'cmd-1', 'result': {}}, 202),
      ),
      (
        'a non-string workspace id',
        () async => _json({
          'commandId': 'cmd-1',
          'result': {'workspaceId': 42},
        }, 202),
      ),
      ('a non-JSON body', () async => http.Response('<html>', 202)),
    ]) {
      test('maps $label to unknown without a second POST', () async {
        final (posts, outcome) = await cloneWith(answer);

        expect(posts, hasLength(1));
        expect(outcome, isA<RemoteProjectCreateUnknown>());
      });
    }

    test('maps an unanswered submit to unknown after the timeout', () {
      fakeAsync((async) {
        final posts = <String>[];
        final repo = _repository((request) {
          final path = request.url.path;
          if (path.endsWith('/session')) {
            return Future.value(_json(_activeSessionJson()));
          }
          posts.add(path);
          return Completer<http.Response>().future;
        });
        repo.restoreSession();
        async.flushMicrotasks();
        RemoteProjectCreateOutcome? outcome;
        repo.projects
            .createProjectFromGitUrl('https://github.com/org/repo.git')
            .then((value) => outcome = value);
        async.elapse(kRemoteProjectCreateTimeout - const Duration(seconds: 1));
        expect(outcome, isNull);
        async.elapse(const Duration(seconds: 2));

        expect(outcome, isA<RemoteProjectCreateUnknown>());
        expect(posts, hasLength(1));
      });
    });

    test('bounds a stalled status read', () {
      fakeAsync((async) {
        final repo = _repository((request) {
          if (request.url.path.endsWith('/session')) {
            return Future.value(_json(_activeSessionJson()));
          }
          return Completer<http.Response>().future;
        });
        repo.restoreSession();
        async.flushMicrotasks();
        Object? error;
        repo.projects.commandStatus('cmd-1').catchError((Object e) {
          error = e;
          return BrowserPortalCommandStatusResponse(
            commandId: 'cmd-1',
            status: BrowserPortalCommandStatus.queued,
          );
        });
        async.elapse(kRemoteProjectCreateTimeout + const Duration(seconds: 1));

        expect(error, isA<TimeoutException>());
      });
    });

    test('reads a command status on the paired session', () async {
      final requests = <String>[];
      final repo = _repository((request) async {
        final path = request.url.path;
        if (path.endsWith('/session')) return _json(_activeSessionJson());
        requests.add('${request.method} ${request.url.path}');
        return _json({
          'commandId': 'cmd/1',
          'status': 'COMPLETED',
          'result': {'workspaceId': 'ws-new'},
        });
      });
      await repo.restoreSession();

      final status = await repo.projects.commandStatus('cmd/1');

      expect(requests, [
        'GET $portalBrowserBasePath/sessions/sess-1/commands/cmd%2F1',
      ]);
      expect(status.status, BrowserPortalCommandStatus.completed);
      expect(status.result, {'workspaceId': 'ws-new'});
    });
  });
}
