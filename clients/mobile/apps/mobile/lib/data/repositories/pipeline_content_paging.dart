import '../models/computer_activity/pipeline_content.dart';
import '../models/computer_activity/action_exception.dart';

/// Joins revision-checked pages. A changing document is retried once as a whole.
Future<RemotePipelineContentDocument> readPipelineContentPages(
  Future<RemotePipelineContentPage> Function(int offset, String? revision) page,
) async {
  for (var attempt = 0; ; attempt++) {
    final first = await page(0, null);
    final text = StringBuffer(first.content);
    var next = first;
    try {
      while (next.nextOffset < next.length) {
        next = await page(next.nextOffset, first.revision);
        if (next.revision != first.revision) {
          throw const RemoteControlException(
            'Your desktop didn\'t answer. Try again.',
          );
        }
        text.write(next.content);
      }
    } on RemoteControlException {
      if (attempt == 0) continue;
      rethrow;
    }
    return RemotePipelineContentDocument(
      format: first.format,
      text: text.toString(),
    );
  }
}
