import 'dart:async';
import 'dart:collection';

/// Limits outstanding desktop requests without rejecting bursts of reads.
/// A slot covers sending and waiting for the reply; response timeouts start
/// only after admission. Requests are never retried after being sent.
final class DesktopRequestQueue {
  final _waiting = Queue<Completer<void>>();
  int _active = 0;
  Object? _closedError;

  Future<T> run<T>(Future<T> Function() request) async {
    await _acquire();
    try {
      final error = _closedError;
      if (error != null) throw error;
      return await request();
    } finally {
      if (_waiting.isEmpty) {
        _active--;
      } else {
        // Transfer this slot to the oldest waiter before admitting new work.
        _waiting.removeFirst().complete();
      }
    }
  }

  Future<void> _acquire() {
    final error = _closedError;
    if (error != null) return Future.error(error);
    if (_active < 8) {
      _active++;
      return Future.value();
    }
    final pending = Completer<void>();
    _waiting.addLast(pending);
    return pending.future;
  }

  void close(Object error) {
    _closedError = error;
    while (_waiting.isNotEmpty) {
      _waiting.removeFirst().completeError(error);
    }
  }
}
