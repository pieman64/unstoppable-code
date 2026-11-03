import 'package:flutter/material.dart';

/// Keeps the composer at the bottom and bounds it by the space left after
/// the host's chrome, notices and keyboard. The transcript gets the remainder.
class ChatBody extends StatelessWidget {
  const ChatBody({
    super.key,
    required this.transcript,
    required this.composer,
    this.minimumTranscriptHeight = 0,
  });

  final Widget transcript;
  final Widget composer;

  /// Keeps transcript controls clear of overlaid chrome when the composer grows.
  final double minimumTranscriptHeight;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(child: transcript),
        ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: (constraints.maxHeight - minimumTranscriptHeight).clamp(
              0.0,
              constraints.maxHeight,
            ),
          ),
          child: composer,
        ),
      ],
    ),
  );
}
