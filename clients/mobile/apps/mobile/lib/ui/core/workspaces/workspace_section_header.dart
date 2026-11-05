import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/typography.dart';

/// Project header shared by mobile computer navigation flows.
class WorkspaceSectionHeader extends StatelessWidget {
  const WorkspaceSectionHeader({
    super.key,
    required this.id,
    required this.name,
    required this.itemLabel,
    required this.icon,
    required this.accent,
    required this.collapsed,
    required this.onToggle,
    this.onCreateTask,
    this.createTaskEnabled = true,
  });
  final String id, name, itemLabel;
  final CanopyGlyph icon;
  final Color accent;
  final bool collapsed, createTaskEnabled;
  final VoidCallback onToggle;
  final VoidCallback? onCreateTask;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Material(
            color: theme.colorScheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              onTap: onToggle,
              borderRadius: BorderRadius.circular(12),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
                child: Row(
                  children: [
                    Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        color: accent.withValues(alpha: 0.18),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Center(
                        child: CanopyIcon(glyph: icon, size: 20, tint: accent),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: AppTypography.emphasisWeight,
                              fontVariations: AppTypography.emphasisVariations,
                            ),
                          ),
                          Text(
                            itemLabel,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (onCreateTask case final createTask?)
                      IconButton(
                        key: ValueKey('create-task-$id'),
                        icon: CanopyIcon(
                          tint: theme.colorScheme.onSurfaceVariant,
                          glyph: CanopyGlyph.plusMedium,
                          size: 20,
                        ),
                        tooltip: 'New task in $name',
                        constraints: const BoxConstraints(
                          minWidth: 48,
                          minHeight: 48,
                        ),
                        color: theme.colorScheme.onSurfaceVariant,
                        onPressed: createTaskEnabled ? createTask : null,
                      ),
                    SizedBox(
                      width: 36,
                      child: CanopyIcon(
                        glyph: collapsed
                            ? CanopyGlyph.chevronRightMedium
                            : CanopyGlyph.chevronDownMedium,
                        size: 20,
                        tint: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

Color? workspaceColor(String? hex) {
  if (hex == null) return null;
  var value = hex.replaceFirst('#', '').trim();
  // Expand 3-digit shorthand (`abc` -> `aabbcc`) before adding the alpha byte.
  if (value.length == 3) {
    value = value.split('').map((c) => '$c$c').join();
  }
  if (value.length == 6) value = 'ff$value';
  if (value.length != 8) return null;
  final parsed = int.tryParse(value, radix: 16);
  return parsed == null ? null : Color(parsed);
}

CanopyGlyph workspaceTypeGlyph(String? type) => switch (type) {
  'single-repo' => CanopyGlyph.codeMedium,
  'multi-repo' => CanopyGlyph.folders,
  'cowork' => CanopyGlyph.folder1,
  _ => CanopyGlyph.circleQuestionmark,
};
