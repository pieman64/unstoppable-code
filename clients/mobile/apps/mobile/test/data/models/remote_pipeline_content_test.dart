import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_content_chunks.dart';

void main() {
  group('RemotePipelineContentPage.fromJson', () {
    Map<String, dynamic> page({
      Object? format = 'markdown',
      String content = 'abc',
      int offset = 0,
      int? nextOffset,
      int length = 3,
    }) => {
      'format': format,
      'content': content,
      'offset': offset,
      'nextOffset': nextOffset ?? offset + content.length,
      'length': length,
      'revision': 'r1',
    };

    test('reads a page', () {
      final parsed = RemotePipelineContentPage.fromJson(page());
      expect(parsed?.format, RemotePipelineContentFormat.markdown);
      expect(parsed?.content, 'abc');
      expect(parsed?.revision, 'r1');
    });

    test('rejects an unknown format and inconsistent offsets', () {
      expect(RemotePipelineContentPage.fromJson(page(format: 'json')), isNull);
      expect(RemotePipelineContentPage.fromJson(page(nextOffset: 5)), isNull);
      expect(RemotePipelineContentPage.fromJson(page(length: 2)), isNull);
      expect(RemotePipelineContentPage.fromJson({'format': 'text'}), isNull);
    });
  });

  group('pipelineContentChunks', () {
    test('keeps Markdown whole', () {
      final chunks = pipelineContentChunks(
        const RemotePipelineContentDocument(
          format: RemotePipelineContentFormat.markdown,
          text: '# A\n\n- b',
        ),
      );
      expect(chunks, [(markdown: true, text: '# A\n\n- b')]);
    });

    test('splits command output on line boundaries without losing lines', () {
      final lines = [for (var i = 0; i < 450; i++) 'line $i'];
      final chunks = pipelineContentChunks(
        RemotePipelineContentDocument(
          format: RemotePipelineContentFormat.text,
          text: '${lines.join('\n')}\n',
        ),
      );
      expect(chunks.length, 3);
      expect(chunks.every((chunk) => !chunk.markdown), isTrue);
      expect(chunks.map((chunk) => chunk.text).join('\n'), lines.join('\n'));
    });
  });
}
