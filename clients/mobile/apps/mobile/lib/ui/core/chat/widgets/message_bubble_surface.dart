import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// The user-bubble chrome (desktop `BUBBLE_SURFACE_CLASS`): a full-width
/// [color] surface with the house border and rounded-xl corners, matching
/// the composer below it.
class MessageBubbleSurface extends StatelessWidget {
  const MessageBubbleSurface({
    super.key,
    required this.color,
    required this.child,
  });

  /// Desktop `px-3`: the horizontal inset shared by bubble text and flat
  /// assistant content so both start on the same left edge.
  static const double textInset = 12;

  final Color color;
  final Widget child;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: double.infinity,
    child: DecoratedBox(
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(AppRadii.xl),
        border: Border.all(color: AppColors.of(context).border),
        boxShadow: const [
          BoxShadow(
            color: Color(0x0D000000),
            blurRadius: 2,
            offset: Offset(0, 1),
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: textInset, vertical: 6),
        child: child,
      ),
    ),
  );
}
