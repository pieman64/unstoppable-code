import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/pipeline_content_view.dart';
import 'package:provider/provider.dart';

/// Pushes the complete [source] of one run above [context]'s route, so Back
/// returns to the run with its selected step.
void pushRemotePipelineContentScreen(
  BuildContext context, {
  required String title,
  required String emptyMessage,
  required String workspaceLocalId,
  required String worktreeLocalId,
  required String executionId,
  required RemotePipelineContentSource source,
}) {
  final viewModel = context.read<RemoteControlViewModel>();
  unawaited(
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChangeNotifierProvider<RemoteControlViewModel>.value(
          value: viewModel,
          child: RemotePipelineContentScreen(
            title: title,
            emptyMessage: emptyMessage,
            workspaceLocalId: workspaceLocalId,
            worktreeLocalId: worktreeLocalId,
            executionId: executionId,
            source: source,
          ),
        ),
      ),
    ),
  );
}

/// One run's complete report or step output (CAN-3717), read from the
/// desktop when opened: the same content and order as the desktop shows.
class RemotePipelineContentScreen extends StatelessWidget {
  const RemotePipelineContentScreen({
    super.key,
    required this.title,
    required this.emptyMessage,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.executionId,
    required this.source,
  });

  final String title;
  final String emptyMessage;
  final String workspaceLocalId;
  final String worktreeLocalId;
  final String executionId;
  final RemotePipelineContentSource source;

  @override
  Widget build(BuildContext context) {
    final viewModel = context.read<RemoteControlViewModel>();
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: Text(
          title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context).textTheme.titleMedium,
        ),
      ),
      body: Builder(
        builder: (context) {
          return Padding(
            padding: CanopyScaffold.contentPaddingOf(context),
            child: Center(
              child: PipelineContentLoader(
                supported: viewModel.supportsPipelineContent,
                load: () => viewModel.readPipelineContent(
                  workspaceLocalId: workspaceLocalId,
                  worktreeLocalId: worktreeLocalId,
                  executionId: executionId,
                  source: source,
                ),
                emptyMessage: emptyMessage,
                builder: (context, chunks) => ListView.builder(
                  key: const ValueKey('pipeline-content'),
                  padding: const EdgeInsets.all(16),
                  itemCount: chunks.length,
                  itemBuilder: (context, index) =>
                      PipelineContentChunkView(chunk: chunks[index]),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
