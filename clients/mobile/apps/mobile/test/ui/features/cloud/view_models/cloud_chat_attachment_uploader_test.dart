import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_uploader.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_attachment_uploader.dart';

import '../../../../support/fake_cloud_chat_repository.dart';

void main() {
  late FakeCloudChatRepository repository;
  late CloudChatAttachmentUploader uploader;

  setUp(() {
    repository = FakeCloudChatRepository();
    uploader = CloudChatAttachmentUploader(repository, 'chat-1');
  });

  test('uploads to its chat and returns the ready ref', () async {
    final ref = await uploader.upload(
      filename: 'notes.txt',
      mediaType: 'text/plain',
      bytes: Uint8List.fromList([1, 2]),
    );

    expect(ref.attachmentId, 'cloud-att-1');
    expect(repository.uploadCalls.single, (
      chatId: 'chat-1',
      filename: 'notes.txt',
      mediaType: 'text/plain',
      size: 2,
    ));
  });

  test('reports a refusal with the server reason', () async {
    repository.uploadHandler = (_, _) => throw const CloudApiException(
      statusCode: 415,
      message: 'attachment media type is not supported',
    );

    await expectLater(
      uploader.upload(
        filename: 'x.exe',
        mediaType: 'application/octet-stream',
        bytes: Uint8List(1),
      ),
      throwsA(
        isA<ChatAttachmentUploadException>().having(
          (e) => e.reason,
          'reason',
          'attachment media type is not supported',
        ),
      ),
    );
  });

  test('deletes from its chat', () async {
    await uploader.delete('att-1');

    expect(repository.deleteAttachmentCalls.single, (
      chatId: 'chat-1',
      attachmentId: 'att-1',
    ));
  });
}
