import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/incoming_invitations_repository.dart';
import 'package:mobile/ui/features/members/view_models/incoming_invitations_view_model.dart';

/// Repository whose response future resolves only when the test decides, so a
/// response can be held in flight across [IncomingInvitationsViewModel.dispose].
final class _ControllableIncomingRepo implements IncomingInvitationsRepository {
  final Completer<void> completer = Completer<void>();

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() async => const [];

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) => completer.future;
}

void main() {
  group('IncomingInvitationsViewModel', () {
    IncomingInvitationsViewModel build() => IncomingInvitationsViewModel(
      repository: MockIncomingInvitationsRepository(latency: Duration.zero),
    );

    test('load populates invitations and clears loading', () async {
      final vm = build();

      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.invitations, isNotEmpty);
      expect(vm.hasInvitations, isTrue);
      expect(vm.error, isNull);
    });

    test('accept drops the invitation from the list', () async {
      final vm = build();
      await vm.load();
      final id = vm.invitations.first.id;

      await vm.accept(id);

      expect(vm.invitations.where((i) => i.id == id), isEmpty);
    });

    test('decline drops the invitation from the list', () async {
      final vm = build();
      await vm.load();
      final id = vm.invitations.first.id;

      await vm.decline(id);

      expect(vm.invitations.where((i) => i.id == id), isEmpty);
    });

    test(
      'a response resolving after dispose does not notify a disposed notifier',
      () async {
        final repo = _ControllableIncomingRepo();
        final vm = IncomingInvitationsViewModel(repository: repo);

        final pending = vm.accept('x'); // suspended awaiting the repository
        vm.dispose(); // torn down before the response completes

        repo.completer.completeError(StateError('resolved after dispose'));

        // The DisposeSafeNotifier guard means the finally-block notify no-ops
        // instead of throwing "used after being disposed".
        await expectLater(pending, throwsA(isA<StateError>()));
        expect(vm.isDisposed, isTrue);
      },
    );
  });
  group('concurrent and stalled loads', () {
    test('a slow earlier load cannot overwrite a newer successful one: a stale '
        'failure must not wipe an invitation the user can see', () async {
      final repository = _RacingRepo();
      final viewModel = IncomingInvitationsViewModel(repository: repository);

      final stale = viewModel.load();
      final fresh = viewModel.load();
      repository.completeFresh(const [
        IncomingInvitation(
          id: 'x',
          organizationName: 'Globex Labs',
          role: OrganizationRole.member,
        ),
      ]);
      repository.failStale(StateError('stale offline'));
      await Future.wait([stale, fresh]);

      expect(viewModel.invitations, hasLength(1));
      expect(viewModel.error, isNull);
    });

    test(
      'a load that never answers is bounded rather than pending forever',
      () async {
        final viewModel = IncomingInvitationsViewModel(
          repository: _NeverAnsweringRepo(),
          loadTimeout: const Duration(milliseconds: 20),
        );

        await viewModel.load();

        expect(viewModel.isLoading, isFalse);
        expect(viewModel.error, isNotNull);
        expect(viewModel.hasLoaded, isTrue);
      },
    );

    test('hasLoaded stays false until the first load settles', () async {
      final repository = _RacingRepo();
      final viewModel = IncomingInvitationsViewModel(repository: repository);
      expect(viewModel.hasLoaded, isFalse);

      final pending = viewModel.load();
      expect(viewModel.hasLoaded, isFalse);

      repository.completeFresh(const []);
      await pending;

      expect(viewModel.hasLoaded, isTrue);
    });
  });
}

/// Hands out two independently controllable fetches, so a stale request can be
/// made to finish after a newer one.
final class _RacingRepo implements IncomingInvitationsRepository {
  final List<Completer<List<IncomingInvitation>>> _pending = [];

  void completeFresh(List<IncomingInvitation> invitations) =>
      _pending.last.complete(invitations);

  void failStale(Object error) => _pending.first.completeError(error);

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() {
    final completer = Completer<List<IncomingInvitation>>();
    _pending.add(completer);
    return completer.future;
  }

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) async {}
}

final class _NeverAnsweringRepo implements IncomingInvitationsRepository {
  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() =>
      Completer<List<IncomingInvitation>>().future;

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) async {}
}
