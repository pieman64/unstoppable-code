import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
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
const int _searchThreshold = 8;

class _RemotePipelinePickerScreenState
    extends State<RemotePipelinePickerScreen> {
  bool _refreshing = true;
  final TextEditingController _search = TextEditingController();
  String _query = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_refresh()));
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
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

  bool _matches(RemotePipelineDescriptor pipeline) {
    final query = _query.trim().toLowerCase();
    if (query.isEmpty) return true;
    return pipeline.name.toLowerCase().contains(query) ||
        (pipeline.description?.toLowerCase().contains(query) ?? false);
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
    final pipelines = all.where(_matches).toList(growable: false);
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
  ) {
    final theme = Theme.of(context);
    if (all.isEmpty && _refreshing) {
      return Padding(
        padding: padding,
        child: const Center(child: CircularProgressIndicator()),
      );
    }
    if (all.isEmpty) {
      return Padding(
        padding: padding.add(const EdgeInsets.symmetric(horizontal: 24)),
        child: Center(
          child: Text(
            'No pipelines can be run in this worktree.',
            key: const ValueKey('pipeline-picker-empty'),
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium,
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      edgeOffset: padding.top,
      child: ListView(
        padding: padding.add(const EdgeInsets.symmetric(vertical: 8)),
        children: [
          if (all.length >= _searchThreshold)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: CanopySearchField(
                key: const ValueKey('pipeline-picker-search'),
                controller: _search,
                hintText: 'Search pipelines',
                onChanged: (value) => setState(() => _query = value),
              ),
            ),
          for (final pipeline in pipelines)
            ListTile(
              key: ValueKey('pipeline-picker-row:${pipeline.pipelineId}'),
              title: Text(pipeline.name),
              subtitle: switch (pipeline.description) {
                final description? => Text(
                  description,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                null => null,
              },
              trailing: _OriginBadge(origin: pipeline.origin),
              onTap: () => _open(pipeline),
            ),
        ],
      ),
    );
  }
}

class _OriginBadge extends StatelessWidget {
  const _OriginBadge({required this.origin});

  final RemotePipelineOrigin origin;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final label = switch (origin) {
      RemotePipelineOrigin.bundled => 'Bundled',
      RemotePipelineOrigin.user => 'Custom',
      RemotePipelineOrigin.project => 'Project',
      RemotePipelineOrigin.shared => 'Shared',
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Text(
        label,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}
