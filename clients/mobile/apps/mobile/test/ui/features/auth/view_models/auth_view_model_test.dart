import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import '../../../../support/account_organizations_fixture.dart';

OrganizationSummary _org(String id) => OrganizationSummary(
  id: id,
  name: 'Org $id',
  role: OrganizationRole.member,
  memberCount: 1,
  subTeamCount: 0,
);

void main() {
  group('AuthViewModel', () {
    AuthViewModel build() =>
        AuthViewModel(repository: MockAuthRepository(latency: Duration.zero));

    test(
      'restore retries validation, deduplicates and ignores sign-out races',
      () async {
        final pending = Completer<AuthSession?>();
        final repo = _RecoveryRepository()
          ..restoreResult = () => pending.future;
        final vm = AuthViewModel(repository: repo);
        final first = vm.restore();
        await vm.restore();
        expect(repo.restoreCalls, 1);
        await vm.signOut();
        final session = await MockAuthRepository(
          latency: Duration.zero,
        ).signIn(email: 'a@b.dev', password: 'password');
        pending.complete(session);
        await first;
        expect(vm.status, AuthStatus.unauthenticated);
        expect(vm.user, isNull);
      },
    );

    test(
      'timeout is retryable and a late response cannot replace recovery',
      () async {
        final pending = Completer<AuthSession?>();
        final repo = _RecoveryRepository()
          ..restoreResult = () => pending.future;
        final vm = AuthViewModel(
          repository: repo,
          sessionValidationTimeout: const Duration(milliseconds: 5),
        );
        await vm.restore();
        expect(vm.status, AuthStatus.validationFailed);
        final session = await MockAuthRepository(
          latency: Duration.zero,
        ).signIn(email: 'a@b.dev', password: 'password');
        repo.restoreResult = () async => session;
        await vm.restore();
        pending.complete(null);
        await Future<void>.delayed(Duration.zero);
        expect(vm.status, AuthStatus.authenticated);
        expect(vm.user?.id, session.user.id);
      },
    );

    test('disposed restoration ignores completion', () async {
      final pending = Completer<AuthSession?>();
      final repo = _RecoveryRepository()..restoreResult = () => pending.future;
      final vm = AuthViewModel(repository: repo);
      final restoration = vm.restore();
      vm.dispose();
      pending.complete(null);
      await restoration;
    });

    for (final flow in ['social', 'apple', 'two-factor']) {
      test(
        '$flow post-exchange interruption recovers through restore',
        () async {
          final repo = _RecoveryRepository();
          final vm = AuthViewModel(repository: repo);
          if (flow == 'apple') {
            await vm.signInWithApple();
          } else if (flow == 'social') {
            await vm.signInWithSocial(SocialProvider.google);
          } else {
            repo.twoFactor = true;
            await vm.signInWithSocial(SocialProvider.google);
            await vm.verifyTwoFactor('123456');
          }
          expect(vm.status, AuthStatus.validationFailed);
          expect(vm.user, isNull);
          final session = await MockAuthRepository(
            latency: Duration.zero,
          ).signIn(email: 'a@b.dev', password: 'password');
          repo.restoreResult = () async => session;
          await vm.restore();
          expect(vm.status, AuthStatus.authenticated);
          expect(repo.restoreCalls, 1);
        },
      );
    }

    for (final invalid in [false, true]) {
      test('organization 401 revalidation invalid=$invalid', () async {
        final repo = _RecoveryRepository();
        final session = await MockAuthRepository(
          latency: Duration.zero,
        ).signIn(email: 'a@b.dev', password: 'password');
        repo.restoreResult = () async => session;
        var fail = false;
        final vm = AuthViewModel(
          repository: repo,
          loadOrganizations: teamsOnly(() async {
            if (fail) throw const ApiException(statusCode: 401, body: '');
            return [_org('org-1')];
          }),
        );
        await vm.restore();
        fail = true;
        repo.restoreResult = () async {
          if (invalid) return null;
          throw const SessionValidationException();
        };
        await vm.reloadOrganizations();
        expect(
          vm.status,
          invalid ? AuthStatus.unauthenticated : AuthStatus.authenticated,
        );
        expect(repo.signOutCalls, invalid ? 1 : 0);
      });
    }

    for (final outcome in ['valid', 'invalid', 'unreachable']) {
      test('resource authentication recovery: $outcome', () async {
        final repo = _RecoveryRepository();
        final session = await MockAuthRepository(
          latency: Duration.zero,
        ).signIn(email: 'a@b.dev', password: 'password');
        repo.restoreResult = () async => session;
        final vm = AuthViewModel(repository: repo);
        await vm.restore();

        repo.restoreResult = switch (outcome) {
          'valid' => () async => session,
          'invalid' => () async => null,
          _ => () async => throw const SessionValidationException(),
        };
        await vm.revalidateSessionAfterAuthenticationFailure();

        expect(
          vm.status,
          outcome == 'invalid'
              ? AuthStatus.unauthenticated
              : AuthStatus.authenticated,
        );
        expect(repo.signOutCalls, outcome == 'invalid' ? 1 : 0);
      });
    }

    test('starts in unknown status with no user', () {
      final vm = build();
      expect(vm.status, AuthStatus.unknown);
      expect(vm.user, isNull);
    });

    test('restore with no persisted session -> unauthenticated', () async {
      final vm = build();
      await vm.restore();
      expect(vm.status, AuthStatus.unauthenticated);
      expect(vm.user, isNull);
    });

    test(
      'restore with no persisted session clears organization state',
      () async {
        final repository = MockAuthRepository(latency: Duration.zero);
        final vm = AuthViewModel(
          repository: repository,
          loadOrganizations: teamsOnly(
            () async => [_org('org-1'), _org('org-2')],
          ),
        );
        await vm.signIn(email: 'alex@canopy.dev', password: 'password');
        vm.switchOrg('org-1');
        expect(vm.organizations, hasLength(2));
        vm.switchOrg('org-1');
        expect(vm.activeOrgId, 'org-1');

        await repository.signOut();
        await vm.restore();

        expect(vm.status, AuthStatus.unauthenticated);
        expect(vm.user, isNull);
        expect(vm.organizations, isEmpty);
        expect(vm.activeOrgId, isNull);
      },
    );

    test('signIn with valid credentials -> authenticated with user', () async {
      final vm = build();
      await vm.signIn(email: 'alex@canopy.dev', password: 'password');
      expect(vm.status, AuthStatus.authenticated);
      expect(vm.user, isNotNull);
      expect(vm.user?.email, 'alex@canopy.dev');
      expect(vm.errorMessage, isNull);
    });

    test('signIn with wrong password -> unauthenticated with error', () async {
      final vm = build();
      await vm.signIn(email: 'alex@canopy.dev', password: 'nope');
      expect(vm.status, AuthStatus.unauthenticated);
      expect(vm.user, isNull);
      expect(vm.errorMessage, 'Invalid email or password');
    });

    test('signIn with empty email -> unauthenticated with error', () async {
      final vm = build();
      await vm.signIn(email: '   ', password: 'password');
      expect(vm.status, AuthStatus.unauthenticated);
      expect(vm.errorMessage, 'Invalid email or password');
    });

    test('restore after a successful signIn -> authenticated', () async {
      final repository = MockAuthRepository(latency: Duration.zero);
      final vm = AuthViewModel(repository: repository);
      await vm.signIn(email: 'alex@canopy.dev', password: 'password');
      expect(vm.status, AuthStatus.authenticated);

      // A fresh view model over the same repository restores the session.
      final restored = AuthViewModel(repository: repository);
      await restored.restore();
      expect(restored.status, AuthStatus.authenticated);
      expect(restored.user?.email, 'alex@canopy.dev');
    });

    test('signOut -> unauthenticated and clears the user', () async {
      final vm = build();
      await vm.signIn(email: 'alex@canopy.dev', password: 'password');
      expect(vm.status, AuthStatus.authenticated);

      await vm.signOut();
      expect(vm.status, AuthStatus.unauthenticated);
      expect(vm.user, isNull);
    });

    test('signOut runs beforeSignOut before repository signOut', () async {
      final calls = <String>[];
      final vm = AuthViewModel(
        repository: _RecordingSignOutRepository(
          onSignOut: () => calls.add('repository'),
        ),
        beforeSignOut: () async => calls.add('before'),
      );

      await vm.signOut();

      expect(calls, ['before', 'repository']);
      expect(vm.status, AuthStatus.unauthenticated);
    });

    test('signOut continues when beforeSignOut fails', () async {
      final calls = <String>[];
      final vm = AuthViewModel(
        repository: _RecordingSignOutRepository(
          onSignOut: () => calls.add('repository'),
        ),
        beforeSignOut: () async {
          calls.add('before');
          throw StateError('cleanup failed');
        },
      );

      await vm.signOut();

      expect(calls, ['before', 'repository']);
      expect(vm.status, AuthStatus.unauthenticated);
    });

    test('signInWithSocial with a session -> authenticated', () async {
      final vm = build();
      await vm.signInWithSocial(SocialProvider.github);
      expect(vm.status, AuthStatus.authenticated);
      expect(vm.user, isNotNull);
    });

    test('signInWithSocial cancelled -> unauthenticated, no error', () async {
      final vm = AuthViewModel(repository: _CancelSocialRepository());
      await vm.signInWithSocial(SocialProvider.google);
      expect(vm.status, AuthStatus.unauthenticated);
      expect(vm.errorMessage, isNull);
    });

    test('signInWithApple with a session -> authenticated', () async {
      final session = AuthSession(
        token: 'apple-token',
        user: AuthUser(
          id: 'apple-user',
          email: 'apple.user@example.com',
          emailVerified: true,
          name: 'Apple User',
          image: null,
          role: 'DEVELOPER',
          status: 'ACTIVE',
          twoFactorEnabled: false,
          createdAt: '',
          updatedAt: '',
        ),
      );
      final vm = AuthViewModel(
        repository: _AppleRepository(SocialSignInSuccess(session)),
      );
      await vm.signInWithApple();
      expect(vm.status, AuthStatus.authenticated);
      expect(vm.user?.email, 'apple.user@example.com');
    });

    test('signInWithApple cancelled -> unauthenticated, no error', () async {
      final vm = AuthViewModel(repository: _AppleRepository(null));
      await vm.signInWithApple();
      expect(vm.status, AuthStatus.unauthenticated);
      expect(vm.errorMessage, isNull);
    });

    test('signInWithApple with 2FA required -> twoFactorPending', () async {
      final vm = AuthViewModel(
        repository: _AppleRepository(
          const SocialSignInTwoFactorRequired(
            challenge: 'chal-xyz',
            verifier: 'verifier-1',
          ),
        ),
      );
      await vm.signInWithApple();
      expect(vm.status, AuthStatus.twoFactorPending);
      expect(vm.errorMessage, isNull);
    });

    group('CAN-4429 workspace context', () {
      test(
        'CAN-4429 a fresh account with organizations starts in Personal',
        () async {
          final vm = AuthViewModel(
            repository: MockAuthRepository(latency: Duration.zero),
            loadOrganizations: teamsOnly(
              () async => [_org('org-a'), _org('org-b')],
            ),
          );
          await vm.signIn(email: 'a@b.dev', password: 'password');

          expect(vm.status, AuthStatus.authenticated);
          expect(vm.organizations, hasLength(2));
          // List order is not a decision source; nothing is saved yet.
          expect(vm.activeOrgId, isNull);
        },
      );

      test(
        'CAN-4429 losing the selected organization falls back to Personal',
        () async {
          var calls = 0;
          final vm = AuthViewModel(
            repository: MockAuthRepository(latency: Duration.zero),
            loadOrganizations: teamsOnly(
              () async => ++calls == 1
                  ? [_org('org-a'), _org('org-b')]
                  : [_org('org-b')],
            ),
          );
          await vm.signIn(email: 'a@b.dev', password: 'password');
          vm.switchOrg('org-a');
          expect(vm.activeOrgId, 'org-a');

          await vm.reloadOrganizations();

          expect(vm.organizations.map((org) => org.id), ['org-b']);
          expect(vm.activeOrgId, isNull);
        },
      );
    });

    test('a single team without Personal still starts in Personal', () async {
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async => [_org('org-7')]),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      expect(vm.activeOrgId, isNull);
      // No Personal organization, so there is no Personal Activity to show.
      expect(vm.isPersonalActive, isFalse);
    });

    test('Personal is selected first and stays apart from teams', () async {
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: () async => AccountOrganizations(
          organizations: [_org('org-1')],
          personalOrganizationId: 'personal-1',
        ),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');

      expect(vm.activeOrgId, isNull);
      expect(vm.personalOrganizationId, 'personal-1');
      expect(vm.isPersonalActive, isTrue);
      expect(vm.activeOrganization, isNull);
      expect(vm.organizations.map((o) => o.id), ['org-1']);

      vm.switchOrg('org-1');
      expect(vm.isPersonalActive, isFalse);
      // The Personal organization is never a team selection.
      vm.switchOrg('personal-1');
      expect(vm.activeOrgId, 'org-1');
      await vm.selectWorkspaceContext(const WorkspaceContext.personal());
      expect(vm.activeOrgId, isNull);
      expect(vm.isPersonalActive, isTrue);
    });

    test('an explicit team choice survives account refresh', () async {
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: () async => AccountOrganizations(
          organizations: [_org('org-1')],
          personalOrganizationId: 'personal-1',
        ),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      vm.switchOrg('org-1');

      await vm.reloadOrganizations();

      expect(vm.activeOrgId, 'org-1');
    });

    test('a replaced Personal id moves the selection to the new one', () async {
      var personal = 'personal-1';
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: () async =>
            AccountOrganizations(personalOrganizationId: personal),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      expect(vm.personalOrganizationId, 'personal-1');

      personal = 'personal-2';
      await vm.reloadOrganizations();

      expect(vm.activeOrgId, isNull);
      expect(vm.personalOrganizationId, 'personal-2');
      expect(vm.isPersonalActive, isTrue);
    });

    test('a promoted Personal organization becomes a team row', () async {
      var promoted = false;
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: () async => promoted
            ? AccountOrganizations(
                organizations: [_org('personal-1')],
                personalOrganizationId: 'personal-2',
              )
            : const AccountOrganizations(personalOrganizationId: 'personal-1'),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');

      promoted = true;
      await vm.reloadOrganizations();

      // Personal stays selected and follows the new Personal organization.
      expect(vm.activeOrgId, isNull);
      expect(vm.organizations.map((o) => o.id), ['personal-1']);
      expect(vm.personalOrganizationId, 'personal-2');
      expect(vm.isPersonalActive, isTrue);
    });

    test('an older account load never overrides a newer one', () async {
      final first = Completer<AccountOrganizations>();
      final second = Completer<AccountOrganizations>();
      var calls = 0;
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: () async {
          calls++;
          if (calls == 1) {
            return const AccountOrganizations(personalOrganizationId: 'p-0');
          }
          return (calls == 2 ? first : second).future;
        },
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      final older = vm.reloadOrganizations();
      final newer = vm.reloadOrganizations();
      second.complete(
        const AccountOrganizations(personalOrganizationId: 'p-2'),
      );
      await newer;
      first.complete(const AccountOrganizations(personalOrganizationId: 'p-1'));
      await older;

      expect(vm.activeOrgId, isNull);
      expect(vm.personalOrganizationId, 'p-2');
    });

    test('sign-out clears the Personal identity', () async {
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: () async =>
            const AccountOrganizations(personalOrganizationId: 'personal-1'),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      await vm.signOut();

      expect(vm.personalOrganizationId, isNull);
      expect(vm.activeOrgId, isNull);
      expect(vm.isPersonalActive, isFalse);
    });

    test('switchOrg changes the active org and notifies listeners', () async {
      var notified = 0;
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(
          () async => [_org('org-1'), _org('org-2')],
        ),
      )..addListener(() => notified++);
      await vm.signIn(email: 'a@b.dev', password: 'password');
      expect(vm.activeOrgId, isNull);

      final before = notified;
      vm.switchOrg('org-2');
      expect(vm.activeOrgId, 'org-2');
      expect(notified, greaterThan(before));
    });

    test('switchOrg ignores unknown orgs and the current org', () async {
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(
          () async => [_org('org-1'), _org('org-2')],
        ),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      vm.switchOrg('org-1');
      expect(vm.activeOrgId, 'org-1');

      vm.switchOrg('org-unknown');
      expect(vm.activeOrgId, 'org-1');
      vm.switchOrg('org-1'); // already active — no-op
      expect(vm.activeOrgId, 'org-1');
    });

    test(
      'applyProfileName updates the cached user name and notifies',
      () async {
        var notified = 0;
        final vm = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
        )..addListener(() => notified++);
        await vm.signIn(email: 'a@b.dev', password: 'password');
        expect(vm.user, isNotNull);
        final before = notified;

        vm.applyProfileName('Ada Lovelace');

        expect(vm.user?.name, 'Ada Lovelace');
        expect(notified, greaterThan(before));
      },
    );

    test('applyProfileName is a no-op when signed out', () {
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
      );

      vm.applyProfileName('Ada');

      expect(vm.user, isNull);
    });

    test(
      'refreshActiveOrg loads a new membership without choosing it',
      () async {
        // No org at sign-in, then one (e.g. after the user accepts an
        // invitation from the no-organization screen). Gaining a membership
        // is not a choice, so the context stays Personal (CAN-4429).
        var calls = 0;
        final vm = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(
            () async =>
                calls++ == 0 ? const <OrganizationSummary>[] : [_org('org-9')],
          ),
        );
        await vm.signIn(email: 'a@b.dev', password: 'password');
        expect(vm.activeOrgId, isNull);
        expect(vm.status, AuthStatus.authenticated);

        await vm.refreshActiveOrg();

        expect(vm.organizations.map((org) => org.id), ['org-9']);
        expect(vm.activeOrgId, isNull);
        expect(vm.status, AuthStatus.authenticated);
      },
    );

    test(
      'reloadOrganizations keeps the active org when it still exists',
      () async {
        var calls = 0;
        final vm = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async {
            calls++;
            // First load: two orgs. Second load: the active org (org-1)
            // survives, so the selection must be preserved.
            return calls == 1
                ? [_org('org-1'), _org('org-2')]
                : [_org('org-2'), _org('org-1')];
          }),
        );
        await vm.signIn(email: 'a@b.dev', password: 'password');
        vm.switchOrg('org-1');
        expect(vm.activeOrgId, 'org-1');

        await vm.reloadOrganizations();

        expect(calls, 2);
        expect(vm.activeOrgId, 'org-1');
        expect(vm.organizations.map((o) => o.id), ['org-2', 'org-1']);
      },
    );

    test(
      'reloadOrganizations falls back to Personal when the active one is gone '
      '(leave/delete)',
      () async {
        var calls = 0;
        final vm = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async {
            calls++;
            // First load: org-1 active. Second load: org-1 removed (left or
            // deleted), so the selection falls back to Personal rather than
            // to whichever org is listed first.
            return calls == 1
                ? [_org('org-1'), _org('org-2')]
                : [_org('org-2'), _org('org-3')];
          }),
        );
        await vm.signIn(email: 'a@b.dev', password: 'password');
        vm.switchOrg('org-1');
        expect(vm.activeOrgId, 'org-1');

        await vm.reloadOrganizations();

        expect(vm.activeOrgId, isNull);
        expect(vm.organizations, hasLength(2));
      },
    );

    test(
      'reloadOrganizations clears the active org when none remain',
      () async {
        var calls = 0;
        final vm = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async {
            calls++;
            return calls == 1 ? [_org('org-1')] : const <OrganizationSummary>[];
          }),
        );
        await vm.signIn(email: 'a@b.dev', password: 'password');
        vm.switchOrg('org-1');
        expect(vm.activeOrgId, 'org-1');

        await vm.reloadOrganizations();

        expect(vm.activeOrgId, isNull);
        expect(vm.organizations, isEmpty);
      },
    );

    test('an empty organization list is a legitimate individual account, not a '
        'load failure (CAN-2576)', () async {
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async => const <OrganizationSummary>[]),
      );

      await vm.signIn(email: 'a@b.dev', password: 'password');

      expect(vm.status, AuthStatus.authenticated);
      expect(vm.activeOrgId, isNull);
      expect(vm.organizationsLoadFailed, isFalse);
    });

    test(
      'a throwing org loader is reported as a load failure, so the shell can '
      'offer Retry instead of nudging a duplicate organization',
      () async {
        final vm = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async => throw StateError('offline')),
        );

        await vm.signIn(email: 'a@b.dev', password: 'password');

        expect(vm.status, AuthStatus.authenticated);
        expect(vm.activeOrgId, isNull);
        expect(vm.organizations, isEmpty);
        expect(vm.organizationsLoadFailed, isTrue);
      },
    );

    test('a successful reload clears a previous load failure', () async {
      var calls = 0;
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async {
          if (calls++ == 0) throw StateError('offline');
          return [_org('org-1')];
        }),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      expect(vm.organizationsLoadFailed, isTrue);

      await vm.refreshActiveOrg();

      expect(vm.organizationsLoadFailed, isFalse);
      expect(vm.organizations.map((org) => org.id), ['org-1']);
    });

    test('signOut clears a pending load failure', () async {
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async => throw StateError('offline')),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      expect(vm.organizationsLoadFailed, isTrue);

      await vm.signOut();

      expect(vm.organizationsLoadFailed, isFalse);
    });

    test('an organization 401 with a valid session stays retryable', () async {
      var calls = 0;
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async {
          if (calls++ == 0) return [_org('org-1')];
          throw const ApiException(statusCode: 401, body: 'unauthorized');
        }),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      expect(vm.status, AuthStatus.authenticated);

      await vm.refreshActiveOrg();

      expect(vm.status, AuthStatus.authenticated);
      expect(vm.organizationsLoadFailed, isTrue);
      expect(vm.activeOrgId, isNull);
    });

    test(
      'a non-401 failure on refresh stays signed in and retryable',
      () async {
        var calls = 0;
        final vm = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async {
            if (calls++ == 0) return [_org('org-1')];
            throw const ApiException(statusCode: 503, body: 'unavailable');
          }),
        );
        await vm.signIn(email: 'a@b.dev', password: 'password');

        await vm.refreshActiveOrg();

        expect(vm.status, AuthStatus.authenticated);
        expect(vm.organizationsLoadFailed, isTrue);
      },
    );

    test('a slow earlier org load cannot overwrite a newer one: repeated Retry '
        'taps resolve last-started-wins, not last-completed-wins', () async {
      var calls = 0;
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async {
          final call = calls++;
          if (call == 0) return const <OrganizationSummary>[];
          if (call == 1) {
            // The stale in-flight request: slow, and it fails.
            await Future<void>.delayed(const Duration(milliseconds: 40));
            throw StateError('stale');
          }
          // The newer request: fast, and it succeeds.
          return [_org('org-9')];
        }),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');

      final stale = vm.refreshActiveOrg();
      final fresh = vm.refreshActiveOrg();
      await Future.wait([stale, fresh]);

      expect(vm.organizations.map((org) => org.id), ['org-9']);
      expect(vm.organizationsLoadFailed, isFalse);
    });

    test('isLoadingOrganizations reports an in-flight reload', () async {
      final completer = Completer<List<OrganizationSummary>>();
      var calls = 0;
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async {
          if (calls++ == 0) return const <OrganizationSummary>[];
          return completer.future;
        }),
      );
      await vm.signIn(email: 'a@b.dev', password: 'password');
      expect(vm.isLoadingOrganizations, isFalse);

      final pending = vm.refreshActiveOrg();
      expect(vm.isLoadingOrganizations, isTrue);

      completer.complete(const <OrganizationSummary>[]);
      await pending;

      expect(vm.isLoadingOrganizations, isFalse);
    });

    test(
      'an org load that never answers is bounded, so a retry spinner cannot '
      'outlive the request and hide the only affordance on the tab',
      () async {
        var calls = 0;
        final vm = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          organizationLoadTimeout: const Duration(milliseconds: 20),
          loadOrganizations: teamsOnly(() async {
            if (calls++ == 0) return const <OrganizationSummary>[];
            return Completer<List<OrganizationSummary>>().future;
          }),
        );
        await vm.signIn(email: 'a@b.dev', password: 'password');

        await vm.refreshActiveOrg();

        expect(vm.organizationsLoadFailed, isTrue);
        expect(vm.isLoadingOrganizations, isFalse);
      },
    );

    test('signInWithSocial with 2FA required -> twoFactorPending', () async {
      final vm = AuthViewModel(repository: _TwoFactorRepository());
      await vm.signInWithSocial(SocialProvider.google);
      expect(vm.status, AuthStatus.twoFactorPending);
      expect(vm.errorMessage, isNull);
    });

    test('verifyTwoFactor with a valid code -> authenticated', () async {
      final vm = AuthViewModel(repository: _TwoFactorRepository());
      await vm.signInWithSocial(SocialProvider.google);
      await vm.verifyTwoFactor('123456');
      expect(vm.status, AuthStatus.authenticated);
      expect(vm.user?.email, '2fa@canopy.dev');
      expect(vm.errorMessage, isNull);
    });

    test('verifyTwoFactor with an invalid code stays pending with an '
        'error', () async {
      final vm = AuthViewModel(repository: _TwoFactorRepository());
      await vm.signInWithSocial(SocialProvider.google);
      await vm.verifyTwoFactor('000000');
      expect(vm.status, AuthStatus.twoFactorPending);
      expect(vm.errorMessage, isNotNull);
    });

    test('cancelTwoFactor -> unauthenticated and clears the error', () async {
      final vm = AuthViewModel(repository: _TwoFactorRepository());
      await vm.signInWithSocial(SocialProvider.google);
      await vm.verifyTwoFactor('000000'); // sets an error message
      vm.cancelTwoFactor();
      expect(vm.status, AuthStatus.unauthenticated);
      expect(vm.errorMessage, isNull);
    });
  });
}

/// Repository whose social sign-in always reports a cancelled flow (null).
class _CancelSocialRepository implements AuthRepository {
  @override
  Future<AuthSession?> restoreSession() async => null;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => throw UnimplementedError();

  @override
  Future<void> signOut() async {}

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async =>
      null;

  @override
  Future<SocialSignInResult?> signInWithApple() => throw UnimplementedError();

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async => throw UnimplementedError();
}

class _RecordingSignOutRepository implements AuthRepository {
  _RecordingSignOutRepository({required this.onSignOut});

  final void Function() onSignOut;

  @override
  Future<AuthSession?> restoreSession() async => null;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => throw UnimplementedError();

  @override
  Future<void> signOut() async => onSignOut();

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async =>
      throw UnimplementedError();

  @override
  Future<SocialSignInResult?> signInWithApple() => throw UnimplementedError();

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async => throw UnimplementedError();
}

/// Repository that reports a 2FA challenge on social sign-in and completes it
/// only when the submitted code equals [validCode].
class _TwoFactorRepository implements AuthRepository {
  static const _validCode = '123456';

  @override
  Future<AuthSession?> restoreSession() async => null;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => throw UnimplementedError();

  @override
  Future<void> signOut() async {}

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async =>
      const SocialSignInTwoFactorRequired(
        challenge: 'chal-xyz',
        verifier: 'verifier-1',
      );

  @override
  Future<SocialSignInResult?> signInWithApple() => throw UnimplementedError();

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async {
    if (code != _validCode) {
      throw const AuthException('That code was not valid. Please try again.');
    }
    return AuthSession(
      token: 'sess-tok',
      user: AuthUser(
        id: '1',
        email: '2fa@canopy.dev',
        emailVerified: true,
        name: 'Two Factor',
        image: null,
        role: 'DEVELOPER',
        status: 'ACTIVE',
        twoFactorEnabled: true,
        createdAt: '',
        updatedAt: '',
      ),
    );
  }
}

/// Repository whose Apple sign-in result is configurable per test — success,
/// cancellation (`null`), or a 2FA challenge, mirroring
/// [_CancelSocialRepository] / [_TwoFactorRepository] but scoped to
/// [AuthRepository.signInWithApple].
class _AppleRepository implements AuthRepository {
  _AppleRepository(this.appleResult);

  final SocialSignInResult? appleResult;

  @override
  Future<AuthSession?> restoreSession() async => null;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => throw UnimplementedError();

  @override
  Future<void> signOut() async {}

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) =>
      throw UnimplementedError();

  @override
  Future<SocialSignInResult?> signInWithApple() async => appleResult;

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async => throw UnimplementedError();
}

final class _RecoveryRepository implements AuthRepository {
  Future<AuthSession?> Function() restoreResult = () async => null;
  int restoreCalls = 0;
  int signOutCalls = 0;
  bool twoFactor = false;
  @override
  Future<AuthSession?> restoreSession() {
    restoreCalls++;
    return restoreResult();
  }

  @override
  Future<void> signOut() async {
    signOutCalls++;
  }

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async {
    if (twoFactor) {
      return const SocialSignInTwoFactorRequired(
        challenge: 'challenge',
        verifier: 'verifier',
      );
    }
    throw const SessionValidationException();
  }

  @override
  Future<SocialSignInResult?> signInWithApple() async =>
      throw const SessionValidationException();
  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async => throw const SessionValidationException();
  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => throw UnimplementedError();
}
