import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show RemoteLinkState;

/// Degraded-connection banner shown when the desktop's heartbeat has lapsed.
///
/// Mirrors web's degraded banner. The server flags a session whose desktop
/// heartbeat lapsed past 90s as stale (`reconnecting`, then `inactive`) while
/// leaving it revivable, so the cached shell stays on screen behind this
/// banner rather than dropping the user to the pairing form (CAN-2651).
///
/// Extracted from `remote_chat_screen.dart` so the workspace list can show the
/// same state. It offers no action: nothing on the phone can bring an offline
/// desktop back, so the offline message says what to do on the desktop
/// (CAN-4426). The overflow menu's Disconnect still leaves the pairing.
///
/// It also covers this phone's own connection ([linkState], CAN-3557). That
/// takes precedence: while it is down, the desktop's status is stale too.
class RemoteDegradedBanner extends StatelessWidget {
  const RemoteDegradedBanner({
    super.key,
    this.status,
    this.linkState = RemoteLinkState.live,
    this.deviceLabel,
  });

  /// The degraded status being reported. The banner and the connected header
  /// read the same value so they cannot contradict each other — a header
  /// saying `Offline` beside a banner promising a reconnect is worse than
  /// either alone.
  final RemotePortalConnectionStatus? status;

  /// This phone's own event delivery.
  final RemoteLinkState linkState;

  /// The paired desktop's name, used to say which computer to open.
  final String? deviceLabel;

  /// True when [status] means "the desktop is not currently answering", which
  /// is the band this banner covers.
  static bool isDegraded(RemotePortalConnectionStatus? status) =>
      status == RemotePortalConnectionStatus.reconnecting ||
      status == RemotePortalConnectionStatus.inactive;

  /// True when either the desktop or this phone's connection is down.
  static bool shows({
    required RemotePortalConnectionStatus? status,
    required RemoteLinkState linkState,
  }) => linkState != RemoteLinkState.live || isDegraded(status);

  String get _message => switch (linkState) {
    RemoteLinkState.reconnecting => 'Reconnecting…',
    RemoteLinkState.unreachable =>
      "Can't reach the server. Showing cached data.",
    RemoteLinkState.live =>
      status == RemotePortalConnectionStatus.inactive
          ? _offlineMessage
          : 'Desktop is reconnecting…',
  };

  String get _offlineMessage => switch (deviceLabel) {
    final label? when label.isNotEmpty =>
      '$label is offline. Open ${Brand.productDisplayName} on that computer '
          'to reconnect. Showing cached data.',
    _ =>
      'Desktop is offline. Open ${Brand.productDisplayName} on your computer '
          'to reconnect. Showing cached data.',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final warning = StatusColors.of(context).warning;
    return Container(
      key: const ValueKey('remote-degraded-banner'),
      width: double.infinity,
      color: warning.withAlpha(30),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Row(
        children: [
          Icon(Icons.wifi_tethering, size: 14, color: warning),
          const SizedBox(width: 6),
          // The warning tint carries the intent; the copy stays on the
          // guaranteed-contrast foreground so the banner is legible on the
          // subtle tinted background in both color modes.
          Expanded(
            child: Text(
              _message,
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.onSurface,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
