import '../protocol.dart';

// Baseline for the mobile IPC subset. Desktop-wide version bumps can change
// unrelated APIs; each mobile reader and operation handles its own refusals
// and unreadable results instead of imposing an upper connection limit.
const minimumDesktopRemoteProtocolVersion = 7;

int readDesktopRemoteProtocolVersion(Map<String, dynamic> hello) {
  final version = hello['version'];
  final number = version is Map ? version['protocolVersion'] : null;
  if (number is! int || number < 1) {
    throw const DeviceLinkException(
      'The computer sent an unreadable connection version. '
      'Update the desktop app and try again.',
    );
  }
  if (number < minimumDesktopRemoteProtocolVersion) {
    throw DeviceLinkException(
      'Update the desktop app to connect to this computer. '
      'Desktop protocol: $number. '
      'Mobile requires $minimumDesktopRemoteProtocolVersion or later.',
    );
  }
  return number;
}
