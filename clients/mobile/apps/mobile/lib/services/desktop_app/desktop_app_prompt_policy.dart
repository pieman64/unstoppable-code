import 'package:mobile/data/models/remote_connection.dart';

/// What mobile knows about whether this account works with a desktop.
enum DesktopPairing {
  /// The Remote Control pairing probe has not answered yet.
  unknown,

  /// The probe answered and no desktop is paired.
  none,

  /// A desktop is paired, being paired, or failed to connect. A paired
  /// desktop that is offline still counts.
  paired;

  /// Only `disconnected`
  /// means "no desktop", and only once the probe has answered.
  static DesktopPairing of(
    RemoteConnectionStatus status, {
    required bool hasProbedSession,
  }) {
    if (status != RemoteConnectionStatus.disconnected) return paired;
    return hasProbedSession ? none : unknown;
  }
}

/// Whether the signed-in account may be offered the desktop app at all: the
/// drawer entry shows exactly when this holds, and the one-time prompt also
/// needs the account not to have closed it before.
bool canOfferDesktopApp({
  required String? accountScope,
  required DesktopPairing pairing,
}) => accountScope != null && pairing == DesktopPairing.none;
