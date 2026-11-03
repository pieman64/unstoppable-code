import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/ui/composition/new_chat/chat_destination.dart';

void main() {
  final studio = RemoteConnection(
    deviceLabel: 'Studio',
    pairedAt: DateTime(2026),
  );

  group('pairedComputers (CAN-2932)', () {
    test('is empty without a pairing', () {
      expect(pairedComputers(connection: null, status: null), isEmpty);
    });

    test('lists the paired computer online while its desktop answers', () {
      for (final status in [null, RemotePortalConnectionStatus.active]) {
        final computer = pairedComputers(
          connection: studio,
          status: status,
        ).single;
        expect(computer.name, 'Studio');
        expect(computer.id, 'computer:Studio');
        expect(computer.availability, ComputerAvailability.online);
      }
    });

    test('keeps a computer whose heartbeat lapsed, as offline', () {
      for (final status in [
        RemotePortalConnectionStatus.reconnecting,
        RemotePortalConnectionStatus.inactive,
      ]) {
        expect(
          pairedComputers(
            connection: studio,
            status: status,
          ).single.availability,
          ComputerAvailability.offline,
        );
      }
    });
  });

  group('resolveChatDestination (CAN-2932)', () {
    final online = pairedComputers(connection: studio, status: null);

    test('opens on Cloud when nothing was started yet', () {
      expect(
        resolveChatDestination(id: null, computers: online, restoring: false),
        isA<CloudChatDestination>(),
      );
    });

    test('opens on the last chat\'s computer while it is paired', () {
      expect(
        resolveChatDestination(
          id: 'computer:Studio',
          computers: online,
          restoring: false,
        ),
        same(online.single),
      );
    });

    test('falls back to Cloud once that computer is no longer paired', () {
      expect(
        resolveChatDestination(
          id: 'computer:Studio',
          computers: const [],
          restoring: false,
        ),
        isA<CloudChatDestination>(),
      );
      expect(
        resolveChatDestination(
          id: 'computer:Laptop',
          computers: online,
          restoring: false,
        ),
        isA<CloudChatDestination>(),
      );
    });

    test('shows the remembered computer as connecting while the pairing '
        'is restored', () {
      final destination = resolveChatDestination(
        id: 'computer:Studio',
        computers: const [],
        restoring: true,
      );
      expect(
        destination,
        isA<ComputerChatDestination>()
            .having((d) => d.name, 'name', 'Studio')
            .having(
              (d) => d.availability,
              'availability',
              ComputerAvailability.connecting,
            ),
      );
    });

    test('keeps Cloud for a Cloud id', () {
      expect(
        resolveChatDestination(id: 'cloud', computers: online, restoring: true),
        isA<CloudChatDestination>(),
      );
    });
  });
}
