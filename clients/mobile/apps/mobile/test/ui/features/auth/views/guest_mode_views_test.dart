import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/account/views/guest_account_screen.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/views/guest_sign_in_screen.dart';
import 'package:mobile/ui/features/auth/views/sign_in_screen.dart';
import 'package:provider/provider.dart';

AuthUser _user(String id, {bool anonymous = false}) => AuthUser(
  id: id,
  email: '$id@example.com',
  emailVerified: !anonymous,
  name: anonymous ? 'Anonymous' : 'Member',
  image: null,
  role: 'DEVELOPER',
  status: 'ACTIVE',
  twoFactorEnabled: false,
  createdAt: '',
  updatedAt: '',
  isAnonymous: anonymous,
);

final _guest = AuthSession(
  token: 'guest-tok',
  user: _user('9', anonymous: true),
);
final _member = AuthSession(token: 'real-tok', user: _user('42'));

// Guest mode views (CAN-2872), at phone width.
void main() {
  late _GuestRepository repo;
  late AuthViewModel auth;

  setUp(() {
    DemoMode.enabled.value = false;
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: 'https://production.test',
        stagingBaseUrl: 'https://staging.test',
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
    repo = _GuestRepository();
    auth = AuthViewModel(repository: repo, guestSessions: repo);
  });

  void usePhone(WidgetTester tester) {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
  }

  Widget host(Widget home) => ChangeNotifierProvider<AuthViewModel>.value(
    value: auth,
    child: MaterialApp(theme: AppTheme.light, home: home),
  );

  group('SignInScreen guest entry', () {
    testWidgets('is hidden while the server does not allow guests', (
      tester,
    ) async {
      usePhone(tester);
      await tester.pumpWidget(host(const SignInScreen()));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('continueAsGuest')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('continues as a guest when the server allows it', (
      tester,
    ) async {
      usePhone(tester);
      repo.available = true;
      await tester.pumpWidget(host(const SignInScreen()));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Continue as guest'));
      await tester.tap(find.text('Continue as guest'));
      await tester.pumpAndSettle();

      expect(auth.status, AuthStatus.authenticated);
      expect(auth.isGuest, isTrue);
      expect(tester.takeException(), isNull);
    });
  });

  group('GuestAccountScreen', () {
    Future<void> pumpGuestSettings(
      WidgetTester tester, {
      void Function(BuildContext)? onSignIn,
    }) async {
      usePhone(tester);
      await auth.continueAsGuest();
      await tester.pumpWidget(
        host(
          GuestAccountScreen(
            onSignIn: onSignIn ?? (_) {},
            onLeaveGuestMode: auth.signOut,
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('offers sign-in, help, and leaving guest mode', (tester) async {
      var signIns = 0;
      await pumpGuestSettings(tester, onSignIn: (_) => signIns++);

      expect(find.text('Guest account'), findsOneWidget);
      expect(find.text('Help'), findsOneWidget);
      expect(find.text('Open source licenses'), findsOneWidget);
      // The server takes feedback only from accounts.
      expect(find.text('Send feedback'), findsNothing);
      // None of the account-security rows a guest cannot use.
      expect(find.text('Login methods'), findsNothing);
      expect(find.text('API keys'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('guest-sign-in-row')));
      expect(signIns, 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('leaving guest mode asks first', (tester) async {
      await pumpGuestSettings(tester);

      await tester.ensureVisible(find.byKey(const ValueKey('guest-leave-row')));
      await tester.tap(find.byKey(const ValueKey('guest-leave-row')));
      await tester.pumpAndSettle();
      expect(find.text('Leave guest mode?'), findsOneWidget);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(auth.isGuest, isTrue);
      expect(repo.signOuts, 0);

      await tester.tap(find.byKey(const ValueKey('guest-leave-row')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('guest-leave-confirm')));
      await tester.pumpAndSettle();
      expect(auth.status, AuthStatus.unauthenticated);
      expect(repo.signOuts, 1);
    });
  });

  group('GuestSignInScreen', () {
    Future<void> openOverGuest(WidgetTester tester) async {
      usePhone(tester);
      await auth.continueAsGuest();
      await tester.pumpWidget(
        host(
          Builder(
            builder: (context) => Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () => unawaited(GuestSignInScreen.open(context)),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(find.text('Sign in to keep your chats'), findsOneWidget);
    }

    testWidgets('stays open as the guest after a cancelled sign-in', (
      tester,
    ) async {
      await openOverGuest(tester);
      repo.socialResult = () async => null;

      await tester.tap(find.text('Continue with Google'));
      await tester.pumpAndSettle();

      expect(find.text('Sign in to keep your chats'), findsOneWidget);
      expect(auth.isGuest, isTrue);
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows a failed sign-in and stays open', (tester) async {
      await openOverGuest(tester);
      repo.socialResult = () async =>
          throw const AuthException('Could not sign in. Please try again.');

      await tester.tap(find.text('Continue with GitHub'));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('guestSignInError')), findsOneWidget);
      expect(find.text('Sign in to keep your chats'), findsOneWidget);
    });

    testWidgets('disables the providers while signing in', (tester) async {
      await openOverGuest(tester);
      final pending = Completer<SocialSignInResult?>();
      repo.socialResult = () => pending.future;

      await tester.tap(find.text('Continue with Google'));
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      final google = tester.widget<FilledButton>(
        find.ancestor(
          of: find.text('Continue with Google'),
          matching: find.byType(FilledButton),
        ),
      );
      expect(google.onPressed, isNull);

      pending.complete(null);
      await tester.pumpAndSettle();
    });

    for (final outcome in ['signed in', 'two-factor']) {
      testWidgets('closes itself once the session is no longer a guest '
          '($outcome)', (tester) async {
        await openOverGuest(tester);
        repo.socialResult = () async => outcome == 'signed in'
            ? SocialSignInSuccess(_member)
            : const SocialSignInTwoFactorRequired(
                challenge: 'c',
                verifier: 'v',
              );

        await tester.tap(find.text('Continue with Google'));
        await tester.pumpAndSettle();

        expect(find.text('Sign in to keep your chats'), findsNothing);
        expect(find.text('Open'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  });
}

final class _GuestRepository implements AuthRepository, GuestSessionRepository {
  bool available = false;
  int signOuts = 0;
  Future<SocialSignInResult?> Function() socialResult = () async =>
      SocialSignInSuccess(_member);

  @override
  Future<bool> guestSessionAvailable() async => available;

  @override
  Future<AuthSession> continueAsGuest() async => stored = _guest;

  /// The session the app holds; a failed sign-in re-checks it.
  AuthSession? stored;

  @override
  Future<AuthSession?> restoreSession() async => stored;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => _member;

  @override
  Future<void> signOut() async => signOuts++;

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) =>
      socialResult();

  @override
  Future<SocialSignInResult?> signInWithApple() => socialResult();

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async => _member;
}
