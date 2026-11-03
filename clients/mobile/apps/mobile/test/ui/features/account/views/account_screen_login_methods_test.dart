import 'dart:async';
import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/auth_source.dart';
import 'package:mobile/data/models/two_factor.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/profile_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/profile_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/account_screen.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';

import '../../../../support/fake_provider_usage_source.dart';
import '../../../../support/settings_root_providers.dart';

Widget _host({
  AuthSourcesRepository? authSources,
  TwoFactorRepository? twoFactor,
}) => MultiProvider(
  providers: [
    // Account's Usage limits row reads the paired desktop's plan usage.
    ListenableProvider<ProviderUsageSource>(
      create: (_) => FakeProviderUsageSource(),
    ),
    ChangeNotifierProvider<AuthViewModel>(
      create: (_) => AuthViewModel(repository: MockAuthRepository()),
    ),
    ChangeNotifierProvider<ApiKeysViewModel>(
      create: (_) => ApiKeysViewModel(
        repository: MockApiKeysRepository(latency: Duration.zero),
      )..load(),
    ),
    ChangeNotifierProvider<AuthSourcesViewModel>(
      create: (_) => AuthSourcesViewModel(
        repository:
            authSources ?? MockAuthSourcesRepository(latency: Duration.zero),
      )..load(),
    ),
    // Settings also summarizes two-factor status and edits the profile, so
    // their view models must be provided for it to build.
    ChangeNotifierProvider<TwoFactorViewModel>(
      create: (_) => TwoFactorViewModel(
        repository:
            twoFactor ?? MockTwoFactorRepository(latency: Duration.zero),
        issuer: 'Test',
      )..load(),
    ),
    ChangeNotifierProvider<ProfileViewModel>(
      create: (_) => ProfileViewModel(
        repository: MockProfileRepository(latency: Duration.zero),
      ),
    ),
    ...settingsRootTestProviders(),
  ],
  child: MaterialApp(theme: AppTheme.light, home: const AccountScreen()),
);

/// Finds a login-method row carrying [label]. Scoping to the row avoids
/// colliding with any identically named text elsewhere on the screen.
Finder _methodRow(String label) =>
    find.widgetWithText(CanopySettingsRow, label);

/// Opens Login methods from Settings.
Future<void> _openLoginMethods(WidgetTester tester) async {
  await tester.tap(find.text('Login methods'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('lists the seeded login methods', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();
    await _openLoginMethods(tester);

    expect(find.text('Login methods'), findsOneWidget);
    expect(_methodRow('Email and password'), findsOneWidget);
    expect(_methodRow('Google'), findsOneWidget);
    expect(_methodRow('GitHub'), findsOneWidget);
  });

  testWidgets('the non-removable method hides its unlink action', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();
    await _openLoginMethods(tester);

    // Two removable methods (Google, GitHub) each get one unlink button; the
    // credential method does not.
    expect(find.byTooltip('Unlink'), findsNWidgets(2));
  });

  testWidgets('announces each Unlink action as its own button', (tester) async {
    final semantics = tester.ensureSemantics();
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final repository = _PendingUnlinkRepository();
    await tester.pumpWidget(_host(authSources: repository));
    await tester.pumpAndSettle();
    await _openLoginMethods(tester);

    Finder unlinkIn(String label) => find.descendant(
      of: _methodRow(label),
      matching: find.byTooltip('Unlink'),
    );
    final row = tester.getSemantics(find.text('Google'));
    final unlink = tester.getSemantics(unlinkIn('Google'));
    // The method text does not claim the action, and the action is not an
    // image.
    expect(unlink, isNot(same(row)));
    expect(row.getSemanticsData().tooltip, isEmpty);
    expect(row.getSemanticsData().hasAction(SemanticsAction.tap), isFalse);
    final data = unlink.getSemanticsData();
    expect(data.tooltip, 'Unlink');
    expect(data.label, isEmpty);
    expect(data.flagsCollection.isButton, isTrue);
    expect(data.flagsCollection.isImage, isFalse);
    expect(data.hasAction(SemanticsAction.tap), isTrue);

    // The last remaining method offers no action at all.
    expect(unlinkIn('Email and password'), findsNothing);
    final credential = tester
        .getSemantics(find.text('Email and password'))
        .getSemanticsData();
    expect(credential.tooltip, isEmpty);
    expect(credential.hasAction(SemanticsAction.tap), isFalse);

    // Activating the node, as a screen reader does, asks for confirmation.
    unlink.owner!.performAction(unlink.id, SemanticsAction.tap);
    await tester.pumpAndSettle();
    expect(find.text('Unlink login method'), findsOneWidget);
    expect(find.textContaining('Unlink Google?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Unlink'));
    await tester.pump();

    // While the unlink runs, the other method's action is disabled.
    final other = tester.getSemantics(unlinkIn('GitHub')).getSemanticsData();
    expect(other.flagsCollection.isEnabled, Tristate.isFalse);
    expect(other.hasAction(SemanticsAction.tap), isFalse);
    repository.finish();
    await tester.pumpAndSettle();
    semantics.dispose();
  });

  testWidgets('unlinking a method confirms then removes the row', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();
    await _openLoginMethods(tester);

    expect(_methodRow('Google'), findsOneWidget);

    // Tap the unlink action inside the Google row.
    await tester.tap(
      find.descendant(
        of: _methodRow('Google'),
        matching: find.byTooltip('Unlink'),
      ),
    );
    await tester.pumpAndSettle();

    // Confirm the destructive dialog.
    await tester.tap(find.widgetWithText(FilledButton, 'Unlink'));
    await tester.pumpAndSettle();

    expect(_methodRow('Google'), findsNothing);
    // GitHub and the credential method remain.
    expect(_methodRow('GitHub'), findsOneWidget);
    expect(_methodRow('Email and password'), findsOneWidget);
  });

  testWidgets(
    'a failed unlink surfaces an error and keeps the method visible',
    (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(_host(authSources: _UnlinkFailsRepository()));
      await tester.pumpAndSettle();
      await _openLoginMethods(tester);

      expect(_methodRow('Google'), findsOneWidget);

      await tester.tap(
        find.descendant(
          of: _methodRow('Google'),
          matching: find.byTooltip('Unlink'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Unlink'));
      await tester.pumpAndSettle();

      expect(find.text('Could not unlink the login method.'), findsOneWidget);
      expect(_methodRow('Google'), findsOneWidget);
    },
  );

  testWidgets('unlinking the credential method refreshes two-factor state', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final twoFactor = _CountingTwoFactorRepository();
    await tester.pumpWidget(
      _host(
        authSources: _CredentialRemovableRepository(),
        twoFactor: twoFactor,
      ),
    );
    await tester.pumpAndSettle();
    await _openLoginMethods(tester);

    // The initial section load fetched two-factor status exactly once.
    expect(twoFactor.statusFetches, 1);

    // Unlink the credential (email/password) method.
    await tester.tap(
      find.descendant(
        of: _methodRow('Email and password'),
        matching: find.byTooltip('Unlink'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Unlink'));
    await tester.pumpAndSettle();

    // Removing the password source must refresh two-factor status so its
    // hasCredentialAuthSource stops reflecting the now-removed credential.
    expect(twoFactor.statusFetches, 2);
  });
}

/// Serves a non-removable credential plus Google and GitHub, and holds
/// [unlink] until [finish], so a test can inspect the screen meanwhile.
final class _PendingUnlinkRepository implements AuthSourcesRepository {
  final Completer<void> _unlink = Completer<void>();

  void finish() => _unlink.complete();

  @override
  Future<AuthSourcesResponse> list() async => const AuthSourcesResponse(
    user: AuthSourcesUser(
      name: 'Ada',
      email: 'ada@example.com',
      twoFactorEnabled: false,
    ),
    sources: [
      AuthSource(
        providerId: 'credential',
        accountId: 'acct-credential',
        label: 'Email and password',
        linkedAt: '2026-06-01T09:00:00.000Z',
        canUnlink: false,
      ),
      AuthSource(
        providerId: 'google',
        accountId: 'acct-google',
        label: 'Google',
        linkedAt: '2026-06-10T12:00:00.000Z',
        canUnlink: true,
      ),
      AuthSource(
        providerId: 'github',
        accountId: 'acct-github',
        label: 'GitHub',
        linkedAt: '2026-06-12T12:00:00.000Z',
        canUnlink: true,
      ),
    ],
  );

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) => _unlink.future;
}

/// Serves two sources on [list] but always throws on [unlink], simulating a
/// failed DELETE while the source remains linked.
final class _UnlinkFailsRepository implements AuthSourcesRepository {
  @override
  Future<AuthSourcesResponse> list() async => const AuthSourcesResponse(
    user: AuthSourcesUser(
      name: 'Ada',
      email: 'ada@example.com',
      twoFactorEnabled: false,
    ),
    sources: [
      AuthSource(
        providerId: 'credential',
        accountId: 'acct-credential',
        label: 'Email and password',
        linkedAt: '2026-06-01T09:00:00.000Z',
        canUnlink: false,
      ),
      AuthSource(
        providerId: 'google',
        accountId: 'acct-google',
        label: 'Google',
        linkedAt: '2026-06-10T12:00:00.000Z',
        canUnlink: true,
      ),
    ],
  );

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) async {
    throw StateError('unlink request failed');
  }
}

/// Serves a removable credential + Google source and removes on [unlink]. Used
/// to drive the credential-unlink path that must refresh two-factor state.
final class _CredentialRemovableRepository implements AuthSourcesRepository {
  final List<AuthSource> _sources = [
    const AuthSource(
      providerId: 'credential',
      accountId: 'acct-credential',
      label: 'Email and password',
      linkedAt: '2026-06-01T09:00:00.000Z',
      canUnlink: true,
    ),
    const AuthSource(
      providerId: 'google',
      accountId: 'acct-google',
      label: 'Google',
      linkedAt: '2026-06-10T12:00:00.000Z',
      canUnlink: true,
    ),
  ];

  @override
  Future<AuthSourcesResponse> list() async => AuthSourcesResponse(
    user: const AuthSourcesUser(
      name: 'Ada',
      email: 'ada@example.com',
      twoFactorEnabled: false,
    ),
    sources: List.unmodifiable(_sources),
  );

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) async {
    _sources.removeWhere((source) => source.accountId == accountId);
  }
}

/// Counts two-factor status fetches so a test can assert the account screen
/// refreshes 2FA state after a credential unlink.
final class _CountingTwoFactorRepository implements TwoFactorRepository {
  int statusFetches = 0;

  @override
  Future<TwoFactorStatus> fetchStatus() async {
    statusFetches += 1;
    return const TwoFactorStatus(enabled: false, hasCredentialAuthSource: true);
  }

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) => throw UnimplementedError();

  @override
  Future<void> verifyEnrollment({required String code}) =>
      throw UnimplementedError();

  @override
  Future<void> disable({String? password}) => throw UnimplementedError();
}
