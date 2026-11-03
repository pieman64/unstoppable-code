import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/home/views/widgets/workspace_context_switcher.dart';
import 'package:provider/provider.dart';

/// Shows [child], an organization-only destination, unless the user works in
/// Personal while belonging to organizations (CAN-4429). Then it asks them to
/// choose an organization, which switches the global context.
///
/// In Personal the shell mounts no organization view models, so [child] is
/// never built there and cannot fall back to mock data.
class OrganizationContextGate extends StatelessWidget {
  const OrganizationContextGate({
    required this.title,
    required this.child,
    super.key,
  });

  /// The destination's name, kept in the app bar while gated.
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthViewModel>();
    if (auth.activeOrgId != null || auth.organizations.isEmpty) return child;
    return CanopyScaffold(
      appBar: CanopyAppBar(
        leading: Align(
          alignment: Alignment.centerLeft,
          child: HomeMenuButton.maybeOf(context, designSystem: true),
        ),
        content: Text(title),
      ),
      body: StateMessageView(
        key: const ValueKey('organization-context-gate'),
        glyph: CanopyGlyph.buildings,
        title: 'Choose an organization',
        message:
            '$title belongs to an organization. You are working in Personal.',
        actionLabel: 'Choose organization',
        onAction: () => unawaited(showOrganizationPicker(context)),
      ),
    );
  }
}
