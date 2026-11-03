// Settings' drill-downs (CAN-4449) are pushed routes, so the user can leave
// one while its request is still running. The old Account tab stayed mounted
// in the shell, so these flows always reached their follow-up. Each test goes
// Back mid-request through the real routes and borrowed view models, then
// finishes the request: the required outcome must still happen. A sign-out
// or another account's sign-in ends the account scope instead: the old
// account's follow-up must then not happen at all.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_source.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/models/two_factor.dart';
import 'package:mobile/data/protocol/generated/api_keys.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/repositories/profile_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/profile_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/account_screen.dart';
import 'package:mobile/ui/features/account/views/api_keys_screen.dart';
import 'package:mobile/ui/features/account/views/login_methods_screen.dart';
import 'package:mobile/ui/features/account/views/two_factor_settings_screen.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

import '../../../../support/fake_provider_usage_source.dart';
import '../../../../support/settings_root_providers.dart';

/// The two ways a user leaves a drill-down.
enum _Back { appBar, system }

void main() {
  for (final back in _Back.values) {
    group('${back.name} Back mid-request', () => _tests(back));
  }
  for (final end in _ScopeEnd.values) {
    group('${end.name} mid-request', () => _scopeTests(end));
    group('${end.name} while a dialog is open', () => _dialogScopeTests(end));
  }
}

void _tests(_Back back) {
  testWidgets('a 2FA disable still asks to sign in again, then signs out', (
    tester,
  ) async {
    final host = await _pumpSettings(tester, twoFactorEnabled: true);
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pump();

    await _leave(tester, back);
    expect(find.byType(TwoFactorSettingsScreen), findsNothing);
    host.twoFactorRepository.finishDisable();
    await tester.pumpAndSettle();

    expect(find.text('Sign in again'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'OK'));
    await tester.pumpAndSettle();
    expect(host.authRepository.signOutCount, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed 2FA disable still reports the failure', (tester) async {
    final host = await _pumpSettings(tester, twoFactorEnabled: true);
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pump();

    await _leave(tester, back);
    host.twoFactorRepository.failDisable();
    await tester.pumpAndSettle();

    expect(
      find.text('Something went wrong. Please try again.'),
      findsOneWidget,
    );
    expect(host.authRepository.signOutCount, 0);
    await _open(tester, 'Two-factor authentication');
    expect(find.text('Enabled'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a started 2FA enrollment still shows its setup dialog, and '
      'cancel clears the secret', (tester) async {
    final host = await _pumpSettings(tester);
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Enable'));
    await tester.pump();

    await _leave(tester, back);
    expect(find.byType(TwoFactorSettingsScreen), findsNothing);
    host.twoFactorRepository.finishEnrollment();
    await tester.pumpAndSettle();

    expect(find.text('Set up authenticator'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(host.twoFactor.step, TwoFactorStep.idle);
    expect(host.twoFactor.enrollment, isNull);
    expect(tester.takeException(), isNull);
  });

  for (final pending in _CreatePhase.values) {
    testWidgets('a key created before Back during the ${pending.name} still '
        'shows its one-time token', (tester) async {
      final host = await _pumpSettings(tester);
      await _open(tester, 'API keys');
      await tester.tap(find.text('New key'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Synthetic key');
      host.apiKeysRepository.holdNextList();
      await tester.tap(find.text('Create'));
      await tester.pump();

      if (pending == _CreatePhase.refresh) {
        host.apiKeysRepository.finishCreate();
        await tester.pump();
      }
      await _leave(tester, back);
      expect(find.byType(ApiKeysScreen), findsNothing);
      if (pending == _CreatePhase.create) {
        host.apiKeysRepository.finishCreate();
        await tester.pump();
      }
      host.apiKeysRepository.finishList();
      await tester.pumpAndSettle();

      expect(find.text('API key created'), findsOneWidget);
      expect(find.text(_ApiKeysRepository.token), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.widgetWithText(CanopySettingsRow, 'API keys'),
          matching: find.text('2'),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('a failed key create still reports the failure', (tester) async {
    final host = await _pumpSettings(tester);
    await _open(tester, 'API keys');
    await tester.tap(find.text('New key'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Synthetic key');
    await tester.tap(find.text('Create'));
    await tester.pump();

    await _leave(tester, back);
    host.apiKeysRepository.failCreate();
    await tester.pumpAndSettle();

    expect(find.text('Could not create the API key.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unlinking the password still refreshes two-factor status', (
    tester,
  ) async {
    final host = await _pumpSettings(tester, passwordLinked: true);
    expect(host.twoFactor.hasCredentialAuthSource, isTrue);
    await _open(tester, 'Login methods');
    await tester.tap(
      find.descendant(
        of: find.widgetWithText(CanopySettingsRow, 'Email and password'),
        matching: find.byTooltip('Unlink'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Unlink'));
    await tester.pump();

    await _leave(tester, back);
    expect(find.byType(LoginMethodsScreen), findsNothing);
    final loadsBefore = host.twoFactorRepository.statusLoads;
    host.authSourcesRepository.finishUnlink();
    await tester.pumpAndSettle();

    expect(host.twoFactorRepository.statusLoads, loadsBefore + 1);
    expect(host.twoFactor.hasCredentialAuthSource, isFalse);
    expect(tester.takeException(), isNull);
  });
}

/// Which request of a key create is still running when the user leaves.
enum _CreatePhase { create, refresh }

/// How the signed-in account scope ends while a request is running.
enum _ScopeEnd { signOut, otherAccount }

void _scopeTests(_ScopeEnd end) {
  testWidgets('an old 2FA disable neither asks to sign in again nor signs '
      'out', (tester) async {
    final host = await _pumpAuthGated(tester, twoFactorEnabled: true);
    final old = host.first;
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pump();

    await _leave(tester, _Back.appBar);
    await _endScope(tester, host, end);
    old.twoFactorRepository.finishDisable();
    await tester.pumpAndSettle();

    expect(find.text('Sign in again'), findsNothing);
    expect(host.authRepository.signOutCount, 1);
    _expectScopeAfter(tester, host, end);
  });

  testWidgets('an old failed 2FA disable reports nothing', (tester) async {
    final host = await _pumpAuthGated(tester, twoFactorEnabled: true);
    final old = host.first;
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pump();

    await _leave(tester, _Back.appBar);
    await _endScope(tester, host, end);
    old.twoFactorRepository.failDisable();
    await tester.pumpAndSettle();

    expect(find.text('Something went wrong. Please try again.'), findsNothing);
    _expectScopeAfter(tester, host, end);
  });

  testWidgets('an old 2FA enrollment never shows its secret, and clears it', (
    tester,
  ) async {
    final host = await _pumpAuthGated(tester);
    final old = host.first;
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Enable'));
    await tester.pump();

    await _leave(tester, _Back.appBar);
    await _endScope(tester, host, end);
    old.twoFactorRepository.finishEnrollment();
    await tester.pumpAndSettle();

    expect(find.text('Set up authenticator'), findsNothing);
    expect(find.textContaining(_TwoFactorRepository.secret), findsNothing);
    expect(old.twoFactor.enrollment, isNull);
    expect(old.twoFactor.step, TwoFactorStep.idle);
    _expectScopeAfter(tester, host, end);
  });

  testWidgets('an old key create never shows its one-time token', (
    tester,
  ) async {
    final host = await _pumpAuthGated(tester);
    final old = host.first;
    await _open(tester, 'API keys');
    await tester.tap(find.text('New key'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Synthetic key');
    await tester.tap(find.text('Create'));
    await tester.pump();

    await _leave(tester, _Back.appBar);
    await _endScope(tester, host, end);
    old.apiKeysRepository.finishCreate();
    await tester.pumpAndSettle();

    expect(find.text('API key created'), findsNothing);
    expect(find.text(_ApiKeysRepository.token), findsNothing);
    _expectScopeAfter(tester, host, end);
  });

  testWidgets('an old failed key create reports nothing', (tester) async {
    final host = await _pumpAuthGated(tester);
    final old = host.first;
    await _open(tester, 'API keys');
    await tester.tap(find.text('New key'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Synthetic key');
    await tester.tap(find.text('Create'));
    await tester.pump();

    await _leave(tester, _Back.appBar);
    await _endScope(tester, host, end);
    old.apiKeysRepository.failCreate();
    await tester.pumpAndSettle();

    expect(find.text('Could not create the API key.'), findsNothing);
    _expectScopeAfter(tester, host, end);
  });

  testWidgets('an old password unlink does not reload old 2FA status', (
    tester,
  ) async {
    final host = await _pumpAuthGated(tester, passwordLinked: true);
    final old = host.first;
    await _open(tester, 'Login methods');
    await tester.tap(
      find.descendant(
        of: find.widgetWithText(CanopySettingsRow, 'Email and password'),
        matching: find.byTooltip('Unlink'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Unlink'));
    await tester.pump();

    await _leave(tester, _Back.appBar);
    await _endScope(tester, host, end);
    final loadsBefore = old.twoFactorRepository.statusLoads;
    old.authSourcesRepository.finishUnlink();
    await tester.pumpAndSettle();

    expect(old.twoFactorRepository.statusLoads, loadsBefore);
    _expectScopeAfter(tester, host, end);
  });
}

/// The account scope ends while one of the flow's dialogs is open, as a
/// session expiry does. The dialog, and a drill-down route the user has not
/// left, stay on the root navigator; the old flow then continues.
void _dialogScopeTests(_ScopeEnd end) {
  testWidgets('an old revoke confirmation revokes no key', (tester) async {
    final host = await _pumpAuthGated(tester);
    final old = host.first;
    await _open(tester, 'API keys');
    await tester.tap(find.byTooltip('Revoke'));
    await tester.pumpAndSettle();

    await _endScopeUnderDialog(tester, host, end);
    await tester.tap(find.widgetWithText(FilledButton, 'Revoke'));
    await tester.pumpAndSettle();

    expect(old.apiKeysRepository.revokes, 0);
    expect(host.second.apiKeysRepository.revokes, 0);
    _expectAccountAfter(tester, host, end);
  });

  testWidgets('an old revoke that fails after the scope ended reports '
      'nothing', (tester) async {
    final host = await _pumpAuthGated(tester);
    final old = host.first;
    await _open(tester, 'API keys');
    await tester.tap(find.byTooltip('Revoke'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Revoke'));
    await tester.pump();
    expect(old.apiKeysRepository.revokes, 1);

    await _endScopeUnderDialog(tester, host, end);
    old.apiKeysRepository.failRevoke();
    await tester.pumpAndSettle();

    expect(find.text('Could not revoke the API key.'), findsNothing);
    _expectAccountAfter(tester, host, end);
  });

  testWidgets('an old key name prompt starts no create', (tester) async {
    final host = await _pumpAuthGated(tester);
    final old = host.first;
    await _open(tester, 'API keys');
    await tester.tap(find.text('New key'));
    await tester.pumpAndSettle();

    await _endScopeUnderDialog(tester, host, end);
    await tester.enterText(find.byType(TextField), 'Synthetic key');
    await tester.tap(find.text('Create'));
    await tester.pumpAndSettle();

    expect(old.apiKeysRepository.creates, 0);
    _expectAccountAfter(tester, host, end);
  });

  testWidgets('an old 2FA disable confirmation sends no disable', (
    tester,
  ) async {
    final host = await _pumpAuthGated(tester, twoFactorEnabled: true);
    final old = host.first;
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();

    await _endScopeUnderDialog(tester, host, end);
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pumpAndSettle();

    expect(old.twoFactorRepository.disables, 0);
    _expectAccountAfter(tester, host, end);
  });

  testWidgets('an old 2FA disable password prompt sends no disable', (
    tester,
  ) async {
    final host = await _pumpAuthGated(
      tester,
      twoFactorEnabled: true,
      passwordLinked: true,
    );
    final old = host.first;
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pumpAndSettle();
    expect(find.text('Confirm account password'), findsOneWidget);

    await _endScopeUnderDialog(tester, host, end);
    await tester.enterText(find.byType(TextField), 'synthetic-password');
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    expect(old.twoFactorRepository.disables, 0);
    _expectAccountAfter(tester, host, end);
  });

  testWidgets('an old 2FA enable password prompt starts no enrollment', (
    tester,
  ) async {
    final host = await _pumpAuthGated(tester, passwordLinked: true);
    final old = host.first;
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Enable'));
    await tester.pumpAndSettle();
    expect(find.text('Confirm account password'), findsOneWidget);

    await _endScopeUnderDialog(tester, host, end);
    await tester.enterText(find.byType(TextField), 'synthetic-password');
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    expect(old.twoFactorRepository.enrollments, 0);
    expect(find.text('Set up authenticator'), findsNothing);
    _expectAccountAfter(tester, host, end);
  });

  testWidgets('an old unlink confirmation sends no unlink', (tester) async {
    final host = await _pumpAuthGated(tester, passwordLinked: true);
    final old = host.first;
    await _open(tester, 'Login methods');
    await tester.tap(
      find.descendant(
        of: find.widgetWithText(CanopySettingsRow, 'Email and password'),
        matching: find.byTooltip('Unlink'),
      ),
    );
    await tester.pumpAndSettle();

    await _endScopeUnderDialog(tester, host, end);
    await tester.tap(find.widgetWithText(FilledButton, 'Unlink'));
    await tester.pumpAndSettle();

    expect(old.authSourcesRepository.unlinks, 0);
    _expectAccountAfter(tester, host, end);
  });

  testWidgets('an old unlink that fails after the scope ended reports '
      'nothing', (tester) async {
    final host = await _pumpAuthGated(tester, passwordLinked: true);
    final old = host.first;
    await _open(tester, 'Login methods');
    await tester.tap(
      find.descendant(
        of: find.widgetWithText(CanopySettingsRow, 'Email and password'),
        matching: find.byTooltip('Unlink'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Unlink'));
    await tester.pump();
    expect(old.authSourcesRepository.unlinks, 1);

    await _endScopeUnderDialog(tester, host, end);
    old.authSourcesRepository.failUnlink();
    await tester.pumpAndSettle();

    expect(find.text('Could not unlink the login method.'), findsNothing);
    _expectAccountAfter(tester, host, end);
  });

  testWidgets('OK on an old "Sign in again" signs out no other scope', (
    tester,
  ) async {
    final host = await _pumpAuthGated(tester, twoFactorEnabled: true);
    final old = host.first;
    await _open(tester, 'Two-factor authentication');
    await tester.tap(find.text('Disable'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pump();
    await _leave(tester, _Back.appBar);
    old.twoFactorRepository.finishDisable();
    await tester.pumpAndSettle();
    expect(find.text('Sign in again'), findsOneWidget);

    await _endScopeUnderDialog(tester, host, end);
    await tester.tap(find.widgetWithText(FilledButton, 'OK'));
    await tester.pumpAndSettle();

    _expectScopeAfter(tester, host, end);
  });

  testWidgets('an old enrollment verified after the scope ended shows no '
      'backup codes and signs out no other scope', (tester) async {
    final host = await _pumpAuthGated(tester);
    final old = host.first;
    await _startEnrollmentAndLeave(tester, old);

    await _endScopeUnderDialog(tester, host, end);
    await tester.enterText(find.byType(TextField), '123456');
    await tester.tap(find.text('Verify'));
    await tester.pumpAndSettle();

    expect(find.text('Save your backup codes'), findsNothing);
    expect(find.text('Sign in again'), findsNothing);
    expect(old.twoFactor.lastBackupCodes, isNull);
    _expectScopeAfter(tester, host, end);
  });

  testWidgets('cancelling an old enrollment after the scope ended still '
      'clears its secret', (tester) async {
    final host = await _pumpAuthGated(tester);
    final old = host.first;
    await _startEnrollmentAndLeave(tester, old);

    await _endScopeUnderDialog(tester, host, end);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(old.twoFactor.enrollment, isNull);
    expect(old.twoFactor.step, TwoFactorStep.idle);
    _expectScopeAfter(tester, host, end);
  });
}

/// Starts an enrollment, leaves the route mid-request, then shows the setup
/// dialog on the root navigator.
Future<void> _startEnrollmentAndLeave(
  WidgetTester tester,
  _Account account,
) async {
  await _open(tester, 'Two-factor authentication');
  await tester.tap(find.text('Enable'));
  await tester.pump();
  await _leave(tester, _Back.appBar);
  account.twoFactorRepository.finishEnrollment();
  await tester.pumpAndSettle();
  expect(find.text('Set up authenticator'), findsOneWidget);
}

/// Ends the account scope under an open dialog, as a session expiry does:
/// the auth view model signs out, and for [_ScopeEnd.otherAccount] a second
/// account then signs in.
Future<void> _endScopeUnderDialog(
  WidgetTester tester,
  _AuthGatedHost host,
  _ScopeEnd end,
) async {
  await host.auth.signOut();
  await tester.pumpAndSettle();
  expect(host.first.twoFactor.isDisposed, isTrue);
  expect(host.first.apiKeys.isDisposed, isTrue);
  if (end == _ScopeEnd.otherAccount) {
    await host.auth.signIn(email: _secondEmail, password: 'synthetic');
    await tester.pumpAndSettle();
  }
}

/// Signs out from Settings, which disposes the account scope, and for
/// [_ScopeEnd.otherAccount] signs in a second account.
Future<void> _endScope(
  WidgetTester tester,
  _AuthGatedHost host,
  _ScopeEnd end,
) async {
  await tester.ensureVisible(find.text('Sign out'));
  await tester.tap(find.text('Sign out'));
  await tester.pumpAndSettle();
  expect(find.text(_signedOut), findsOneWidget);
  expect(host.first.twoFactor.isDisposed, isTrue);
  expect(host.first.apiKeys.isDisposed, isTrue);
  if (end == _ScopeEnd.otherAccount) {
    await host.auth.signIn(email: _secondEmail, password: 'synthetic');
    await tester.pumpAndSettle();
    expect(find.byType(AccountScreen), findsOneWidget);
  }
}

/// The scope after [_endScope] is unchanged by the old request.
void _expectScopeAfter(
  WidgetTester tester,
  _AuthGatedHost host,
  _ScopeEnd end,
) {
  expect(switch (end) {
    _ScopeEnd.signOut => find.text(_signedOut),
    _ScopeEnd.otherAccount => find.byType(AccountScreen),
  }, findsOneWidget);
  _expectAccountAfter(tester, host, end);
}

/// The auth state after the scope ended is unchanged by the old flow. A
/// drill-down route the user has not left may still cover the gate.
void _expectAccountAfter(
  WidgetTester tester,
  _AuthGatedHost host,
  _ScopeEnd end,
) {
  switch (end) {
    case _ScopeEnd.signOut:
      expect(host.auth.status, AuthStatus.unauthenticated);
    case _ScopeEnd.otherAccount:
      expect(host.auth.status, AuthStatus.authenticated);
      expect(host.auth.user?.email, _secondEmail);
  }
  expect(host.authRepository.signOutCount, 1);
  expect(find.byType(SnackBar), findsNothing);
  expect(tester.takeException(), isNull);
}

Future<void> _open(WidgetTester tester, String title) async {
  await tester.tap(find.text(title));
  await tester.pumpAndSettle();
}

Future<void> _leave(WidgetTester tester, _Back back) async {
  switch (back) {
    case _Back.appBar:
      await tester.tap(find.byTooltip('Back'));
    case _Back.system:
      await tester.binding.handlePopRoute();
  }
  await tester.pumpAndSettle();
}

const _firstEmail = 'first@example.com';
const _secondEmail = 'second@example.com';
const _signedOut = 'Signed out';

typedef _AuthGatedHost = ({
  _AuthRepository authRepository,
  AuthViewModel auth,
  _Account first,
  _Account second,
});

/// One account's repositories, and the view models its scope created.
final class _Account {
  _Account({required bool twoFactorEnabled, required bool passwordLinked})
    : authSourcesRepository = _AuthSourcesRepository(
        passwordLinked: passwordLinked,
      ) {
    twoFactorRepository = _TwoFactorRepository(
      enabled: twoFactorEnabled,
      sources: authSourcesRepository,
    );
  }

  final _AuthSourcesRepository authSourcesRepository;
  late final _TwoFactorRepository twoFactorRepository;
  final _ApiKeysRepository apiKeysRepository = _ApiKeysRepository();
  late TwoFactorViewModel twoFactor;
  late ApiKeysViewModel apiKeys;
}

/// Mounts Settings behind a gate like `AuthGate` in `main.dart`: one
/// `MaterialApp` and root navigator stay, and the account view models live
/// in the signed-in branch below them, so a sign-out disposes them.
Future<_AuthGatedHost> _pumpAuthGated(
  WidgetTester tester, {
  bool twoFactorEnabled = false,
  bool passwordLinked = false,
}) async {
  tester.view.physicalSize = const Size(390, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final authRepository = _AuthRepository();
  final auth = AuthViewModel(repository: authRepository);
  final accounts = {
    _firstEmail: _Account(
      twoFactorEnabled: twoFactorEnabled,
      passwordLinked: passwordLinked,
    ),
    _secondEmail: _Account(twoFactorEnabled: false, passwordLinked: false),
  };
  await auth.signIn(email: _firstEmail, password: 'synthetic');

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthViewModel>(create: (_) => auth),
        Provider<FeedbackReportRepository>.value(
          value: MockFeedbackReportRepository(latency: Duration.zero),
        ),
        ...settingsRootTestProviders(),
      ],
      child: MaterialApp(
        theme: AppTheme.light,
        home: Builder(
          builder: (context) {
            final auth = context.watch<AuthViewModel>();
            final account = auth.status == AuthStatus.authenticated
                ? accounts[auth.user?.email]
                : null;
            if (account == null) {
              return const Scaffold(body: Center(child: Text(_signedOut)));
            }
            return MultiProvider(
              providers: [
                ListenableProvider<ProviderUsageSource>(
                  create: (_) => FakeProviderUsageSource(),
                ),
                ChangeNotifierProvider<ApiKeysViewModel>(
                  create: (_) => account.apiKeys = ApiKeysViewModel(
                    repository: account.apiKeysRepository,
                  )..load(),
                ),
                ChangeNotifierProvider<AuthSourcesViewModel>(
                  create: (_) => AuthSourcesViewModel(
                    repository: account.authSourcesRepository,
                  )..load(),
                ),
                ChangeNotifierProvider<TwoFactorViewModel>(
                  create: (_) => account.twoFactor = TwoFactorViewModel(
                    repository: account.twoFactorRepository,
                    issuer: 'Test',
                  )..load(),
                ),
                ChangeNotifierProvider<ProfileViewModel>(
                  create: (_) => ProfileViewModel(
                    repository: MockProfileRepository(latency: Duration.zero),
                  ),
                ),
              ],
              child: const AccountScreen(),
            );
          },
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (
    authRepository: authRepository,
    auth: auth,
    first: accounts[_firstEmail]!,
    second: accounts[_secondEmail]!,
  );
}

typedef _Host = ({
  _AuthRepository authRepository,
  _TwoFactorRepository twoFactorRepository,
  _ApiKeysRepository apiKeysRepository,
  _AuthSourcesRepository authSourcesRepository,
  TwoFactorViewModel twoFactor,
});

/// Mounts the merged Settings page with the account view models below
/// `MaterialApp`, where the shell provides them in production.
Future<_Host> _pumpSettings(
  WidgetTester tester, {
  bool twoFactorEnabled = false,
  bool passwordLinked = false,
}) async {
  tester.view.physicalSize = const Size(390, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final authSourcesRepository = _AuthSourcesRepository(
    passwordLinked: passwordLinked,
  );
  final twoFactorRepository = _TwoFactorRepository(
    enabled: twoFactorEnabled,
    sources: authSourcesRepository,
  );
  final apiKeysRepository = _ApiKeysRepository();
  final authRepository = _AuthRepository();
  final twoFactor = TwoFactorViewModel(
    repository: twoFactorRepository,
    issuer: 'Test',
  )..load();

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthViewModel>(
          create: (_) => AuthViewModel(repository: authRepository),
        ),
        Provider<FeedbackReportRepository>.value(
          value: MockFeedbackReportRepository(latency: Duration.zero),
        ),
        ...settingsRootTestProviders(),
      ],
      child: MaterialApp(
        theme: AppTheme.light,
        home: MultiProvider(
          providers: [
            ListenableProvider<ProviderUsageSource>(
              create: (_) => FakeProviderUsageSource(),
            ),
            ChangeNotifierProvider<ApiKeysViewModel>(
              create: (_) =>
                  ApiKeysViewModel(repository: apiKeysRepository)..load(),
            ),
            ChangeNotifierProvider<AuthSourcesViewModel>(
              create: (_) =>
                  AuthSourcesViewModel(repository: authSourcesRepository)
                    ..load(),
            ),
            ChangeNotifierProvider<TwoFactorViewModel>.value(value: twoFactor),
            ChangeNotifierProvider<ProfileViewModel>(
              create: (_) => ProfileViewModel(
                repository: MockProfileRepository(latency: Duration.zero),
              ),
            ),
          ],
          child: const AccountScreen(),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (
    authRepository: authRepository,
    twoFactorRepository: twoFactorRepository,
    apiKeysRepository: apiKeysRepository,
    authSourcesRepository: authSourcesRepository,
    twoFactor: twoFactor,
  );
}

/// Signs in any email as a synthetic user, and counts sign-outs.
final class _AuthRepository implements AuthRepository {
  int signOutCount = 0;

  @override
  Future<void> signOut() async {
    signOutCount += 1;
  }

  @override
  Future<AuthSession?> restoreSession() => throw UnimplementedError();

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => AuthSession(
    token: 'synthetic-session',
    user: AuthUser(
      id: email,
      email: email,
      emailVerified: true,
      name: 'Synthetic User',
      image: null,
      role: 'DEVELOPER',
      status: 'ACTIVE',
      twoFactorEnabled: false,
      createdAt: '2026-06-01T09:00:00.000Z',
      updatedAt: '2026-06-01T09:00:00.000Z',
    ),
  );

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

/// Holds each enroll and disable request until the test finishes it, counts
/// them, and accepts any code. The password flag follows [sources], like the
/// server.
final class _TwoFactorRepository implements TwoFactorRepository {
  _TwoFactorRepository({required this.enabled, required this.sources});

  static const secret = 'JBSWY3DPEHPK3PXP';

  final _AuthSourcesRepository sources;
  bool enabled;
  int statusLoads = 0;
  int enrollments = 0;
  int disables = 0;
  final Completer<TwoFactorEnrollment> _enrollment = Completer();
  final Completer<void> _disable = Completer();

  void finishEnrollment() => _enrollment.complete(
    const TwoFactorEnrollment(
      otpauthUri: 'otpauth://totp/Test?secret=$secret',
      backupCodes: ['11112222'],
    ),
  );

  void finishDisable() => _disable.complete();

  void failDisable() => _disable.completeError(StateError('disable failed'));

  @override
  Future<TwoFactorStatus> fetchStatus() async {
    statusLoads += 1;
    return TwoFactorStatus(
      enabled: enabled,
      hasCredentialAuthSource: sources.hasCredential,
    );
  }

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) {
    enrollments += 1;
    return _enrollment.future;
  }

  @override
  Future<void> verifyEnrollment({required String code}) async {}

  @override
  Future<void> disable({String? password}) async {
    disables += 1;
    await _disable.future;
    enabled = false;
  }
}

/// Two keys; counts creates and revokes, and holds create, revoke and the
/// list after [holdNextList] until finished.
final class _ApiKeysRepository implements ApiKeysRepository {
  static const token = 'sk-synthetic-once';

  final List<UserApiKeyListItem> _keys = [_key('key-ci', 'CI token')];
  final Completer<UserApiKeyCreateResponse> _create = Completer();
  Completer<List<UserApiKeyListItem>>? _list;
  final Completer<void> _revoke = Completer();
  bool _holdList = false;
  int creates = 0;
  int revokes = 0;

  void holdNextList() => _holdList = true;

  void finishCreate() {
    final item = _key('key-new', 'Synthetic key');
    _keys.insert(0, item);
    _create.complete(UserApiKeyCreateResponse(token: token, userApiKey: item));
  }

  void failCreate() => _create.completeError(StateError('create failed'));

  void failRevoke() => _revoke.completeError(StateError('revoke failed'));

  void finishList() => _list?.complete(List.of(_keys));

  @override
  Future<List<UserApiKeyListItem>> list() async {
    if (!_holdList) return List.of(_keys);
    _holdList = false;
    return (_list = Completer()).future;
  }

  @override
  Future<UserApiKeyCreateResponse> create(String name) {
    creates += 1;
    return _create.future;
  }

  @override
  Future<void> revoke(String id) {
    revokes += 1;
    return _revoke.future;
  }

  static UserApiKeyListItem _key(String id, String name) => UserApiKeyListItem(
    id: id,
    name: name,
    source: UserApiKeySource.manual,
    createdIp: null,
    createdAt: '2026-07-03T00:00:00.000Z',
    lastUsedAt: null,
  );
}

/// Google, plus a removable password when [passwordLinked]; counts unlinks
/// and holds each until finished or failed. Without a password, enroll and
/// disable skip its prompt.
final class _AuthSourcesRepository implements AuthSourcesRepository {
  _AuthSourcesRepository({required bool passwordLinked}) {
    if (!passwordLinked) _sources.removeAt(0);
  }

  final Completer<void> _unlink = Completer();
  int unlinks = 0;
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

  bool get hasCredential => _sources.any((s) => s.providerId == 'credential');

  void finishUnlink() => _unlink.complete();

  void failUnlink() => _unlink.completeError(StateError('unlink failed'));

  @override
  Future<AuthSourcesResponse> list() async => AuthSourcesResponse(
    user: const AuthSourcesUser(
      name: 'Synthetic User',
      email: 'synthetic@example.com',
      twoFactorEnabled: false,
    ),
    sources: List.of(_sources),
  );

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) async {
    unlinks += 1;
    await _unlink.future;
    _sources.removeWhere((s) => s.accountId == accountId);
  }
}
