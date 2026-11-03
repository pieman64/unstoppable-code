import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:flutter/services.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/org_invite.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';

/// Bottom-sheet invite flow: an email + role form that, on success, shows the
/// invite link (new users) or a dashboard note (existing users).
///
/// Takes [viewModel] directly rather than reading it from the tree because the
/// sheet is hosted on the root navigator, above the feature providers.
class InviteMemberSheet extends StatefulWidget {
  const InviteMemberSheet({
    super.key,
    required this.viewModel,
    required this.canGrantAdmin,
  });

  final MembersViewModel viewModel;
  final bool canGrantAdmin;

  @override
  State<InviteMemberSheet> createState() => _InviteMemberSheetState();
}

class _InviteMemberSheetState extends State<InviteMemberSheet> {
  final _emailController = TextEditingController();
  OrganizationRole _role = OrganizationRole.member;
  bool _submitting = false;
  bool _copied = false;
  String? _error;
  OutgoingInvite? _created;

  @override
  void dispose() {
    _emailController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final email = _emailController.text.trim();
    if (email.isEmpty || !email.contains('@')) {
      setState(() => _error = 'Enter a valid email address');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final invite = await widget.viewModel.submitInvite(
        email: email,
        role: _role,
      );
      if (!mounted) return;
      setState(() {
        _created = invite;
        _submitting = false;
      });
    } catch (error) {
      if (!mounted) return;
      final org = widget.viewModel.organization;
      setState(() {
        _error =
            orgLapseActionMessage(
              error,
              orgName: org?.name,
              viewerRole: org?.viewerRole,
            ) ??
            presentableErrorMessage(error) ??
            'Could not send the invite. Please try again.';
        _submitting = false;
      });
    }
  }

  void _reset() {
    _emailController.clear();
    setState(() {
      _created = null;
      _error = null;
      _copied = false;
      _role = OrganizationRole.member;
    });
  }

  Future<void> _copy(String link) async {
    await Clipboard.setData(ClipboardData(text: link));
    if (!mounted) return;
    setState(() => _copied = true);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final created = _created;
    return Padding(
      padding: EdgeInsets.only(
        left: 24,
        right: 24,
        top: 8,
        bottom: 24 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: created == null
            ? _form(context, theme)
            : _success(context, theme, created),
      ),
    );
  }

  List<Widget> _form(BuildContext context, ThemeData theme) {
    final error = _error;
    return [
      Text(
        'Add member',
        style: theme.textTheme.titleLarge?.copyWith(
          fontWeight: AppTypography.emphasisWeight,
          fontVariations: AppTypography.emphasisVariations,
        ),
      ),
      const SizedBox(height: 4),
      Text(
        'Invite someone to this organization by email.',
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      const SizedBox(height: 20),
      TextField(
        controller: _emailController,
        enabled: !_submitting,
        keyboardType: TextInputType.emailAddress,
        autocorrect: false,
        decoration: const InputDecoration(
          labelText: 'Email',
          border: OutlineInputBorder(),
          prefixIcon: Icon(Icons.mail_outline),
        ),
      ),
      if (widget.canGrantAdmin) ...[
        const SizedBox(height: 16),
        Align(
          alignment: Alignment.centerLeft,
          child: Text(
            'Role',
            style: theme.textTheme.labelMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        const SizedBox(height: 8),
        SegmentedButton<OrganizationRole>(
          segments: const [
            ButtonSegment(
              value: OrganizationRole.member,
              label: Text('Member'),
            ),
            ButtonSegment(value: OrganizationRole.admin, label: Text('Admin')),
          ],
          selected: {_role},
          onSelectionChanged: _submitting
              ? null
              : (selection) => setState(() => _role = selection.first),
        ),
      ],
      if (error != null) ...[
        const SizedBox(height: 12),
        Text(
          error,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.error,
          ),
        ),
      ],
      const SizedBox(height: 24),
      Row(
        children: [
          Expanded(
            child: OutlinedButton(
              onPressed: _submitting ? null : () => Navigator.of(context).pop(),
              child: const Text('Cancel'),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: FilledButton(
              onPressed: _submitting ? null : () => unawaited(_submit()),
              child: _submitting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Send invite'),
            ),
          ),
        ],
      ),
    ];
  }

  List<Widget> _success(
    BuildContext context,
    ThemeData theme,
    OutgoingInvite invite,
  ) {
    if (invite.invitedUserExists) {
      return [
        Icon(
          Icons.check_circle_outline,
          size: 40,
          color: theme.colorScheme.primary,
        ),
        const SizedBox(height: 12),
        Text(
          'Invitation sent',
          style: theme.textTheme.titleLarge?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text(
          '${invite.invitedEmail} already has an account — the invitation '
          'will appear on their dashboard.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Done'),
        ),
      ];
    }

    final origin = AppConfig.apiBaseUrl;
    final link = origin.isEmpty
        ? '/invite/${invite.code}'
        : '$origin/invite/${invite.code}';
    return [
      Icon(
        Icons.check_circle_outline,
        size: 40,
        color: theme.colorScheme.primary,
      ),
      const SizedBox(height: 12),
      Text(
        'Invite created',
        style: theme.textTheme.titleLarge?.copyWith(
          fontWeight: AppTypography.emphasisWeight,
          fontVariations: AppTypography.emphasisVariations,
        ),
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 8),
      Text(
        'Share this link with ${invite.invitedEmail}:',
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 12),
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          link,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodySmall,
        ),
      ),
      const SizedBox(height: 16),
      Row(
        children: [
          Expanded(
            child: OutlinedButton(
              onPressed: _reset,
              child: const Text('Invite another'),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: FilledButton.icon(
              onPressed: () => unawaited(_copy(link)),
              icon: Icon(_copied ? Icons.check : Icons.copy, size: 18),
              label: Text(_copied ? 'Copied' : 'Copy link'),
            ),
          ),
        ],
      ),
      const SizedBox(height: 4),
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Done'),
      ),
    ];
  }
}
