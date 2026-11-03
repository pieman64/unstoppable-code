import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/workspace_context_copy.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

/// The drawer's workspace context row (CAN-4429): Personal or the selected
/// organization, which opens the context picker. It sits below the wordmark
/// with no surface at rest, like the web sidebar's top `SidebarContextRow`.
///
/// Hidden for an account with no organizations, which is always Personal.
class WorkspaceContextRow extends StatelessWidget {
  const WorkspaceContextRow({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthViewModel>();
    if (auth.organizations.isEmpty) return const SizedBox.shrink();
    final organization = auth.activeOrganization;
    final label = organization?.name ?? _personalLabel;
    final colorScheme = Theme.of(context).colorScheme;
    void open() => unawaited(showWorkspaceContextPicker(context));
    final row = Semantics(
      button: true,
      label: 'Workspace context: $label',
      onTap: open,
      excludeSemantics: true,
      child: ListTile(
        key: const ValueKey('home-workspace-context-row'),
        onTap: open,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        leading: _ContextGlyph(
          glyph: organization == null
              ? CanopyGlyph.user
              : CanopyGlyph.buildings,
          logoUrl: organization?.logoUrl,
        ),
        title: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        trailing: CanopyIcon(
          glyph: CanopyGlyph.chevronDownSmall,
          size: 20,
          tint: colorScheme.onSurfaceVariant,
        ),
      ),
    );
    return Padding(padding: const EdgeInsets.only(bottom: 4), child: row);
  }
}

const String _personalLabel = 'Personal';

/// The uploaded organization logo, or the context glyph while unavailable.
/// A fixed slot keeps labels aligned when the image loads or fails.
class _ContextGlyph extends StatelessWidget {
  const _ContextGlyph({required this.glyph, this.logoUrl});

  final CanopyGlyph glyph;
  final String? logoUrl;

  @override
  Widget build(BuildContext context) {
    final fallback = CanopyIcon(
      glyph: glyph,
      tint: Theme.of(context).colorScheme.onSurfaceVariant,
    );
    final logoUrl = this.logoUrl;
    if (logoUrl == null || logoUrl.isEmpty) return fallback;
    return SizedBox.square(
      dimension: 24,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadii.sm),
        child: Image.network(
          logoUrl,
          width: 24,
          height: 24,
          fit: BoxFit.cover,
          excludeFromSemantics: true,
          frameBuilder: (context, child, frame, wasSynchronouslyLoaded) =>
              frame == null ? fallback : child,
          errorBuilder: (context, error, stackTrace) => fallback,
        ),
      ),
    );
  }
}

/// Picker title suffixes by organization id. Names that match ignoring case
/// and surrounding spaces get the last six ID characters, without hyphens, so
/// each option is distinct; the name itself stays verbatim.
Map<String, String> _organizationSuffixes(List<OrganizationSummary> orgs) {
  String key(OrganizationSummary org) => org.name.trim().toLowerCase();
  final counts = <String, int>{};
  for (final org in orgs) {
    counts.update(key(org), (count) => count + 1, ifAbsent: () => 1);
  }
  return {
    for (final org in orgs)
      if (counts[key(org)]! > 1) org.id: _idSuffix(org.id),
  };
}

String _idSuffix(String id) {
  final compact = id.replaceAll('-', '');
  return compact.length > 6 ? compact.substring(compact.length - 6) : compact;
}

/// Lists Personal and every organization; choosing one switches the global
/// context. Organization actions stay in Settings (CAN-3558).
Future<void> showWorkspaceContextPicker(BuildContext context) =>
    _showContextPicker(context, includePersonal: true);

/// Lists the organizations only, for screens that need one.
Future<void> showOrganizationPicker(BuildContext context) => _showContextPicker(
  context,
  title: 'Choose an organization',
  includePersonal: false,
);

Future<void> _showContextPicker(
  BuildContext context, {
  required bool includePersonal,
  String? title,
}) {
  final auth = context.read<AuthViewModel>();
  final messenger = ScaffoldMessenger.of(context);
  final selected = auth.workspaceContext;

  Future<void> select(WorkspaceContext choice) async {
    final message = switch (await auth.selectWorkspaceContext(choice)) {
      WorkspaceContextSelection.saved ||
      WorkspaceContextSelection.superseded => null,
      WorkspaceContextSelection.unsaved =>
        'Could not save this choice. It applies until you restart the app.',
      WorkspaceContextSelection.refused => switchContextFailedMessage,
    };
    if (message == null) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          action: SnackBarAction(
            label: 'Retry',
            onPressed: () => unawaited(select(choice)),
          ),
        ),
      );
  }

  final suffixes = _organizationSuffixes(auth.organizations);

  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) {
      void choose(WorkspaceContext choice) {
        Navigator.of(sheetContext).pop();
        unawaited(select(choice));
      }

      final maxHeight = MediaQuery.sizeOf(sheetContext).height * 0.6;
      return SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: maxHeight),
          child: Column(
            key: const ValueKey('workspace-context-picker'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (title != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                  child: Text(
                    title,
                    style: Theme.of(sheetContext).textTheme.titleSmall
                        ?.copyWith(
                          fontWeight: AppTypography.emphasisWeight,
                          fontVariations: AppTypography.emphasisVariations,
                        ),
                  ),
                ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    if (includePersonal)
                      _ContextOption(
                        key: const ValueKey('workspace-context-personal'),
                        glyph: CanopyGlyph.user,
                        title: _personalLabel,
                        selected: selected.isPersonal,
                        onTap: () => choose(const WorkspaceContext.personal()),
                      ),
                    for (final org in auth.organizations)
                      _ContextOption(
                        key: ValueKey('workspace-context-org-${org.id}'),
                        glyph: CanopyGlyph.buildings,
                        logoUrl: org.logoUrl,
                        title: org.name,
                        titleSuffix: suffixes[org.id],
                        subtitle: _roleLabel(org.role),
                        selected: selected.organizationId == org.id,
                        onTap: () =>
                            choose(WorkspaceContext.organization(org.id)),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

/// One picker row. The selected row carries a checkmark, not a background.
/// A long title truncates before its [titleSuffix], which stays visible.
class _ContextOption extends StatelessWidget {
  const _ContextOption({
    required this.glyph,
    required this.title,
    required this.selected,
    required this.onTap,
    this.titleSuffix,
    this.subtitle,
    this.logoUrl,
    super.key,
  });

  final CanopyGlyph glyph;
  final String title;
  final String? titleSuffix;
  final String? subtitle;
  final String? logoUrl;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final subtitle = this.subtitle;
    final titleSuffix = this.titleSuffix;
    final name = Text(title, maxLines: 1, overflow: TextOverflow.ellipsis);
    // One node carries the row's name, tap action and selected state, so a
    // screen reader announces which context is selected (CAN-3715).
    return MergeSemantics(
      child: Semantics(
        selected: selected,
        child: ListTile(
          minTileHeight: 48,
          leading: _ContextGlyph(glyph: glyph, logoUrl: logoUrl),
          title: titleSuffix == null
              ? name
              : Semantics(
                  label: '$title $titleSuffix',
                  excludeSemantics: true,
                  child: Row(
                    children: [
                      Flexible(child: name),
                      Text(' $titleSuffix', maxLines: 1),
                    ],
                  ),
                ),
          subtitle: subtitle == null ? null : Text(subtitle),
          trailing: selected
              ? CanopyIcon(
                  glyph: CanopyGlyph.checkmark1,
                  tint: colorScheme.onSurface,
                )
              : null,
          onTap: onTap,
        ),
      ),
    );
  }
}

String _roleLabel(OrganizationRole role) => switch (role) {
  OrganizationRole.owner => 'Owner',
  OrganizationRole.admin => 'Admin',
  OrganizationRole.member => 'Member',
};
