/// The OS platform reported when registering a push token with the account
/// API's `/api/account/devices` endpoint.
enum DevicePlatform {
  ios,
  android;

  /// The wire value expected by the backend (`IOS` / `ANDROID`).
  String get wire => this == DevicePlatform.ios ? 'IOS' : 'ANDROID';
}
