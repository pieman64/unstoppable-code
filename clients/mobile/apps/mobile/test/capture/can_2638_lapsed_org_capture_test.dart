// Visual-evidence capture for CAN-2638: a lapsed org's Activity and Stats
// screens showed a raw `ApiException(403): {"error":...}` dump (Activity) or a
// dead-end Retry (Stats), with no way to fix the billing problem that caused
// them.
//
// What changed: the web API's lapse 403 now carries a machine-readable
// `code: 'org_teams_lapsed'` discriminator, and mobile parses it into a
// cause-aware "on hold" state — a Subscribe / Update-payment-method CTA for
// owners, ask-an-owner copy with no button for admins and members.
// Non-lapse failures render fixed copy plus the server's own 4xx sentence, and
// never the exception object.
//
// Run both stages from `apps/mobile` (the same spec is copied to a clean
// origin/develop worktree for the before stage):
//
//   CAN2638_STAGE=before flutter test test/capture/can_2638_lapsed_org_capture_test.dart --update-goldens
//   CAN2638_STAGE=after  flutter test test/capture/can_2638_lapsed_org_capture_test.dart --update-goldens
//
// Both color modes are captured in a single run: every scenario is pumped once
// in light and once in dark, and the mode is part of the file name.
//
// Captures are deterministic: the in-file fake repositories throw a fixed
// ApiException with zero latency, and the auth view model is seeded from an
// injected loader. No live desktop, agents, or network are involved. Output is
// written to the gitignored `<repo>/.playwright/can-2638/` directory.

import 'dart:convert';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/repositories/stats_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_screen.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/stats/view_models/stats_view_model.dart';
import 'package:mobile/ui/features/stats/views/stats_screen.dart';
import '../support/account_organizations_fixture.dart';

final String? _requestedStage = Platform.environment['CAN2638_STAGE'];
final String _stage = switch (_requestedStage) {
  null => 'after',
  'before' => 'before',
  'after' => 'after',
  final value => throw ArgumentError.value(
    value,
    'CAN2638_STAGE',
    'must be either "before" or "after"',
  ),
};

String _capture(String name, ThemeMode mode) {
  final suffix = mode == ThemeMode.dark ? 'dark' : 'light';
  return '../../../../.playwright/can-2638/$name-$_stage-$suffix.png';
}

Future<void> _loadRealFont() async {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Verdana.ttf',
    '/Library/Fonts/Arial.ttf',
  ];
  for (final path in candidates) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    for (final family in ['Roboto', '.SF UI Text', '.SF UI Display']) {
      final loader = FontLoader(family)..addFont(Future.value(bytes));
      await loader.load();
    }
    return;
  }
}

Future<void> _loadMaterialIcons() async {
  final candidates = <String>[
    if (Platform.environment['FLUTTER_ROOT'] case final root?)
      '$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    for (final launcher in [
      '/opt/homebrew/bin/flutter',
      '/usr/local/bin/flutter',
    ])
      if (File(launcher).existsSync())
        '${File(launcher).resolveSymbolicLinksSync().replaceFirst(RegExp(r'/flutter$'), '')}/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
  ];
  for (final path in candidates) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader('MaterialIcons')..addFont(Future.value(bytes))).load();
    return;
  }
}

/// The exact 403 body `requireOrgTeamsCapability` returns for a lapsed org.
String _lapseBody({String reason = 'trial_ended'}) => jsonEncode({
  'error':
      "Your organization's trial has ended. Subscribe to Team to restore "
      'team features.',
  'code': 'org_teams_lapsed',
  'lapseReason': reason,
  'requiredPlanName': 'Team',
  'trialEndedAt': null,
});

const String _genericBody = '{"error":"Service unavailable"}';

final class _ThrowingFeedRepository implements FeedRepository {
  _ThrowingFeedRepository({required this.status, required this.body});

  final int status;
  final String body;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) async => throw ApiException(statusCode: status, body: body);

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => null;
}

final class _ThrowingStatsRepository implements StatsRepository {
  _ThrowingStatsRepository({required this.status, required this.body});

  final int status;
  final String body;

  @override
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  }) async => throw ApiException(statusCode: status, body: body);
}

Future<AuthViewModel> _seedAuth(OrganizationRole role) async {
  final auth = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
    loadOrganizations: teamsOnly(
      () async => [
        OrganizationSummary(
          id: 'org-lapsed',
          name: 'Acme',
          role: role,
          memberCount: 4,
          subTeamCount: 1,
        ),
      ],
    ),
  );
  await auth.reloadOrganizations();
  return auth;
}

void _usePhoneViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Future<void> _pumpFeed(
  WidgetTester tester, {
  required FeedRepository repository,
  required OrganizationRole role,
  required ThemeMode mode,
}) async {
  _usePhoneViewport(tester);
  final auth = await _seedAuth(role);

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthViewModel>.value(value: auth),
        ChangeNotifierProvider<FeedViewModel>(
          create: (_) => FeedViewModel(repository: repository)..loadFeed(),
        ),
        ChangeNotifierProvider<MembersViewModel>(
          create: (_) => MembersViewModel(
            repository: MockMembersRepository(latency: Duration.zero),
          )..load(),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: mode,
        home: const FeedScreen(),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _pumpStats(
  WidgetTester tester, {
  required StatsRepository repository,
  required OrganizationRole role,
  required ThemeMode mode,
}) async {
  _usePhoneViewport(tester);
  final auth = await _seedAuth(role);

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthViewModel>.value(value: auth),
        ChangeNotifierProvider<StatsViewModel>(
          create: (_) => StatsViewModel(repository: repository)..loadUsage(),
        ),
        ChangeNotifierProvider<MembersViewModel>(
          create: (_) => MembersViewModel(
            repository: MockMembersRepository(latency: Duration.zero),
          )..load(),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: mode,
        home: const StatsScreen(),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _captureSurface(String name, ThemeMode mode) async {
  final surface = find.byType(MaterialApp);
  expect(surface, findsOneWidget);
  if (_requestedStage == null) return;
  // No explicit directory creation: `--update-goldens` creates the parent
  // directories itself, and `matchesGoldenFile` resolves its path against the
  // *test file's* directory while a bare `Directory(...)` resolves against the
  // process CWD — the two only agree when the run starts from `apps/mobile`.
  await expectLater(surface, matchesGoldenFile(_capture(name, mode)));
}

void main() {
  group('CAN-2638 lapsed org captures', () {
    setUpAll(() async {
      TestWidgetsFlutterBinding.ensureInitialized();
      await _loadRealFont();
      await _loadMaterialIcons();
    });

    for (final mode in [ThemeMode.light, ThemeMode.dark]) {
      final label = mode == ThemeMode.dark ? 'dark' : 'light';

      testWidgets('activity, lapsed org, owner ($label)', (tester) async {
        await _pumpFeed(
          tester,
          repository: _ThrowingFeedRepository(status: 403, body: _lapseBody()),
          role: OrganizationRole.owner,
          mode: mode,
        );
        await _captureSurface('activity-lapsed-owner', mode);
      });

      testWidgets('activity, lapsed org, member ($label)', (tester) async {
        await _pumpFeed(
          tester,
          repository: _ThrowingFeedRepository(status: 403, body: _lapseBody()),
          role: OrganizationRole.member,
          mode: mode,
        );
        await _captureSurface('activity-lapsed-member', mode);
      });

      testWidgets('activity, past-due org, owner ($label)', (tester) async {
        await _pumpFeed(
          tester,
          repository: _ThrowingFeedRepository(
            status: 403,
            body: _lapseBody(reason: 'payment_failed'),
          ),
          role: OrganizationRole.owner,
          mode: mode,
        );
        await _captureSurface('activity-past-due-owner', mode);
      });

      testWidgets('activity, generic network failure ($label)', (tester) async {
        await _pumpFeed(
          tester,
          repository: _ThrowingFeedRepository(status: 503, body: _genericBody),
          role: OrganizationRole.owner,
          mode: mode,
        );
        await _captureSurface('activity-generic-failure', mode);
      });

      testWidgets('stats, lapsed org, owner ($label)', (tester) async {
        await _pumpStats(
          tester,
          repository: _ThrowingStatsRepository(status: 403, body: _lapseBody()),
          role: OrganizationRole.owner,
          mode: mode,
        );
        await _captureSurface('stats-lapsed-owner', mode);
      });
    }
  });
}
