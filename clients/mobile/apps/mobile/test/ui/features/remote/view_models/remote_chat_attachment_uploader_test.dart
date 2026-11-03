import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_uploader.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_attachment_uploader.dart';

import '../../../../support/fake_remote_control_repository.dart';

void main() {
  late FakeRemoteControlRepository repository;
  late RemoteChatAttachmentUploader uploader;

  setUp(() {
    repository = FakeRemoteControlRepository();
    uploader = RemoteChatAttachmentUploader(repository);
  });

  test('uploads through the session repository and returns its ref', () async {
    final ref = await uploader.upload(
      filename: 'notes.txt',
      mediaType: 'text/plain',
      bytes: Uint8List.fromList([1, 2, 3]),
    );

    expect(ref.attachmentId, 'fake-1');
    expect(repository.uploadCalls.single, (
      filename: 'notes.txt',
      mediaType: 'text/plain',
      size: 3,
    ));
  });

  test('reports a refusal with the server reason', () async {
    repository.uploadHandler = (_) =>
        throw const RemoteControlException('Attachment is too large');

    await expectLater(
      uploader.upload(
        filename: 'big.png',
        mediaType: 'image/png',
        bytes: Uint8List(1),
      ),
      throwsA(
        isA<ChatAttachmentUploadException>().having(
          (e) => e.reason,
          'reason',
          'Attachment is too large',
        ),
      ),
    );
  });

  test('deletes through the session repository', () async {
    await uploader.delete('att-1');

    expect(repository.deleteAttachmentCalls, ['att-1']);
  });
}
