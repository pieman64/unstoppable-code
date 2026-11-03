import 'dart:async';

/// Result of asking the OS for notification permission.
enum PushPermissionStatus {
  /// The user granted permission (or it was already granted).
  granted,

  /// The user explicitly denied permission.
  denied,

  /// The user hasn't been asked yet, or the OS hasn't reported a decision
  /// (e.g. iOS provisional authorization).
  notDetermined,
}

/// Normalized push notification message, platform-channel-free so consumers
/// stay independent of the underlying messaging implementation.
final class PushMessage {
  /// Creates a [PushMessage] with an optional title, body, and data payload.
  const PushMessage({this.title, this.body, this.data = const {}});

  /// The notification title, if any.
  final String? title;

  /// The notification body text, if any.
  final String? body;

  /// Additional message data, typically custom payload or metadata.
  final Map<String, String> data;
}

/// Folds an iOS notification subtitle into the body. The server sends the
/// task name as an APNs subtitle on iOS and as the body's first line on
/// Android, so message bodies read the same on both platforms.
String? foldPushSubtitle(String? subtitle, String? body) {
  if (subtitle == null || subtitle.isEmpty) return body;
  if (body == null || body.isEmpty) return subtitle;
  return '$subtitle\n$body';
}

/// Platform-agnostic contract over the underlying push-messaging plugin
/// (Firebase Cloud Messaging), so the app's push lifecycle service is
/// testable without platform channels. The real Firebase-backed
/// implementation lands in a later task; [FakePushMessaging] is the
/// in-memory implementation used in tests until then.
abstract interface class PushMessaging {
  /// Requests notification permission from the OS.
  Future<PushPermissionStatus> requestPermission();

  /// Returns the current device push token, or `null` when one isn't
  /// available yet.
  Future<String?> getToken();

  /// Emits a new token whenever the underlying plugin rotates it.
  Stream<String> get onTokenRefresh;

  /// Deletes the current token (e.g. to stop receiving push on this device).
  Future<void> deleteToken();

  /// Emits [PushMessage]s received while the app is in the foreground.
  Stream<PushMessage> get onForegroundMessage;

  /// Emits [PushMessage]s received when a user taps a notification,
  /// regardless of the app state.
  Stream<PushMessage> get onNotificationOpened;

  /// Returns the message whose notification launched the app from a
  /// terminated state; returns the value at most once per launch.
  Future<PushMessage?> getInitialMessage();
}

/// In-memory [PushMessaging] used in tests (and anywhere else a fake is
/// useful before the real plugin lands). [permissionResult] and [token]
/// configure the values [requestPermission] and [getToken] resolve with;
/// [emitTokenRefresh] drives [onTokenRefresh] manually. [initialMessage]
/// and [emitForegroundMessage]/[emitNotificationOpened] drive the message
/// streams.
final class FakePushMessaging implements PushMessaging {
  FakePushMessaging({
    this.permissionResult = PushPermissionStatus.granted,
    this.token,
    this.getTokenError,
    this.getTokenFailuresRemaining = 0,
    this.deleteTokenError,
  });

  /// The value [requestPermission] resolves with.
  PushPermissionStatus permissionResult;

  /// The value [getToken] resolves with.
  String? token;

  /// Error thrown by [getToken] while [getTokenFailuresRemaining] is positive.
  Object? getTokenError;

  /// Number of [getToken] calls that should throw [getTokenError].
  int getTokenFailuresRemaining;

  /// Error thrown by [deleteToken].
  Object? deleteTokenError;

  /// Number of times [requestPermission] has been called.
  int requestPermissionCallCount = 0;

  /// Number of times [getToken] has been called.
  int getTokenCallCount = 0;

  /// Number of times [deleteToken] has been called.
  int deleteTokenCallCount = 0;

  /// The message that launched the app from a terminated state, or `null`
  /// if there was none.
  PushMessage? initialMessage;

  bool _initialMessageConsumed = false;

  final StreamController<String> _refreshController =
      StreamController<String>.broadcast();

  final StreamController<PushMessage> _foregroundController =
      StreamController<PushMessage>.broadcast();

  final StreamController<PushMessage> _openedController =
      StreamController<PushMessage>.broadcast();

  @override
  Future<PushPermissionStatus> requestPermission() async {
    requestPermissionCallCount++;
    return permissionResult;
  }

  @override
  Future<String?> getToken() async {
    getTokenCallCount++;
    if (getTokenError != null && getTokenFailuresRemaining > 0) {
      getTokenFailuresRemaining--;
      throw getTokenError!;
    }
    return token;
  }

  @override
  Stream<String> get onTokenRefresh => _refreshController.stream;

  @override
  Future<void> deleteToken() async {
    deleteTokenCallCount++;
    if (deleteTokenError != null) {
      throw deleteTokenError!;
    }
    token = null;
  }

  /// Test helper: pushes [newToken] onto [onTokenRefresh] and updates
  /// [token] to match, mirroring how a real refresh leaves [getToken]
  /// returning the new value afterward.
  void emitTokenRefresh(String newToken) {
    token = newToken;
    _refreshController.add(newToken);
  }

  @override
  Stream<PushMessage> get onForegroundMessage => _foregroundController.stream;

  @override
  Stream<PushMessage> get onNotificationOpened => _openedController.stream;

  @override
  Future<PushMessage?> getInitialMessage() async {
    if (_initialMessageConsumed) {
      return null;
    }
    _initialMessageConsumed = true;
    return initialMessage;
  }

  /// Test helper: pushes [message] onto [onForegroundMessage].
  void emitForegroundMessage(PushMessage message) {
    _foregroundController.add(message);
  }

  /// Test helper: pushes [message] onto [onNotificationOpened].
  void emitNotificationOpened(PushMessage message) {
    _openedController.add(message);
  }
}
