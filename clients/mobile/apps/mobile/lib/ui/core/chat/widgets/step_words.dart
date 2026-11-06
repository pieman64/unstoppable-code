import 'package:flutter/material.dart';

/// A step row's words and its lighter detail on one line, as desktop's
/// `StepRow`: the words keep their width and the detail ends in "…" first.
/// Only words longer than [wordsShare] of the line end in "…" themselves,
/// so some detail always shows.
class StepWords extends StatelessWidget {
  const StepWords({super.key, required this.words, this.detail});

  final Widget words;
  final Widget? detail;

  static const double wordsShare = 0.6;

  @override
  Widget build(BuildContext context) {
    final detail = this.detail;
    if (detail == null) return words;
    return LayoutBuilder(
      builder: (context, constraints) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: constraints.maxWidth * wordsShare,
            ),
            child: words,
          ),
          const SizedBox(width: 6),
          Flexible(child: detail),
        ],
      ),
    );
  }
}
