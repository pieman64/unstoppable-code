import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show RemoteLinkState;

/// How loudly a connection status should read. Kept as an intent rather than a
/// [Color] so this stays a pure, context-free helper the widget maps onto
/// `StatusColors` at paint time.
enum RemoteConnectionTone {
  /// Healthy or merely in-flight — the quiet secondary tier.
  neutral,

  /// The desktop is away and what is on screen is a cache.
  warning,

  /// The session is over; nothing on screen will update.
  failed,
}

/// One line of connection status, ready to render.
class RemoteConnectionStatusLabel {
  const RemoteConnectionStatusLabel({required this.text, required this.tone});

  final String text;
  final RemoteConnectionTone tone;
}

/// Describes [status] as the single status line under the paired device name.
///
/// While this phone's own connection is down ([linkState] is not live), the
/// desktop's last reported status is as stale as everything else on screen,
/// so the line reports the cache instead (CAN-3557).
///
/// The degraded statuses deliberately spend the line on *why the data is
/// stale* rather than on the words `Reconnecting`/`Offline`: the degraded
/// banner already carries the loud signal, so the line the user reads next to
/// their device name is better spent on how old the projects below it are.
RemoteConnectionStatusLabel describeRemoteConnectionStatus({
  required RemotePortalConnectionStatus? status,
  DateTime? lastSeenAt,
  RemoteLinkState linkState = RemoteLinkState.live,
}) {
  if (linkState != RemoteLinkState.live) {
    return const RemoteConnectionStatusLabel(
      text: 'Cached data',
      tone: RemoteConnectionTone.warning,
    );
  }
  switch (status) {
    case RemotePortalConnectionStatus.active:
      return const RemoteConnectionStatusLabel(
        text: 'Connected',
        tone: RemoteConnectionTone.neutral,
      );
    case RemotePortalConnectionStatus.pending:
      return const RemoteConnectionStatusLabel(
        text: 'Connecting',
        tone: RemoteConnectionTone.neutral,
      );
    case null:
      return const RemoteConnectionStatusLabel(
        text: 'Checking connection',
        tone: RemoteConnectionTone.neutral,
      );
    case RemotePortalConnectionStatus.reconnecting:
    case RemotePortalConnectionStatus.inactive:
      return RemoteConnectionStatusLabel(
        text: lastSeenAt == null
            ? 'Cached data'
            : 'Cached data · Last seen ${formatRelativeDate(lastSeenAt)}',
        tone: RemoteConnectionTone.warning,
      );
    case RemotePortalConnectionStatus.ended:
      return const RemoteConnectionStatusLabel(
        text: 'Disconnected',
        tone: RemoteConnectionTone.failed,
      );
  }
}
