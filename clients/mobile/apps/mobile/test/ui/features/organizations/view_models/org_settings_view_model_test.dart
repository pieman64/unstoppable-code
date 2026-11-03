import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/org_settings_repository.dart';
import 'package:mobile/ui/features/organizations/view_models/org_settings_view_model.dart';

void main() {
  group('OrgSettingsViewModel', () {
    OrgSettingsViewModel build({
      OrganizationRole viewerRole = OrganizationRole.admin,
    }) => OrgSettingsViewModel(
      repository: MockOrgSettingsRepository(
        latency: Duration.zero,
        viewerRole: viewerRole,
      ),
    );

    test('load populates the organization and clears loading', () async {
      final vm = build();
      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.organization, isNotNull);
      expect(vm.error, isNull);
      expect(vm.enforcedSync.plans, isTrue);
      expect(vm.githubConnection.connected, isTrue);
    });

    test('an admin or owner viewer can edit; a member cannot', () async {
      final admin = build();
      await admin.load();
      expect(admin.canEditSettings, isTrue);

      final owner = build(viewerRole: OrganizationRole.owner);
      await owner.load();
      expect(owner.canEditSettings, isTrue);

      final member = build(viewerRole: OrganizationRole.member);
      await member.load();
      expect(member.canEditSettings, isFalse);
    });

    test('isScopeEnforced reads each scope from the current set', () async {
      final vm = build();
      await vm.load();

      expect(vm.isScopeEnforced(EnforcedSyncScope.plans), isTrue);
      expect(vm.isScopeEnforced(EnforcedSyncScope.transcripts), isFalse);
      expect(vm.isScopeEnforced(EnforcedSyncScope.metadata), isFalse);
    });

    test('isScopeEnforced treats unset scopes as not enforced', () async {
      final vm = OrgSettingsViewModel(repository: _UnsetScopesRepository());
      await vm.load();

      expect(vm.isScopeEnforced(EnforcedSyncScope.transcripts), isFalse);
      expect(vm.isScopeEnforced(EnforcedSyncScope.summaries), isFalse);
      expect(vm.isScopeEnforced(EnforcedSyncScope.plans), isFalse);
      expect(vm.isScopeEnforced(EnforcedSyncScope.metadata), isFalse);
    });

    test('summaries is a first-class settable scope', () async {
      final vm = OrgSettingsViewModel(
        repository: MockOrgSettingsRepository(
          latency: Duration.zero,
          enforcedSync: const EnforcedSyncScopes(
            transcripts: null,
            plans: null,
            metadata: null,
            summaries: null,
          ),
        ),
      );
      await vm.load();
      expect(vm.isScopeEnforced(EnforcedSyncScope.summaries), isFalse);

      await vm.setScopeEnforced(EnforcedSyncScope.summaries, true);

      expect(vm.isScopeEnforced(EnforcedSyncScope.summaries), isTrue);
      expect(vm.enforcedSync.summaries, isTrue);
    });

    test('setScopeEnforced toggles one scope and refetches', () async {
      final vm = build();
      await vm.load();

      await vm.setScopeEnforced(EnforcedSyncScope.transcripts, true);

      expect(vm.isScopeEnforced(EnforcedSyncScope.transcripts), isTrue);
      // The other scopes are preserved (full-replacement built from current).
      expect(vm.isScopeEnforced(EnforcedSyncScope.plans), isTrue);
      expect(vm.isBusy, isFalse);
    });

    test('toggling one scope preserves a required summaries policy it did not '
        'touch', () async {
      final vm = OrgSettingsViewModel(
        repository: MockOrgSettingsRepository(
          latency: Duration.zero,
          enforcedSync: const EnforcedSyncScopes(
            transcripts: null,
            plans: null,
            metadata: null,
            summaries: true,
          ),
        ),
      );
      await vm.load();

      await vm.setScopeEnforced(EnforcedSyncScope.plans, true);

      expect(vm.enforcedSync.plans, isTrue);
      // Not dropped to null by the unrelated toggle: the server reads a
      // missing scope as unset, so dropping it here would rewrite a policy
      // this toggle never touched.
      expect(vm.enforcedSync.summaries, isTrue);
    });

    test(
      'toggling one scope preserves a prohibited summaries policy verbatim',
      () async {
        final vm = OrgSettingsViewModel(
          repository: MockOrgSettingsRepository(
            latency: Duration.zero,
            enforcedSync: const EnforcedSyncScopes(
              transcripts: null,
              plans: null,
              metadata: null,
              // false = PROHIBITED, which must survive as false and never be
              // flattened to null (member's choice) or flipped to true.
              summaries: false,
            ),
          ),
        );
        await vm.load();

        await vm.setScopeEnforced(EnforcedSyncScope.transcripts, true);

        expect(vm.enforcedSync.transcripts, isTrue);
        expect(vm.enforcedSync.summaries, isFalse);
        expect(vm.isScopeEnforced(EnforcedSyncScope.summaries), isFalse);
      },
    );

    test('toggling summaries preserves every other scope verbatim', () async {
      final vm = OrgSettingsViewModel(
        repository: MockOrgSettingsRepository(
          latency: Duration.zero,
          enforcedSync: const EnforcedSyncScopes(
            transcripts: false,
            plans: true,
            metadata: null,
            summaries: null,
          ),
        ),
      );
      await vm.load();

      await vm.setScopeEnforced(EnforcedSyncScope.summaries, true);

      expect(vm.enforcedSync.summaries, isTrue);
      expect(vm.enforcedSync.transcripts, isFalse);
      expect(vm.enforcedSync.plans, isTrue);
      expect(vm.enforcedSync.metadata, isNull);
    });

    test('disconnectGitHub clears the connection and refetches', () async {
      final vm = build();
      await vm.load();

      await vm.disconnectGitHub();

      expect(vm.githubConnection.connected, isFalse);
      expect(vm.githubConnection.accountLogin, isNull);
    });

    test('load reports an error when the fetch fails', () async {
      final vm = OrgSettingsViewModel(repository: _FailingRepository());
      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.error, isNotNull);
      expect(vm.organization, isNull);
      // Getters fall back to safe defaults before a successful load. Scopes
      // fall back to unset (null), not false: false would mean PROHIBITED.
      expect(vm.canEditSettings, isFalse);
      expect(vm.enforcedSync.plans, isNull);
      expect(vm.isScopeEnforced(EnforcedSyncScope.plans), isFalse);
      expect(vm.githubConnection.connected, isFalse);
    });

    test('a mutation surfaces actionError and rethrows on failure', () async {
      final vm = OrgSettingsViewModel(repository: _MutationFailingRepository());

      await expectLater(
        vm.setScopeEnforced(EnforcedSyncScope.plans, true),
        throwsA(isA<StateError>()),
      );
      expect(vm.actionError, isNotNull);
      expect(vm.isBusy, isFalse);
    });

    test(
      'mutation completion after dispose does not notify a dead listener',
      () async {
        final vm = OrgSettingsViewModel(
          repository: MockOrgSettingsRepository(
            latency: const Duration(milliseconds: 1),
          ),
        );
        await vm.load();

        final future = vm.disconnectGitHub();
        vm.dispose();

        await expectLater(future, completes);
      },
    );
  });
}

/// Fails the org fetch, exercising the load error path.
final class _FailingRepository implements OrgSettingsRepository {
  @override
  Future<OrganizationDetail> fetchOrganization() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('fetch failed');
  }

  @override
  Future<EnforcedSyncScopes> setEnforcedSync(EnforcedSyncScopes scopes) =>
      throw UnimplementedError();

  @override
  Future<void> disconnectGitHub() => throw UnimplementedError();
}

/// Succeeds the fetch but fails every mutation, exercising the action-error
/// path.
final class _MutationFailingRepository implements OrgSettingsRepository {
  @override
  Future<OrganizationDetail> fetchOrganization() async =>
      const OrganizationDetail(
        id: 'org-1',
        name: 'Acme',
        viewerRole: OrganizationRole.admin,
        canViewUsageStats: true,
        usageStatsMinRole: OrganizationRole.member,
        enforcedSync: EnforcedSyncScopes(
          transcripts: false,
          plans: false,
          metadata: false,
        ),
        githubConnection: OrganizationGitHubConnectionDetail(
          connected: true,
          accountLogin: 'acme-eng',
        ),
        subTeams: [],
        members: [],
      );

  @override
  Future<EnforcedSyncScopes> setEnforcedSync(EnforcedSyncScopes scopes) async =>
      throw StateError('boom');

  @override
  Future<void> disconnectGitHub() async => throw StateError('boom');
}

/// Returns the protocol's unset (`null`) state for every data-sharing scope.
final class _UnsetScopesRepository implements OrgSettingsRepository {
  @override
  Future<OrganizationDetail> fetchOrganization() async =>
      const OrganizationDetail(
        id: 'org-1',
        name: 'Acme',
        viewerRole: OrganizationRole.admin,
        canViewUsageStats: true,
        usageStatsMinRole: OrganizationRole.member,
        enforcedSync: EnforcedSyncScopes(),
        githubConnection: OrganizationGitHubConnectionDetail(
          connected: false,
          accountLogin: null,
        ),
        subTeams: [],
        members: [],
      );

  @override
  Future<EnforcedSyncScopes> setEnforcedSync(EnforcedSyncScopes scopes) =>
      throw UnimplementedError();

  @override
  Future<void> disconnectGitHub() => throw UnimplementedError();
}
