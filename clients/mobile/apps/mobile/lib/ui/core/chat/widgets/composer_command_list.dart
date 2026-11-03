import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/chat/view_models/composer_command_menu.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';

/// Shows `/` and `$` suggestions above the composer [child] while its draft
/// has a trigger token. Owns the [ComposerMenuController] for [draft].
class ComposerCommandMenu extends StatefulWidget {
  const ComposerCommandMenu({
    super.key,
    required this.draft,
    required this.source,
    required this.actions,
    required this.enabled,
    required this.dollar,
    required this.child,
  });

  final TextEditingController draft;

  /// Null turns suggestions off.
  final ComposerCommandSource? source;
  final List<ComposerAction> actions;

  /// False for a disabled or read-only composer, which never opens the list.
  final bool enabled;

  /// Whether `$` is a trigger (Codex chats only).
  final bool dollar;
  final Widget child;

  @override
  State<ComposerCommandMenu> createState() => _ComposerCommandMenuState();
}

class _ComposerCommandMenuState extends State<ComposerCommandMenu>
    with WidgetsBindingObserver {
  late ComposerMenuController _menu = ComposerMenuController(widget.draft);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  // The list's height cap follows the keyboard, which the Scaffold body's
  // MediaQuery does not report.
  @override
  void didChangeMetrics() {
    if (_menu.isOpen) setState(() {});
  }

  @override
  void didUpdateWidget(ComposerCommandMenu oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.draft != widget.draft) {
      _menu.dispose();
      _menu = ComposerMenuController(widget.draft);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _menu.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _menu.configure(
      source: widget.source,
      actions: widget.actions,
      enabled: widget.enabled,
      dollar: widget.dollar,
    );
    return LayoutBuilder(
      builder: (context, constraints) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListenableBuilder(
            listenable: _menu,
            builder: (context, _) => _menu.isOpen
                ? ConstrainedBox(
                    // Keep a draft line and the actions usable in short windows.
                    // Suggestions return when unfolding or dismissing the keyboard.
                    constraints: BoxConstraints(
                      maxHeight: constraints.hasBoundedHeight
                          ? math.max(0, constraints.maxHeight - 112)
                          : double.infinity,
                    ),
                    child: ComposerCommandList(menu: _menu),
                  )
                : const SizedBox.shrink(),
          ),
          Flexible(
            child: Focus(
              canRequestFocus: false,
              skipTraversal: true,
              onFocusChange: _menu.setFocused,
              child: widget.child,
            ),
          ),
        ],
      ),
    );
  }
}

/// The grouped suggestion rows for an open [menu], in a bounded scrolling
/// card. Renders nothing when no row matches.
class ComposerCommandList extends StatelessWidget {
  const ComposerCommandList({super.key, required this.menu});

  final ComposerMenuController menu;

  @override
  Widget build(BuildContext context) {
    final sections = menu.sections;
    final status = menu.status;
    final enableError = menu.enableError;
    final trigger = menu.trigger?.character ?? '/';
    if (sections.isEmpty &&
        enableError == null &&
        status != ComposerCommandsStatus.loading &&
        status != ComposerCommandsStatus.failed) {
      return const SizedBox.shrink();
    }
    final colors = AppColors.of(context);
    // Space left above the keyboard; the list takes at most a third of it so
    // the draft and the send action stay visible below it. Read the view
    // itself: the Scaffold body's MediaQuery has the keyboard inset removed.
    final media = MediaQueryData.fromView(View.of(context));
    final visibleHeight =
        media.size.height - media.viewInsets.bottom - media.padding.top;
    final maxHeight = (visibleHeight * 0.35).clamp(96.0, 320.0);
    return Container(
      key: const ValueKey('composer-command-list'),
      margin: const EdgeInsets.fromLTRB(8, 8, 8, 0),
      constraints: BoxConstraints(maxHeight: maxHeight),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Material(
        type: MaterialType.transparency,
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.symmetric(vertical: 4),
          children: [
            if (enableError != null)
              _Notice(
                key: const ValueKey('composer-command-enable-error'),
                text: enableError,
                color: colors['fg-destructive'],
              ),
            for (final (sectionIndex, section) in sections.indexed) ...[
              _GroupHeader(label: section.group.label),
              for (final (index, _) in section.entries.indexed)
                _row(sections, sectionIndex, index, trigger, colors),
            ],
            if (status == ComposerCommandsStatus.loading)
              _Notice(
                key: const ValueKey('composer-command-loading'),
                text: 'Loading commands…',
                color: colors.foregroundMuted,
                trailing: const LoadingSpinner(),
              ),
            if (status == ComposerCommandsStatus.failed)
              _Notice(
                key: const ValueKey('composer-command-failed'),
                text: "Couldn't load commands",
                color: colors.foregroundSecondary,
                trailing: TextButton(
                  key: const ValueKey('composer-command-retry'),
                  style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                  onPressed: menu.retry,
                  child: const Text('Retry'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _row(
    List<ComposerMenuSection> sections,
    int sectionIndex,
    int index,
    String trigger,
    AppColors colors,
  ) {
    final group = sections[sectionIndex].group;
    final entry = sections[sectionIndex].entries[index];
    final enabling = menu.enabling;
    return switch (entry) {
      ComposerShowAllEntry(:final count) => _CommandRow(
        key: const ValueKey('composer-command-show-all'),
        title: 'Show all $count',
        detail: '',
        enabled: enabling == null,
        onTap: () => unawaited(menu.select(entry)),
      ),
      ComposerActionEntry(:final action) => _CommandRow(
        key: ValueKey('composer-command-${action.name}'),
        leading: CanopyIcon(
          glyph: _actionGlyph(action.name),
          size: 16,
          tint: colors.foregroundSecondary,
        ),
        title: '/${action.name}',
        detail: action.disabledReason ?? action.description,
        enabled: action.disabledReason == null && enabling == null,
        onTap: () => unawaited(menu.select(entry)),
      ),
      ComposerCommandEntry(:final command) => _CommandRow(
        key: ValueKey(
          _commandRowKey(group, sections, sectionIndex, index, command.name),
        ),
        // No Central-catalog glyph names a skill or host command, so these
        // rows carry no icon (DESIGN.md), as on desktop.
        title: _commandTitle(command, trigger),
        detail: command.unavailableReason ?? command.description,
        enabled: command.unavailableReason == null && enabling == null,
        busy: identical(enabling, command),
        onTap: () => unawaited(menu.select(entry)),
      ),
    };
  }
}

/// `composer-command-<group>-<encoded name>`, with `#2`, `#3`… for later rows that
/// share the name (distinct plugins' commands), counted across repeated runs
/// of the group. Encoding names reserves the ordinal delimiter, so a command
/// naturally named `deploy-2` cannot collide with a second `deploy` row.
String _commandRowKey(
  ComposerMenuGroup group,
  List<ComposerMenuSection> sections,
  int sectionIndex,
  int index,
  String name,
) {
  var ordinal = 1;
  final earlier = [
    for (final (position, section) in sections.indexed)
      if (section.group == group && position < sectionIndex) ...section.entries,
    ...sections[sectionIndex].entries.take(index),
  ];
  for (final entry in earlier) {
    if (entry case ComposerCommandEntry(
      :final command,
    ) when command.name == name) {
      ordinal++;
    }
  }
  final key = 'composer-command-${group.name}-${Uri.encodeComponent(name)}';
  return ordinal == 1 ? key : '$key#$ordinal';
}

String _commandTitle(ComposerCommand command, String trigger) {
  for (final value in [command.displayName, command.insertText]) {
    final text = value?.trim();
    if (text != null && text.isNotEmpty) return text;
  }
  return '$trigger${command.name}';
}

CanopyGlyph _actionGlyph(String name) => switch (name) {
  'attach' => CanopyGlyph.pageAttachment,
  'thinking' => CanopyGlyph.brain2,
  'plan' => CanopyGlyph.map,
  'fast' => CanopyGlyph.zap,
  _ => CanopyGlyph.agent,
};

class _GroupHeader extends StatelessWidget {
  const _GroupHeader({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Text(
        label,
        style: AppTypography.compactLabel.copyWith(
          color: AppColors.of(context).foregroundMuted,
        ),
      ),
    ),
  );
}

class _CommandRow extends StatelessWidget {
  const _CommandRow({
    super.key,
    this.leading,
    required this.title,
    required this.detail,
    required this.enabled,
    required this.onTap,
    this.busy = false,
  });

  final Widget? leading;
  final String title;
  final String detail;
  final bool enabled;
  final bool busy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final foreground = enabled ? colors.foreground : colors.disabledTint;
    return Semantics(
      button: true,
      enabled: enabled,
      label: detail.isEmpty ? title : '$title, $detail',
      excludeSemantics: true,
      child: InkWell(
        onTap: enabled ? onTap : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Row(
              spacing: 12,
              children: [
                if (leading case final leading?)
                  Opacity(opacity: enabled ? 1 : 0.5, child: leading),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.sectionLabel.copyWith(
                          color: foreground,
                        ),
                      ),
                      if (detail.isNotEmpty)
                        Text(
                          detail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppTypography.bodySmall.copyWith(
                            color: enabled
                                ? colors.foregroundMuted
                                : colors.disabledTint,
                          ),
                        ),
                    ],
                  ),
                ),
                if (busy) const LoadingSpinner(),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
    super.key,
    required this.text,
    required this.color,
    this.trailing,
  });

  final String text;
  final Color color;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 48),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(
          spacing: 12,
          children: [
            Expanded(
              child: Text(
                text,
                style: AppTypography.bodySmall.copyWith(color: color),
              ),
            ),
            ?trailing,
          ],
        ),
      ),
    ),
  );
}
