import 'package:mobile/data/models/remote_chat.dart';

/// Tracks locally added and removed tabs, so an older tab-list response
/// cannot close a tab added after it started or bring back one removed
/// after it started.
final class TabListBaselineTracker {
  final Map<(String, RemoteChatScope?), int> _addedAt = {};
  final Map<(String, RemoteChatScope?), ({int mark, int? cursor})> _removedAt =
      {};
  int _mark = 0;

  int get mark => _mark;

  void recordAdditions(
    List<RemoteChatSummary> previous,
    List<RemoteChatSummary> next,
  ) {
    final known = {for (final summary in previous) _key(summary)};
    for (final summary in next) {
      final key = _key(summary);
      _removedAt.remove(key);
      if (!known.contains(key)) _addedAt[key] = ++_mark;
    }
  }

  void recordAddition(RemoteChatSummary summary) {
    _removedAt.remove(_key(summary));
    _addedAt[_key(summary)] = ++_mark;
  }

  /// Records a removal delivered by the event at [cursor], when known.
  void recordRemoval(RemoteChatSummary summary, {int? cursor}) {
    _addedAt.remove(_key(summary));
    _removedAt[_key(summary)] = (mark: ++_mark, cursor: cursor);
  }

  bool addedAfter(RemoteChatSummary summary, int baseline) =>
      (_addedAt[_key(summary)] ?? 0) > baseline;

  /// Whether [summary] was removed after [baseline] by an event the read at
  /// [readCursor] does not include.
  bool removedAfter(
    RemoteChatSummary summary,
    int baseline, {
    int? readCursor,
  }) {
    final removal = _removedAt[_key(summary)];
    if (removal == null || removal.mark <= baseline) return false;
    final cursor = removal.cursor;
    return readCursor == null || cursor == null || cursor > readCursor;
  }

  void clear() {
    _addedAt.clear();
    _removedAt.clear();
  }

  (String, RemoteChatScope?) _key(RemoteChatSummary summary) =>
      (summary.chatId, summary.scope);
}
