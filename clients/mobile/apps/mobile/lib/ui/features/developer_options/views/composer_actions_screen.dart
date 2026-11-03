import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action_sheet.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_plugins_sheet.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';

/// Reference for the composer's `+` sheet and plugins sheet with synthetic
/// rows. The chat feature owns the real sheets' data; Developer Options does
/// not import it.
class ComposerActionsScreen extends StatefulWidget {
  const ComposerActionsScreen({super.key});

  @override
  State<ComposerActionsScreen> createState() => _ComposerActionsScreenState();
}

class _ComposerActionsScreenState extends State<ComposerActionsScreen> {
  bool _plan = false;

  void _openActions({required bool full}) => showCanopyComposerActionSheet(
    context,
    actions: [
      for (final (id, glyph, label) in const [
        ('attach-camera', CanopyGlyph.camera1, 'Take photo'),
        ('attach-library', CanopyGlyph.images1, 'Photo library'),
        ('attach-files', CanopyGlyph.pageAttachment, 'Files'),
      ])
        CanopyComposerSheetAction(
          id: id,
          glyph: glyph,
          label: label,
          enabled: !full,
          detail: full && id == 'attach-camera'
              ? 'Up to 8 attachments per message'
              : null,
          onSelected: () {},
        ),
      CanopyComposerSheetAction(
        id: 'plugins',
        glyph: CanopyGlyph.puzzle,
        label: 'Plugins',
        count: 2,
        onSelected: _openPlugins,
      ),
      CanopyComposerSheetAction(
        id: 'plan',
        glyph: CanopyGlyph.map,
        label: 'Plan mode',
        toggled: _plan,
        onSelected: () => setState(() => _plan = !_plan),
      ),
    ],
  );

  void _openPlugins() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const SafeArea(child: _PluginsPreview()),
  );

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      automaticallyImplyLeading: true,
      content: const Text('Composer actions'),
    ),
    body: Builder(
      builder: (context) => ListView(
        padding:
            CanopyScaffold.contentPaddingOf(context) + const EdgeInsets.all(16),
        children: [
          FilledButton.tonal(
            key: const ValueKey('preview-composer-actions'),
            onPressed: () => _openActions(full: false),
            child: const Text('Open the + sheet'),
          ),
          const SizedBox(height: 8),
          FilledButton.tonal(
            key: const ValueKey('preview-composer-actions-full'),
            onPressed: () => _openActions(full: true),
            child: const Text('Open the + sheet at 8 attachments'),
          ),
          const SizedBox(height: 8),
          FilledButton.tonal(
            key: const ValueKey('preview-composer-plugins'),
            onPressed: _openPlugins,
            child: const Text('Open the plugins sheet'),
          ),
          const SizedBox(height: 24),
          for (final state in [
            CanopyPluginsSheetState.loading,
            CanopyPluginsSheetState.failed,
          ])
            CanopyComposerPluginsSheet(
              state: state,
              sections: const [],
              onToggle: (_) {},
              onRetry: () {},
            ),
        ],
      ),
    ),
  );
}

/// An interactive plugins sheet: toggles flip locally, and the last row
/// always fails to show its error.
class _PluginsPreview extends StatefulWidget {
  const _PluginsPreview();

  @override
  State<_PluginsPreview> createState() => _PluginsPreviewState();
}

class _PluginsPreviewState extends State<_PluginsPreview> {
  final _selected = {'kit', 'github'};
  String? _failed;

  static const _rows = [
    ('Collections', 'kit', 'Release kit', 'Skills for shipping a release'),
    ('Plugins', 'github', 'GitHub', 'Pull requests, issues, and checks'),
    ('Skills', 'notes', 'Release notes', 'Draft notes from merged work'),
    ('MCP servers', 'linear', 'Linear', 'Fails, to show the error'),
  ];

  @override
  Widget build(BuildContext context) => CanopyComposerPluginsSheet(
    state: CanopyPluginsSheetState.ready,
    onRetry: () {},
    onToggle: (id) => setState(() {
      _failed = id == 'linear' ? id : null;
      if (_failed == null && !_selected.remove(id)) _selected.add(id);
    }),
    sections: [
      for (final (title, id, label, detail) in _rows)
        (
          title: title,
          rows: [
            CanopyPluginToggle(
              id: id,
              label: label,
              detail: detail,
              selected: _selected.contains(id),
              error: _failed == id
                  ? 'Could not change $label. Try again.'
                  : null,
            ),
          ],
        ),
    ],
  );
}
