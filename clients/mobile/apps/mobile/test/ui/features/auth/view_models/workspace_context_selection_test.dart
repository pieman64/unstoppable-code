// CAN-4429: the saved workspace context in AuthViewModel. Covers restart
// restore, membership fallback, account isolation, failed and slow writes,
// stale reads, and a seeded operation sequence checked against a model.

import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/services/workspace_context_store.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import '../../../../support/account_organizations_fixture.dart';

const _personal = WorkspaceContext.personal();
const _a = WorkspaceContext.organization('org-a');
const _b = WorkspaceContext.organization('org-b');

OrganizationSummary _org(String id) => OrganizationSummary(
  id: id,
  name: 'Org $id',
  role: OrganizationRole.member,
  memberCount: 1,
  subTeamCount: 0,
);

/// Signs in whoever the email names, so tests can switch accounts.
final class _AccountRepository implements AuthRepository {
  AuthSession? _session;

  @override
  Future<AuthSession?> restoreSession() async => _session;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => _session = AuthSession(
    token: 'token-$email',
    user: AuthUser(
      id: email,
      email: email,
      emailVerified: true,
      name: email,
      image: null,
      role: 'DEVELOPER',
      status: 'ACTIVE',
      twoFactorEnabled: false,
      createdAt: '',
      updatedAt: '',
    ),
  );

  @override
  Future<void> signOut() async => _session = null;

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async =>
      null;

  @override
  Future<SocialSignInResult?> signInWithApple() async => null;

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) => throw UnimplementedError();
}

/// A store whose durable map changes only when a write completes. Writes can
/// fail, be delayed or be held open; reads can be held open.
final class _ScriptedStore implements WorkspaceContextStore {
  final Map<String, WorkspaceContext> durable = {};
  final List<String> log = [];
  int failNextWrites = 0;
  Duration Function() writeDelay = () => Duration.zero;
  Completer<void>? readGate;
  Completer<void>? writeGate;
  bool failReads = false;

  @override
  Future<WorkspaceContext?> read(String accountId) async {
    await readGate?.future;
    if (failReads) throw StateError('unreadable');
    return durable[accountId];
  }

  @override
  Future<void> write(String accountId, WorkspaceContext context) async {
    final fail = failNextWrites > 0;
    if (fail) failNextWrites--;
    await writeGate?.future;
    await Future<void>.delayed(writeDelay());
    if (fail) throw StateError('write failed');
    durable[accountId] = context;
    log.add('$accountId=$context');
  }
}

void main() {
  late _ScriptedStore store;
  late Map<String, List<String>> memberships;
  late bool offline;

  setUp(() {
    store = _ScriptedStore();
    offline = false;
    memberships = {
      'u@example.test': ['org-a', 'org-b'],
      'v@example.test': ['org-b'],
    };
  });

  AuthViewModel launch() {
    late final AuthViewModel vm;
    vm = AuthViewModel(
      repository: _AccountRepository(),
      workspaceContextStore: store,
      loadOrganizations: teamsOnly(() async {
        if (offline) throw StateError('offline');
        return [
          for (final id in memberships[vm.user?.id] ?? const <String>[])
            _org(id),
        ];
      }),
    );
    addTearDown(vm.dispose);
    return vm;
  }

  Future<void> settle() =>
      Future<void>.delayed(const Duration(milliseconds: 5));

  group('CAN-4429 saved workspace context', () {
    test('a choice survives a restart for the same account', () async {
      final first = launch();
      await first.signIn(email: 'u@example.test', password: 'p');
      expect(first.workspaceContext, _personal);
      expect(
        await first.selectWorkspaceContext(_a),
        WorkspaceContextSelection.saved,
      );

      final second = launch();
      await second.signIn(email: 'u@example.test', password: 'p');

      expect(second.workspaceContext, _a);
      expect(second.activeOrgId, 'org-a');
    });

    test('a saved organization the user left restores as Personal', () async {
      store.durable['u@example.test'] = _a;
      memberships['u@example.test'] = ['org-b'];

      final vm = launch();
      await vm.signIn(email: 'u@example.test', password: 'p');

      expect(vm.workspaceContext, _personal);
    });

    test('each account keeps its own choice', () async {
      final vm = launch();
      await vm.signIn(email: 'u@example.test', password: 'p');
      await vm.selectWorkspaceContext(_a);
      await vm.signOut();

      await vm.signIn(email: 'v@example.test', password: 'p');
      expect(vm.workspaceContext, _personal);
      await vm.selectWorkspaceContext(_b);
      await vm.signOut();

      await vm.signIn(email: 'u@example.test', password: 'p');
      expect(vm.workspaceContext, _a);
      expect(store.durable, {'u@example.test': _a, 'v@example.test': _b});
    });

    test('an organization outside the membership is refused', () async {
      final vm = launch();
      await vm.signIn(email: 'v@example.test', password: 'p');

      expect(
        await vm.selectWorkspaceContext(_a),
        WorkspaceContextSelection.refused,
      );
      expect(vm.workspaceContext, _personal);
      expect(store.durable, isEmpty);
    });

    test('a failed write keeps the last saved choice', () async {
      final vm = launch();
      await vm.signIn(email: 'u@example.test', password: 'p');
      expect(
        await vm.selectWorkspaceContext(_a),
        WorkspaceContextSelection.saved,
      );

      store.failNextWrites = 1;
      expect(
        await vm.selectWorkspaceContext(_b),
        WorkspaceContextSelection.unsaved,
      );

      // The live selection holds until restart; the saved one is unchanged.
      expect(vm.workspaceContext, _b);
      expect(store.durable['u@example.test'], _a);
    });

    test(
      'a choice replaced before its save lands reports superseded',
      () async {
        final vm = launch();
        await vm.signIn(email: 'u@example.test', password: 'p');
        final delays = [const Duration(milliseconds: 30), Duration.zero];
        store.writeDelay = () => delays.removeAt(0);

        final first = vm.selectWorkspaceContext(_a);
        final second = vm.selectWorkspaceContext(_b);

        expect(await first, WorkspaceContextSelection.superseded);
        expect(await second, WorkspaceContextSelection.saved);
        expect(vm.workspaceContext, _b);
        expect(store.durable['u@example.test'], _b);
      },
    );

    test('a slow earlier write cannot overwrite a later choice', () async {
      final vm = launch();
      await vm.signIn(email: 'u@example.test', password: 'p');
      final delays = [
        const Duration(milliseconds: 30),
        Duration.zero,
        Duration.zero,
      ];
      store.writeDelay = () => delays.removeAt(0);

      final slow = vm.selectWorkspaceContext(_a);
      final fast = vm.selectWorkspaceContext(_b);
      final last = vm.selectWorkspaceContext(_personal);
      await Future.wait([slow, fast, last]);

      expect(store.log, [
        'u@example.test=$_a',
        'u@example.test=$_b',
        'u@example.test=$_personal',
      ]);
      expect(store.durable['u@example.test'], _personal);
    });

    test('a restore read that finishes after sign-out is ignored', () async {
      store.durable['u@example.test'] = _a;
      store.readGate = Completer<void>();
      final vm = launch();
      final signIn = vm.signIn(email: 'u@example.test', password: 'p');
      await settle();
      await vm.signOut();
      store.readGate!.complete();
      await signIn;

      expect(vm.status, AuthStatus.unauthenticated);
      expect(vm.activeOrgId, isNull);
    });

    test('an unreadable preference starts in Personal and is kept', () async {
      store
        ..durable['u@example.test'] = _a
        ..failReads = true;
      final vm = launch();
      await vm.signIn(email: 'u@example.test', password: 'p');

      expect(vm.workspaceContext, _personal);
      expect(store.durable['u@example.test'], _a);
    });

    test('leaving the selected organization saves Personal', () async {
      final vm = launch();
      await vm.signIn(email: 'u@example.test', password: 'p');
      await vm.selectWorkspaceContext(_a);

      memberships['u@example.test'] = ['org-b'];
      await vm.reloadOrganizations();
      await settle();

      expect(vm.workspaceContext, _personal);
      expect(store.durable['u@example.test'], _personal);
    });

    test(
      'a failed membership load keeps the saved choice for the retry',
      () async {
        final vm = launch();
        await vm.signIn(email: 'u@example.test', password: 'p');
        await vm.selectWorkspaceContext(_a);

        final saved = memberships['u@example.test'];
        memberships.remove('u@example.test');
        final failing = AuthViewModel(
          repository: _AccountRepository(),
          workspaceContextStore: store,
          loadOrganizations: teamsOnly(() async {
            final orgs = memberships['u@example.test'];
            if (orgs == null) throw StateError('offline');
            return [for (final id in orgs) _org(id)];
          }),
        );
        addTearDown(failing.dispose);
        await failing.signIn(email: 'u@example.test', password: 'p');
        expect(failing.organizationsLoadFailed, isTrue);
        expect(store.durable['u@example.test'], _a);

        memberships['u@example.test'] = saved!;
        await failing.refreshActiveOrg();
        expect(failing.workspaceContext, _a);
      },
    );

    test(
      'a reload after a failed load keeps a choice whose save is pending',
      () async {
        final vm = launch();
        await vm.signIn(email: 'u@example.test', password: 'p');
        await vm.selectWorkspaceContext(_a);

        store.writeGate = Completer<void>();
        final selectB = vm.selectWorkspaceContext(_b);
        offline = true;
        await vm.reloadOrganizations();
        expect(vm.organizationsLoadFailed, isTrue);

        // The reload succeeds while the save of B is still pending.
        offline = false;
        final reload = vm.reloadOrganizations();
        await settle();
        store.writeGate!.complete();
        await reload;

        expect(await selectB, WorkspaceContextSelection.saved);
        expect(store.durable['u@example.test'], _b);
        expect(vm.workspaceContext, _b);
      },
    );

    test(
      'a choice made while the reload reads the saved one is kept',
      () async {
        final vm = launch();
        await vm.signIn(email: 'u@example.test', password: 'p');
        await vm.selectWorkspaceContext(_b);
        offline = true;
        await vm.reloadOrganizations();

        // Personal is chosen while the reload reads the old saved B and
        // before the save of Personal lands.
        offline = false;
        store.readGate = Completer<void>();
        store.writeGate = Completer<void>();
        final reload = vm.reloadOrganizations();
        await settle();
        final selectPersonal = vm.selectWorkspaceContext(_personal);
        store.readGate!.complete();
        await settle();
        store.writeGate!.complete();
        await reload;

        expect(await selectPersonal, WorkspaceContextSelection.saved);
        expect(store.durable['u@example.test'], _personal);
        expect(vm.workspaceContext, _personal);
      },
    );
  });

  group('CAN-4429 seeded workspace context sequence', () {
    // Seed and operation names are preserved so a failure replays exactly.
    // The later seeds also hold a save while memberships reload.
    for (final (seed, ops) in const [
      (4429, 7),
      (17, 7),
      (2026, 7),
      (4430, 8),
      (31, 8),
      (2027, 8),
    ]) {
      test('seed $seed keeps live and saved choices consistent', () async {
        final random = Random(seed);
        final trace = <String>[];
        var vm = launch();
        String? account;
        // The model of what must be saved and selected.
        final saved = <String, WorkspaceContext>{};
        var selected = _personal;

        WorkspaceContext restored(String id) {
          final choice = saved[id];
          final orgId = choice?.organizationId;
          return orgId != null && memberships[id]!.contains(orgId)
              ? choice!
              : _personal;
        }

        for (var step = 0; step < 60; step++) {
          store.writeDelay = () => Duration(milliseconds: random.nextInt(3));
          final op = random.nextInt(ops);
          switch (op) {
            case 0 || 1:
              final choice = [_personal, _a, _b][random.nextInt(3)];
              final fail = random.nextInt(5) == 0;
              trace.add('select $choice fail=$fail');
              if (account == null) break;
              if (fail) store.failNextWrites = 1;
              final outcome = await vm.selectWorkspaceContext(choice);
              final member =
                  choice.organizationId == null ||
                  memberships[account]!.contains(choice.organizationId);
              expect(
                outcome,
                !member
                    ? WorkspaceContextSelection.refused
                    : fail
                    ? WorkspaceContextSelection.unsaved
                    : WorkspaceContextSelection.saved,
                reason: trace.join('\n'),
              );
              if (!member) {
                store.failNextWrites = 0;
                break;
              }
              selected = choice;
              if (!fail) saved[account] = choice;
            case 2:
              final id = random.nextBool()
                  ? 'u@example.test'
                  : 'v@example.test';
              trace.add('signIn $id');
              if (account != null) await vm.signOut();
              await vm.signIn(email: id, password: 'p');
              account = id;
              selected = restored(id);
            case 3:
              trace.add('signOut');
              await vm.signOut();
              account = null;
              selected = _personal;
            case 4:
              trace.add('restart');
              final id = account;
              vm = launch();
              if (id != null) {
                await vm.signIn(email: id, password: 'p');
                selected = restored(id);
              } else {
                selected = _personal;
              }
            case 5:
              // Toggle membership in B for the signed-in account.
              trace.add('toggle org-b');
              if (account == null) break;
              final orgs = memberships[account]!;
              orgs.contains('org-b') ? orgs.remove('org-b') : orgs.add('org-b');
              final lostSelection = selected == _b && !orgs.contains('org-b');
              await vm.reloadOrganizations();
              await settle();
              if (lostSelection) {
                selected = _personal;
                saved[account] = _personal;
              }
            case 6:
              trace.add('reload');
              if (account == null) break;
              await vm.reloadOrganizations();
            case 7:
              // Select an organization, then lose it or fail the reload
              // before the save lands.
              final orgs = account == null ? null : memberships[account]!;
              if (orgs == null || orgs.isEmpty) break;
              final orgId = orgs[random.nextInt(orgs.length)];
              final choice = WorkspaceContext.organization(orgId);
              final remove = random.nextBool();
              final fail = random.nextInt(5) == 0;
              trace.add('held select $choice remove=$remove fail=$fail');
              if (fail) store.failNextWrites = 1;
              store.writeGate = Completer<void>();
              final outcome = vm.selectWorkspaceContext(choice);
              if (remove) {
                orgs.remove(orgId);
              } else {
                offline = true;
              }
              await vm.reloadOrganizations();
              store.writeGate!.complete();
              store.writeGate = null;
              // The selection result does not depend on the reload.
              expect(
                await outcome,
                fail
                    ? WorkspaceContextSelection.unsaved
                    : WorkspaceContextSelection.saved,
                reason: trace.join('\n'),
              );
              if (!fail) saved[account!] = choice;
              if (remove) {
                await settle();
                selected = _personal;
                saved[account!] = _personal;
                // Rejoin so later steps can choose it again.
                orgs.add(orgId);
                await vm.reloadOrganizations();
              } else {
                expect(
                  vm.workspaceContext,
                  _personal,
                  reason: trace.join('\n'),
                );
                // The next load restores the saved choice.
                offline = false;
                await vm.reloadOrganizations();
                selected = restored(account!);
              }
          }
          await settle();
          final reason = 'seed $seed\n${trace.join('\n')}';
          expect(vm.workspaceContext, selected, reason: reason);
          expect(store.durable, saved, reason: reason);
          final orgId = vm.activeOrgId;
          if (orgId != null) {
            expect(
              vm.organizations.map((org) => org.id),
              contains(orgId),
              reason: reason,
            );
          }
        }
      });
    }
  });
}
