import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:mobile/data/services/push_messaging.dart';

/// [PushMessaging] backed by the `firebase_messaging` plugin
/// (`FirebaseMessaging.instance`).
///
/// Thin wrapper around the plugin — not unit-tested directly, since doing so
/// would require platform channels. [FakePushMessaging] is used in tests
/// instead. Requires [Firebase.initializeApp] to have already run
/// successfully; see the guarded call in `main.dart`.
final class FirebasePushMessaging implements PushMessaging {
  const FirebasePushMessaging();

  @override
  Future<PushPermissionStatus> requestPermission() async {
    final NotificationSettings settings = await FirebaseMessaging.instance
        .requestPermission();
    // AuthorizationStatus is a closed enum (authorized, denied,
    // notDetermined, provisional) — this switch is already exhaustive, so
    // there is no reachable "any other" case to fall back to notDetermined.
    return switch (settings.authorizationStatus) {
      AuthorizationStatus.authorized => PushPermissionStatus.granted,
      AuthorizationStatus.provisional => PushPermissionStatus.granted,
      AuthorizationStatus.denied => PushPermissionStatus.denied,
      AuthorizationStatus.notDetermined => PushPermissionStatus.notDetermined,
    };
  }

  @override
  Future<String?> getToken() {
    return FirebaseMessaging.instance.getToken();
  }

  @override
  Stream<String> get onTokenRefresh =>
      FirebaseMessaging.instance.onTokenRefresh;

  @override
  Future<void> deleteToken() {
    return FirebaseMessaging.instance.deleteToken();
  }

  static PushMessage _toPushMessage(RemoteMessage message) {
    return PushMessage(
      title: message.notification?.title,
      body: foldPushSubtitle(
        message.notification?.apple?.subtitle,
        message.notification?.body,
      ),
      data: message.data.map((key, value) => MapEntry(key, '$value')),
    );
  }

  @override
  Stream<PushMessage> get onForegroundMessage =>
      FirebaseMessaging.onMessage.map(_toPushMessage);

  @override
  Stream<PushMessage> get onNotificationOpened =>
      FirebaseMessaging.onMessageOpenedApp.map(_toPushMessage);

  @override
  Future<PushMessage?> getInitialMessage() async {
    final RemoteMessage? message = await FirebaseMessaging.instance
        .getInitialMessage();
    return message == null ? null : _toPushMessage(message);
  }
}
