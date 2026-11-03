import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

import '../../support/provider_usage_fixture.dart';

RemoteControlApiService _service(MockClient client) => RemoteControlApiService(
  apiClient: ApiClient(
    baseUrl: 'https://example.test',
    tokenProvider: () => 'token-1',
    httpClient: client,
  ),
);

void main() {
  group('fetchCurrentSession', () {
    test('parses an active session', () async {
      final service = _service(
        MockClient((request) async {
          expect(request.url.path, '$portalBrowserBasePath/session');
          expect(request.headers['Authorization'], 'Bearer token-1');
          return http.Response(
            jsonEncode({
              'session': {
                'id': 'sess-1',
                'status': 'active',
                'connectionStatus': 'active',
                'clientName': "Alex's MacBook Pro",
                'clientVersion': '1.2.3',
                'activatedAt': '2026-07-16T09:00:00Z',
                'lastSeenAt': '2026-07-16T10:00:00Z',
              },
            }),
            200,
          );
        }),
      );

      final session = await service.fetchCurrentSession();
      expect(session, isNotNull);
      expect(session?.id, 'sess-1');
      expect(session?.status, 'active');
      expect(session?.connectionStatus, RemotePortalConnectionStatus.active);
      expect(session?.clientName, "Alex's MacBook Pro");
    });

    test('reads the space notification gate, failing closed', () async {
      for (final (value, expected) in <(Object?, bool)>[
        (true, true),
        (false, false),
        (null, false),
        ('true', false),
      ]) {
        final service = _service(
          MockClient(
            (request) async => http.Response(
              jsonEncode({
                'session': {
                  'id': 'sess-1',
                  'status': 'active',
                  'spaceNotificationSettingsEnabled': ?value,
                },
              }),
              200,
            ),
          ),
        );
        final session = await service.fetchCurrentSession();
        expect(session?.spaceNotificationSettingsEnabled, expected);
      }
    });

    test('returns null when no session exists', () async {
      final service = _service(
        MockClient(
          (request) async => http.Response(jsonEncode({'session': null}), 200),
        ),
      );
      expect(await service.fetchCurrentSession(), isNull);
    });
  });

  group('connect', () {
    test('returns the activated sessionId', () async {
      final service = _service(
        MockClient((request) async {
          expect(request.url.path, '$portalBrowserBasePath/connect');
          expect(jsonDecode(request.body), {'code': '123456'});
          return http.Response(
            jsonEncode({'sessionId': 'sess-9', 'status': 'active'}),
            200,
          );
        }),
      );
      expect(await service.connect('123456'), 'sess-9');
    });

    test('surfaces rejection as ApiException with the server body', () async {
      final service = _service(
        MockClient(
          (request) async =>
              http.Response(jsonEncode({'error': 'Code not recognized.'}), 401),
        ),
      );

      try {
        await service.connect('654321');
        fail('expected ApiException');
      } on ApiException catch (e) {
        expect(e.statusCode, 401);
        expect(apiErrorMessage(e), 'Code not recognized.');
      }
    });
  });

  group('fetchState', () {
    test('parses snapshot, connection status, and event cursor', () async {
      final service = _service(
        MockClient((request) async {
          expect(
            request.url.path,
            '$portalBrowserBasePath/sessions/sess-1/state',
          );
          expect(request.url.queryParameters['scope'], 'overview');
          return http.Response(
            jsonEncode({
              'state': {
                'workspaces': [
                  {'localId': 'ws-1', 'name': 'app', 'type': 'single-repo'},
                ],
                'worktrees': [],
                'standaloneChats': [],
                'chatSummaries': [
                  {
                    'chatId': 'chat-1',
                    'scope': 'worktree',
                    'workspaceLocalId': 'ws-1',
                    'worktreeLocalId': 'wt-1',
                    'title': 'Fix tests',
                  },
                ],
                'chatMessages': [
                  {
                    'scope': 'worktree',
                    'localChatId': 'chat-1',
                    'localMessageId': 'msg-1',
                    'role': 'user',
                    'status': 'complete',
                    'content': 'hello',
                    'occurredAt': '2026-07-16T10:00:00Z',
                  },
                ],
              },
              'connectionStatus': 'reconnecting',
              'refreshing': true,
              'eventCursor': 41,
            }),
            200,
          );
        }),
      );

      final result = await service.fetchState('sess-1');
      expect(result.snapshot.workspaces.single.localId, 'ws-1');
      expect(result.snapshot.chatSummaries.single.chatId, 'chat-1');
      expect(result.snapshot.chatMessages.single.text, 'hello');
      expect(
        result.snapshot.chatMessages.single.scope,
        RemoteChatScope.worktree,
      );
      expect(
        result.connectionStatus,
        RemotePortalConnectionStatus.reconnecting,
      );
      expect(result.refreshing, isTrue);
      expect(result.eventCursor, 41);
    });
  });

  group('fetchState provider usage (CAN-3636)', () {
    RemoteControlApiService serviceReturning(Map<String, dynamic> body) =>
        _service(MockClient((_) async => http.Response(jsonEncode(body), 200)));

    Map<String, dynamic> body({Object? snapshot}) => {
      // The projected shell never carries account-level usage.
      'state': {'workspaces': [], 'worktrees': [], 'standaloneChats': []},
      'connectionStatus': 'active',
      'refreshing': false,
      'eventCursor': 40,
      'scope': 'overview',
      'snapshot': ?snapshot,
    };

    test('reads the cached singleton from the raw overview entities', () async {
      final result = await serviceReturning(
        body(
          snapshot: {
            'scope': 'overview',
            'entities': [
              {'entityType': 'workspace', 'localId': 'ws', 'payload': {}},
              providerUsageEntity(providerUsagePayload()),
            ],
          },
        ),
      ).fetchState('sess-1');
      final usage = result.snapshot.providerUsage!.projection!;
      expect(usage.providers.map((p) => p.provider.wire), ['claude', 'codex']);
      expect(usage.providers.first.planLabel, 'Claude Max 20x');
      expect(result.eventCursor, 40);
    });

    test('an overview without the singleton clears it; no raw snapshot '
        'says nothing', () async {
      final cleared = await serviceReturning(
        body(snapshot: {'scope': 'overview', 'entities': <Object>[]}),
      ).fetchState('sess-1');
      expect(cleared.snapshot.providerUsage, isNotNull);
      expect(cleared.snapshot.providerUsage!.projection, isNull);

      final older = await serviceReturning(body()).fetchState('sess-1');
      expect(older.snapshot.providerUsage, isNull);

      final scoped = await serviceReturning(
        body(snapshot: {'scope': 'worktree', 'entities': <Object>[]}),
      ).fetchState('sess-1');
      expect(scoped.snapshot.providerUsage, isNull);
    });
  });

  group('submitCommand', () {
    test('posts the command envelope and parses the 202 response', () async {
      final service = _service(
        MockClient((request) async {
          expect(
            request.url.path,
            '$portalBrowserBasePath/sessions/sess-1/commands',
          );
          expect(jsonDecode(request.body), {
            'type': 'portal.chat.send',
            'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
            'payload': {
              'projectId': 'ws-1',
              'worktreeId': 'wt-1',
              'chatId': 'chat-1',
              'userMessageId': 'msg-77',
              'text': 'run the tests',
            },
          });
          return http.Response(
            jsonEncode({
              'commandId': 'cmd-1',
              'queuedWhileReconnecting': false,
              'chatId': 'chat-1',
            }),
            202,
          );
        }),
      );

      final result = await service.submitCommand(
        'sess-1',
        type: 'portal.chat.send',
        target: {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
        payload: {
          'projectId': 'ws-1',
          'worktreeId': 'wt-1',
          'chatId': 'chat-1',
          'userMessageId': 'msg-77',
          'text': 'run the tests',
        },
      );
      expect(result.commandId, 'cmd-1');
      expect(result.chatId, 'chat-1');
      expect(result.queuedWhileReconnecting, isFalse);
      expect(result.error, isNull);
    });
  });

  group('chat attachments', () {
    test('uploadChatAttachment posts bytes and parses the ref', () async {
      final service = _service(
        MockClient((request) async {
          expect(request.method, 'POST');
          expect(
            request.url.path,
            '$portalAttachmentBasePath/sessions/sess-1/attachments',
          );
          expect(request.url.queryParameters, {
            'filename': 'p.png',
            'mediaType': 'image/png',
          });
          expect(request.headers['Content-Type'], startsWith('image/png'));
          expect(request.bodyBytes, [1, 2]);
          return http.Response(
            jsonEncode({
              'attachmentId': '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
              'filename': 'p.png',
              'mediaType': 'image/png',
              'size': 2,
              'contentSha256': 'a' * 64,
              'storageKind': 'blob',
              'source': '/c',
            }),
            201,
          );
        }),
      );
      final ref = await service.uploadChatAttachment(
        'sess-1',
        filename: 'p.png',
        mediaType: 'image/png',
        bytes: Uint8List.fromList([1, 2]),
      );
      expect(ref.attachmentId, '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3');
      expect(ref.size, 2);
    });

    test('uploadChatAttachment rejects a malformed ref as a 502', () async {
      final service = _service(
        MockClient((_) async => http.Response('{}', 201)),
      );
      await expectLater(
        service.uploadChatAttachment(
          's',
          filename: 'p.png',
          mediaType: 'image/png',
          bytes: Uint8List(1),
        ),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 502)),
      );
    });

    test('deleteChatAttachment issues DELETE on the attachment path', () async {
      late http.Request captured;
      final service = _service(
        MockClient((request) async {
          captured = request;
          return http.Response('', 204);
        }),
      );
      await service.deleteChatAttachment('sess-1', 'att-1');
      expect(captured.method, 'DELETE');
      expect(
        captured.url.path,
        '$portalAttachmentBasePath/sessions/sess-1/attachments/att-1',
      );
    });
  });

  group('endSession', () {
    test('posts to the end route', () async {
      var called = false;
      final service = _service(
        MockClient((request) async {
          expect(
            request.url.path,
            '$portalBrowserBasePath/sessions/sess-1/end',
          );
          called = true;
          return http.Response(jsonEncode({'ok': true}), 200);
        }),
      );
      await service.endSession('sess-1');
      expect(called, isTrue);
    });

    test('sends through a caller-owned client with the same auth', () async {
      final service = _service(
        MockClient((request) async => fail('used the shared client')),
      );
      http.Request? sent;
      final owned = MockClient((request) async {
        sent = request;
        return http.Response(jsonEncode({'ok': true}), 200);
      });

      await service.endSession('sess-1', httpClient: owned);

      expect(sent?.method, 'POST');
      expect(
        sent?.url.toString(),
        'https://example.test$portalBrowserBasePath/sessions/sess-1/end',
      );
      expect(sent?.headers['Authorization'], 'Bearer token-1');
    });
  });

  group('readDiff', () {
    test('posts the diff read request and parses the snapshot', () async {
      Map<String, dynamic>? body;
      final service = _service(
        MockClient((request) async {
          expect(
            request.url.path,
            '$portalBrowserBasePath/sessions/sess-1/diff/read',
          );
          body = jsonDecode(request.body) as Map<String, dynamic>;
          return http.Response(
            jsonEncode({
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'repoId': 'api',
              'filePath': 'lib/a.dart',
              'files': [
                {
                  'filePath': 'lib/a.dart',
                  'status': 'modified',
                  'insertions': 1,
                  'deletions': 1,
                },
              ],
              'patch': '@@ -1 +1 @@\n-a\n+b\n',
              'rangeLabel': 'abc123..def456',
            }),
            200,
          );
        }),
      );

      final diff = await service.readDiff(
        'sess-1',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        repoId: 'api',
        path: 'lib/a.dart',
        source: RemoteDiffSource.committed,
      );
      expect(body, {
        'workspaceId': 'ws-1',
        'worktreeId': 'wt-1',
        'repoId': 'api',
        'path': 'lib/a.dart',
        'source': 'committed',
      });
      expect(diff.filePath, 'lib/a.dart');
      expect(diff.patch, '@@ -1 +1 @@\n-a\n+b\n');
      expect(diff.rangeLabel, 'abc123..def456');
      expect(diff.insertions, 1);
      expect(diff.deletions, 1);
    });

    test('omits repoId when absent and tolerates a missing patch', () async {
      Map<String, dynamic>? body;
      final service = _service(
        MockClient((request) async {
          body = jsonDecode(request.body) as Map<String, dynamic>;
          return http.Response(
            jsonEncode({
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'filePath': 'lib/a.dart',
              'files': <Object>[],
            }),
            200,
          );
        }),
      );

      final diff = await service.readDiff(
        'sess-1',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        path: 'lib/a.dart',
        source: RemoteDiffSource.uncommitted,
      );
      expect(body, {
        'workspaceId': 'ws-1',
        'worktreeId': 'wt-1',
        'path': 'lib/a.dart',
        'source': 'uncommitted',
      });
      expect(diff.patch, '');
      expect(diff.rangeLabel, isNull);
      expect(diff.insertions, isNull);
    });
  });

  group('fetchCommandStatus (CAN-3988)', () {
    test('reads the encoded session command route', () async {
      final service = _service(
        MockClient((request) async {
          expect(request.method, 'GET');
          expect(
            request.url.path,
            '$portalBrowserBasePath/sessions/sess%2F1/commands/cmd%3F1',
          );
          expect(request.headers['Authorization'], 'Bearer token-1');
          return http.Response(
            jsonEncode({
              'commandId': 'cmd?1',
              'status': 'FAILED',
              'delivered': true,
              'error': 'Failed to clone the repository.',
            }),
            200,
          );
        }),
      );

      final status = await service.fetchCommandStatus('sess/1', 'cmd?1');

      expect(status.commandId, 'cmd?1');
      expect(status.status, BrowserPortalCommandStatus.failed);
      expect(status.delivered, isTrue);
      expect(status.error, 'Failed to clone the repository.');
    });

    for (final status in BrowserPortalCommandStatus.values) {
      test('parses ${status.wire}', () async {
        final service = _service(
          MockClient(
            (_) async => http.Response(
              jsonEncode({'commandId': 'cmd-1', 'status': status.wire}),
              200,
            ),
          ),
        );

        expect(
          (await service.fetchCommandStatus('sess-1', 'cmd-1')).status,
          status,
        );
      });
    }

    test('surfaces a missing command as an ApiException', () async {
      final service = _service(
        MockClient(
          (_) async => http.Response(jsonEncode({'error': 'Not found'}), 404),
        ),
      );

      await expectLater(
        service.fetchCommandStatus('sess-1', 'cmd-1'),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 404)),
      );
    });
  });
}
