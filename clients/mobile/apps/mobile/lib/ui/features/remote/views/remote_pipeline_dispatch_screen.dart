import 'dart:async';
import 'package:mobile/ui/core/pipelines/pipeline_dispatch_form.dart';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/remote_pipeline_dispatch.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

/// Fills one pipeline's dispatch inputs and starts it on the paired desktop
/// (CAN-3174). Replaces itself with the live run screen once the desktop
/// confirms the start, so Back returns to the chat.
class RemotePipelineDispatchScreen extends StatefulWidget {
  const RemotePipelineDispatchScreen({
    super.key,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.pipeline,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;
  final RemotePipelineDescriptor pipeline;

  @override
  State<RemotePipelineDispatchScreen> createState() =>
      _RemotePipelineDispatchScreenState();
}

class _RemotePipelineDispatchScreenState
    extends State<RemotePipelineDispatchScreen> {
  bool _navigated = false;

  String get _pipelineId => widget.pipeline.pipelineId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _open());
  }

  /// Entering the screen starts from a clean slate: a rejection from an
  /// earlier visit must not sit above Run. The dispatcher keeps an in-flight
  /// start, so re-entering mid-start still shows it.
  void _open() {
    if (!mounted) return;
    context.read<RemoteControlViewModel>().clearPipelineDispatch(
      worktreeLocalId: widget.worktreeLocalId,
      pipelineId: _pipelineId,
    );
    _load();
  }

  void _load() {
    if (!mounted) return;
    unawaited(
      context.read<RemoteControlViewModel>().loadPipelineForm(
        workspaceLocalId: widget.workspaceLocalId,
        worktreeLocalId: widget.worktreeLocalId,
        pipelineId: _pipelineId,
      ),
    );
  }

  void _openRun(RemoteControlViewModel viewModel, String executionId) {
    if (_navigated) return;
    _navigated = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      viewModel.clearPipelineDispatch(
        worktreeLocalId: widget.worktreeLocalId,
        pipelineId: _pipelineId,
      );
      final navigator = Navigator.of(context);
      // Chat → picker → form becomes chat → run: drop the form, then replace
      // the picker, so Back from the run returns to the chat.
      navigator.pop();
      unawaited(
        navigator.pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) =>
                ChangeNotifierProvider<RemoteControlViewModel>.value(
                  value: viewModel,
                  child: RemotePipelineRunScreen(
                    workspaceLocalId: widget.workspaceLocalId,
                    worktreeLocalId: widget.worktreeLocalId,
                    executionId: executionId,
                    pipelineName: widget.pipeline.name,
                  ),
                ),
          ),
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<RemoteControlViewModel>();
    final formState = viewModel.pipelineFormState(
      worktreeLocalId: widget.worktreeLocalId,
      pipelineId: _pipelineId,
    );
    final dispatch = viewModel.pipelineDispatchState(
      worktreeLocalId: widget.worktreeLocalId,
      pipelineId: _pipelineId,
    );
    if (dispatch case RemotePipelineDispatchStarted(:final executionId)) {
      _openRun(viewModel, executionId);
    }
    final submitting = dispatch is RemotePipelineDispatchSubmitting;
    final blocksBack = submitting && !dispatch.queuedWhileReconnecting;
    final status = viewModel.portalConnectionStatus;
    final degraded = RemoteDegradedBanner.isDegraded(status);
    final theme = Theme.of(context);
    return PopScope(
      canPop: !blocksBack,
      child: CanopyScaffold(
        appBar: CanopyAppBar(
          automaticallyImplyLeading: true,
          content: Text(
            widget.pipeline.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.titleMedium,
          ),
        ),
        body: Builder(
          builder: (context) {
            final basePadding = CanopyScaffold.contentPaddingOf(context);
            // The banner sits directly under the app bar, so the content
            // below it drops the top inset the bar would otherwise need.
            final padding = degraded
                ? basePadding.copyWith(top: 0)
                : basePadding;
            final content = switch (formState) {
              // Disconnecting clears every form; say so instead of spinning.
              null when !viewModel.isConnected => _LoadFailure(
                padding: padding,
                message: 'Not connected to a desktop.',
                onRetry: _load,
              ),
              null || RemotePipelineFormLoading() => Padding(
                padding: padding,
                child: const Center(child: CircularProgressIndicator()),
              ),
              RemotePipelineFormFailed(:final message) => _LoadFailure(
                padding: padding,
                message: message,
                onRetry: _load,
              ),
              RemotePipelineFormLoaded(:final form) => _buildForm(
                context,
                padding,
                form,
                submitting: submitting,
                degraded: degraded,
                dispatchError: dispatch is RemotePipelineDispatchFailed
                    ? dispatch.message
                    : null,
              ),
            };
            return Padding(
              padding: EdgeInsets.only(top: degraded ? basePadding.top : 0),
              child: Column(
                children: [
                  if (degraded)
                    RemoteDegradedBanner(
                      status: status,
                      deviceLabel: viewModel.connection?.deviceLabel,
                    ),
                  Expanded(child: content),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _buildForm(
    BuildContext context,
    EdgeInsets padding,
    RemotePipelineDispatchForm form, {
    required bool submitting,
    required bool degraded,
    required String? dispatchError,
  }) => PipelineDispatchForm(
    form: form,
    padding: padding,
    description: widget.pipeline.description,
    submitting: submitting,
    degraded: degraded,
    dispatchError: dispatchError,
    onRun: (inputs) {
      final model = context.read<RemoteControlViewModel>();
      model.clearPipelineDispatch(
        worktreeLocalId: widget.worktreeLocalId,
        pipelineId: _pipelineId,
      );
      unawaited(
        model.dispatchPipeline(
          workspaceLocalId: widget.workspaceLocalId,
          worktreeLocalId: widget.worktreeLocalId,
          pipelineId: _pipelineId,
          inputs: inputs,
        ),
      );
    },
  );
}

class _LoadFailure extends StatelessWidget {
  const _LoadFailure({
    required this.padding,
    required this.message,
    required this.onRetry,
  });

  final EdgeInsets padding;
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Padding(
    padding: padding.add(const EdgeInsets.symmetric(horizontal: 24)),
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          FilledButton.tonal(
            key: const ValueKey('pipeline-dispatch-retry'),
            onPressed: onRetry,
            child: const Text('Try again'),
          ),
        ],
      ),
    ),
  );
}
