import 'package:mobile/ui/core/pipelines/pipeline_run_view.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_content_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/pipeline_run_chat_follow_up.dart';
import 'package:provider/provider.dart';

/// Pushes the run viewer for [run] above [context]'s route, re-providing
/// the view model because the pushed route sits outside the caller's subtree.
void pushRemotePipelineRunScreen(
  BuildContext context, {
  required String workspaceLocalId,
  required String worktreeLocalId,
  required RemotePipelineRun run,
}) {
  final viewModel = context.read<RemoteControlViewModel>();
  unawaited(
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChangeNotifierProvider<RemoteControlViewModel>.value(
          value: viewModel,
          child: RemotePipelineRunScreen(
            workspaceLocalId: workspaceLocalId,
            worktreeLocalId: worktreeLocalId,
            executionId: run.localId,
            pipelineName: run.pipelineName,
          ),
        ),
      ),
    ),
  );
}

/// Full-screen viewer for one pipeline execution, mirroring desktop's
/// `PipelineExecutionDetailModal` reflowed to a single column: header,
/// attention block, job → step tree, step log.
///
/// Run controls live in the app bar's options menu. Only the controls the
/// run can take are listed (CAN-2865: never a permanently disabled one):
/// Cancel while it is active, Resume when it is paused without waiting for
/// input, Retry once it has failed or been cancelled. Each is sent as a
/// portal command and reconciles through the run's next
/// `portal.pipeline.event`, exactly like the web portal's controls. Refresh
/// is always there.
///
/// The screen owns no data. It asks the view model for the run on open and
/// again when the app returns to the foreground (mobile pauses its event
/// subscription in the background), and otherwise re-renders as
/// `portal.pipeline.event` upserts land — including runs started on the
/// desktop.
class RemotePipelineRunScreen extends StatefulWidget {
  const RemotePipelineRunScreen({
    super.key,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.executionId,
    required this.pipelineName,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;
  final String executionId;

  /// Shown in the app bar before the run lands, so the screen never opens
  /// with an empty title.
  final String pipelineName;

  @override
  State<RemotePipelineRunScreen> createState() =>
      _RemotePipelineRunScreenState();
}

class _RemotePipelineRunScreenState extends State<RemotePipelineRunScreen>
    with WidgetsBindingObserver {
  String? _selectedJobId;
  String? _selectedStepId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _request());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Events do not accumulate while the subscription is paused, so a
    // returning user would otherwise read a run frozen at backgrounding.
    if (state == AppLifecycleState.resumed) _request();
  }

  void _request() {
    if (!mounted) return;
    unawaited(
      context.read<RemoteControlViewModel>().requestPipelineRunDetail(
        workspaceLocalId: widget.workspaceLocalId,
        worktreeLocalId: widget.worktreeLocalId,
        executionId: widget.executionId,
      ),
    );
  }

  void _submitAction(RemotePipelineRunAction action) {
    unawaited(
      context.read<RemoteControlViewModel>().submitPipelineRunAction(
        workspaceLocalId: widget.workspaceLocalId,
        worktreeLocalId: widget.worktreeLocalId,
        executionId: widget.executionId,
        action: action,
      ),
    );
  }

  /// Sends the follow-up, then opens the chat that received it above this
  /// route, so Back returns to the same run and step.
  Future<void> _startChatFollowUp(
    RemotePipelineRun run,
    RemotePipelineFollowUpOutput output,
  ) async {
    final viewModel = context.read<RemoteControlViewModel>();
    final target = await viewModel.startPipelineChatFollowUp(run, output);
    if (!mounted || target == null) return;
    final worktree = viewModel
        .worktreesFor(target.workspaceLocalId)
        .where((worktree) => worktree.localId == target.worktreeLocalId)
        .firstOrNull;
    if (worktree == null) return;
    final releaseVisibility = viewModel.beginRemoteRouteVisibility();
    unawaited(
      Navigator.of(context)
          .push(
            MaterialPageRoute<void>(
              builder: (_) =>
                  ChangeNotifierProvider<RemoteControlViewModel>.value(
                    value: viewModel,
                    child: RemoteChatScreen.worktree(
                      worktree: worktree,
                      initialChatId: target.chatId,
                    ),
                  ),
            ),
          )
          .whenComplete(releaseVisibility),
    );
  }

  void _requestLog(String jobId, String stepId) {
    unawaited(
      context.read<RemoteControlViewModel>().requestPipelineStepLog(
        workspaceLocalId: widget.workspaceLocalId,
        worktreeLocalId: widget.worktreeLocalId,
        executionId: widget.executionId,
        jobId: jobId,
        stepId: stepId,
      ),
    );
  }

  Future<RemotePipelineContentDocument> _readContent(
    RemotePipelineContentSource source,
  ) => context.read<RemoteControlViewModel>().readPipelineContent(
    workspaceLocalId: widget.workspaceLocalId,
    worktreeLocalId: widget.worktreeLocalId,
    executionId: widget.executionId,
    source: source,
  );

  /// Opens complete content above this route, so Back returns to the same
  /// run and selected step.
  void _openContent(
    String title,
    String emptyMessage,
    RemotePipelineContentSource source,
  ) => pushRemotePipelineContentScreen(
    context,
    title: title,
    emptyMessage: emptyMessage,
    workspaceLocalId: widget.workspaceLocalId,
    worktreeLocalId: widget.worktreeLocalId,
    executionId: widget.executionId,
    source: source,
  );

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<RemoteControlViewModel>();
    final run = viewModel.pipelineRunFor(
      worktreeLocalId: widget.worktreeLocalId,
      executionId: widget.executionId,
    );
    final pending = viewModel.isPipelineRunPending(widget.executionId);
    final error = viewModel.pipelineRunError(widget.executionId);
    final actionError = viewModel.pipelineRunActionError(widget.executionId);
    final theme = Theme.of(context);

    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: Text(
          run?.pipelineName ?? widget.pipelineName,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.titleMedium,
        ),
        trailing: PipelineRunOptionsMenu(
          run: run,
          pendingAction: viewModel.pendingPipelineRunAction(widget.executionId),
          onAction: _submitAction,
          onRefresh: _request,
        ),
      ),
      body: Builder(
        builder: (context) {
          final padding = CanopyScaffold.contentPaddingOf(context);
          if (run == null && error != null) {
            return PipelineRunNotice(
              padding: padding,
              message: error,
              onRetry: _request,
            );
          }
          if (run == null && pending) {
            return Padding(
              padding: padding,
              child: const Center(child: CircularProgressIndicator()),
            );
          }
          if (run == null) {
            // The request settled with neither a run nor an error — the
            // watchdog timeout fired on a desktop that stayed silent. There
            // is nothing else to show, so this reads the same as any other
            // failure to load.
            return PipelineRunNotice(
              padding: padding,
              message: 'Could not load this run.',
              onRetry: _request,
            );
          }
          return PipelineRunBody(
            key: const ValueKey('pipeline-run-detail'),
            padding: padding,
            run: run,
            pending: pending,
            error: error,
            selectedJobId: _selectedJobId,
            selectedStepId: _selectedStepId,
            // Tapping the open step again closes its log.
            onSelectStep: (jobId, stepId) => setState(() {
              final isOpen =
                  _selectedJobId == jobId && _selectedStepId == stepId;
              _selectedJobId = isOpen ? null : jobId;
              _selectedStepId = isOpen ? null : stepId;
            }),
            onLoadLog: _requestLog,
            stepOutput: viewModel.supportsPipelineContent
                ? (jobId, step) => (
                    load: () => _readContent(
                      RemotePipelineStepOutputSource(
                        jobId: jobId,
                        stepId: step.stepId,
                      ),
                    ),
                    open: () => _openContent(
                      step.name,
                      'This step has no output.',
                      RemotePipelineStepOutputSource(
                        jobId: jobId,
                        stepId: step.stepId,
                      ),
                    ),
                  )
                : null,
            onOpenReport: () => _openContent(
              'Full report',
              'This run has no saved report.',
              const RemotePipelineReportSource(),
            ),
            onRetry: _request,
            actionError: actionError,
            onDismissActionError: () =>
                viewModel.clearPipelineRunActionError(widget.executionId),
            chatFollowUp: PipelineRunChatFollowUp(
              key: const ValueKey('pipeline-run-follow-up'),
              run: run,
              supported: viewModel.supportsPipelineChatFollowUp,
              pending: viewModel.isPipelineChatFollowUpPending(run.localId),
              error: viewModel.pipelineChatFollowUpError(run.localId),
              onSubmit: (output) => unawaited(_startChatFollowUp(run, output)),
              onDismissError: () =>
                  viewModel.clearPipelineChatFollowUpError(run.localId),
            ),
          );
        },
      ),
    );
  }
}
