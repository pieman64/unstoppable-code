import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';

/// A page route that belongs to the workspace context it opened in
/// (CAN-4429): [workspaceContext] when given, else the one provided at
/// [context]. Pushed routes sit beside the shell, so a screen that shows one
/// context's data must not outlive that context.
///
/// When the provided context changes, the route closes with the screens
/// opened above it. A host without a provided context keeps the route open.
Route<void> workspaceContextRoute(
  BuildContext context,
  WidgetBuilder builder, {
  WorkspaceContext? workspaceContext,
}) => _WorkspaceContextRoute(
  workspaceContext: workspaceContext ?? context.read<WorkspaceContext?>(),
  builder: builder,
);

final class _WorkspaceContextRoute extends MaterialPageRoute<void> {
  _WorkspaceContextRoute({
    required this.workspaceContext,
    required WidgetBuilder builder,
  }) : super(builder: (context) => _ContextExit(child: builder(context)));

  final WorkspaceContext? workspaceContext;
}

class _ContextExit extends StatefulWidget {
  const _ContextExit({required this.child});

  final Widget child;

  @override
  State<_ContextExit> createState() => _ContextExitState();
}

class _ContextExitState extends State<_ContextExit> {
  bool _closing = false;

  @override
  Widget build(BuildContext context) {
    final current = context.watch<WorkspaceContext?>();
    final route = ModalRoute.of(context);
    if (!_closing &&
        route is _WorkspaceContextRoute &&
        _leftContext(route, current)) {
      _closing = true;
      // The navigator cannot change during a build.
      WidgetsBinding.instance.addPostFrameCallback((_) => _close(route));
    }
    return widget.child;
  }

  static bool _leftContext(
    _WorkspaceContextRoute route,
    WorkspaceContext? current,
  ) {
    final opened = route.workspaceContext;
    return opened != null && current != null && current != opened;
  }

  void _close(_WorkspaceContextRoute route) {
    if (!mounted || !route.isActive) return;
    final current = context.read<WorkspaceContext?>();
    final navigator = route.navigator!;
    // Close the screens this route opened, but keep a route opened since in
    // the new context: it owns that decision.
    _WorkspaceContextRoute? kept;
    navigator.popUntil((above) {
      if (above is _WorkspaceContextRoute && !_leftContext(above, current)) {
        kept = above;
      }
      return above == route || kept != null;
    });
    final keptRoute = kept;
    if (keptRoute == null) {
      navigator.pop();
      return;
    }
    // The kept route opened above this one: remove this route and the
    // screens it opened from beneath it, so going back does not show them
    // again.
    while (route.isActive) {
      navigator.removeRouteBelow(keptRoute);
    }
  }
}
