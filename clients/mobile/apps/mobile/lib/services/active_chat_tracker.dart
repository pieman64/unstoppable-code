/// Tracks which remote chat transcript, if any, is currently on screen. A
/// plain mutable holder — reads happen on demand, so it does not need to be a
/// [Listenable].
final class ActiveChatTracker {
  String? _activeChatId;
  Object? _owner;

  String? get activeChatId => _activeChatId;

  /// Direct assignment is retained for simple consumers and tests. Screen
  /// lifecycle code should use [claim] and [release] so an offstage route
  /// cannot clear the chat claimed by the route currently on top.
  set activeChatId(String? value) {
    _owner = null;
    _activeChatId = value;
  }

  void claim(Object owner, String? chatId) {
    _owner = owner;
    _activeChatId = chatId;
  }

  void release(Object owner) {
    if (!identical(_owner, owner)) return;
    _owner = null;
    _activeChatId = null;
  }
}
