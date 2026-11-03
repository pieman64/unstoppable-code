import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/organizations/views/widgets/org_lapse_state_view.dart';
import 'package:mobile/ui/features/stats/view_models/stats_view_model.dart';
import 'package:mobile/ui/features/stats/views/tabs/activity_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/cost_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/overview_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/pipelines_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/team_impact_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/tokens_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/tools_tab.dart';

/// One usage tab: a label plus a builder that renders it from the shared
/// [TeamUsageResponse].
typedef _StatsTab = ({String label, Widget Function(TeamUsageResponse) build});

/// The organization usage-statistics screen: a scrollable 7-tab host over the
/// single [TeamUsageResponse] the app already fetches. The AppBar and the
/// loading/error/empty + pull-to-refresh states wrap every tab so all tabs
/// share one payload.
class StatsScreen extends StatelessWidget {
  const StatsScreen({super.key});

  static final List<_StatsTab> _tabs = [
    (label: 'Overview', build: (usage) => OverviewTab(usage: usage)),
    (label: 'Team Impact', build: (usage) => TeamImpactTab(usage: usage)),
    (label: 'Tokens', build: (usage) => TokensTab(usage: usage)),
    (label: 'Observed cost', build: (usage) => CostTab(usage: usage)),
    (label: 'Pipelines', build: (usage) => PipelinesTab(usage: usage)),
    (label: 'Tools', build: (usage) => ToolsTab(usage: usage)),
    (label: 'Activity', build: (usage) => ActivityTab(usage: usage)),
  ];

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<StatsViewModel>();

    return DefaultTabController(
      length: _tabs.length,
      child: Scaffold(
        appBar: AppBar(
          leading: HomeMenuButton.maybeOf(context),
          title: const Text('Usage'),
          actions: [
            const _ScopeSelector(),
            PopupMenuButton<StatsRange>(
              tooltip: 'Time range',
              initialValue: viewModel.range,
              onSelected: (range) => unawaited(viewModel.setRange(range)),
              itemBuilder: (context) => [
                for (final range in StatsRange.values)
                  PopupMenuItem(value: range, child: Text(range.label)),
              ],
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(viewModel.range.label),
                    const Icon(Icons.expand_more, size: 20),
                  ],
                ),
              ),
            ),
          ],
          bottom: TabBar(
            isScrollable: true,
            // A scrollable TabBar defaults to TabAlignment.startOffset in
            // Material 3, which inserts a ~52px indent before the first tab.
            // Align to the start to drop that indent; "Overview" then begins at
            // the leading edge, leaving only the tab's normal label padding.
            tabAlignment: TabAlignment.start,
            tabs: [for (final tab in _tabs) Tab(text: tab.label)],
          ),
        ),
        body: ListenableBuilder(
          listenable: viewModel,
          builder: (context, _) {
            if (viewModel.isLoading) {
              return const Center(child: CircularProgressIndicator());
            }
            final lapse = viewModel.planLapse;
            if (lapse != null) {
              // Retry cannot clear a billing lapse; offer the remedy instead.
              return OrgLapseStateView(lapse: lapse, glyph: CanopyGlyph.chart4);
            }

            if (viewModel.error != null) {
              return StateMessageView(
                glyph: CanopyGlyph.chart4,
                title: 'Could not load stats',
                message: viewModel.errorMessage,
                onRetry: viewModel.loadUsage,
              );
            }
            final usage = viewModel.usage;
            if (usage == null) {
              return const SizedBox.shrink();
            }
            return RefreshIndicator(
              onRefresh: viewModel.loadUsage,
              // Each tab's vertical ListView sits under TabBarView's horizontal
              // PageView, so its scroll notifications reach this indicator at
              // depth 1. The default predicate (depth 0) would ignore them and
              // pull-to-refresh would never fire; accept depth 1 instead.
              notificationPredicate: (notification) => notification.depth == 1,
              child: TabBarView(
                children: [for (final tab in _tabs) tab.build(usage)],
              ),
            );
          },
        ),
      ),
    );
  }
}

/// Compact AppBar control letting the viewer scope usage to the whole
/// organization or one of its sub-teams.
///
/// The sub-team list is sourced from the already-loaded [OrganizationDetail]
/// (via [MembersViewModel]) rather than a second fetch. It renders nothing when
/// the viewer cannot view usage stats (mirroring the server's
/// `canViewUsageStats` gate) or when the org exposes no sub-teams to switch to,
/// so single-team orgs and restricted viewers see no scope chrome.
class _ScopeSelector extends StatelessWidget {
  const _ScopeSelector();

  @override
  Widget build(BuildContext context) {
    final organization = context.watch<MembersViewModel>().organization;
    if (organization == null || !organization.canViewUsageStats) {
      return const SizedBox.shrink();
    }
    final subTeams = organization.subTeams;
    if (subTeams.isEmpty) return const SizedBox.shrink();

    final statsViewModel = context.watch<StatsViewModel>();
    final scope = statsViewModel.scope;
    final label = scope.teamName ?? 'Organization';

    return PopupMenuButton<StatsScope>(
      tooltip: 'Usage scope: $label',
      initialValue: scope,
      onSelected: (next) => unawaited(statsViewModel.setScope(next)),
      itemBuilder: (context) => [
        const PopupMenuItem(
          value: StatsScope.organization(),
          child: Text('Organization'),
        ),
        for (final team in subTeams)
          PopupMenuItem(
            value: StatsScope.team(teamId: team.id, teamName: team.name),
            child: Text(team.name),
          ),
      ],
      icon: const Icon(Icons.groups_outlined),
    );
  }
}
