import 'dart:convert';

import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/services/api_client.dart';

/// No desktop could take the code: none is waiting for one or heartbeating.
/// The code itself was never checked, so the remedy is on the desktop
/// (CAN-4426). The connect form shows branded copy for it.
final class RemoteNoDesktopForCodeException extends RemoteControlException {
  const RemoteNoDesktopForCodeException()
    : super(
        'Open the desktop app on your computer, turn on Remote Control, then '
        'enter the new code.',
      );
}

/// Maps a rejected `POST .../connect` to a user-presentable failure.
///
/// The no-desktop case keys off the 404's `code` discriminator, never its
/// message text. Other failures keep the server's message, then fall back to
/// copy for the status.
RemoteControlException remotePairingFailure(ApiException exception) {
  if (_isNoDesktopForCode(exception)) {
    return const RemoteNoDesktopForCodeException();
  }
  final serverMessage = apiErrorMessage(exception);
  if (serverMessage != null) return RemoteControlException(serverMessage);
  return RemoteControlException(switch (exception.statusCode) {
    401 ||
    403 => 'That code was not recognized. Check your desktop and try again.',
    404 => 'Remote Control is not available for your account yet.',
    429 => 'Too many attempts. Wait a few minutes and try again.',
    _ => 'Pairing failed. Check your desktop and try again.',
  });
}

bool _isNoDesktopForCode(ApiException exception) {
  if (exception.statusCode != 404) return false;
  try {
    final decoded = jsonDecode(exception.body);
    return decoded is Map<String, dynamic> &&
        decoded['code'] == 'no_eligible_desktop';
  } catch (_) {
    // Non-JSON body.
    return false;
  }
}
