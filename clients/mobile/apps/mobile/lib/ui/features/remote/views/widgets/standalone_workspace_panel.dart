import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/brand/brand.g.dart';

/// Right-hand drawer for a standalone (cowork) chat, mirroring the DESKTOP
/// cowork workspace-item cards (Notes, Prompts, Attachments — the
/// `workspace-items:*` IPC domain). The portal protocol does not yet ship
/// commands for reading or managing them, so the panel is visually faithful
/// but read-only — each card notes that the content is managed in the
/// desktop app. (The former cowork Context and Artifacts features were
/// removed; see docs/cowork-workspaces.md.)
class StandaloneWorkspacePanel extends StatelessWidget {
  const StandaloneWorkspacePanel({super.key, this.workspaceName});

  /// The owning cowork workspace's display name, when resolvable.
  final String? workspaceName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Drawer(
      child: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              'PROJECT',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
            if (workspaceName case final name? when name.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(name, style: theme.textTheme.titleMedium),
            ],
            const SizedBox(height: 12),
            for (final section in const [
              (Icons.sticky_note_2_outlined, 'Notes'),
              (Icons.text_snippet_outlined, 'Prompts'),
              (Icons.attach_file, 'Attachments'),
            ]) ...[
              Card(
                child: ListTile(
                  leading: Icon(
                    section.$1,
                    size: 20,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  title: Text(section.$2),
                  subtitle: Text(
                    'Managed in ${Brand.productDisplayName}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  dense: true,
                ),
              ),
              const SizedBox(height: 8),
            ],
          ],
        ),
      ),
    );
  }
}
