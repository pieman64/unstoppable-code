import 'dart:async';
import 'models.dart';
import 'navigation.dart';
import 'settings.dart';
import 'state.dart';

/// Coalesces read acknowledgements for the visible chat. Only the desktop
/// changes unread state. Transient failures retry while the chat stays visible.
final class DeviceChatReadReceipts {
  DeviceChatReadReceipts(this.navigation, {this.createTimer = Timer.new});
  final DeviceChatNavigation navigation;
  final Timer Function(Duration, void Function()) createTimer;
  ({DeviceChatRef ref, int revision})? _latest;
  (String, int)? _attempted;
  bool _busy = false, _disposed = false, _failed = false;
  int _generation = 0, _retries = 0;
  Timer? _retry;

  void observe(DeviceChatState? state, {required bool enabled}) {
    final next =
        enabled && state != null && !state.closed && state.tab['unread'] == true
        ? (ref: state.ref, revision: state.revision)
        : null;
    if ((_latest?.ref.key, _latest?.revision) !=
        (next?.ref.key, next?.revision)) {
      _cancelRetry();
      // Returning to a chat can retry a failed read at the same revision.
      // Successful reads still wait for the desktop's projection.
      if (_failed) _attempted = null;
      _failed = false;
    }
    _latest = next;
    _flush();
  }

  void invalidate() {
    _generation++;
    _busy = false;
    _latest = null;
    _attempted = null;
    _failed = false;
    _cancelRetry();
  }

  void retry() {
    _cancelRetry();
    _attempted = null;
    _flush();
  }

  void _flush() {
    final next = _latest;
    if (_disposed ||
        _busy ||
        _retry != null ||
        next == null ||
        _attempted == (next.ref.key, next.revision)) {
      return;
    }
    _attempted = (next.ref.key, next.revision);
    _failed = false;
    _busy = true;
    final generation = _generation;
    unawaited(_mark(next.ref, next.revision, generation));
  }

  void _cancelRetry() {
    _retry?.cancel();
    _retry = null;
    _retries = 0;
  }

  Future<void> _mark(DeviceChatRef ref, int revision, int generation) async {
    try {
      await navigation.markRead(ref);
    } catch (cause) {
      if (_disposed || generation != _generation) return;
      _failed = true;
      // Canonical refusals require a refresh. Admission failures and uncertain
      // delivery can retry this idempotent read marker, at most three times.
      if (cause is! DeviceChatSettingsRejected &&
          _latest?.ref.key == ref.key &&
          _latest?.revision == revision &&
          _retries < 3) {
        final delay = Duration(seconds: 1 << _retries++);
        _retry = createTimer(delay, () {
          _retry = null;
          _attempted = null;
          _flush();
        });
      }
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
