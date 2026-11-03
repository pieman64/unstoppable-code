import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/ui/core/chat/widgets/draft_option_sheet.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// Horizontal inset shared by the section label and project headers.
const double _edgeInset = 16;

/// Size of the project folder icon.
const double _iconSize = 14;

/// Width taken by the project icon and the gap after it.
const double _iconSlot = _iconSize + 10;

/// Where a project's name starts; its chats indent to this edge so they read
/// as the project's contents, as in the web sidebar.
const double cloudProjectContentInset = _edgeInset + _iconSlot;

/// Quiet label that opens the list of projects, matching the web sidebar's
/// "Projects" heading.
class CloudProjectsSectionLabel extends StatelessWidget {
  const CloudProjectsSectionLabel({super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      key: const ValueKey('cloud-projects-section'),
      padding: const EdgeInsets.fromLTRB(_edgeInset, 8, _edgeInset, 0),
      child: Text(
        'Projects',
        style: AppTypography.bodySmall.copyWith(
          color: AppColors.of(context).foregroundMuted,
        ),
      ),
    );
  }
}

/// Project header in the cloud chats list: the folder icon on the left edge,
/// the name, and a New chat action for that project on the right.
class CloudWorkspaceHeader extends StatelessWidget {
  const CloudWorkspaceHeader({
    super.key,
    required this.workspace,
    required this.onNewChat,
  });

  final CloudWorkspaceSummary workspace;

  /// Opens a new chat in this project. Null disables the action.
  final VoidCallback? onNewChat;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Padding(
      key: ValueKey('cloud-workspace-header-${workspace.externalId}'),
      padding: const EdgeInsets.fromLTRB(_edgeInset, 12, 4, 0),
      child: Row(
        children: [
          CloudProjectIcon(color: workspace.color),
          const SizedBox(width: _iconSlot - _iconSize),
          Expanded(
            child: Text(
              workspace.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body.copyWith(
                color: colors.foreground,
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
          ),
          CanopyIconButton(
            key: ValueKey('cloud-new-chat-${workspace.externalId}'),
            glyph: CanopyGlyph.plusMedium,
            tooltip: 'New chat in ${workspace.name}',
            size: CanopyIconButtonSize.small,
            onPressed: onNewChat,
          ),
        ],
      ),
    );
  }
}

/// A project's folder icon, tinted with its accent color when it has a valid
/// one.
class CloudProjectIcon extends StatelessWidget {
  const CloudProjectIcon({super.key, required this.color});

  final String? color;

  @override
  Widget build(BuildContext context) {
    return CanopyIcon(
      glyph: CanopyGlyph.folderFilled,
      size: _iconSize,
      tint: _parseColor(color) ?? AppColors.of(context).foregroundSecondary,
    );
  }

  static Color? _parseColor(String? hex) {
    if (hex == null) return null;
    final match = RegExp(r'^#?([0-9a-fA-F]{6})$').firstMatch(hex.trim());
    if (match == null) return null;
    return Color(0xff000000 | int.parse(match.group(1)!, radix: 16));
  }
}

/// Asks which project a new chat belongs in, marking [selectedId]. Returns
/// the chosen project's id, or null when the sheet is dismissed.
Future<String?> showCloudProjectPickerSheet(
  BuildContext context,
  List<CloudWorkspaceSummary> workspaces, {
  String? selectedId,
}) => showDraftOptionSheet(
  context,
  title: 'Choose a project',
  keyPrefix: 'cloud-project',
  selectedId: selectedId,
  options: [
    for (final workspace in workspaces)
      (
        id: workspace.externalId,
        name: workspace.name,
        icon: CloudProjectIcon(color: workspace.color),
        subtitle: null,
      ),
  ],
);
