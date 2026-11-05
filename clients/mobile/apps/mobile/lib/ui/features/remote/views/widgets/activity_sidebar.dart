import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/activity/activity_sidebar.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import '../remote_file_diff_screen.dart';
import '../remote_pipeline_picker_screen.dart';
import '../remote_pipeline_run_screen.dart';

class RemoteActivitySidebar extends StatelessWidget {
  const RemoteActivitySidebar({
    super.key,
    required this.worktree,
    required this.activity,
    this.selectedChatId,
    this.onSetHookPaused,
    this.runPrAction,
    this.prProgress,
    this.cachedPrRepos,
    this.cachedPrBusy = false,
    this.changedFilesStatus = ChangedFilesLoadStatus.loaded,
    this.onRetryChangedFiles,
  });
  final RemoteWorktree worktree;
  final RemoteWorktreeActivity activity;
  final String? selectedChatId;
  final void Function(String, bool)? onSetHookPaused;
  final RemotePrActionRunner? runPrAction;
  final RemotePrProgressState? prProgress;
  final List<RemotePrRepo>? cachedPrRepos;
  final bool cachedPrBusy;
  final ChangedFilesLoadStatus changedFilesStatus;
  final VoidCallback? onRetryChangedFiles;
  @override
  Widget build(BuildContext context) {
    final pipelineRuns = context
        .select<RemoteControlViewModel?, List<RemotePipelineRun>?>(
          (model) => model?.pipelineRunsFor(worktree.localId),
        );
    final supportsPipelineDispatch = context
        .select<RemoteControlViewModel?, bool>(
          (model) => model?.supportsPipelineDispatch == true,
        );
    Widget bind(Widget child) =>
        ChangeNotifierProvider<RemoteControlViewModel>.value(
          value: context.read<RemoteControlViewModel>(),
          child: child,
        );
    return WorktreeActivitySidebar(
      worktree: WorktreeActivityContext(
        workspaceLocalId: worktree.workspaceLocalId,
        localId: worktree.localId,
        insertions: worktree.insertions,
        deletions: worktree.deletions,
        prStatuses: worktree.prStatuses,
        mergingPr: worktree.mergingPr,
        mergeProgressLabel: worktree.mergeProgressLabel,
      ),
      activity: activity,
      selectedChatId: selectedChatId,
      onSetHookPaused: onSetHookPaused,
      runPrAction: runPrAction,
      prProgress: prProgress,
      cachedPrRepos: cachedPrRepos,
      cachedPrBusy: cachedPrBusy,
      changedFilesStatus: changedFilesStatus,
      onRetryChangedFiles: onRetryChangedFiles,
      pipelineRuns: pipelineRuns,
      onOpenDiff: (file) => unawaited(
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => bind(
              RemoteFileDiffScreen(
                workspaceLocalId: worktree.workspaceLocalId,
                worktreeLocalId: worktree.localId,
                file: file,
              ),
            ),
          ),
        ),
      ),
      onOpenPipelinePicker: supportsPipelineDispatch
          ? () => unawaited(
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => bind(
                    RemotePipelinePickerScreen(
                      workspaceLocalId: worktree.workspaceLocalId,
                      worktreeLocalId: worktree.localId,
                    ),
                  ),
                ),
              ),
            )
          : null,
      onOpenPipelineRun: (run) => pushRemotePipelineRunScreen(
        context,
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
        run: run,
      ),
    );
  }
}
