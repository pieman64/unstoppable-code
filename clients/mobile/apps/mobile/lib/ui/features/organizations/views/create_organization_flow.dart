import 'package:flutter/material.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';
import 'package:mobile/ui/features/organizations/view_models/org_view_model.dart';
import 'package:provider/provider.dart';

/// Prompts for an organization name, returning the entered text or null when
/// cancelled. [initialValue] pre-fills the field (used by rename).
Future<String?> promptForOrganizationName(
  BuildContext context, {
  required String title,
  required String confirmLabel,
  String initialValue = '',
}) => showDialog<String>(
  context: context,
  builder: (dialogContext) => _OrganizationNameDialog(
    title: title,
    confirmLabel: confirmLabel,
    initialValue: initialValue,
  ),
);

/// The name dialog, stateful purely so it owns its [TextEditingController].
///
/// Disposing the controller off `showDialog(...).whenComplete` instead would
/// free it while the dialog's exit transition is still building the field that
/// depends on it. Tying it to this element's lifetime disposes it once the
/// route is actually gone.
class _OrganizationNameDialog extends StatefulWidget {
  const _OrganizationNameDialog({
    required this.title,
    required this.confirmLabel,
    required this.initialValue,
  });

  final String title;
  final String confirmLabel;
  final String initialValue;

  @override
  State<_OrganizationNameDialog> createState() =>
      _OrganizationNameDialogState();
}

class _OrganizationNameDialogState extends State<_OrganizationNameDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initialValue,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.title),
    content: TextField(
      controller: _controller,
      autofocus: true,
      textInputAction: TextInputAction.done,
      onSubmitted: (value) => Navigator.of(context).pop(value),
      decoration: const InputDecoration(
        labelText: 'Name',
        hintText: 'e.g. Acme Engineering',
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () => Navigator.of(context).pop(_controller.text),
        child: Text(widget.confirmLabel),
      ),
    ],
  );
}

/// Prompts for a name, creates the organization, and switches to it. Returns
/// true only when an organization was actually created.
///
/// Shared by the Members screen overflow menu and the no-organization tab, so
/// an org-less user creating their first org lands in exactly the same state
/// as an existing member creating their second.
///
/// The return value matters to callers: a cancelled dialog must not be
/// mistaken for a completed create and trigger follow-up work.
Future<bool> promptCreateOrganization(BuildContext context) async {
  final name = await promptForOrganizationName(
    context,
    title: 'New organization',
    confirmLabel: 'Create',
  );
  if (name == null || name.trim().isEmpty) return false;
  if (!context.mounted) return false;
  final orgVm = context.read<OrgViewModel>();
  final auth = context.read<AuthViewModel>();
  final messenger = ScaffoldMessenger.of(context);
  final newOrgId = await orgVm.create(name.trim());
  if (newOrgId == null) {
    final activeOrg = auth.activeOrganization;
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          orgLapseActionMessage(
                orgVm.error,
                orgName: activeOrg?.name,
                viewerRole: activeOrg?.role,
              ) ??
              orgVm.errorMessage ??
              'Could not create the organization.',
        ),
      ),
    );
    return false;
  }
  await auth.reloadOrganizations();
  if (auth.status == AuthStatus.unauthenticated) {
    // The reload answered 401 and signed the user out, which also cleared
    // `organizationsLoadFailed` — so check for the signed-out status first, or
    // the branch below is skipped and "Organization created" renders over the
    // sign-in screen. Tested against `unauthenticated` specifically rather than
    // "not authenticated": signOut is what produces it.
    return true;
  }
  if (auth.organizationsLoadFailed) {
    // The organization exists, but the refresh that would surface it did not
    // land. Claiming plain success here would contradict the "couldn't load
    // your organizations" shell the user is about to be shown.
    messenger.showSnackBar(
      const SnackBar(
        content: Text("Organization created, but we couldn't refresh it yet."),
      ),
    );
    return true;
  }
  auth.switchOrg(newOrgId);
  messenger.showSnackBar(const SnackBar(content: Text('Organization created')));
  return true;
}
