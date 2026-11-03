import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// One on/off row of the plugins sheet.
final class CanopyPluginToggle {
  const CanopyPluginToggle({
    required this.id,
    required this.label,
    required this.selected,
    this.detail = '',
    this.saving = false,
    this.enabled = true,
    this.unavailableReason,
    this.error,
  });

  /// Names the row's widget key, `composer-plugin-<id>`.
  final String id;
  final String label;
  final String detail;
  final bool selected;

  /// The row's write is in flight.
  final bool saving;
  final bool enabled;

  /// Why the chat cannot use this row, shown in place of [detail].
  final String? unavailableReason;

  /// Why the row's last change failed, naming the row. It takes the place
  /// of [label], and its tooltip and accessible name carry it in full.
  final String? error;
}

/// A titled group of rows, such as Plugins or MCP servers.
typedef CanopyPluginSection = ({String title, List<CanopyPluginToggle> rows});

/// The state the plugins sheet shows.
enum CanopyPluginsSheetState { loading, failed, ready }

/// The composer's plugins sheet: grouped on/off rows under a search field
/// that filters them by name, each row showing its own failed change. The
/// sheet holds only the search text; the owner supplies rows and handles
/// each toggle.
class CanopyComposerPluginsSheet extends StatefulWidget {
  const CanopyComposerPluginsSheet({
    super.key,
    required this.state,
    required this.sections,
    required this.onToggle,
    required this.onRetry,
  });

  final CanopyPluginsSheetState state;
  final List<CanopyPluginSection> sections;
  final ValueChanged<String> onToggle;
  final VoidCallback onRetry;

  static const _title = 'Plugins';

  @override
  State<CanopyComposerPluginsSheet> createState() =>
      _CanopyComposerPluginsSheetState();
}

class _CanopyComposerPluginsSheetState
    extends State<CanopyComposerPluginsSheet> {
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final query = _search.text.trim().toLowerCase();
    final hasRows = widget.sections.any((section) => section.rows.isNotEmpty);
    final rows = [
      for (final section in widget.sections)
        (
          title: section.title,
          rows: [
            for (final row in section.rows)
              if (row.label.toLowerCase().contains(query)) row,
          ],
        ),
    ].where((section) => section.rows.isNotEmpty).toList();
    Widget message(String text) => Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Text(
        text,
        style: AppTypography.body.copyWith(color: colors.foregroundSecondary),
      ),
    );
    // The sheet stops below the top of the screen, so the chat stays in view.
    // A modal sheet is not resized for the keyboard the way the chat's
    // Scaffold is, so the sheet lifts its own content above it.
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: Column(
          key: const ValueKey('composer-plugins-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text(
                CanopyComposerPluginsSheet._title,
                style: AppTypography.title.copyWith(color: colors.foreground),
              ),
            ),
            if (widget.state == CanopyPluginsSheetState.ready && hasRows)
              Padding(
                key: const ValueKey('composer-plugins-search'),
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: CanopySearchField(
                  controller: _search,
                  hintText: 'Search plugins',
                  onChanged: (_) => setState(() {}),
                ),
              ),
            switch (widget.state) {
              CanopyPluginsSheetState.loading => const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: CircularProgressIndicator()),
              ),
              CanopyPluginsSheetState.failed => Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  message("Couldn't load plugins."),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: FilledButton.tonal(
                      key: const ValueKey('composer-plugins-retry'),
                      onPressed: widget.onRetry,
                      child: const Text('Retry'),
                    ),
                  ),
                ],
              ),
              CanopyPluginsSheetState.ready when !hasRows => message(
                'No plugins are available for this chat.',
              ),
              CanopyPluginsSheetState.ready when rows.isEmpty => message(
                'No plugins match "${_search.text.trim()}".',
              ),
              CanopyPluginsSheetState.ready => Flexible(
                child: ListView(
                  key: const ValueKey('composer-plugins-list'),
                  shrinkWrap: true,
                  padding: const EdgeInsets.only(bottom: 16),
                  children: [
                    for (final (index, section) in rows.indexed) ...[
                      // A leading section named like the sheet would repeat
                      // its title.
                      if (index > 0 ||
                          section.title != CanopyComposerPluginsSheet._title)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                          child: Text(
                            section.title,
                            style: AppTypography.sectionLabel.copyWith(
                              color: colors.foregroundSecondary,
                            ),
                          ),
                        ),
                      for (final row in section.rows)
                        _toggleRow(context, row, colors),
                    ],
                  ],
                ),
              ),
            },
          ],
        ),
      ),
    );
  }

  Widget _toggleRow(
    BuildContext context,
    CanopyPluginToggle row,
    AppColors colors,
  ) {
    final detail = row.unavailableReason ?? row.detail;
    final error = row.error;
    return SwitchListTile(
      key: ValueKey('composer-plugin-${row.id}'),
      minTileHeight: 48,
      value: row.selected,
      onChanged: row.enabled && !row.saving
          ? (_) => widget.onToggle(row.id)
          : null,
      title: error == null
          ? Text(
              row.label,
              style: AppTypography.body.copyWith(color: colors.foreground),
            )
          : _errorLabel(context, row.id, error),
      subtitle: detail.isEmpty
          ? null
          : Text(
              detail,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.bodySmall.copyWith(
                color: colors.foregroundSecondary,
              ),
            ),
    );
  }

  /// A failed change in place of the row's label, on one line so the row
  /// keeps its height; the tooltip and screen readers get the full text.
  Widget _errorLabel(BuildContext context, String id, String error) => Tooltip(
    message: error,
    excludeFromSemantics: true,
    child: Semantics(
      label: error,
      liveRegion: true,
      child: ExcludeSemantics(
        child: Text(
          error,
          key: ValueKey('composer-plugin-error-$id'),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: AppTypography.body.copyWith(
            color: Theme.of(context).colorScheme.error,
          ),
        ),
      ),
    ),
  );
}
