import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
import 'package:mobile/data/models/computer_activity/pipeline_dispatch.dart';

const int _searchThreshold = 8;

class PipelinePickerBody extends StatefulWidget {
  const PipelinePickerBody({
    super.key,
    required this.padding,
    required this.pipelines,
    required this.refreshing,
    required this.onRefresh,
    required this.onOpen,
  });
  final EdgeInsets padding;
  final List<RemotePipelineDescriptor> pipelines;
  final bool refreshing;
  final Future<void> Function() onRefresh;
  final ValueChanged<RemotePipelineDescriptor> onOpen;
  @override
  State<PipelinePickerBody> createState() => _PipelinePickerBodyState();
}

class _PipelinePickerBodyState extends State<PipelinePickerBody> {
  final _search = TextEditingController();
  String _query = '';
  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  bool _matches(RemotePipelineDescriptor pipeline) {
    final query = _query.trim().toLowerCase();
    return query.isEmpty ||
        pipeline.name.toLowerCase().contains(query) ||
        (pipeline.description?.toLowerCase().contains(query) ?? false);
  }

  @override
  Widget build(BuildContext context) => _buildContent(
    widget.padding,
    widget.pipelines,
    widget.pipelines.where(_matches).toList(),
  );
  Widget _buildContent(
    EdgeInsets padding,
    List<RemotePipelineDescriptor> all,
    List<RemotePipelineDescriptor> pipelines,
  ) {
    final theme = Theme.of(context);
    if (all.isEmpty && widget.refreshing) {
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
      onRefresh: widget.onRefresh,
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
              key: ValueKey(
                'pipeline-picker-row:${pipeline.origin.name}:${pipeline.pipelineId}',
              ),
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
              onTap: () => widget.onOpen(pipeline),
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
      RemotePipelineOrigin.curated => 'Curated',
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
