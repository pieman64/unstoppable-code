import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_mini_button.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_selection.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/effort_speed.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/core/typography.dart';

export 'package:mobile/data/models/effort_speed.dart';

/// The desktop name of an effort level (`THINKING_LEVEL_LABELS`, with Low).
String canopyEffortLabel(String level) => switch (level) {
  'off' => 'None',
  'low' => 'Low',
  'medium' => 'Medium',
  'high' => 'High',
  'xhigh' => 'Extra High',
  'max' => 'Max',
  'ultra' => 'Ultra',
  _ => level.isEmpty ? level : '${level[0].toUpperCase()}${level.substring(1)}',
};

/// The desktop effort ramp (`getThinkingIconColorClass`) in semantic roles:
/// medium positive, high accent, extra high attention, max destructive and
/// ultra special. None and Low stay secondary.
Color canopyEffortTint(AppColors colors, String level) => switch (level) {
  'medium' => colors['fg-positive'],
  'high' => colors['fg-accent'],
  'xhigh' => colors['fg-attention'],
  'max' => colors['fg-destructive'],
  'ultra' => colors['fg-special'],
  _ => colors.foregroundSecondary,
};

/// The trigger's accessible name: the level, then the speed when it is on.
String canopyEffortSemanticLabel(String level, CanopyEffortSpeed speed) {
  final name = canopyEffortLabel(level);
  return switch (speed) {
    CanopyEffortSpeed.regular => 'Effort, current level $name',
    CanopyEffortSpeed.fast => 'Effort, current level $name, fast mode on',
    CanopyEffortSpeed.ultraFast =>
      'Effort, current level $name, ultra fast mode on',
  };
}

/// Composer trigger that names the effort level. A bolt leads the name while
/// Fast mode is on, purple for Ultra fast. The name truncates only when its
/// row gives it less room than it needs. The chip keeps the composer row's
/// 32px height; its touch target is at least 48px square and extends above
/// the chip, so rows that hold it align their controls to the bottom.
class CanopyEffortTrigger extends StatelessWidget {
  const CanopyEffortTrigger({
    super.key,
    required this.level,
    required this.speed,
    required this.onTap,
  });

  final String level;
  final CanopyEffortSpeed speed;
  final VoidCallback? onTap;

  static const double _target = 48;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final fg = onTap == null ? colors.disabledTint : colors.foregroundSecondary;
    return Semantics(
      container: true,
      button: true,
      enabled: onTap != null,
      label: canopyEffortSemanticLabel(level, speed),
      onTap: onTap,
      child: ExcludeSemantics(
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minWidth: _target,
              minHeight: _target,
            ),
            child: Align(
              alignment: Alignment.bottomCenter,
              widthFactor: 1,
              heightFactor: 1,
              child: _chip(colors, fg),
            ),
          ),
        ),
      ),
    );
  }

  Widget _chip(AppColors colors, Color fg) => TextButton(
    onPressed: onTap,
    style: TextButton.styleFrom(
      foregroundColor: fg,
      minimumSize: const Size(48, 32),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.standard,
      padding: const EdgeInsets.symmetric(horizontal: 4),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.md),
      ),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      spacing: 4,
      children: [
        if (speed != CanopyEffortSpeed.regular)
          CanopyIcon(
            key: const ValueKey('effort-trigger-bolt'),
            glyph: CanopyGlyph.zapFilled,
            size: 14,
            tint: speed == CanopyEffortSpeed.ultraFast
                ? colors['fg-special']
                : fg,
          ),
        Flexible(
          child: Text(
            canopyEffortLabel(level),
            maxLines: 1,
            softWrap: false,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.bodySmall.copyWith(color: fg),
          ),
        ),
      ],
    ),
  );
}

/// The Effort panel: `Effort <Level>` over a slider with one stop per level,
/// and Fast mode in the header's corner when [speed] is non-null.
///
/// A drag previews its level in the header and calls [onSelect] once, when it
/// ends on a new level. [onSelect] completes with whether the host kept the
/// level; when it did not, the panel shows the host's level again. A null
/// [onToggleFast] shows the speed read-only, as for Ultra fast, which this
/// client cannot change.
class CanopyEffortPanel extends StatefulWidget {
  const CanopyEffortPanel({
    super.key,
    required this.level,
    required this.levels,
    required this.onSelect,
    this.speed,
    this.onToggleFast,
  });

  final String level;

  /// The model's levels, weakest first.
  final List<String> levels;
  final Future<bool> Function(String level) onSelect;
  final CanopyEffortSpeed? speed;
  final VoidCallback? onToggleFast;

  static const _speedNames = {
    CanopyEffortSpeed.regular: 'Regular',
    CanopyEffortSpeed.fast: 'Fast',
    CanopyEffortSpeed.ultraFast: 'Ultra fast',
  };

  static const _speedDetails = {
    CanopyEffortSpeed.fast: 'Faster replies',
    CanopyEffortSpeed.ultraFast:
        'Fastest replies. Higher speeds may use more of your subscription '
        'allowance. Change it in the desktop app.',
  };

  /// The provider's current speed guidance (`CODEX_SPEED_HELP_URL`).
  static const speedHelpUrl =
      'https://learn.chatgpt.com/docs/agent-configuration/speed';

  @override
  State<CanopyEffortPanel> createState() => _CanopyEffortPanelState();
}

class _CanopyEffortPanelState extends State<CanopyEffortPanel> {
  var _selection = const CanopyEffortSelection();

  @override
  void didUpdateWidget(CanopyEffortPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    _selection = _selection.hostChanged(
      levels: !listEquals(oldWidget.levels, widget.levels),
      level: oldWidget.level != widget.level,
    );
  }

  void _start(double value) {
    _selection = _selection.start(widget.levels, value);
  }

  void _drag(double value) {
    final next = _selection.drag(widget.levels, value);
    if (!identical(next, _selection)) setState(() => _selection = next);
  }

  void _release(double value) {
    final landing = _selection.release(
      widget.levels,
      value,
      hostLevel: widget.level,
    );
    if (landing == null) return;
    setState(() => _selection = landing.next);
    final level = landing.send;
    if (level != null) unawaited(_send(landing.next.choice, level));
  }

  Future<void> _send(int choice, String level) async {
    final kept = await widget.onSelect(level);
    final next = _selection.settle(choice, kept: kept);
    if (mounted && !identical(next, _selection)) {
      setState(() => _selection = next);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final levels = widget.levels;
    final shown = _selection.shown(widget.level);
    final speed = widget.speed;
    final detail = CanopyEffortPanel._speedDetails[speed];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: _Heading(
                key: const ValueKey('effort-level'),
                title: 'Effort',
                value: canopyEffortLabel(shown),
                valueColor: canopyEffortTint(colors, shown),
              ),
            ),
            if (speed != null)
              _FastToggle(speed: speed, onToggle: widget.onToggleFast),
          ],
        ),
        if (levels.length > 1)
          Slider(
            key: const ValueKey('effort-slider'),
            value: levels.indexOf(shown).clamp(0, levels.length - 1).toDouble(),
            max: (levels.length - 1).toDouble(),
            divisions: levels.length - 1,
            activeColor: colors['fg-accent'],
            inactiveColor: colors.border,
            semanticFormatterCallback: (value) =>
                canopyEffortLabel(levels[value.round()]),
            onChangeStart: _start,
            onChanged: _drag,
            onChangeEnd: _release,
          ),
        if (speed != null) ...[
          const SizedBox(height: 4),
          _Heading(
            key: const ValueKey('effort-speed'),
            title: 'Speed',
            value: CanopyEffortPanel._speedNames[speed]!,
            valueColor: speed == CanopyEffortSpeed.ultraFast
                ? colors['fg-special']
                : colors.foreground,
          ),
          if (detail != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                detail,
                style: AppTypography.bodySmall.copyWith(
                  color: colors.foregroundSecondary,
                ),
              ),
            ),
          if (speed == CanopyEffortSpeed.ultraFast)
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: CanopyMiniButton(
                label: 'Learn more',
                semanticsLabel: 'Learn more about speed usage',
                glyph: CanopyGlyph.arrowUpRight,
                onPressed: () =>
                    unawaited(openExternalUrl(CanopyEffortPanel.speedHelpUrl)),
              ),
            ),
        ],
      ],
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading({
    super.key,
    required this.title,
    required this.value,
    required this.valueColor,
  });

  final String title;
  final String value;
  final Color valueColor;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '$title  ',
            style: TextStyle(color: colors.foregroundSecondary),
          ),
          TextSpan(
            text: value,
            style: TextStyle(color: valueColor),
          ),
        ],
      ),
      style: AppTypography.body,
    );
  }
}

/// Fast mode's corner toggle. It follows the speed: an outlined bolt for
/// Regular, a filled accent bolt for Fast, and a filled purple bolt for Ultra
/// fast. Without [onToggle] it keeps its color and only shows the speed.
class _FastToggle extends StatelessWidget {
  const _FastToggle({required this.speed, required this.onToggle});

  final CanopyEffortSpeed speed;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final on = speed != CanopyEffortSpeed.regular;
    final name = speed == CanopyEffortSpeed.ultraFast
        ? 'Ultra fast mode'
        : 'Fast mode';
    final glyph = on ? CanopyGlyph.zapFilled : CanopyGlyph.zap;
    final tint = switch (speed) {
      CanopyEffortSpeed.regular => colors.foregroundSecondary,
      CanopyEffortSpeed.fast => colors['fg-accent'],
      CanopyEffortSpeed.ultraFast => colors['fg-special'],
    };
    final onToggle = this.onToggle;
    return Semantics(
      key: const ValueKey('effort-fast-mode'),
      toggled: on,
      enabled: onToggle != null,
      child: onToggle == null
          ? Semantics(
              label: name,
              child: SizedBox.square(
                dimension: 48,
                child: Center(
                  child: CanopyIcon(glyph: glyph, size: 20, tint: tint),
                ),
              ),
            )
          : CanopyIconButton(
              glyph: glyph,
              tooltip: name,
              tint: tint,
              onPressed: onToggle,
            ),
    );
  }
}
