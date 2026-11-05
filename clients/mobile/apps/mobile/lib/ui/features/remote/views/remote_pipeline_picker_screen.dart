import 'package:mobile/ui/core/pipelines/pipeline_picker_body.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/remote_pipeline_dispatch.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_dispatch_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

/// Lists the pipelines the paired desktop can start in one worktree
/// (CAN-3174), the phone counterpart of desktop's Dispatch Pipeline picker.
/// Rows come from the worktree state's `pipelines` slice, re-read on open.
class RemotePipelinePickerScreen extends StatefulWidget {
  const RemotePipelinePickerScreen({
    super.key,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;

  @override
  State<RemotePipelinePickerScreen> createState() =>
      _RemotePipelinePickerScreenState();
}

/// The list length at which a search field earns its space.

class _RemotePipelinePickerScreenState
    extends State<RemotePipelinePickerScreen> {
  bool _refreshing = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_refresh()));
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    setState(() => _refreshing = true);
    await context.read<RemoteControlViewModel>().refreshWorktreeActivity(
      workspaceLocalId: widget.workspaceLocalId,
      worktreeLocalId: widget.worktreeLocalId,
    );
    if (mounted) setState(() => _refreshing = false);
  }

  void _open(RemotePipelineDescriptor pipeline) {
    final viewModel = context.read<RemoteControlViewModel>();
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
            child: RemotePipelineDispatchScreen(
              workspaceLocalId: widget.workspaceLocalId,
              worktreeLocalId: widget.worktreeLocalId,
              pipeline: pipeline,
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<RemoteControlViewModel>();
    final all = viewModel
        .worktreeActivityFor(widget.worktreeLocalId)
        .dispatchablePipelines;
    final pipelines = all;
    final theme = Theme.of(context);
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: Text('Run pipeline', style: theme.textTheme.titleMedium),
      ),
      body: Builder(
        builder: (context) {
          final padding = CanopyScaffold.contentPaddingOf(context);
          final status = viewModel.portalConnectionStatus;
          if (!RemoteDegradedBanner.isDegraded(status)) {
            return _buildContent(padding, all, pipelines);
          }
          // The banner sits directly under the app bar, so the list below it
          // drops the top inset the bar would otherwise need.
          return Padding(
            padding: EdgeInsets.only(top: padding.top),
            child: Column(
              children: [
                RemoteDegradedBanner(
                  status: status,
                  deviceLabel: viewModel.connection?.deviceLabel,
                ),
                Expanded(
                  child: _buildContent(
                    padding.copyWith(top: 0),
                    all,
                    pipelines,
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildContent(
    EdgeInsets padding,
    List<RemotePipelineDescriptor> all,
    List<RemotePipelineDescriptor> pipelines,
  ) => PipelinePickerBody(
    padding: padding,
    pipelines: all,
    refreshing: _refreshing,
    onRefresh: _refresh,
    onOpen: _open,
  );
}
