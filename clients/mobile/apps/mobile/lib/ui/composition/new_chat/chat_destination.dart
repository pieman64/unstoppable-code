import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';

/// Where a new chat runs (CAN-2932): Cloud, or one of the paired computers.
/// The choice belongs to the draft; a started chat never moves.
sealed class ChatDestination {
  const ChatDestination();

  /// Stable identity, persisted as the last destination a chat started on.
  String get id;

  /// The name the destination control and its picker show.
  String get name;
}

final class CloudChatDestination extends ChatDestination {
  const CloudChatDestination();

  static const String cloudId = 'cloud';

  @override
  String get id => cloudId;

  @override
  String get name => 'Cloud';
}

/// Whether a paired computer can take a new chat now.
enum ComputerAvailability {
  online,

  /// Paired, but its desktop app is not answering.
  offline,

  /// Remembered from the last chat, while the pairing is still being
  /// restored.
  connecting,
}

final class ComputerChatDestination extends ChatDestination {
  const ComputerChatDestination({
    required this.name,
    required this.availability,
  });

  static const String _idPrefix = 'computer:';

  @override
  final String name;

  final ComputerAvailability availability;

  @override
  String get id => '$_idPrefix$name';

  /// The computer name a stored [id] refers to; null for other ids.
  static String? nameFromId(String id) =>
      id.startsWith(_idPrefix) ? id.substring(_idPrefix.length) : null;
}

/// The computers a new chat can run on. The phone pairs with one computer
/// today; pairing several is CAN-4425.
///
/// A paired computer whose heartbeat lapsed stays listed as offline: it
/// comes back without pairing again (CAN-2651).
List<ComputerChatDestination> pairedComputers({
  required RemoteConnection? connection,
  required RemotePortalConnectionStatus? status,
}) {
  if (connection == null) return const [];
  final offline = switch (status) {
    RemotePortalConnectionStatus.reconnecting ||
    RemotePortalConnectionStatus.inactive ||
    RemotePortalConnectionStatus.ended => true,
    RemotePortalConnectionStatus.pending ||
    RemotePortalConnectionStatus.active ||
    null => false,
  };
  return [
    ComputerChatDestination(
      name: connection.deviceLabel,
      availability: offline
          ? ComputerAvailability.offline
          : ComputerAvailability.online,
    ),
  ];
}

/// The destination a draft opens on for [id], the user's pick or the last
/// chat's destination: that computer while it is paired, Cloud otherwise.
///
/// While the pairing is still being [restoring], a remembered computer shows
/// as connecting rather than falling back to Cloud.
ChatDestination resolveChatDestination({
  required String? id,
  required List<ComputerChatDestination> computers,
  required bool restoring,
}) {
  if (id == null) return const CloudChatDestination();
  for (final computer in computers) {
    if (computer.id == id) return computer;
  }
  final name = ComputerChatDestination.nameFromId(id);
  if (name != null && restoring && computers.isEmpty) {
    return ComputerChatDestination(
      name: name,
      availability: ComputerAvailability.connecting,
    );
  }
  return const CloudChatDestination();
}
