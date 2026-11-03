import 'dart:async';
import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/core/design-system/icon/canopy_icon_gallery.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/models/two_factor.dart';
import 'package:mobile/data/protocol/generated/api_keys.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/data/repositories/profile_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/data/services/two_factor_api_service.dart';
import 'package:mobile/main.dart' show buildProviderUsageSourceProvider;
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/profile_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/account_profile_header.dart';
import 'package:mobile/ui/features/account/views/account_screen.dart';
import 'package:mobile/ui/features/account/views/two_factor_settings_screen.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/ui/features/account/views/usage_limits_screen.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';

import '../../../../support/fake_provider_usage_source.dart';
import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/provider_usage_fixture.dart';
import '../../../../support/remote_session_fake_server.dart';

Widget _host({
  ApiKeysRepository? apiKeys,
  AuthRepository? auth,
  AuthViewModel? authViewModel,
  TwoFactorRepository? twoFactor,
  bool? showDeveloperOptions,
  RemoteControlViewModel? remote,
  List<HomeTab>? shellTabs,
  ThemeData? theme,
}) => MultiProvider(
  providers: [
    // Account's Usage limits row reads the paired desktop's plan usage; a
    // given [remote] backs it through the production composition.
    if (remote == null)
      ListenableProvider<ProviderUsageSource>(
        create: (_) => FakeProviderUsageSource(),
      )
    else ...[
      ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
      buildProviderUsageSourceProvider(),
    ],
    Provider<FeedbackReportRepository>.value(
      value: MockFeedbackReportRepository(latency: Duration.zero),
    ),
    if (authViewModel == null)
      ChangeNotifierProvider<AuthViewModel>(
        create: (_) => AuthViewModel(repository: auth ?? MockAuthRepository()),
      )
    else
      ChangeNotifierProvider<AuthViewModel>.value(value: authViewModel),
    ChangeNotifierProvider<ApiKeysViewModel>(
      create: (_) => ApiKeysViewModel(
        repository: apiKeys ?? MockApiKeysRepository(latency: Duration.zero),
      )..load(),
    ),
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
    ChangeNotifierProvider<ThemeController>(
      create: (_) => ThemeController(store: InMemoryThemePreferenceStore()),
    ),
    // Settings' App section reads the root theme and notifications state.
    ChangeNotifierProvider<NotificationsViewModel>(
      create: (_) => NotificationsViewModel(
        repository: MockNotificationPreferencesRepository(
          latency: Duration.zero,
        ),
        isConfigured: () => true,
      ),
    ),
    ChangeNotifierProvider<AuthSourcesViewModel>(
      create: (_) => AuthSourcesViewModel(
        repository: MockAuthSourcesRepository(latency: Duration.zero),
      )..load(),
    ),
  ],
  child: MaterialApp(
    theme: theme ?? AppTheme.light,
    home: _withShellTabs(
      shellTabs,
      showDeveloperOptions == null
          ? const AccountScreen()
          : AccountScreen(showDeveloperOptions: showDeveloperOptions),
    ),
  ),
);

/// Opens the drill-down behind the Settings row titled [title].
Future<void> _openRow(WidgetTester tester, String title) async {
  await tester.tap(find.text(title));
  await tester.pumpAndSettle();
}

Widget _withShellTabs(List<HomeTab>? tabs, Widget child) => tabs == null
    ? child
    : HomeTabControllerProvider(
        tabs: tabs,
        initialTab: HomeTab.account,
        child: child,
      );

void main() {
  group('Usage limits', _usageLimitsTests);
  group('merged Settings page (CAN-4449)', _mergedSettingsTests);

  testWidgets('editing the display name updates the header', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    // A signed-in user is needed for the profile header to render; sign in via
    // runAsync so the mock repo's Future.delayed resolves outside FakeAsync.
    final auth = AuthViewModel(
      repository: MockAuthRepository(latency: Duration.zero),
    );
    await tester.runAsync(() => auth.signInWithSocial(SocialProvider.google));

    await tester.pumpWidget(_host(authViewModel: auth));
    await tester.pumpAndSettle();

    expect(find.byTooltip('Edit name'), findsOneWidget);
    await tester.tap(find.byTooltip('Edit name'));
    await tester.pumpAndSettle();

    expect(find.text('Edit name'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'Ada Lovelace');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    // The header reflects the new name (from the server response).
    expect(find.text('Ada Lovelace'), findsOneWidget);
  });

  testWidgets('announces Edit name as a button apart from the name and email', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    final auth = AuthViewModel(
      repository: MockAuthRepository(latency: Duration.zero),
    );
    await tester.runAsync(() => auth.signInWithSocial(SocialProvider.google));
    await tester.pumpWidget(_host(authViewModel: auth));
    await tester.pumpAndSettle();

    final edit = tester
        .getSemantics(find.byTooltip('Edit name'))
        .getSemanticsData();
    expect(edit.tooltip, 'Edit name');
    expect(edit.label, isEmpty);
    expect(edit.flagsCollection.isButton, isTrue);
    // The avatar and pencil badge are decoration, not an image.
    expect(edit.flagsCollection.isImage, isFalse);
    expect(edit.hasAction(SemanticsAction.tap), isTrue);

    final user = auth.user!;
    for (final text in [user.name, user.email]) {
      final node = tester
          .getSemantics(
            find.descendant(
              of: find.byType(AccountProfileHeader),
              matching: find.text(text),
            ),
          )
          .getSemanticsData();
      expect(node.label, contains(text));
      expect(node.tooltip, isEmpty);
      expect(node.flagsCollection.isButton, isFalse);
    }
    semantics.dispose();
  });

  testWidgets('renders the Send feedback entry point', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('send-feedback-tile')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('lists API keys from the repository', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();
    await _openRow(tester, 'API keys');

    expect(find.text('API keys'), findsOneWidget); // the screen title
    expect(find.text('CI token'), findsOneWidget); // seeded key
  });

  testWidgets('labels service-account API keys', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host(apiKeys: _ServiceAccountKeysRepository()));
    await tester.pumpAndSettle();
    await _openRow(tester, 'API keys');

    expect(find.text('Automation token'), findsOneWidget);
    // The source label is composed into the row's subtitle
    // ('Service account · Created … · …'), so match the substring rather than a
    // standalone Text widget.
    expect(find.textContaining('Service account'), findsOneWidget);
  });

  testWidgets('creating a key reveals the one-time token and adds a row', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();
    await _openRow(tester, 'API keys');

    await tester.tap(find.text('New key'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Prod token');
    await tester.tap(find.text('Create'));
    await tester.pumpAndSettle();

    // One-time token dialog.
    expect(find.text('API key created'), findsOneWidget);
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();

    // The new key now appears in the list.
    expect(find.text('Prod token'), findsOneWidget);
  });

  testWidgets('creating a key still reveals the one-time token when the '
      'follow-up refresh fails', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host(apiKeys: _CreateOkListFailsRepository()));
    await tester.pumpAndSettle();
    await _openRow(tester, 'API keys');

    await tester.tap(find.text('New key'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Prod token');
    await tester.tap(find.text('Create'));
    await tester.pumpAndSettle();

    // The unrecoverable token is still surfaced, and no failure snackbar hides
    // it, even though the post-create list refresh threw.
    expect(find.text('API key created'), findsOneWidget);
    expect(find.text('Could not create the API key.'), findsNothing);
  });

  testWidgets('a failed revoke surfaces an error and keeps the key visible', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host(apiKeys: _RevokeFailsRepository()));
    await tester.pumpAndSettle();
    await _openRow(tester, 'API keys');

    expect(find.text('CI token'), findsOneWidget);

    await tester.tap(find.byTooltip('Revoke'));
    await tester.pumpAndSettle();

    // Confirm the destructive dialog.
    await tester.tap(find.widgetWithText(FilledButton, 'Revoke'));
    await tester.pumpAndSettle();

    // The failure must be surfaced, and the still-active key must remain.
    expect(find.text('Could not revoke the API key.'), findsOneWidget);
    expect(find.text('CI token'), findsOneWidget);
  });

  testWidgets('announces each Revoke action as its own button', (tester) async {
    final semantics = tester.ensureSemantics();
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final repository = _PendingRevokeRepository();
    await tester.pumpWidget(_host(apiKeys: repository));
    await tester.pumpAndSettle();
    await _openRow(tester, 'API keys');

    Finder revokeIn(String name) => find.descendant(
      of: find.widgetWithText(CanopySettingsRow, name),
      matching: find.byTooltip('Revoke'),
    );
    final row = tester.getSemantics(find.text('CI token'));
    final revoke = tester.getSemantics(revokeIn('CI token'));
    // The key text does not claim the action, and the action is not an image.
    expect(revoke, isNot(same(row)));
    expect(row.getSemanticsData().tooltip, isEmpty);
    expect(row.getSemanticsData().hasAction(SemanticsAction.tap), isFalse);
    final data = revoke.getSemanticsData();
    expect(data.tooltip, 'Revoke');
    expect(data.label, isEmpty);
    expect(data.flagsCollection.isButton, isTrue);
    expect(data.flagsCollection.isImage, isFalse);
    expect(data.hasAction(SemanticsAction.tap), isTrue);

    // Activating the node, as a screen reader does, asks for confirmation.
    revoke.owner!.performAction(revoke.id, SemanticsAction.tap);
    await tester.pumpAndSettle();
    expect(find.text('Revoke API key'), findsOneWidget);
    expect(find.textContaining('"CI token"'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Revoke'));
    await tester.pump();

    // While the revoke runs, the other key's action is disabled.
    final other = tester
        .getSemantics(revokeIn('Desktop sign-in'))
        .getSemanticsData();
    expect(other.flagsCollection.isEnabled, Tristate.isFalse);
    expect(other.hasAction(SemanticsAction.tap), isFalse);
    repository.finish();
    await tester.pumpAndSettle();
    semantics.dispose();
  });

  testWidgets('shows the disabled 2FA status with an Enable action', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();
    await _openRow(tester, 'Two-factor authentication');

    expect(find.text('Two-factor authentication'), findsOneWidget);
    expect(find.text('Disabled'), findsOneWidget);
    expect(find.text('Enable'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('developer options opens the Canopy icon gallery', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.text('Developer options'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Developer options'));
    await tester.pumpAndSettle();

    expect(find.text('Developer options'), findsOneWidget);
    expect(find.text('Design system'), findsOneWidget);

    await tester.tap(find.text('Design system'));
    await tester.pumpAndSettle();
    expect(find.text('Design system'), findsOneWidget);
    expect(find.text('Icons'), findsOneWidget);

    await tester.tap(find.text('Icons'));
    await tester.pumpAndSettle();
    expect(find.text('Icons'), findsOneWidget);
    expect(find.byType(CanopyIconGallery), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('production builds hide developer options', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host(showDeveloperOptions: false));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('developer-options-button')),
      findsNothing,
    );
  });

  testWidgets('the Sign out row signs the user out', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final auth = AuthViewModel(
      repository: MockAuthRepository(latency: Duration.zero),
    );
    await tester.pumpWidget(_host(authViewModel: auth));
    await tester.pumpAndSettle();

    // Sign out is the last row, past `ensureVisible`'s reach — its own doc
    // comment says it "does not work when [the target is] far away enough
    // from the displayed part of [the Scrollable] that [it] has not yet
    // cached [the target's] element", and to use `scrollUntilVisible`.
    final signOut = find.text('Sign out');
    await tester.scrollUntilVisible(signOut, 200);
    await tester.ensureVisible(signOut);
    await tester.pumpAndSettle();
    await tester.tap(signOut);
    await tester.pumpAndSettle();

    expect(auth.status, AuthStatus.unauthenticated);
  });

  testWidgets('shows the enabled 2FA status with a Disable action', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      _host(
        twoFactor: MockTwoFactorRepository(
          latency: Duration.zero,
          initiallyEnabled: true,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await _openRow(tester, 'Two-factor authentication');

    expect(find.text('Enabled'), findsOneWidget);
    expect(find.text('Disable'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('enabling 2FA reveals the setup key, verifies, and shows backup '
      'codes', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final auth = _TrackingAuthRepository();
    await tester.pumpWidget(_host(auth: auth));
    await tester.pumpAndSettle();
    await _openRow(tester, 'Two-factor authentication');

    await tester.tap(find.text('Enable'));
    await tester.pumpAndSettle();

    // Enroll dialog surfaces the setup key + URL as selectable text.
    expect(find.text('Set up authenticator'), findsOneWidget);
    expect(find.textContaining('JBSWY3DPEHPK3PXP'), findsWidgets);
    expect(find.textContaining('issuer=Test'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '123456');
    await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
    await tester.pumpAndSettle();

    // Backup codes stay visible until the user explicitly acknowledges them.
    expect(find.text('Save your backup codes'), findsOneWidget);
    await tester.tapAt(const Offset(20, 20));
    await tester.pumpAndSettle();
    expect(find.text('Save your backup codes'), findsOneWidget);
    expect(find.text('Sign in again'), findsNothing);
    expect(auth.signOutCount, 0);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Save your backup codes'), findsOneWidget);
    expect(find.text('Sign in again'), findsNothing);
    expect(auth.signOutCount, 0);

    await tester.tap(find.widgetWithText(FilledButton, 'Done'));
    await tester.pumpAndSettle();

    expect(find.text('Sign in again'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'OK'));
    await tester.pumpAndSettle();

    expect(auth.signOutCount, 1);
    // Sign-out returns to the first route before the auth gate swaps it.
    expect(find.byType(TwoFactorSettingsScreen), findsNothing);
    expect(
      find.descendant(
        of: find.ancestor(
          of: find.text('Two-factor authentication'),
          matching: find.byType(CanopySettingsRow),
        ),
        matching: find.text('On'),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('credential-linked enable prompts for password and sends it', (
    tester,
  ) async {
    final repository = _PasswordCapturingTwoFactorRepository();
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host(twoFactor: repository));
    await tester.pumpAndSettle();
    await _openRow(tester, 'Two-factor authentication');

    await tester.tap(find.text('Enable'));
    await tester.pumpAndSettle();

    expect(find.text('Confirm account password'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'pw-enable');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pumpAndSettle();

    expect(repository.beginPassword, 'pw-enable');
    expect(find.text('Set up authenticator'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a wrong enrollment code keeps the dialog open with an error', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();
    await _openRow(tester, 'Two-factor authentication');

    await tester.tap(find.text('Enable'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), '000000');
    await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
    await tester.pumpAndSettle();

    // Dialog stays open; the invalid-code message appears; 2FA is not enabled.
    expect(find.text('Set up authenticator'), findsOneWidget);
    expect(
      find.text('That code was not valid. Please try again.'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a disable blocked by the re-auth wall surfaces guidance', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host(twoFactor: _DisableNeedsReauthRepository()));
    await tester.pumpAndSettle();
    await _openRow(tester, 'Two-factor authentication');

    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();

    // Confirm the destructive dialog.
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pumpAndSettle();

    expect(
      find.text(
        'Please sign out and sign in again to manage two-factor '
        'authentication.',
      ),
      findsOneWidget,
    );
    // Still enabled — the disable was rejected.
    expect(find.text('Enabled'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a successful disable signs out after reauth guidance', (
    tester,
  ) async {
    final auth = _TrackingAuthRepository();
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      _host(
        auth: auth,
        twoFactor: MockTwoFactorRepository(
          latency: Duration.zero,
          initiallyEnabled: true,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await _openRow(tester, 'Two-factor authentication');

    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pumpAndSettle();

    expect(find.text('Sign in again'), findsOneWidget);
    expect(
      find.text(
        'Two-factor authentication is disabled. Please sign in again to '
        'continue with refreshed credentials.',
      ),
      findsOneWidget,
    );

    await tester.tap(find.widgetWithText(FilledButton, 'OK'));
    await tester.pumpAndSettle();

    expect(auth.signOutCount, 1);
    expect(find.byType(TwoFactorSettingsScreen), findsNothing);
    expect(
      find.descendant(
        of: find.ancestor(
          of: find.text('Two-factor authentication'),
          matching: find.byType(CanopySettingsRow),
        ),
        matching: find.text('Off'),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('credential-linked disable prompts for password and sends it', (
    tester,
  ) async {
    final auth = _TrackingAuthRepository();
    final repository = _PasswordCapturingTwoFactorRepository(
      initiallyEnabled: true,
    );
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host(auth: auth, twoFactor: repository));
    await tester.pumpAndSettle();
    await _openRow(tester, 'Two-factor authentication');

    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pumpAndSettle();

    expect(find.text('Confirm account password'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'pw-disable');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pumpAndSettle();

    expect(repository.disablePassword, 'pw-disable');
    expect(find.text('Sign in again'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

/// Tracks sign-out after 2FA enrollment without needing a full auth flow.
final class _TrackingAuthRepository implements AuthRepository {
  int signOutCount = 0;

  @override
  Future<AuthSession?> restoreSession() => throw UnimplementedError();

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) => throw UnimplementedError();

  @override
  Future<void> signOut() async {
    signOutCount += 1;
  }

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) =>
      throw UnimplementedError();

  @override
  Future<SocialSignInResult?> signInWithApple() => throw UnimplementedError();

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) => throw UnimplementedError();
}

/// Succeeds on [create] but always throws on [list], simulating a network blip
/// on the post-create refresh.
final class _CreateOkListFailsRepository implements ApiKeysRepository {
  @override
  Future<List<UserApiKeyListItem>> list() async {
    throw StateError('list request failed');
  }

  @override
  Future<UserApiKeyCreateResponse> create(String name) async {
    final item = UserApiKeyListItem(
      id: 'key-created',
      name: name,
      source: UserApiKeySource.manual,
      createdIp: '127.0.0.1',
      createdAt: '2026-07-03T00:00:00.000Z',
      lastUsedAt: null,
    );
    return UserApiKeyCreateResponse(token: 'sk-secret-once', userApiKey: item);
  }

  @override
  Future<void> revoke(String id) => throw UnimplementedError();
}

/// Serves two keys and holds [revoke] until [finish], so a test can inspect
/// the screen while the mutation runs.
final class _PendingRevokeRepository implements ApiKeysRepository {
  final Completer<void> _revoke = Completer<void>();

  void finish() => _revoke.complete();

  @override
  Future<List<UserApiKeyListItem>> list() async => const [
    UserApiKeyListItem(
      id: 'key-ci',
      name: 'CI token',
      source: UserApiKeySource.manual,
      createdIp: '127.0.0.1',
      createdAt: '2026-07-03T00:00:00.000Z',
      lastUsedAt: null,
    ),
    UserApiKeyListItem(
      id: 'key-desktop',
      name: 'Desktop sign-in',
      source: UserApiKeySource.oauthDesktop,
      createdIp: null,
      createdAt: '2026-07-03T00:00:00.000Z',
      lastUsedAt: null,
    ),
  ];

  @override
  Future<UserApiKeyCreateResponse> create(String name) =>
      throw UnimplementedError();

  @override
  Future<void> revoke(String id) => _revoke.future;
}

/// Serves one key on [list] but always throws on [revoke], simulating a failed
/// DELETE while the key remains active.
final class _RevokeFailsRepository implements ApiKeysRepository {
  @override
  Future<List<UserApiKeyListItem>> list() async => const [
    UserApiKeyListItem(
      id: 'key-keep',
      name: 'CI token',
      source: UserApiKeySource.manual,
      createdIp: '127.0.0.1',
      createdAt: '2026-07-03T00:00:00.000Z',
      lastUsedAt: null,
    ),
  ];

  @override
  Future<UserApiKeyCreateResponse> create(String name) =>
      throw UnimplementedError();

  @override
  Future<void> revoke(String id) async {
    throw StateError('revoke request failed');
  }
}

final class _ServiceAccountKeysRepository implements ApiKeysRepository {
  @override
  Future<List<UserApiKeyListItem>> list() async => const [
    UserApiKeyListItem(
      id: 'service-account-key',
      name: 'Automation token',
      source: UserApiKeySource.serviceAccount,
      createdIp: '127.0.0.1',
      createdAt: '2026-07-23T00:00:00.000Z',
      lastUsedAt: null,
    ),
  ];

  @override
  Future<UserApiKeyCreateResponse> create(String name) =>
      throw UnimplementedError();

  @override
  Future<void> revoke(String id) => throw UnimplementedError();
}

/// Reports enabled, then rejects disable with the bearer re-auth wall (403), so
/// the section renders the "sign in again" guidance and stays enabled.
final class _DisableNeedsReauthRepository implements TwoFactorRepository {
  @override
  Future<TwoFactorStatus> fetchStatus() async =>
      const TwoFactorStatus(enabled: true);

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) => throw UnimplementedError();

  @override
  Future<void> verifyEnrollment({required String code}) =>
      throw UnimplementedError();

  @override
  Future<void> disable({String? password}) async {
    throw const TwoFactorException(TwoFactorFailure.needsReauth);
  }
}

final class _PasswordCapturingTwoFactorRepository
    implements TwoFactorRepository {
  _PasswordCapturingTwoFactorRepository({bool initiallyEnabled = false})
    : _enabled = initiallyEnabled;

  bool _enabled;
  String? beginPassword;
  String? disablePassword;

  @override
  Future<TwoFactorStatus> fetchStatus() async =>
      TwoFactorStatus(enabled: _enabled, hasCredentialAuthSource: true);

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) async {
    beginPassword = password;
    return TwoFactorEnrollment(
      otpauthUri: 'otpauth://totp/$issuer?secret=JBSWY3DPEHPK3PXP',
      backupCodes: const ['11112222'],
    );
  }

  @override
  Future<void> verifyEnrollment({required String code}) async {
    _enabled = true;
  }

  @override
  Future<void> disable({String? password}) async {
    disablePassword = password;
    _enabled = false;
  }
}

final _openRemotes =
    <({FakePortalSessionServer server, RemoteControlViewModel remote})>[];

/// Unmounts the screen and releases every paired remote, inside the test
/// body: the binding checks for pending timers before tear-downs run.
Future<void> _closeRemotes(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  for (final (:server, :remote) in _openRemotes) {
    server.close();
    remote.dispose();
  }
  _openRemotes.clear();
  await tester.pump(const Duration(seconds: 1));
}

/// A usage-limits test whose paired remotes are released when it ends.
void _usageTest(String description, Future<void> Function(WidgetTester) body) =>
    testWidgets(description, (tester) async {
      try {
        await body(tester);
      } finally {
        await _closeRemotes(tester);
      }
    });

/// Pairs [server]'s only desktop through the production HTTP repository, so
/// the Account row is fed by the real state parser and event path.
Future<RemoteControlViewModel> _pairedRemote(
  WidgetTester tester,
  FakePortalSessionServer server,
) async {
  final remote = RemoteControlViewModel(
    repository: server.repository(),
    stateRefreshDebounce: Duration.zero,
  );
  _openRemotes.add((server: server, remote: remote));
  unawaited(remote.restoreIfIdle());
  for (var i = 0; i < 10 && !remote.isConnected; i++) {
    await tester.pump(const Duration(milliseconds: 10));
  }
  expect(remote.isConnected, isTrue);
  return remote;
}

Future<void> _pumpAccount(
  WidgetTester tester,
  RemoteControlViewModel remote, {
  double textScale = 1,
  ThemeData? theme,
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final auth = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
  );
  await tester.runAsync(() => auth.signInWithSocial(SocialProvider.google));
  await tester.pumpWidget(
    _host(
      authViewModel: auth,
      remote: remote,
      shellTabs: homeTabsForShellMode(
        AuthenticatedShellMode.organization,
        hasTeams: true,
      ),
      theme: theme,
    ),
  );
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
}

FakePortalSessionServer _usageServer({
  Map<String, dynamic>? providerUsage,
  Map<String, bool> capabilities = const {'provider_usage': true},
}) => FakePortalSessionServer()
  ..addSession(
    id: 'sess-a',
    clientName: 'Desktop A',
    eventCursor: 40,
    capabilities: capabilities,
    providerUsage: providerUsage ?? providerUsagePayload(),
  );

const _usageRow = ValueKey('account-usage-limits');

void _usageLimitsTests() {
  _usageTest('a connected desktop with both providers shows Usage limits '
      'between the profile and Organization, Claude then Codex', (
    tester,
  ) async {
    final remote = await _pairedRemote(tester, _usageServer());
    await _pumpAccount(tester, remote);

    // The fixture reached the screen: the profile and Organization render.
    // The header shows the email first; the Account section repeats it.
    final profile = find.text('google.user@example.com').first;
    final organization = find.text('Organization');
    expect(profile, findsOneWidget);
    expect(organization, findsOneWidget);

    final row = find.byKey(_usageRow);
    expect(row, findsOneWidget);
    expect(
      find.descendant(of: row, matching: find.text('Usage limits')),
      findsOneWidget,
    );
    final claude = find.descendant(of: row, matching: find.text('Claude'));
    final codex = find.descendant(of: row, matching: find.text('Codex'));
    expect(
      find.descendant(of: row, matching: find.text('72% · 7-day')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.text('55% · 7-day window')),
      findsOneWidget,
    );
    expect(tester.getTopLeft(claude).dy, lessThan(tester.getTopLeft(codex).dy));
    expect(tester.getTopLeft(profile).dy, lessThan(tester.getTopLeft(row).dy));
    expect(
      tester.getBottomLeft(row).dy,
      lessThanOrEqualTo(tester.getTopLeft(organization).dy),
    );
    expect(tester.takeException(), isNull);
  });

  _usageTest('only Claude signed in shows one Claude line (AC-02)', (
    tester,
  ) async {
    final remote = await _pairedRemote(
      tester,
      _usageServer(
        providerUsage: providerUsagePayload(
          codex: signedOutUsageEntry('codex'),
        ),
      ),
    );
    await _pumpAccount(tester, remote);
    final row = find.byKey(_usageRow);
    expect(
      find.descendant(of: row, matching: find.text('Claude')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.text('Codex')),
      findsNothing,
    );
  });

  for (final (label, server) in [
    (
      'the desktop lacks the capability',
      () => _usageServer(capabilities: const {}),
    ),
    (
      'neither provider is signed in',
      () => _usageServer(
        providerUsage: providerUsagePayload(
          claude: signedOutUsageEntry('claude'),
          codex: signedOutUsageEntry('codex'),
        ),
      ),
    ),
  ]) {
    _usageTest('the row is hidden when $label (AC-03)', (tester) async {
      final remote = await _pairedRemote(tester, server());
      await _pumpAccount(tester, remote);
      expect(find.text('Organization'), findsOneWidget);
      expect(find.byKey(_usageRow), findsNothing);
      expect(find.text('Usage limits'), findsNothing);
    });
  }

  _usageTest('a signed-in provider whose fetch failed keeps the row, which '
      'opens its error and refresh (AC-05)', (tester) async {
    const message = "Couldn't reach Claude. Check the desktop's connection.";
    final server = _usageServer(
      providerUsage: providerUsagePayload(
        claude: failedUsageEntry('claude', message: message),
        codex: signedOutUsageEntry('codex'),
      ),
    );
    final remote = await _pairedRemote(tester, server);
    await _pumpAccount(tester, remote);

    final row = find.byKey(_usageRow);
    expect(row, findsOneWidget);
    expect(
      find.descendant(of: row, matching: find.text('Claude')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.text('Usage unavailable')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.text('Codex')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);

    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.byType(UsageLimitsScreen), findsOneWidget);
    expect(find.text(message), findsOneWidget);
    expect(find.text('Not signed in on desktop'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('usage-limits-refresh-claude')));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(server.commandBodies, [
      {
        'type': 'portal.provider_usage.refresh',
        'payload': {'provider': 'claude'},
      },
    ]);
    expect(
      find.byKey(const ValueKey('usage-limits-progress-claude')),
      findsOneWidget,
    );

    // The desktop reads usage again and Claude recovers.
    server.push('sess-a', [
      providerUsageDeltaEnvelope(
        providerUsagePayload(codex: signedOutUsageEntry('codex')),
        cursor: 41,
      ),
    ]);
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(find.text(message), findsNothing);
    expect(find.text('72.0%'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('usage-limits-progress-claude')),
      findsNothing,
    );
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: row, matching: find.text('72% · 7-day')),
      findsOneWidget,
    );
    expect(remote.commandFailureMessage, isNull);
  });

  _usageTest('the row hides when the desktop stops being live (AC-03)', (
    tester,
  ) async {
    final server = _usageServer();
    final remote = await _pairedRemote(tester, server);
    await _pumpAccount(tester, remote);
    expect(find.byKey(_usageRow), findsOneWidget);
    server.sleep('sess-a');
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(remote.isConnected, isTrue, reason: 'still paired');
    expect(find.byKey(_usageRow), findsNothing);
  });

  _usageTest('the row is hidden with no paired desktop (AC-03)', (
    tester,
  ) async {
    final remote = RemoteControlViewModel(
      repository: FakeRemoteControlRepository()..supportsProviderUsage = true,
    );
    addTearDown(remote.dispose);
    await _pumpAccount(tester, remote);
    expect(find.text('Organization'), findsOneWidget);
    expect(find.byKey(_usageRow), findsNothing);
  });

  _usageTest('a pushed update changes the row in place (AC-09) and the '
      'row opens the detail screen (AC-04)', (tester) async {
    final server = _usageServer();
    final remote = await _pairedRemote(tester, server);
    await _pumpAccount(tester, remote);
    server.push('sess-a', [
      providerUsageDeltaEnvelope(
        providerUsagePayload(claude: claudeUsageEntry(fiveHour: 91)),
        cursor: 41,
      ),
    ]);
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    final row = find.byKey(_usageRow);
    expect(
      find.descendant(of: row, matching: find.text('91% · 5-hour window')),
      findsOneWidget,
    );

    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.byType(UsageLimitsScreen), findsOneWidget);
    expect(find.text('91.0%'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(_usageRow), findsOneWidget);
  });

  for (final theme in [AppTheme.light, AppTheme.dark]) {
    _usageTest('the row fits 390 px at text scale 3 with a 44 px target '
        '(${theme.brightness.name}, AC-11)', (tester) async {
      final remote = await _pairedRemote(tester, _usageServer());
      await _pumpAccount(tester, remote, textScale: 3, theme: theme);
      final row = find.byKey(_usageRow);
      expect(row, findsOneWidget);
      expect(tester.getSize(row).height, greaterThanOrEqualTo(44));
      expect(tester.getSize(row).width, greaterThanOrEqualTo(44));
      expect(
        find.descendant(of: row, matching: find.text('72% · 7-day')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      // Scroll the whole Account screen so every section lays out.
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -6000));
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  }
}

void _mergedSettingsTests() {
  Future<void> pumpSettings(
    WidgetTester tester, {
    bool showDeveloperOptions = true,
  }) async {
    tester.view.physicalSize = const Size(390, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final auth = AuthViewModel(
      repository: MockAuthRepository(latency: Duration.zero),
    );
    await tester.runAsync(() => auth.signInWithSocial(SocialProvider.google));
    await tester.pumpWidget(
      _host(
        authViewModel: auth,
        shellTabs: organizationHomeTabs,
        showDeveloperOptions: showDeveloperOptions,
      ),
    );
    await tester.pumpAndSettle();
  }

  double top(WidgetTester tester, String text) =>
      tester.getTopLeft(find.text(text).first).dy;

  testWidgets('is titled Settings and has no gear to a second screen', (
    tester,
  ) async {
    await pumpSettings(tester);

    expect(find.text('Settings'), findsOneWidget);
    expect(find.byTooltip('Settings'), findsNothing);
    expect(find.text('Appearance'), findsOneWidget);
    expect(find.text('Push notifications'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('orders its sections as the layout table', (tester) async {
    await pumpSettings(tester);

    final order = [
      'google.user@example.com',
      'Organization',
      'Account',
      'App',
      'Help',
      'Developer',
      'Sign out',
    ];
    for (final label in order) {
      expect(find.text(label), findsWidgets, reason: label);
    }
    for (var i = 1; i < order.length; i++) {
      expect(
        top(tester, order[i]),
        greaterThan(top(tester, order[i - 1])),
        reason: '${order[i - 1]} before ${order[i]}',
      );
    }
    expect(top(tester, 'Login methods'), greaterThan(top(tester, 'Account')));
    expect(top(tester, 'Push notifications'), greaterThan(top(tester, 'App')));
    expect(
      top(tester, 'Open source licenses'),
      greaterThan(top(tester, 'Send feedback')),
    );
    expect(find.byKey(const ValueKey('send-feedback-tile')), findsOneWidget);
  });

  testWidgets('keeps login methods, 2FA and API keys on drill-downs', (
    tester,
  ) async {
    await pumpSettings(tester);

    // Summary rows only: the inline lists moved to their own screens.
    expect(find.text('Email and password'), findsNothing);
    expect(find.text('CI token'), findsNothing);

    await tester.tap(find.text('Login methods'));
    await tester.pumpAndSettle();
    expect(find.text('Email and password'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Appearance opens a menu that applies the chosen mode', (
    tester,
  ) async {
    await pumpSettings(tester);
    final controller = tester
        .element(find.byType(AccountScreen))
        .read<ThemeController>();
    expect(controller.mode, ThemeMode.system);

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    expect(find.text('Light'), findsOneWidget);
    expect(find.text('Dark'), findsOneWidget);

    await tester.tap(find.text('Dark'));
    await tester.pumpAndSettle();
    expect(controller.mode, ThemeMode.dark);
    expect(find.text('Light'), findsNothing);
  });
}
