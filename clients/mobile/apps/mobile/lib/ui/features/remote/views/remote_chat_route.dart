import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/workspace_context_route.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

/// The route every Remote Control chat push uses. Pushed routes sit beside
/// the shell, not under it, so the Remote Control model is re-provided here.
///
/// The chat closes when the workspace context it opened in changes; see
/// [workspaceContextRoute] (CAN-4429).
Route<void> remoteChatRoute(
  BuildContext context,
  Widget screen, {
  WorkspaceContext? workspaceContext,
}) {
  final viewModel = context.read<RemoteControlViewModel>();
  return workspaceContextRoute(
    context,
    (_) => ChangeNotifierProvider<RemoteControlViewModel>.value(
      value: viewModel,
      child: screen,
    ),
    workspaceContext: workspaceContext,
  );
}
