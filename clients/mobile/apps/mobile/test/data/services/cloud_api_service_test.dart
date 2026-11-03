import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/data/models/model_routing_availability.dart';
import '../../support/conversation_v2_fixtures.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/cloud_api_service.dart';

CloudApiService _service(
  Future<http.Response> Function(http.Request request) handler,
) => CloudApiService(
  apiClient: ApiClient(
    baseUrl: 'https://example.test',
    tokenProvider: () => 'mobile-session',
    httpClient: MockClient(handler),
  ),
);

http.Response _json(
  Object body, [
  int status = 200,
  Map<String, String>? headers,
]) => http.Response(jsonEncode(body), status, headers: headers ?? const {});

const _chat = <String, Object?>{
  'externalId': 'chat-1',
  'title': 'Cloud task',
  'taskChatExternalId': null,
  'modelDefinitionId': 'model-1',
  'thinkingLevel': 'high',
  'fastMode': true,
  'coreAgentSessionId': 'session-1',
  'createdAtMs': 42,
};

const _workspace = <String, Object?>{
  'retainedChatCount': 1,
  'deletionRetentionDays': 30,
  'externalId': 'workspace-1',
  'name': 'Mobile',
  'description': null,
  'color': '#123456',
  'coreSandboxId': 'sandbox-1',
  'createdAtMs': 21,
  'chats': [_chat],
};

void main() {
  test(
    'v2 routes encode identities, preserve cursors, and send the v2 body',
    () async {
      final requests = <http.Request>[];
      final service = _service((request) async {
        requests.add(request);
        expect(request.headers['Authorization'], 'Bearer mobile-session');
        expect(request.headers['x-canopy-client'], 'mobile');
        final path = request.url.path;
        if (path.endsWith('/discovery')) {
          return _json({'sessionId': 'session-1', 'protocolVersion': 2});
        }
        if (path.endsWith('/conversation') &&
            request.url.queryParameters.containsKey('cursor')) {
          return _json({
            ...v2Snapshot(),
            '@type': 'agent_conversation_history_page',
            'snapshotStateVersion': '0',
            'messageWatermark': '0',
          });
        }
        if (path.endsWith('/conversation')) return _json(v2Snapshot());
        if (path.endsWith('/turns')) {
          return _json(v2Accepted('request', 'hello'), 201);
        }
        return _json({
          'protocolVersion': 2,
          'sessionId': 'session-1',
          'kind': 'cancelled',
          'commandId': 'command',
          'stateVersion': '2',
          'turn': v2Turn(status: 'CANCELLED'),
          'replayed': false,
        });
      });
      expect(
        (await service.discoverConversation('chat/id')).protocolVersion,
        2,
      );
      await service.getConversation('chat/id');
      await service.getConversationHistory('chat/id', 'opaque history/+=');
      await service.postConversationTurn(
        'chat/id',
        const ConversationSendInput(
          clientRequestId: 'request',
          content: 'hello',
          modelDefinitionId: 'model',
          thinkingEffort: 'high',
          fastMode: true,
          retryUncertain: true,
        ),
      );
      await service.conversationCommand(
        'chat/id',
        'turn/id',
        ConversationTurnOperation.cancel,
        const ConversationCommandInput(
          commandId: 'command',
          expectedStateVersion: '1',
        ),
      );
      expect(
        requests.first.url.toString(),
        contains('chat%2Fid/conversation/discovery'),
      );
      expect(requests[2].url.queryParameters['cursor'], 'opaque history/+=');
      expect(jsonDecode(requests[3].body), {
        'clientRequestId': 'request',
        'content': 'hello',
        'modelDefinitionId': 'model',
        'thinkingEffort': 'high',
        'fastMode': true,
        'retryUncertain': true,
      });
      expect(requests.last.url.toString(), contains('/turns/turn%2Fid/cancel'));
      expect(jsonDecode(requests.last.body), {
        'commandId': 'command',
        'expectedStateVersion': '1',
      });
    },
  );
  test(
    'v2 malformed successful admission is retryable and uncertain',
    () async {
      final service = _service((_) async => _json({'protocolVersion': 2}, 201));
      await expectLater(
        service.postConversationTurn(
          'chat',
          const ConversationSendInput(clientRequestId: 'r', content: 'hello'),
        ),
        throwsA(
          isA<CloudSendError>()
              .having((e) => e.uncertain, 'uncertain', isTrue)
              .having((e) => e.kind, 'kind', CloudSendErrorKind.retryable),
        ),
      );
    },
  );
  test(
    'v2 queue capacity Core errors retry without becoming uncertain',
    () async {
      final service = _service(
        (_) async => _json(
          {
            'code': 'AGENT_SESSION_QUEUE_CAPACITY_EXCEEDED',
            'metadata': {
              '@type': 'agent_conversation_queue_capacity_exceeded',
              'protocolVersion': 2,
              'sessionId': 'session-1',
              'retryable': true,
              'queueCapacity': 10,
              'pendingTurnCount': 10,
            },
          },
          409,
          {'Retry-After': '7'},
        ),
      );
      await expectLater(
        service.postConversationTurn(
          'chat',
          const ConversationSendInput(clientRequestId: 'r', content: 'hello'),
        ),
        throwsA(
          isA<CloudSendError>()
              .having((e) => e.kind, 'kind', CloudSendErrorKind.retryable)
              .having((e) => e.retryAfter, 'delay', const Duration(seconds: 7))
              .having((e) => e.uncertain, 'uncertain', isFalse),
        ),
      );
    },
  );
  test('v2 discovery never falls back to legacy on HTTP failure', () async {
    final service = _service((_) async => _json({'error': 'unavailable'}, 404));
    await expectLater(
      service.discoverConversation('chat'),
      throwsA(isA<CloudApiException>()),
    );
  });

  group('provisionFirstWorkspace', () {
    test('posts the account-idempotent first-workspace request', () async {
      final requests = <http.Request>[];
      final service = _service((request) async {
        requests.add(request);
        return _json({'workspace': _workspace}, 201);
      });

      final workspace = await service.provisionFirstWorkspace('My project');

      expect(workspace?.externalId, 'workspace-1');
      expect(requests.single.method, 'POST');
      expect(requests.single.url.path, '/api/cloud/workspaces');
      // No externalId: the server derives one from the account, which is what
      // makes a web tab and this device collide onto one workspace.
      expect(jsonDecode(requests.single.body), {
        'name': 'My project',
        'firstWorkspaceOnly': true,
      });
    });

    test('returns null when the server declines to create one', () async {
      final service = _service(
        (request) async => _json({'workspace': null}, 200),
      );

      expect(await service.provisionFirstWorkspace('My project'), isNull);
    });

    test(
      'surfaces the tenancy-provisioning 503 with its Retry-After',
      () async {
        final service = _service(
          (request) async => _json(
            {
              'error': {
                'code': 'CLOUD_ACCOUNT_PROVISIONING',
                'message': 'Cloud account is still being set up.',
              },
            },
            503,
            {'Retry-After': '2'},
          ),
        );

        await expectLater(
          service.provisionFirstWorkspace('My project'),
          throwsA(
            isA<CloudApiException>()
                .having((e) => e.statusCode, 'statusCode', 503)
                .having((e) => e.code, 'code', 'CLOUD_ACCOUNT_PROVISIONING')
                .having(
                  (e) => e.retryAfter,
                  'retryAfter',
                  const Duration(seconds: 2),
                ),
          ),
        );
      },
    );
  });

  test('lists workspaces and derives the workspace chat listing', () async {
    final service = _service((request) async {
      expect(request.method, 'GET');
      expect(request.url.path, '/api/cloud/workspaces');
      expect(request.headers['Authorization'], 'Bearer mobile-session');
      return _json({
        'workspaces': [_workspace],
      });
    });

    final workspaces = await service.listWorkspaces();
    expect(workspaces.single.externalId, 'workspace-1');
    expect(workspaces.single.chats.single.fastMode, isTrue);
    expect(
      (await service.listChats('workspace-1')).single.externalId,
      'chat-1',
    );
  });

  test('creates a chat with the complete mobile create contract', () async {
    final service = _service((request) async {
      expect(request.method, 'POST');
      expect(request.url.path, '/api/cloud/workspaces/workspace-1/chats');
      // The opening prompt is an accepted turn, attributed to this surface.
      expect(request.headers['x-canopy-client'], 'mobile');
      expect(jsonDecode(request.body), {
        'externalId': 'client-chat-1',
        'title': 'New task',
        'prompt': 'Ship it',
        'modelDefinitionId': 'model-1',
        'thinkingLevel': 'high',
        'fastMode': true,
      });
      return _json({'chat': _chat}, 201);
    });

    final result = await service.createChat(
      'workspace-1',
      externalId: 'client-chat-1',
      title: 'New task',
      prompt: 'Ship it',
      modelDefinitionId: 'model-1',
      thinkingLevel: 'high',
      fastMode: true,
    );
    expect(result.externalId, 'chat-1');
  });

  test('creates an Auto chat without a model id', () async {
    final service = _service((request) async {
      expect(jsonDecode(request.body), {
        'externalId': 'client-chat-1',
        'modelSelectionMode': 'AUTO',
      });
      return _json({
        'chat': {..._chat, 'modelSelectionMode': 'auto'},
      }, 201);
    });

    final result = await service.createChat(
      'workspace-1',
      externalId: 'client-chat-1',
      modelDefinitionId: 'model-1',
      autoModel: true,
    );
    expect(result.modelAuto, isTrue);
  });

  test('turns on Auto with a PATCH and reads routing availability', () async {
    final requests = <http.Request>[];
    final service = _service((request) async {
      requests.add(request);
      if (request.url.path.endsWith('/model-routing-availability')) {
        return _json({'state': 'no-credits'});
      }
      return _json({
        'chat': {..._chat, 'modelSelectionMode': 'auto'},
      });
    });

    expect((await service.setChatAutoModel('chat/1')).modelAuto, isTrue);
    expect(
      await service.getModelRoutingAvailability(),
      ModelRoutingAvailability.noCredits,
    );
    expect(requests.first.method, 'PATCH');
    expect(requests.first.url.path, '/api/cloud/chats/chat%2F1');
    expect(jsonDecode(requests.first.body), {'modelSelectionMode': 'AUTO'});
    expect(requests.last.url.path, '/api/cloud/model-routing-availability');
  });

  test('creates a chat with the draft plugin selection', () async {
    final service = _service((request) async {
      expect(jsonDecode(request.body), {
        'externalId': 'client-chat-1',
        'pluginSelections': {
          'collectionIds': <String>[],
          'skillRefs': [
            {'sourceId': 'src', 'skillName': 'notes'},
          ],
          'pluginRefs': <Object>[],
        },
      });
      return _json({'chat': _chat}, 201);
    });

    await service.createChat(
      'workspace-1',
      externalId: 'client-chat-1',
      pluginSelections: {
        'collectionIds': <String>[],
        'skillRefs': [
          {'sourceId': 'src', 'skillName': 'notes'},
        ],
        'pluginRefs': <Object>[],
      },
    );
  });

  test('gets, renames, changes model, and archives a chat', () async {
    final requests = <http.Request>[];
    final service = _service((request) async {
      requests.add(request);
      if (request.method == 'DELETE') {
        return _json({'archived': true, 'mode': 'archive'});
      }
      return _json({'chat': _chat});
    });

    expect((await service.getChat('chat-1')).externalId, 'chat-1');
    await service.renameChat('chat-1', 'Renamed');
    await service.setChatModel('chat-1', 'model-2');
    await service.archiveChat('chat-1');

    expect(requests.map((r) => r.method), ['GET', 'PATCH', 'PATCH', 'DELETE']);
    expect(jsonDecode(requests[1].body), {'title': 'Renamed'});
    expect(jsonDecode(requests[2].body), {'modelDefinitionId': 'model-2'});
    expect(requests[3].url.queryParameters, {'mode': 'archive'});
  });

  test('deletes a chat into the retention window', () async {
    final requests = <http.Request>[];
    final service = _service((request) async {
      requests.add(request);
      return _json({'archived': true, 'mode': 'delete'});
    });

    await service.deleteChat('chat/1');

    expect(requests.single.method, 'DELETE');
    expect(requests.single.url.path, '/api/cloud/chats/chat%2F1');
    expect(requests.single.url.queryParameters, {'mode': 'delete'});
  });

  test('bootstraps messages and performs a status-only read', () async {
    var statusOnly = false;
    final service = _service((request) async {
      expect(request.url.path, '/api/cloud/chats/chat-1/messages');
      statusOnly = request.url.queryParameters['statusOnly'] == 'true';
      return statusOnly
          ? _json({
              'sourceAgentSessionId': 'session-1',
              'terminalSession': {
                'status': 'COMPLETED',
                'sourceAgentSessionId': 'session-1',
              },
            })
          : _json({
              'messages': [
                {
                  'id': 'message-1',
                  'role': 'ASSISTANT',
                  'text': 'Done',
                  'cost': {'kind': 'billable', 'costUsd': '0.0123'},
                  'costBilledViaLlmProxy': true,
                  'createdAtMs': 99,
                  'artifacts': const [],
                },
                {
                  'id': 'message-2',
                  'role': 'FUTURE_ROLE',
                  'text': 'Still visible',
                  'cost': {'kind': 'future-cost', 'amount': '0.5'},
                  'costBilledViaLlmProxy': false,
                  'createdAtMs': 100,
                  'artifacts': const [],
                },
              ],
              'toolActivity': [
                {
                  'kind': 'future-kind',
                  'payload': {'byteSize': '9007199254740993'},
                },
              ],
              'activeStream': {'after': '9007199254740993'},
            });
    });

    final bootstrap = await service.getMessages('chat-1');
    expect(bootstrap.messages.first.cost.amountUsd, '0.0123');
    expect(bootstrap.messages.last.role, 'FUTURE_ROLE');
    expect(bootstrap.messages.last.cost.kind, CloudCoreCostKind.unknown);
    expect(bootstrap.toolActivity.single.kind, CloudToolActivityKind.unknown);
    expect(bootstrap.activeStreamAfter, '9007199254740993');

    final status = await service.getMessageStatus('chat-1');
    expect(statusOnly, isTrue);
    expect(status.terminalSession?.status, 'COMPLETED');
  });

  test('posts a turn and preserves decimal/cursor strings', () async {
    final service = _service((request) async {
      expect(request.method, 'POST');
      expect(jsonDecode(request.body), {
        'text': 'Hello',
        'clientRequestId': 'request-1',
        'modelDefinitionId': 'model-1',
        'thinkingLevel': null,
        'fastMode': false,
      });
      return _json({
        'message': {
          'id': 'message-1',
          'role': 'USER',
          'text': 'Hello',
          'cost': {'kind': 'pending'},
          'costBilledViaLlmProxy': false,
          'createdAtMs': 100,
          'artifacts': [
            {
              'toolCallId': 'tool-1',
              'artifactIndex': 0,
              'kind': 'file',
              'label': 'large.bin',
              'storageKind': 'blob',
              'sizeBytes': '9007199254740993',
              'file': {'name': 'large.bin'},
            },
          ],
        },
        'replayed': false,
        'streamAfter': '9007199254740994',
        'capabilityBundleStateVersion': '9007199254740995',
      }, 201);
    });

    final result = await service.postMessage(
      'chat-1',
      text: 'Hello',
      clientRequestId: 'request-1',
      modelDefinitionId: 'model-1',
      resetThinkingLevel: true,
      fastMode: false,
    );
    expect(result.streamAfter, '9007199254740994');
    expect(result.capabilityBundleStateVersion, '9007199254740995');
    expect(result.message.artifacts.single.sizeBytes, '9007199254740993');
  });

  group('chat attachments', () {
    const ref = <String, Object?>{
      'attachmentId': 'att-1',
      'filename': 'photo one.png',
      'mediaType': 'image/png',
      'size': 3,
      'contentSha256': 'abc123',
      'storageKind': 'blob',
      'source': 'https://core.test/attachments/att-1',
    };

    test('uploads raw bytes with the name and type in the query', () async {
      final service = _service((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, '/api/cloud/chats/chat%201/attachments');
        expect(request.url.queryParameters, {
          'filename': 'photo one.png',
          'mediaType': 'image/png',
        });
        expect(request.headers['Content-Type'], 'application/octet-stream');
        expect(request.bodyBytes, [1, 2, 3]);
        return _json(ref, 201);
      });

      final uploaded = await service.uploadChatAttachment(
        'chat 1',
        filename: 'photo one.png',
        mediaType: 'image/png',
        bytes: Uint8List.fromList([1, 2, 3]),
      );

      expect(uploaded.toJson(), ref);
    });

    test('reports a refused upload with the server reason', () async {
      final service = _service(
        (_) async => _json({'error': 'attachment is too large'}, 413),
      );

      await expectLater(
        service.uploadChatAttachment(
          'chat-1',
          filename: 'big.png',
          mediaType: 'image/png',
          bytes: Uint8List(1),
        ),
        throwsA(
          isA<CloudApiException>()
              .having((e) => e.statusCode, 'statusCode', 413)
              .having((e) => e.message, 'message', 'attachment is too large'),
        ),
      );
    });

    test('rejects an upload answer without an id', () async {
      final service = _service((_) async => _json({'filename': 'x.png'}, 201));

      await expectLater(
        service.uploadChatAttachment(
          'chat-1',
          filename: 'x.png',
          mediaType: 'image/png',
          bytes: Uint8List(1),
        ),
        throwsA(isA<CloudApiException>()),
      );
    });

    test('deletes an unsent upload', () async {
      final service = _service((request) async {
        expect(request.method, 'DELETE');
        expect(request.url.path, '/api/cloud/chats/chat-1/attachments/att-1');
        return http.Response('', 204);
      });

      await service.deleteChatAttachment('chat-1', 'att-1');
    });

    test('sends refs as cloudAttachments on v1 and v2 turns', () async {
      final bodies = <Object?>[];
      final service = _service((request) async {
        bodies.add(jsonDecode(request.body));
        if (request.url.path.endsWith('/turns')) {
          return _json(v2Accepted('request-2', 'Look'), 201);
        }
        return _json({
          'message': {
            'id': 'message-1',
            'role': 'USER',
            'text': 'Look',
            'cost': {'kind': 'pending'},
            'costBilledViaLlmProxy': false,
            'createdAtMs': 100,
            'artifacts': const [],
            'attachments': [ref],
          },
          'replayed': false,
        }, 201);
      });
      final attachment = ChatAttachmentRef.fromJson(ref);

      await service.postMessage(
        'chat-1',
        text: 'Look',
        clientRequestId: 'request-1',
        cloudAttachments: [attachment],
      );
      await service.postConversationTurn(
        'chat-1',
        ConversationSendInput(
          clientRequestId: 'request-2',
          content: 'Look',
          cloudAttachments: [attachment],
        ),
      );

      expect(bodies, [
        {
          'text': 'Look',
          'clientRequestId': 'request-1',
          'cloudAttachments': [ref],
        },
        {
          'clientRequestId': 'request-2',
          'content': 'Look',
          'cloudAttachments': [ref],
        },
      ]);
    });

    test('omits cloudAttachments when a turn carries none', () {
      expect(
        const ConversationSendInput(
          clientRequestId: 'request-1',
          content: 'Hi',
        ).toJson().containsKey('cloudAttachments'),
        isFalse,
      );
    });
  });

  test('classifies malformed successful turn responses as retryable', () async {
    final validMessage = <String, Object?>{
      'id': 'message-1',
      'role': 'USER',
      'text': 'Hello',
      'cost': {'kind': 'pending'},
      'costBilledViaLlmProxy': false,
      'createdAtMs': 100,
      'artifacts': <Object?>[],
    };
    final responses = <Map<String, Object?>>[
      {'replayed': false},
      {
        'message': {...validMessage}..remove('id'),
        'replayed': false,
      },
      {'message': validMessage, 'replayed': 'false'},
    ];
    var call = 0;
    final service = _service((request) async => _json(responses[call++], 201));

    for (var index = 0; index < responses.length; index++) {
      await expectLater(
        service.postMessage(
          'chat-1',
          text: 'Hello',
          clientRequestId: 'request-$index',
        ),
        throwsA(
          isA<CloudSendError>()
              .having(
                (error) => error.kind,
                'kind',
                CloudSendErrorKind.retryable,
              )
              .having((error) => error.status, 'status', 0),
        ),
      );
    }
  });

  test('interrupts a turn and continues a terminal chat', () async {
    final requests = <http.Request>[];
    final service = _service((request) async {
      requests.add(request);
      if (request.url.path.endsWith('/interrupt')) {
        return _json({
          'outcome': 'superseded',
          'turnId': 'turn-1',
          'activeTurnId': 'turn-2',
        });
      }
      return _json({'chat': _chat});
    });

    final interrupt = await service.interruptTurn('chat-1', 'turn-1');
    expect(interrupt.outcome, AgentTurnInterruptOutcome.superseded);
    expect(interrupt.activeTurnId, 'turn-2');
    await service.continueChat(
      'chat-1',
      sourceAgentSessionId: 'session-1',
      fastMode: true,
    );
    expect(requests.last.url.path, '/api/cloud/chats/chat-1/fork');
    expect(jsonDecode(requests.last.body), {
      'mode': 'continue',
      'sourceAgentSessionId': 'session-1',
      'fastMode': true,
    });
  });

  test('loads the cloud model catalog', () async {
    final service = _service(
      (request) async => _json({
        'models': [
          {
            'id': 'model-1',
            'label': 'Model One',
            'provider': 'openai',
            'contextWindow': 1050000,
            'thinkingLevels': ['off', 'high'],
            'family': 'gpt',
            'familyLabel': 'GPT',
          },
        ],
        'modelHarnesses': {'model-1': 'codex'},
        'defaultModelId': 'model-1',
        'defaultModelBlocked': false,
      }),
    );

    final catalog = await service.getModels();
    expect(catalog.models.single.id, 'model-1');
    expect(catalog.modelHarnesses['model-1'], 'codex');
    expect(catalog.defaultModelId, 'model-1');
  });

  test('parses string and structured error envelopes plus headers', () async {
    var call = 0;
    final service = _service((request) async {
      call++;
      return call == 1
          ? _json({'error': 'plain failure'}, 400)
          : _json(
              {
                'error': {'code': 'body-code', 'message': 'structured failure'},
              },
              503,
              {'X-Canopy-Error-Code': 'header-code', 'Retry-After': '2'},
            );
    });

    await expectLater(
      service.getChat('one'),
      throwsA(
        isA<CloudApiException>()
            .having((e) => e.message, 'message', 'plain failure')
            .having((e) => e.code, 'code', isNull),
      ),
    );
    await expectLater(
      service.getChat('two'),
      throwsA(
        isA<CloudApiException>()
            .having((e) => e.message, 'message', 'structured failure')
            .having((e) => e.code, 'code', 'body-code')
            .having((e) => e.headerCode, 'headerCode', 'header-code')
            .having(
              (e) => e.retryAfter,
              'retryAfter',
              const Duration(seconds: 2),
            ),
      ),
    );
  });

  test('ignores non-finite Retry-After on API errors', () async {
    final service = _service(
      (request) async =>
          _json({'error': 'unavailable'}, 503, {'Retry-After': 'NaN'}),
    );

    await expectLater(
      service.getChat('chat-1'),
      throwsA(
        isA<CloudApiException>().having(
          (error) => error.retryAfter,
          'retryAfter',
          isNull,
        ),
      ),
    );
  });
}
