import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';

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

// Guest sessions (CAN-2872).
void main() {
  late _GuestRepository repo;
  late int orgLoads;

  AuthViewModel build() {
    orgLoads = 0;
    return AuthViewModel(
      repository: repo,
      guestSessions: repo,
      loadOrganizations: () async {
        orgLoads++;
        return const AccountOrganizations();
      },
    );
  }

  Future<AuthViewModel> buildGuest() async {
    final vm = build();
    await vm.continueAsGuest();
    expect(vm.isGuest, isTrue);
    return vm;
  }

  setUp(() => repo = _GuestRepository());

  test('loadGuestEntry reports whether the server allows guests', () async {
    final vm = build();
    expect(vm.guestEntryAvailable, isFalse);

    repo.available = true;
    await vm.loadGuestEntry();
    expect(vm.guestEntryAvailable, isTrue);

    repo.available = false;
    await vm.loadGuestEntry();
    expect(vm.guestEntryAvailable, isFalse);
  });

  test('without a guest repository there is no guest entry', () async {
    final vm = AuthViewModel(repository: repo);
    repo.available = true;

    await vm.loadGuestEntry();
    await vm.continueAsGuest();

    expect(vm.guestEntryAvailable, isFalse);
    expect(vm.status, AuthStatus.unknown);
    expect(repo.guestMints, 0);
  });

  test(
    'continueAsGuest signs in as a guest without loading organizations',
    () async {
      final vm = build();
      final statuses = <AuthStatus>[];
      vm.addListener(() => statuses.add(vm.status));

      await vm.continueAsGuest();

      expect(statuses.first, AuthStatus.authenticating);
      expect(vm.status, AuthStatus.authenticated);
      expect(vm.isGuest, isTrue);
      expect(vm.user?.id, '9');
      expect(orgLoads, 0);
      expect(vm.organizationsLoadFailed, isFalse);
    },
  );

  test('a failed guest mint returns to sign-in with the message', () async {
    repo.guestFailure = const AuthException('Could not start a guest session.');
    final vm = build();

    await vm.continueAsGuest();

    expect(vm.status, AuthStatus.unauthenticated);
    expect(vm.errorMessage, 'Could not start a guest session.');
  });

  test('a restored guest session skips organizations', () async {
    repo.restored = _guest;
    final vm = build();

    await vm.restore();

    expect(vm.status, AuthStatus.authenticated);
    expect(vm.isGuest, isTrue);
    expect(orgLoads, 0);
  });

  group('signing in from guest mode', () {
    test('stays authenticated as the guest while the sign-in runs', () async {
      final vm = await buildGuest();
      final pending = Completer<SocialSignInResult?>();
      repo.socialResult = () => pending.future;
      final frames = <(AuthStatus, bool, int)>[];
      vm.addListener(() => frames.add((vm.status, vm.isGuest, orgLoads)));

      final signIn = vm.signInWithSocial(SocialProvider.google);
      expect(vm.isSigningIn, isTrue);
      expect(vm.isGuest, isTrue);
      expect(vm.status, AuthStatus.authenticated);

      pending.complete(SocialSignInSuccess(_member));
      await signIn;

      // Never the sign-in screen, and the account's app only once its
      // organizations have loaded: no organization-less shell in between.
      expect(
        frames.map((frame) => frame.$1),
        isNot(contains(AuthStatus.unauthenticated)),
      );
      expect(
        frames.where(
          (frame) =>
              frame.$1 == AuthStatus.authenticated &&
              !frame.$2 &&
              frame.$3 == 0,
        ),
        isEmpty,
      );
      expect(vm.isSigningIn, isFalse);
      expect(vm.isGuest, isFalse);
      expect(vm.user?.id, '42');
      expect(orgLoads, 1);
    });

    test('recovery remembers the guest origin after token exchange', () async {
      final vm = await buildGuest();
      repo.socialResult = () async => throw const SessionValidationException();
      await vm.signInWithSocial(SocialProvider.google);
      expect(vm.status, AuthStatus.validationFailed);
      repo.restored = _member;
      await vm.restore();
      expect(vm.signedInFromGuestId, '9');
      await vm.restore();
      expect(vm.signedInFromGuestId, '9');
      await vm.signOut();
      expect(vm.signedInFromGuestId, isNull);
    });

    test('a cancelled sign-in returns to the guest app', () async {
      final vm = await buildGuest();
      repo.socialResult = () async => null;

      await vm.signInWithSocial(SocialProvider.google);

      expect(vm.status, AuthStatus.authenticated);
      expect(vm.isGuest, isTrue);
      expect(vm.isSigningIn, isFalse);
    });

    test('a failed sign-in keeps the guest and shows the error', () async {
      final vm = await buildGuest();
      repo.socialResult = () async =>
          throw const AuthException('Could not sign in. Please try again.');

      await vm.signInWithApple();

      expect(vm.status, AuthStatus.authenticated);
      expect(vm.isGuest, isTrue);
      expect(vm.errorMessage, 'Could not sign in. Please try again.');
    });

    test(
      'a failure after the exchange lands where the session really is',
      () async {
        final vm = await buildGuest();
        // The exchange succeeded and merged the guest away, then the account's
        // session failed validation and the store was cleared.
        repo.socialResult = () async {
          repo.restored = null;
          throw const AuthException(
            'Sign-in did not complete. Please try again.',
          );
        };

        await vm.signInWithSocial(SocialProvider.google);

        expect(vm.status, AuthStatus.unauthenticated);
        expect(vm.isGuest, isFalse);
        expect(vm.errorMessage, 'Sign-in did not complete. Please try again.');
      },
    );

    test(
      'a failure that left the account session stored signs that account in',
      () async {
        final vm = await buildGuest();
        repo.socialResult = () async {
          repo.restored = _member;
          throw const AuthException('Could not sign in. Please try again.');
        };

        await vm.signInWithSocial(SocialProvider.google);

        expect(vm.status, AuthStatus.authenticated);
        expect(vm.isGuest, isFalse);
        expect(vm.user?.id, '42');
      },
    );

    test(
      'an unreachable session check offers recovery, not the guest',
      () async {
        final vm = await buildGuest();
        repo.socialResult = () async {
          repo.restoreFailure = const SessionValidationException();
          throw const AuthException('Could not sign in. Please try again.');
        };

        await vm.signInWithSocial(SocialProvider.google);

        expect(vm.status, AuthStatus.validationFailed);
      },
    );

    test('a 401 during the sign-in does not revalidate the session', () async {
      final vm = await buildGuest();
      final pending = Completer<SocialSignInResult?>();
      repo.socialResult = () => pending.future;
      final signIn = vm.signInWithSocial(SocialProvider.google);
      final restoresBefore = repo.restores;

      await vm.revalidateSessionAfterAuthenticationFailure();
      expect(repo.restores, restoresBefore);

      pending.complete(SocialSignInSuccess(_member));
      await signIn;
      expect(vm.user?.id, '42');
    });

    test('abandoning two-factor after the guest is gone signs out', () async {
      final vm = await buildGuest();
      repo.socialResult = () async =>
          const SocialSignInTwoFactorRequired(challenge: 'c', verifier: 'v');
      await vm.signInWithSocial(SocialProvider.github);
      repo.restored = null;

      vm.cancelTwoFactor();
      expect(vm.status, AuthStatus.authenticated);
      await pumpEventQueue();

      expect(vm.status, AuthStatus.unauthenticated);
    });

    test(
      'a two-factor account can be abandoned back to the guest app',
      () async {
        final vm = await buildGuest();
        repo.socialResult = () async =>
            const SocialSignInTwoFactorRequired(challenge: 'c', verifier: 'v');

        await vm.signInWithSocial(SocialProvider.github);
        expect(vm.status, AuthStatus.twoFactorPending);

        vm.cancelTwoFactor();

        expect(vm.status, AuthStatus.authenticated);
        expect(vm.isGuest, isTrue);
      },
    );

    test(
      'remembers the guest it signed in from, also through two-factor',
      () async {
        for (final twoFactor in [false, true]) {
          final vm = await buildGuest();
          repo.socialResult = () async => twoFactor
              ? const SocialSignInTwoFactorRequired(
                  challenge: 'c',
                  verifier: 'v',
                )
              : SocialSignInSuccess(_member);

          await vm.signInWithSocial(SocialProvider.google);
          if (twoFactor) await vm.verifyTwoFactor('123456');

          expect(vm.isGuest, isFalse, reason: 'twoFactor: $twoFactor');
          expect(vm.signedInFromGuestId, '9', reason: 'twoFactor: $twoFactor');

          await vm.signOut();
          expect(vm.signedInFromGuestId, isNull);
        }
      },
    );

    test('a sign-in that did not start from a guest names none', () async {
      final vm = build();
      repo.socialResult = () async => SocialSignInSuccess(_member);

      await vm.signInWithSocial(SocialProvider.google);

      expect(vm.signedInFromGuestId, isNull);
    });

    test('a signed-out sign-in still ends signed out on cancel', () async {
      final vm = build();
      repo.socialResult = () async => null;

      await vm.signInWithSocial(SocialProvider.google);

      expect(vm.status, AuthStatus.unauthenticated);
    });
  });
}

final class _GuestRepository implements AuthRepository, GuestSessionRepository {
  bool available = false;
  AuthException? guestFailure;

  /// What restoreSession reports: the session the app holds, as the real
  /// store would after each call below.
  AuthSession? restored;
  int guestMints = 0;
  int restores = 0;
  Object? restoreFailure;
  Future<SocialSignInResult?> Function() socialResult = () async =>
      SocialSignInSuccess(_member);

  @override
  Future<bool> guestSessionAvailable() async => available;

  @override
  Future<AuthSession> continueAsGuest() async {
    guestMints++;
    final failure = guestFailure;
    if (failure != null) throw failure;
    return restored = _guest;
  }

  @override
  Future<AuthSession?> restoreSession() async {
    restores++;
    final failure = restoreFailure;
    if (failure != null) throw failure;
    return restored;
  }

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => _member;

  @override
  Future<void> signOut() async {}

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
