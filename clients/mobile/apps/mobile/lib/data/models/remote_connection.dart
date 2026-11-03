/// Models for the Remote Control pairing lifecycle: whether the mobile app is
/// connected to a desktop, and the metadata shown once it is.
///
/// These are mobile-local (the pairing/connection handshake is not part of the
/// `PortalSessionShellState` shell payload), so they are hand-written rather
/// than mirrored from `@canopy/protocol`.
library;

import 'package:mobile/data/models/remote_portal_event.dart';

/// Lifecycle of the mobile → desktop Remote Control connection.
enum RemoteConnectionStatus {
  /// No desktop paired; the connect/pairing form is shown.
  disconnected,

  /// A pairing attempt is in flight.
  connecting,

  /// Paired with a desktop; the workspaces list is shown.
  connected,

  /// The most recent connect attempt failed.
  error,
}

/// Metadata about the currently paired desktop, shown in the connected header.
class RemoteConnection {
  const RemoteConnection({
    required this.deviceLabel,
    required this.pairedAt,
    this.connectionStatus,
    this.sessionId,
    this.lastSeenAt,
    this.spaceNotificationSettingsEnabled = false,
  });

  /// Human-friendly label for the paired desktop (e.g. `"Alex's MacBook Pro"`).
  final String deviceLabel;

  /// Opaque server pairing identity, used to scope disposable local caches.
  final String? sessionId;

  /// When the pairing was established.
  final DateTime pairedAt;

  /// Desktop liveness as the server derived it at restore/pair time
  /// (`PortalConnectionStatus`). Carried through so the UI can show a degraded
  /// banner immediately (CAN-2651) instead of waiting for the first event
  /// batch — which, on a session that is stale precisely because the desktop
  /// went quiet, is exactly the wrong thing to wait for. Null when the server
  /// did not report one.
  final RemotePortalConnectionStatus? connectionStatus;

  /// Most recent desktop heartbeat reported by the server. Used to make
  /// cached workspace data explicit while the desktop is unavailable.
  final DateTime? lastSeenAt;

  /// Server-evaluated gate for per-space notification choices (CAN-3615);
  /// absent on older servers, so fail closed.
  final bool spaceNotificationSettingsEnabled;
}
