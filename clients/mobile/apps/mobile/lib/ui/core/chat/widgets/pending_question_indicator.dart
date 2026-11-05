import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/status_colors.dart';

/// Persistent attention signal, cleared by answering rather than reading.
class PendingQuestionIndicator extends StatelessWidget {
  /// The one label for this status, shared with row title signals.
  static const String message = 'Question needs an answer';

  const PendingQuestionIndicator({super.key, this.size = 18}) : _dot = false;

  const PendingQuestionIndicator.dot({super.key, this.size = 7}) : _dot = true;

  final bool _dot;

  final double size;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: message,
    child: _dot
        ? Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              color: StatusColors.of(context).warning,
              shape: BoxShape.circle,
            ),
          )
        : CanopyIcon(
            glyph: CanopyGlyph.circleQuestionmark,
            size: size,
            tint: StatusColors.of(context).warning,
          ),
  );
}
