import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/workspace_context_label.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';

/// Publishes [AuthViewModel.workspaceContext] as a plain value (CAN-4429), so
/// features that scope by context read it without depending on auth, and
/// rebuild only when the context itself changes.
///
/// Mounted under the [AuthViewModel] provider, above `MaterialApp`, so pushed
/// routes see it too. Public so tests compose the same provider.
SingleChildWidget workspaceContextProvider() => MultiProvider(
  providers: [
    ProxyProvider<AuthViewModel, WorkspaceContext>(
      update: (_, auth, _) => auth.workspaceContext,
    ),
    ProxyProvider<AuthViewModel, WorkspaceContextLabel>(
      update: (_, auth, _) => WorkspaceContextLabel(
        auth.workspaceContext.isPersonal
            ? 'Personal'
            : auth.activeOrganization?.name ?? 'this organization',
      ),
    ),
  ],
);
