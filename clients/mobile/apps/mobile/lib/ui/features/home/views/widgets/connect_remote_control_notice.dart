import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';

/// Activity's Remote Control setup prompt (CAN-3715).
///
/// Connecting lets a completion notification open its chat directly; it does
/// not change what Activity shows, so the copy promises only that. Shown once
/// the pairing probe has answered that this account has no desktop, the same
/// definition [CloudFirstProjectBinding] uses. Pairing, reconnecting, offline
/// and error states belong to the Remote screen. [onConnect] opens the
/// existing connection steps on the Remote tab.
///
/// The shell passes the connection state and the action, so this widget reads
/// no other feature's model.
class ConnectRemoteControlNotice extends StatelessWidget {
  const ConnectRemoteControlNotice({
    super.key,
    required this.status,
    required this.hasProbedSession,
    required this.onConnect,
  });

  final RemoteConnectionStatus status;

  /// Whether the pairing probe has answered.
  final bool hasProbedSession;

  /// Selects the Remote tab, or null when the shell has no Remote tab.
  final VoidCallback? onConnect;

  @override
  Widget build(BuildContext context) {
    final onConnect = this.onConnect;
    if (status != RemoteConnectionStatus.disconnected ||
        !hasProbedSession ||
        onConnect == null) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InlineNotice(
        key: const ValueKey('activity-connect-remote-control'),
        glyph: CanopyGlyph.devices,
        state: 'Connect Remote Control to open chats from notifications.',
        actions: [
          (
            label: 'Connect',
            glyph: CanopyGlyph.chevronRightMedium,
            onPressed: onConnect,
          ),
        ],
      ),
    );
  }
}
