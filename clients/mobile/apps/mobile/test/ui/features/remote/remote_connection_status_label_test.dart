import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/ui/features/remote/view_models/remote_connection_status_label.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show RemoteLinkState;

void main() {
  group('describeRemoteConnectionStatus', () {
    test('reports a healthy session as connected', () {
      final label = describeRemoteConnectionStatus(
        status: RemotePortalConnectionStatus.active,
      );

      expect(label.text, 'Connected');
      expect(label.tone, RemoteConnectionTone.neutral);
    });

    test('reports an in-flight session as connecting', () {
      final label = describeRemoteConnectionStatus(
        status: RemotePortalConnectionStatus.pending,
      );

      expect(label.text, 'Connecting');
      expect(label.tone, RemoteConnectionTone.neutral);
    });

    test('names the unknown state rather than guessing at health', () {
      final label = describeRemoteConnectionStatus(status: null);

      expect(label.text, 'Checking connection');
      expect(label.tone, RemoteConnectionTone.neutral);
    });

    // The degraded statuses replace the bare `Reconnecting`/`Offline` words
    // with the fact the user actually needs: the projects on screen are a
    // cache, and this is how old it is. The louder "your desktop is away"
    // signal is the degraded banner's job, not this line's.
    for (final status in const [
      RemotePortalConnectionStatus.reconnecting,
      RemotePortalConnectionStatus.inactive,
    ]) {
      test('$status explains the cached data with its age', () {
        final label = describeRemoteConnectionStatus(
          status: status,
          lastSeenAt: DateTime.now().subtract(const Duration(hours: 2)),
        );

        expect(label.text, 'Cached data · Last seen 2h ago');
        expect(label.tone, RemoteConnectionTone.warning);
      });

      test('$status still explains the cached data without a last seen', () {
        final label = describeRemoteConnectionStatus(status: status);

        expect(label.text, 'Cached data');
        expect(label.tone, RemoteConnectionTone.warning);
      });
    }

    // CAN-3557: when this phone's own connection is down, the desktop's last
    // reported status is stale too, so the line explains the cache instead.
    for (final link in const [
      RemoteLinkState.reconnecting,
      RemoteLinkState.unreachable,
    ]) {
      test('$link reports cached data over a live desktop', () {
        final label = describeRemoteConnectionStatus(
          status: RemotePortalConnectionStatus.active,
          lastSeenAt: DateTime.now().subtract(const Duration(hours: 2)),
          linkState: link,
        );

        expect(label.text, 'Cached data');
        expect(label.tone, RemoteConnectionTone.warning);
      });
    }

    test('reports an ended session as disconnected, not merely degraded', () {
      final label = describeRemoteConnectionStatus(
        status: RemotePortalConnectionStatus.ended,
        lastSeenAt: DateTime.now().subtract(const Duration(hours: 2)),
      );

      expect(label.text, 'Disconnected');
      expect(label.tone, RemoteConnectionTone.failed);
    });
  });
}
