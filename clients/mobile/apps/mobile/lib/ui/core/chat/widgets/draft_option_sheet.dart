import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// One choice in a new chat's option sheet, such as a project or the
/// worktree to start from. [subtitle] tells apart choices that share a
/// name.
typedef DraftOption = ({String id, String name, Widget icon, String? subtitle});

const double _edgeInset = 16;
const double _iconSize = 14;
const double _iconSlot = _iconSize + 10;

/// Asks for one of [options] under [title], marking [selectedId]. Returns
/// the chosen option's id, or null when the sheet is dismissed. Keys start
/// with [keyPrefix]: the sheet is `<prefix>-picker` and each row
/// `<prefix>-option-<id>`.
Future<String?> showDraftOptionSheet(
  BuildContext context, {
  required String title,
  required List<DraftOption> options,
  required String keyPrefix,
  String? selectedId,
}) {
  return showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) {
      final colors = AppColors.of(context);
      return SafeArea(
        key: ValueKey('$keyPrefix-picker'),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.7,
          ),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.only(bottom: 8),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  _edgeInset,
                  0,
                  _edgeInset,
                  8,
                ),
                child: Text(
                  title,
                  style: AppTypography.bodySmall.copyWith(
                    color: colors.foregroundMuted,
                  ),
                ),
              ),
              for (final option in options)
                Semantics(
                  key: ValueKey('$keyPrefix-option-${option.id}'),
                  selected: option.id == selectedId,
                  child: ListTile(
                    minTileHeight: 48,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: _edgeInset,
                    ),
                    horizontalTitleGap: _iconSlot - _iconSize,
                    minLeadingWidth: _iconSize,
                    leading: option.icon,
                    title: Text(
                      option.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.body.copyWith(
                        color: colors.foreground,
                      ),
                    ),
                    subtitle: switch (option.subtitle) {
                      final subtitle? => Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.bodySmall.copyWith(
                          color: colors.foregroundMuted,
                        ),
                      ),
                      null => null,
                    },
                    trailing: option.id == selectedId
                        ? CanopyIcon(
                            glyph: CanopyGlyph.checkmark1,
                            size: 20,
                            tint: colors.foreground,
                          )
                        : null,
                    onTap: () => Navigator.of(context).pop(option.id),
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );
}
