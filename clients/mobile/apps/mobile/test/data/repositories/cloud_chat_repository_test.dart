import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/cloud_api_service.dart';

HttpCloudChatRepository _repository(
  Future<http.Response> Function(http.Request request) handler,
) => HttpCloudChatRepository(
  service: CloudApiService(
    apiClient: ApiClient(
      baseUrl: 'https://example.test',
      httpClient: MockClient(handler),
    ),
  ),
);

void main() {
  test('supportsCloudChats changes from unknown to true after a 200', () async {
    final repository = _repository(
      (_) async => http.Response(jsonEncode({'workspaces': const []}), 200),
    );
    expect(repository.supportsCloudChats, isNull);
    expect(await repository.listWorkspaces(), isEmpty);
    expect(repository.supportsCloudChats, isTrue);
  });

  test('a gate 404 disables cloud chats without surfacing an error', () async {
    final repository = _repository(
      (_) async => http.Response(jsonEncode({'error': 'not found'}), 404),
    );
    expect(await repository.listWorkspaces(), isEmpty);
    expect(repository.supportsCloudChats, isFalse);
  });

  test('other failures preserve unknown support and are rethrown', () async {
    final repository = _repository(
      (_) async => http.Response(jsonEncode({'error': 'down'}), 503),
    );
    await expectLater(
      repository.listWorkspaces(),
      throwsA(isA<CloudApiException>()),
    );
    expect(repository.supportsCloudChats, isNull);
  });

  test('uploads and deletes chat attachments through the service', () async {
    final requests = <String>[];
    final repository = _repository((request) async {
      requests.add('${request.method} ${request.url.path}');
      if (request.method == 'DELETE') return http.Response('', 204);
      return http.Response(
        jsonEncode({
          'attachmentId': 'att-1',
          'filename': 'notes.txt',
          'mediaType': 'text/plain',
          'size': 2,
          'contentSha256': 'abc',
          'storageKind': 'blob',
          'source': '/s',
        }),
        201,
      );
    });

    final ref = await repository.uploadChatAttachment(
      'chat-1',
      filename: 'notes.txt',
      mediaType: 'text/plain',
      bytes: Uint8List.fromList([1, 2]),
    );
    await repository.deleteChatAttachment('chat-1', ref.attachmentId);

    expect(ref.attachmentId, 'att-1');
    expect(requests, [
      'POST /api/cloud/chats/chat-1/attachments',
      'DELETE /api/cloud/chats/chat-1/attachments/att-1',
    ]);
  });

  test('mock repository echoes sent attachments on the user row', () async {
    final repository = MockCloudChatRepository(latency: Duration.zero);
    final ref = await repository.uploadChatAttachment(
      'cloud-chat-1',
      filename: 'p.png',
      mediaType: 'image/png',
      bytes: Uint8List.fromList([1, 2, 3]),
    );

    final result = await repository.postMessage(
      'cloud-chat-1',
      text: 'Look',
      clientRequestId: 'request-1',
      cloudAttachments: [ref],
    );

    expect(result.message.attachments.single['attachmentId'], ref.attachmentId);
  });

  test('mock repository is supported and reflects chat mutations', () async {
    final repository = MockCloudChatRepository(latency: Duration.zero);
    expect(repository.supportsCloudChats, isTrue);
    final workspace = (await repository.listWorkspaces()).single;
    final created = await repository.createChat(
      workspace.externalId,
      externalId: 'new-chat',
      title: 'New chat',
      prompt: 'Hello',
    );
    expect(created.externalId, 'new-chat');
    expect(
      (await repository.listChats(workspace.externalId)).last.title,
      'New chat',
    );
    await repository.renameChat('new-chat', 'Renamed');
    expect((await repository.getChat('new-chat')).title, 'Renamed');
    await repository.archiveChat('new-chat');
    expect(
      await repository.listChats(workspace.externalId),
      isNot(contains(created)),
    );
    final deleted = await repository.createChat(
      workspace.externalId,
      externalId: 'deleted-chat',
      title: 'Deleted chat',
      prompt: 'Hello',
    );
    await repository.deleteChat('deleted-chat');
    expect(
      await repository.listChats(workspace.externalId),
      isNot(contains(deleted)),
    );
  });

  test(
    'mock first-workspace provision adopts the existing workspace',
    () async {
      final repository = MockCloudChatRepository(latency: Duration.zero);
      final existing = (await repository.listWorkspaces()).single;

      final provisioned = await repository.provisionFirstWorkspace(
        'My project',
      );

      expect(provisioned?.externalId, existing.externalId);
      expect(await repository.listWorkspaces(), hasLength(1));
    },
  );
}
