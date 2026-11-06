import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/action_dialogs.dart';

/// Archive confirmation shared by Remote Control and Computer connect rows.
Future<bool> confirmWorktreeArchive(
  BuildContext context,
  String title,
) => confirmDestructive(
  context,
  title: 'Archive worktree?',
  message:
      'Archive “$title” on your desktop? This stops its running sessions and removes the active checkout. Retained archives are managed on the desktop.',
  confirmLabel: 'Archive',
);

/// The worktree context menu's archive entry.
PopupMenuItem<String> worktreeArchiveMenuItem(
  BuildContext context, {
  required Key key,
  required bool enabled,
  required bool pending,
}) {
  final active = enabled && !pending;
  return PopupMenuItem<String>(
    key: key,
    value: 'archive',
    enabled: active,
    child: Row(
      children: [
        CanopyIcon(
          glyph: CanopyGlyph.archive,
          size: 20,
          tint: active
              ? Theme.of(context).colorScheme.error
              : Theme.of(context).disabledColor,
        ),
        const SizedBox(width: 12),
        Text(pending ? 'Archiving…' : 'Archive'),
      ],
    ),
  );
}
