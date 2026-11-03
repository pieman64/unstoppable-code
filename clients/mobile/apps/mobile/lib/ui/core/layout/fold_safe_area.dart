import 'package:flutter/widgets.dart';

/// Keeps the navigator in one readable pane while the display is folded.
class FoldSafeArea extends StatelessWidget {
  const FoldSafeArea({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => DisplayFeatureSubScreen(
    child: LayoutBuilder(
      builder: (context, constraints) => MediaQuery(
        data: MediaQuery.of(context).copyWith(size: constraints.biggest),
        child: child,
      ),
    ),
  );
}
