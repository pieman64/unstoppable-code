import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/incoming_invitations_repository.dart';

void main() {
  group('MockIncomingInvitationsRepository', () {
    MockIncomingInvitationsRepository build() =>
        MockIncomingInvitationsRepository(latency: Duration.zero);

    test('fetchIncomingInvitations returns the seeded invitations', () async {
      final repo = build();

      final invites = await repo.fetchIncomingInvitations();

      expect(invites, isNotEmpty);
    });

    test('respondToInvitation drops the invitation from the list', () async {
      final repo = build();
      final before = await repo.fetchIncomingInvitations();
      final targetId = before.first.id;

      await repo.respondToInvitation(inviteId: targetId, accept: true);

      final after = await repo.fetchIncomingInvitations();
      expect(after.where((i) => i.id == targetId), isEmpty);
    });
  });
}
