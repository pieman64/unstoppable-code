import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// A chat header's subtitle led by where the chat runs (CAN-2932): the cloud
/// or computer icon the drawer's Recents rows use, announced as [location].
class ChatLocationSubtitle extends StatelessWidget {
  const ChatLocationSubtitle({
    super.key,
    required this.glyph,
    required this.location,
    required this.text,
    this.computer,
  });

  final CanopyGlyph glyph;

  /// The icon's accessible label, such as "Cloud chat".
  final String location;

  final String? text;

  /// The computer the chat runs on, after [text]; each truncates on its own
  /// so a long branch cannot push the computer's name out of view.
  final String? computer;

  @override
  Widget build(BuildContext context) {
    final parts = [
      for (final part in [text, computer])
        if (part != null && part.isNotEmpty) part,
    ];
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          key: const ValueKey('chat-location-icon'),
          label: location,
          child: CanopyIcon(
            glyph: glyph,
            size: 14,
            tint: AppColors.of(context).foregroundSecondary,
          ),
        ),
        for (final (index, part) in parts.indexed) ...[
          if (index == 0)
            const SizedBox(width: 4)
          else
            const ExcludeSemantics(child: Text(' · ')),
          Flexible(
            child: Text(part, maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
        ],
      ],
    );
  }
}
