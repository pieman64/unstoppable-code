import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_pipeline_content_commands.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_content_reader.dart';

import '../../../../support/fake_remote_control_repository.dart';

const _document = RemotePipelineContentDocument(
  format: RemotePipelineContentFormat.text,
  text: 'beginning-middle-end',
);

void main() {
  late FakeRemoteControlRepository repository;
  late OwnedCommandRegistry commands;
  late PipelineContentReader reader;

  setUp(() {
    repository = FakeRemoteControlRepository()..supportsPipelineContent = true;
    commands = OwnedCommandRegistry(notify: () {});
    reader = PipelineContentReader(repository: repository, commands: commands);
  });

  Future<RemotePipelineContentDocument> read() => reader.read(
    workspaceLocalId: 'ws-1',
    worktreeLocalId: 'wt-1',
    executionId: 'exec-1',
    source: const RemotePipelineReportSource(),
  );

  test(
    'joins every page, sending the first revision with later pages',
    () async {
      repository
        ..contentPageSize = 7
        ..contentDocuments['report'] = _document;

      final document = await read();

      expect(document.text, 'beginning-middle-end');
      expect(document.format, RemotePipelineContentFormat.text);
      expect(repository.contentReadCalls.map((call) => call.offset), [
        0,
        7,
        14,
      ]);
      expect(repository.contentReadCalls.map((call) => call.revision), [
        null,
        'r1',
        'r1',
      ]);
    },
  );

  test('an older desktop is never asked', () async {
    repository.supportsPipelineContent = false;
    await expectLater(
      read(),
      throwsA(
        isA<RemoteControlException>().having(
          (e) => e.message,
          'message',
          kRemotePipelineContentUnsupported,
        ),
      ),
    );
    expect(repository.contentReadCalls, isEmpty);
  });

  test(
    'a page the relay stopped waiting for arrives as a command event',
    () async {
      repository.contentReadHandler = (offset) async =>
          const RemotePortalCommandResult(commandId: 'cmd-late');
      final document = read();
      await pumpEventQueue();
      commands.handleCompleted(
        'cmd-late',
        pipelineContentPageJson(_document),
        projectionSequence: 1,
      );
      expect((await document).text, 'beginning-middle-end');
    },
  );

  test('a failed command surfaces the desktop reason', () async {
    repository.contentReadHandler = (offset) async =>
        const RemotePortalCommandResult(commandId: 'cmd-late');
    final document = read();
    await pumpEventQueue();
    commands.handleFailed(
      'cmd-late',
      "This run's report is no longer available.",
      projectionSequence: 1,
    );
    await expectLater(
      document,
      throwsA(
        isA<RemoteControlException>().having(
          (e) => e.message,
          'message',
          "This run's report is no longer available.",
        ),
      ),
    );
  });

  test('a document that changes between pages is read again once', () async {
    var reads = 0;
    repository.contentReadHandler = (offset) async {
      reads++;
      // The second page of the first pass reports a newer revision.
      final revision = reads == 2 ? 'r2' : 'r1';
      return RemotePortalCommandResult(
        commandId: 'content-$reads',
        result: pipelineContentPageJson(
          _document,
          offset: offset,
          pageSize: 10,
          revision: revision,
        ),
      );
    };

    expect((await read()).text, 'beginning-middle-end');
    expect(reads, 4);
  });

  test('a desktop that never answers times out', () {
    fakeAsync((async) {
      repository.contentReadHandler = (offset) async =>
          const RemotePortalCommandResult(commandId: 'cmd-silent');
      Object? error;
      read().catchError((Object e) {
        error = e;
        return _document;
      });
      async.elapse(kRemotePipelineContentPageTimeout);
      expect(error, isA<RemoteControlException>());
    });
  });
}
