import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/member_detail.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/repositories/member_detail_repository.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/features/members/view_models/member_detail_view_model.dart';
import 'package:mobile/ui/features/members/views/widgets/role_badge.dart';
import 'package:mobile/ui/features/organizations/views/widgets/org_lapse_state_view.dart';

/// Read-only member profile drill-down, pushed from the members list.
///
/// Owns its [MemberDetailViewModel] (scoped to this pushed route rather than a
/// global provider) so it loads once on push and disposes on pop. Shows the
/// subject's profile header, their usage rollup (only when the org's
/// `usageStatsMinRole` gate permits it), and their shared plans / approved
/// plans / pipelines.
class MemberDetailScreen extends StatelessWidget {
  const MemberDetailScreen({
    super.key,
    required this.repository,
    required this.member,
    required this.canViewStats,
  });

  final MemberDetailRepository repository;
  final OrganizationMember member;
  final bool canViewStats;

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<MemberDetailViewModel>(
      create: (_) => MemberDetailViewModel(
        repository: repository,
        member: member,
        canViewStats: canViewStats,
      )..load(),
      child: const _MemberDetailView(),
    );
  }
}

class _MemberDetailView extends StatelessWidget {
  const _MemberDetailView();

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<MemberDetailViewModel>();
    final member = viewModel.member;

    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: Text(
          member.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: Builder(
        builder: (context) => RefreshIndicator(
          edgeOffset: CanopyScaffold.contentPaddingOf(context).top,
          onRefresh: viewModel.load,
          child: ListView(
            padding:
                CanopyScaffold.contentPaddingOf(context) +
                const EdgeInsets.all(16),
            // Always scrollable so pull-to-refresh still fires when the content
            // (loading/error/empty states) is shorter than the viewport.
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              _ProfileHeader(member: member),
              const SizedBox(height: 24),
              if (viewModel.isLoading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 48),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (viewModel.planLapse != null)
                // The org lost its team features, so this member's usage rollup
                // is gated. Retry cannot clear that; offer the remedy instead.
                OrgLapseStateView(
                  lapse: viewModel.planLapse!,
                  glyph: CanopyGlyph.user,
                  scrollable: false,
                )
              else if (viewModel.error != null)
                StateMessageView(
                  glyph: CanopyGlyph.user,
                  title: 'Could not load this member.',
                  message: viewModel.errorMessage,
                  onRetry: viewModel.load,
                  scrollable: false,
                )
              else if (viewModel.data != null)
                ..._sections(context, viewModel.data!),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _sections(BuildContext context, MemberDetailData data) {
    final usage = data.usage;
    return [
      if (usage != null) ...[
        _UsageSection(usage: usage),
        const SizedBox(height: 24),
      ],
      _SharedPlansSection(plans: data.sharedPlans),
      const SizedBox(height: 24),
      _ApprovedPlansSection(plans: data.approvedPlans),
      const SizedBox(height: 24),
      _PipelinesSection(pipelines: data.pipelines),
    ];
  }
}

class _ProfileHeader extends StatelessWidget {
  const _ProfileHeader({required this.member});

  final OrganizationMember member;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        CircleAvatar(radius: 28, child: Text(_initials(member.name))),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                member.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.titleLarge?.copyWith(
                  fontWeight: AppTypography.emphasisWeight,
                  fontVariations: AppTypography.emphasisVariations,
                ),
              ),
              Text(
                member.email,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 6),
              RoleBadge(role: member.role),
            ],
          ),
        ),
      ],
    );
  }
}

class _UsageSection extends StatelessWidget {
  const _UsageSection({required this.usage});

  final TeamUsageResponse usage;

  @override
  Widget build(BuildContext context) {
    return _Section(
      title: 'Usage',
      testKey: const Key('member-detail-usage'),
      child: GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 12,
        crossAxisSpacing: 12,
        childAspectRatio: 1.5,
        children: [
          for (final card in usage.headline) _HeadlineCard(card: card),
        ],
      ),
    );
  }
}

class _HeadlineCard extends StatelessWidget {
  const _HeadlineCard({required this.card});

  final TelemetryHeadlineCard card;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final trend = formatTrend(card.value, card.previousValue);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              card.label,
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            Text(
              formatHeadlineValue(card.value, card.unit),
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            Text(
              trend ?? '—',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SharedPlansSection extends StatelessWidget {
  const _SharedPlansSection({required this.plans});

  final List<MemberSharedPlan> plans;

  @override
  Widget build(BuildContext context) {
    return _Section(
      title: 'Plans',
      testKey: const Key('member-detail-plans'),
      child: plans.isEmpty
          ? const _EmptyRow(message: 'No shared plans.')
          : Column(
              children: [
                for (final plan in plans)
                  _DetailRow(
                    icon: Icons.description_outlined,
                    title: plan.title,
                    subtitle: [
                      _scopeLabel(plan.shareScope),
                      if (plan.ownerName != null) plan.ownerName!,
                      if (formatRelativeTime(plan.updatedAt) case final updated
                          when updated.isNotEmpty)
                        'Updated $updated',
                    ].where((s) => s.isNotEmpty).join(' · '),
                  ),
              ],
            ),
    );
  }
}

class _ApprovedPlansSection extends StatelessWidget {
  const _ApprovedPlansSection({required this.plans});

  final List<MemberApprovedPlan> plans;

  @override
  Widget build(BuildContext context) {
    return _Section(
      title: 'Approved plans',
      testKey: const Key('member-detail-approved-plans'),
      child: plans.isEmpty
          ? const _EmptyRow(message: 'No approved plans.')
          : Column(
              children: [
                for (final plan in plans)
                  _DetailRow(
                    icon: Icons.task_alt_outlined,
                    title: plan.title,
                    subtitle: [
                      if (plan.reviewStatus != null)
                        _statusLabel(plan.reviewStatus!),
                      if (formatRelativeTime(plan.implementationStartedAt)
                          case final started when started.isNotEmpty)
                        'Started $started',
                    ].where((s) => s.isNotEmpty).join(' · '),
                  ),
              ],
            ),
    );
  }
}

class _PipelinesSection extends StatelessWidget {
  const _PipelinesSection({required this.pipelines});

  final List<MemberPipeline> pipelines;

  @override
  Widget build(BuildContext context) {
    return _Section(
      title: 'Pipelines',
      testKey: const Key('member-detail-pipelines'),
      child: pipelines.isEmpty
          ? const _EmptyRow(message: 'No shared pipelines.')
          : Column(
              children: [
                for (final pipeline in pipelines)
                  _DetailRow(
                    icon: Icons.account_tree_outlined,
                    title: pipeline.name,
                    subtitle: [
                      _scopeLabel(pipeline.shareScope),
                      if (pipeline.ownerName != null) pipeline.ownerName!,
                      if (pipeline.version.isNotEmpty) 'v${pipeline.version}',
                    ].where((s) => s.isNotEmpty).join(' · '),
                  ),
              ],
            ),
    );
  }
}

/// A titled section wrapper with a consistent header, keyed for tests.
class _Section extends StatelessWidget {
  const _Section({
    required this.title,
    required this.child,
    required this.testKey,
  });

  final String title;
  final Widget child;
  final Key testKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      key: testKey,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        const SizedBox(height: 8),
        child,
      ],
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        backgroundColor: theme.colorScheme.surfaceContainerHighest,
        child: Icon(icon, size: 20, color: theme.colorScheme.onSurfaceVariant),
      ),
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        subtitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _EmptyRow extends StatelessWidget {
  const _EmptyRow({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Text(
        message,
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

/// Presentational label for a wire share scope (plain string, not a union).
String _scopeLabel(String shareScope) => switch (shareScope.toUpperCase()) {
  'ORGANIZATION' => 'Organization',
  'TEAM' => 'Team',
  'USER' => 'Private',
  '' => '',
  _ => shareScope,
};

/// Presentational label for a wire review status (plain string, not a union).
String _statusLabel(String status) {
  if (status.isEmpty) return '';
  final lower = status.toLowerCase().replaceAll('_', ' ');
  return lower[0].toUpperCase() + lower.substring(1);
}

String _initials(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty);
  if (parts.isEmpty) return '?';
  if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
  return (parts.first.substring(0, 1) + parts.last.substring(0, 1))
      .toUpperCase();
}
