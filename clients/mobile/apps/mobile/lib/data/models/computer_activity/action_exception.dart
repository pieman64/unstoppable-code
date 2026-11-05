/// Error surfaced by Remote Control repository operations. Carries a
/// user-presentable [message] the connect form can show inline.
///
/// Lives below the repository so the repository's delegates can throw it
/// without importing the repository that composes them.
class RemoteControlException implements Exception {
  const RemoteControlException(this.message);

  final String message;

  @override
  String toString() => 'RemoteControlException: $message';
}
