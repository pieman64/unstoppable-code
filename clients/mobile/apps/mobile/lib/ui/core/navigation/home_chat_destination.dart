import 'package:flutter/widgets.dart';

/// App composition supplies the chat home without coupling navigation to I/O.
class HomeChatDestination extends InheritedWidget {
  const HomeChatDestination({
    super.key,
    required this.builder,
    required super.child,
  });
  final WidgetBuilder builder;
  static HomeChatDestination? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<HomeChatDestination>();
  @override
  bool updateShouldNotify(HomeChatDestination oldWidget) =>
      builder != oldWidget.builder;
}
