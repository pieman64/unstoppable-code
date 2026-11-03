import 'package:flutter/foundation.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';

/// One typed signal for authentication failures from every cloud transport.
///
/// The owning scope uses this to ask `AuthViewModel` for an authoritative
/// session check. Resource-level 401/403 responses never sign the user out
/// directly because the resource or organization may be unavailable while
/// the saved session remains valid.
final class CloudAuthenticationFailures {
  final Set<VoidCallback> _listeners = {};

  void addListener(VoidCallback listener) => _listeners.add(listener);
  void removeListener(VoidCallback listener) => _listeners.remove(listener);

  void report(Object error) {
    if (!_isAuthenticationFailure(error)) return;
    for (final listener in List<VoidCallback>.of(_listeners)) {
      listener();
    }
  }

  static bool _isAuthenticationFailure(Object error) => switch (error) {
    CloudApiException(:final statusCode) =>
      statusCode == 401 || statusCode == 403,
    CloudSendError(:final status) => status == 401 || status == 403,
    CloudEventStreamException(:final kind) =>
      kind == CloudEventStreamErrorKind.authentication,
    _ => false,
  };
}
