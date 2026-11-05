import 'package:flutter/widgets.dart';

/// Optional app-composed destination. The home shell owns only navigation.
class HomeExtraDestination extends InheritedWidget {
  const HomeExtraDestination({
    super.key,
    required this.label,
    required this.subtitle,
    required this.pageBuilder,
    required super.child,
  });
  final String label, subtitle;
  final WidgetBuilder pageBuilder;
  static HomeExtraDestination? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<HomeExtraDestination>();
  @override
  bool updateShouldNotify(HomeExtraDestination oldWidget) =>
      label != oldWidget.label || subtitle != oldWidget.subtitle;
}
