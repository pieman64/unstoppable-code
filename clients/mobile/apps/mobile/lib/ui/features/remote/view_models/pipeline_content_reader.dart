import 'dart:async';

import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_pipeline_content_commands.dart';

import 'owned_command_registry.dart';

/// Deadline for one page: the request and any wait for its command event.
const Duration kRemotePipelineContentPageTimeout = Duration(seconds: 30);

const String _unanswered = "Your desktop didn't answer. Try again.";

/// Reads a complete pipeline document (CAN-3717): a step's readable output
/// or the run's saved report, joined from bounded pages read one after
/// another. Nothing is read until a person opens the content, and nothing is
/// cached here; the streamed run keeps its bounded step tails.
final class PipelineContentReader {
  PipelineContentReader({
    required this.repository,
    required this.commands,
    this.pageTimeout = kRemotePipelineContentPageTimeout,
  });

  final RemoteControlRepository repository;
  final OwnedCommandRegistry commands;
  final Duration pageTimeout;

  /// The whole document. When it changes between pages, for example while
  /// the step still runs, the read starts over once before failing. Throws
  /// [RemoteControlException] with a readable message.
  Future<RemotePipelineContentDocument> read({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineContentSource source,
  }) async {
    if (!repository.pipelineContent.isSupported) {
      throw const RemoteControlException(kRemotePipelineContentUnsupported);
    }
    Future<RemotePipelineContentPage> page(int offset, String? revision) =>
        _page(
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
          executionId: executionId,
          source: source,
          offset: offset,
          revision: revision,
        );
    for (var attempt = 0; ; attempt++) {
      final first = await page(0, null);
      final text = StringBuffer(first.content);
      var next = first;
      try {
        while (next.nextOffset < next.length) {
          next = await page(next.nextOffset, first.revision);
          if (next.revision != first.revision) {
            throw const RemoteControlException(_unanswered);
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

  Future<RemotePipelineContentPage> _page({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineContentSource source,
    required int offset,
    required String? revision,
  }) async {
    String? commandId;
    try {
      return await () async {
        final response = await repository.pipelineContent.readPage(
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
          executionId: executionId,
          source: source,
          offset: offset,
          revision: revision,
        );
        var result = response.result;
        if (result == null) {
          // The relay stopped waiting; the page arrives as the command's
          // terminal event, possibly before this registration.
          if (response.commandId.isEmpty) {
            throw const RemoteControlException(_unanswered);
          }
          commandId = response.commandId;
          final answer = Completer<Map<String, dynamic>?>();
          commands.register(
            response.commandId,
            recordOutcome: false,
            onCompleted: (value) {
              if (!answer.isCompleted) answer.complete(value);
            },
            onFailed: (message) {
              if (!answer.isCompleted) {
                answer.completeError(RemoteControlException(message));
              }
            },
          );
          result = await answer.future;
        }
        final page = result == null
            ? null
            : RemotePipelineContentPage.fromJson(result);
        if (page == null || page.offset != offset) {
          throw const RemoteControlException(_unanswered);
        }
        return page;
      }().timeout(pageTimeout);
    } on TimeoutException {
      if (commandId case final id?) commands.release(id);
      throw const RemoteControlException(_unanswered);
    }
  }
}
