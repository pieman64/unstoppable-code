import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/services/desktop_app/desktop_app_prompt_policy.dart';

void main() {
  group('DesktopPairing.of', () {
    test('disconnected means no desktop once the probe has answered', () {
      expect(
        DesktopPairing.of(
          RemoteConnectionStatus.disconnected,
          hasProbedSession: true,
        ),
        DesktopPairing.none,
      );
    });

    test('disconnected before the probe answers is unknown', () {
      expect(
        DesktopPairing.of(
          RemoteConnectionStatus.disconnected,
          hasProbedSession: false,
        ),
        DesktopPairing.unknown,
      );
    });

    for (final status in [
      RemoteConnectionStatus.connecting,
      RemoteConnectionStatus.connected,
      // A paired desktop that is offline or failed to connect (CAN-4426).
      RemoteConnectionStatus.error,
    ]) {
      for (final probed in [true, false]) {
        test('${status.name} counts as paired (probed: $probed)', () {
          expect(
            DesktopPairing.of(status, hasProbedSession: probed),
            DesktopPairing.paired,
          );
        });
      }
    }
  });

  group('canOfferDesktopApp', () {
    test('a signed-in account with no desktop can be offered it', () {
      expect(
        canOfferDesktopApp(
          accountScope: 'production:7',
          pairing: DesktopPairing.none,
        ),
        isTrue,
      );
    });

    test('nobody signed in is never offered it', () {
      expect(
        canOfferDesktopApp(accountScope: null, pairing: DesktopPairing.none),
        isFalse,
      );
    });

    for (final pairing in [DesktopPairing.unknown, DesktopPairing.paired]) {
      test('pairing ${pairing.name} is never offered it', () {
        expect(
          canOfferDesktopApp(accountScope: 'production:7', pairing: pairing),
          isFalse,
        );
      });
    }
  });
}
