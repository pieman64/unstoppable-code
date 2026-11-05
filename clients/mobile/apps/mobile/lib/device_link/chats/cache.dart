import '../cache/observable_lru.dart';
import 'state.dart';

/// One computer's desktop-owned chat projections. Account composition owns
/// the containing repository; nothing here is shared across computers.
final class DeviceChatCache {
  DeviceChatCache({int maxEntries = 20, int maxWeight = 8 * 1024 * 1024})
    : _store = ObservableLru<String, DeviceChatState>(
        maxEntries: maxEntries,
        maxWeight: maxWeight,
        weigh: _weigh,
      );

  final ObservableLru<String, DeviceChatState> _store;
  Stream<String> get updates => _store.updates;
  Iterable<DeviceChatState> get states => [
    for (final key in _store.keys) _store.peek(key)!,
  ];
  DeviceChatState? peek(String key) => _store.peek(key);
  DeviceChatState? read(String key) => _store.read(key);
  void Function() retain(String key) => _store.retain(key);
  void put(DeviceChatState state) => _store.put(state.ref.key, state);
  Future<void> close() => _store.close();

  /// A fresh tail at the same transcript revision must not throw away older
  /// pages already loaded. A new revision replaces the cached transcript.
  void hydrate(DeviceChatState next) {
    final previous = peek(next.ref.key);
    if (previous != null &&
        previous.transcriptRevision == next.transcriptRevision &&
        next.messages.isNotEmpty) {
      final boundary = previous.messages.indexWhere(
        (message) => message.id == next.messages.first.id,
      );
      if (boundary > 0) {
        next.messages.insertAll(0, previous.messages.take(boundary));
        next.before = previous.before;
      }
    }
    put(next);
  }

  static int _weigh(DeviceChatState state) => payloadWeight([
    state.ref.key,
    state.tab,
    state.runtime,
    state.scope.tabs,
    state.scope.runtime,
    state.scope.questions,
    state.scope.approvals,
    for (final message in state.messages) message.raw,
  ]);
}
