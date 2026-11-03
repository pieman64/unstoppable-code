import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_plugins_sheet.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';

String _sectionTitle(ComposerPluginKind kind) => switch (kind) {
  ComposerPluginKind.collection => 'Collections',
  ComposerPluginKind.plugin => 'Plugins',
  ComposerPluginKind.skill => 'Skills',
  ComposerPluginKind.mcpServer => 'MCP servers',
};

/// Opens the plugins sheet for [source], as the `+` sheet's Plugins row and
/// `/plugins` do. The sheet's controller lives as long as the sheet.
Future<void> showComposerPluginsSheet(
  BuildContext context,
  ComposerPluginsSource source,
) => showModalBottomSheet<void>(
  context: context,
  showDragHandle: true,
  isScrollControlled: true,
  useSafeArea: true,
  // The route leaves the bottom inset to its content.
  builder: (_) => SafeArea(child: _ComposerPluginsSheet(source: source)),
);

class _ComposerPluginsSheet extends StatefulWidget {
  const _ComposerPluginsSheet({required this.source});

  final ComposerPluginsSource source;

  @override
  State<_ComposerPluginsSheet> createState() => _ComposerPluginsSheetState();
}

class _ComposerPluginsSheetState extends State<_ComposerPluginsSheet> {
  late final _controller = ComposerPluginsController(widget.source);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _controller,
    builder: (context, _) {
      final controller = _controller;
      final items = {
        for (final item in controller.catalog.items) item.key: item,
      };
      return CanopyComposerPluginsSheet(
        state: switch (controller.status) {
          ComposerPluginsStatus.loading => CanopyPluginsSheetState.loading,
          ComposerPluginsStatus.failed => CanopyPluginsSheetState.failed,
          ComposerPluginsStatus.ready => CanopyPluginsSheetState.ready,
        },
        onRetry: controller.load,
        onToggle: (id) {
          if (items[id] case final item?) unawaited(controller.toggle(item));
        },
        sections: [
          for (final kind in ComposerPluginKind.values)
            (
              title: _sectionTitle(kind),
              rows: [
                for (final item in controller.catalog.itemsOf(kind))
                  CanopyPluginToggle(
                    id: item.key,
                    label: item.name,
                    detail: item.description,
                    selected: controller.isSelected(item),
                    saving: controller.saving != null,
                    enabled: controller.canToggle(item),
                    unavailableReason: controller.isSupported(item)
                        ? null
                        : composerPluginUnsupportedReason,
                    error: controller.errorFor(item),
                  ),
              ],
            ),
        ],
      );
    },
  );
}
