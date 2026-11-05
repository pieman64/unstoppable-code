import 'dart:async';
import 'models.dart';
import 'navigation.dart';
import 'state.dart';

/// Coalesces read acknowledgements for the visible chat. Only the desktop
/// changes unread state. A failure stays unread until a refresh or new change.
final class DeviceChatReadReceipts {
  DeviceChatReadReceipts(this.navigation);
  final DeviceChatNavigation navigation;
  ({DeviceChatRef ref, int revision})? _latest;
  (String, int)? _attempted;
  bool _busy = false, _disposed = false;
  int _generation = 0;

  void observe(DeviceChatState? state, {required bool enabled}) {
    _latest =
        enabled && state != null && !state.closed && state.tab['unread'] == true
        ? (ref: state.ref, revision: state.revision)
        : null;
    _flush();
  }

  void invalidate() {
    _generation++;
    _busy = false;
    _latest = null;
    _attempted = null;
  }

  void retry() {
    _attempted = null;
    _flush();
  }

  void _flush() {
    final next = _latest;
    if (_disposed ||
        _busy ||
        next == null ||
        _attempted == (next.ref.key, next.revision)) {
      return;
    }
    _attempted = (next.ref.key, next.revision);
    _busy = true;
    final generation = _generation;
    unawaited(_mark(next.ref, generation));
  }

  Future<void> _mark(DeviceChatRef ref, int generation) async {
    try {
      await navigation.markRead(ref);
    } catch (_) {
      /* Keep the desktop's unread projection on refusal. */
    } finally {
      if (!_disposed && generation == _generation) {
        _busy = false;
        _flush();
      }
    }
  }

  void dispose() {
    _disposed = true;
    invalidate();
  }
}
