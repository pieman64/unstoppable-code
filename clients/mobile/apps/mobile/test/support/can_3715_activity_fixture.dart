import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/main.dart'
    show
        buildOrganizationShellProviders,
        buildPersonalShellProviders,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import 'cloud_chat_providers.dart';
import 'fake_remote_control_repository.dart';
import 'settings_root_providers.dart';

/// Synthetic CAN-3715 account: one team with August activity and a Personal
/// organization with recent work. No network, login, desktop or push service.
const can3715TeamId = '11111111-1111-4111-8111-111111111111';
const can3715PersonalId = '33333333-3333-4333-8333-333333333333';

OrganizationSummary can3715Team() => OrganizationSummary(
  id: can3715TeamId,
  name: 'Acme Robotics',
  role: OrganizationRole.member,
  memberCount: 3,
  subTeamCount: 0,
);

/// Serves thirty rows and a second page of five, plus sharing evidence.
/// [personal] rows are recent; team rows are 47-50 days old. Rows are in the
/// server's order: occurredAt newest first, then ID descending (the server
/// breaks ties by an internal source ID that mobile cannot see). A cursor
/// holds its last row's time and ID, as the server's value cursor does, so a
/// later change to that row never moves the cursor.
final class Can3715FeedRepository implements FeedRepository {
  Can3715FeedRepository({required this.personal, this.sharing});

  final bool personal;
  final FeedSharingStatus? sharing;

  /// The row each requested cursor names (null for a first page).
  final cursors = <String?>[];
  final _now = DateTime.now();

  /// Delays every page, so transitions can be observed and recorded.
  Duration latency = Duration.zero;

  /// Holds every page until it completes, so a response lands at a chosen
  /// moment.
  Completer<void>? gate;

  /// Rows that landed since the first load, newest first above the others.
  int newer = 0;

  /// Rows updated since the first load, latest last. The feed is ordered by
  /// occurredAt, so an update moves a row to the top under the same ID.
  final updated = <String>[];

  /// Rows removed since the first load.
  final removed = <String>{};

  /// Rows that synced late (`<scope>-late-N`). Their event times sort just
  /// below the current time of the [lateBelow] row.
  String? lateBelow;
  int late = 0;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) async {
    cursors.add(cursor?.split('|').last);
    await Future<void>.delayed(latency);
    await gate?.future;
    final scope = personal ? 'personal' : 'team';
    final rows = <String, (DateTime, String)>{
      for (var i = 0; i < 35; i++)
        '$scope-$i': (
          _now.subtract(
            personal
                ? Duration(minutes: 5 + i * 7)
                : Duration(days: 47 + i ~/ 10, hours: i),
          ),
          personal ? 'personal/work-$i' : 'feature/org-work-$i',
        ),
      for (var i = 0; i < newer; i++)
        '$scope-new-$i': (
          _now.subtract(const Duration(minutes: 4)).add(Duration(seconds: i)),
          personal ? 'personal/new-$i' : 'feature/org-new-$i',
        ),
    };
    for (final (k, id) in updated.indexed) {
      rows[id] = (
        _now.subtract(const Duration(minutes: 3)).add(Duration(seconds: k)),
        rows[id]!.$2,
      );
    }
    if (rows[lateBelow]?.$1 case final below?) {
      for (var i = 0; i < late; i++) {
        rows['$scope-late-$i'] = (
          below.subtract(Duration(milliseconds: 10 * (i + 1))),
          personal ? 'personal/late-$i' : 'feature/org-late-$i',
        );
      }
    }
    removed.forEach(rows.remove);
    final ids = rows.keys.toList()
      ..sort((a, b) {
        final byTime = rows[b]!.$1.compareTo(rows[a]!.$1);
        return byTime != 0 ? byTime : b.compareTo(a);
      });
    var start = 0;
    if (cursor != null) {
      final [time, after] = cursor.split('|');
      final at = DateTime.fromMicrosecondsSinceEpoch(int.parse(time));
      start = ids.indexWhere((id) {
        final byTime = rows[id]!.$1.compareTo(at);
        return byTime < 0 || (byTime == 0 && id.compareTo(after) < 0);
      });
      if (start < 0) start = ids.length;
    }
    final end = (start + (cursor == null ? 30 : 5)).clamp(0, ids.length);
    return FeedPageResponse(
      items: [
        for (final id in ids.sublist(start, end))
          WorktreeUpdatedFeedItem(
            actor: FeedActor(displayName: 'Brady Example', userId: 'user-1'),
            id: id,
            occurredAt: rows[id]!.$1.toIso8601String(),
            branchName: rows[id]!.$2,
          ),
      ],
      nextCursor: end < ids.length
          ? '${rows[ids[end - 1]]!.$1.microsecondsSinceEpoch}|${ids[end - 1]}'
          : null,
    );
  }

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async =>
      personal ? null : sharing;
}

/// Signs in an account with the synthetic team and Personal organization and
/// selects the team, as a user who chose it would have.
Future<AuthViewModel> can3715Auth() async {
  final repository = MockAuthRepository(latency: Duration.zero);
  await repository.signIn(email: 'brady@example.com', password: 'password');
  final auth = AuthViewModel(
    repository: repository,
    loadOrganizations: () async => AccountOrganizations(
      organizations: [can3715Team()],
      personalOrganizationId: can3715PersonalId,
    ),
  );
  await auth.restore();
  auth.switchOrg(can3715TeamId);
  return auth;
}

/// The authenticated shell for [auth]'s selected context, composed from the
/// production provider builders the way `AuthGate` composes it, with the
/// Activity feed and Remote Control replaced by synthetic repositories.
class Can3715Shell extends StatelessWidget {
  const Can3715Shell({
    super.key,
    required this.auth,
    required this.teamFeed,
    required this.personalFeed,
    required this.remote,
    this.themeMode = ThemeMode.light,
    this.initialTab = HomeTab.activity,
    this.cloudAvailable,
  });

  final AuthViewModel auth;
  final Can3715FeedRepository teamFeed;
  final Can3715FeedRepository personalFeed;
  final FakeRemoteControlRepository remote;
  final ThemeMode themeMode;
  final HomeTab initialTab;

  /// The cloud probe's answer, which hides Cloud and Chat when false.
  final bool? cloudAvailable;

  @override
  Widget build(BuildContext context) => MultiProvider(
    providers: [
      ChangeNotifierProvider<AuthViewModel>.value(value: auth),
      ...settingsRootTestProviders(),
      ...cloudChatTestProviders(),
      ...buildSharedShellProviders(),
      ChangeNotifierProvider<RemoteControlViewModel>(
        create: (_) => RemoteControlViewModel(repository: remote),
      ),
    ],
    child: MaterialApp(
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: themeMode,
      home: ListenableBuilder(
        listenable: auth,
        builder: (context, _) {
          final personal = auth.isPersonalActive;
          final mode = personal
              ? AuthenticatedShellMode.personal
              : AuthenticatedShellMode.organization;
          final orgId = auth.activeOrgId;
          return HomeTabControllerProvider(
            tabs: visibleHomeTabs(
              homeTabsForShellMode(
                mode,
                hasTeams: auth.organizations.isNotEmpty,
              ),
              cloudAvailable: cloudAvailable,
            ),
            initialTab: initialTab,
            child: KeyedSubtree(
              key: ValueKey('$mode:$orgId'),
              child: MultiProvider(
                providers: [
                  ...personal
                      ? buildPersonalShellProviders(auth.personalOrganizationId)
                      : buildOrganizationShellProviders(orgId),
                  ChangeNotifierProvider<FeedViewModel>(
                    create: (_) => FeedViewModel(
                      repository: personal ? personalFeed : teamFeed,
                    )..loadFeed(),
                  ),
                ],
                child: HomeShell(
                  refreshActivity: refreshActivityFeed,
                  activityAccount: watchActivityAccount,

                  membersTab: membersTabForShellMode(
                    mode,
                    hasTeams: auth.organizations.isNotEmpty,
                  ),
                ),
              ),
            ),
          );
        },
      ),
    ),
  );
}
