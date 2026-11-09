import 'package:flutter/widgets.dart';

/// App composition supplies the account's Orchestrator connection.
class HomeOrchestratorDestination extends InheritedWidget {
  const HomeOrchestratorDestination({
    super.key,
    required this.builder,
    required super.child,
  });
  final Widget Function(BuildContext, bool isActive) builder;
  static HomeOrchestratorDestination? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<HomeOrchestratorDestination>();
  @override
  bool updateShouldNotify(HomeOrchestratorDestination oldWidget) =>
      builder != oldWidget.builder;
}
