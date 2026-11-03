import 'package:flutter/foundation.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

typedef ChatWatcherDelete =
    Future<void> Function(String watcherId, {required bool notifySubscriber});

/// The "Chat watchers" sheet's delete flow, as `WatcherManagementModal.tsx`
/// runs it: Delete arms one row's inline confirm, which carries the "Notify
/// subscribing chat" choice. A confirmed delete stays pending until the row
/// leaves the projection, because the removal delta is the real result.
class ChatWatcherDeleteController extends ChangeNotifier
    with DisposeSafeNotifier {
  ChatWatcherDeleteController({required this._delete});

  final ChatWatcherDelete _delete;
  String? _confirmingId;
  bool _notifySubscriber = false;
  final _pending = <String>{};
  final _errors = <String, String>{};

  bool isConfirming(String watcherId) => _confirmingId == watcherId;
  bool get notifySubscriber => _notifySubscriber;
  bool isPending(String watcherId) => _pending.contains(watcherId);
  String? errorFor(String watcherId) => _errors[watcherId];

  void arm(String watcherId) {
    if (_pending.contains(watcherId)) return;
    _confirmingId = watcherId;
    _notifySubscriber = false;
    _errors.remove(watcherId);
    notifyListeners();
  }

  void cancel() {
    _confirmingId = null;
    _notifySubscriber = false;
    notifyListeners();
  }

  void setNotifySubscriber(bool value) {
    _notifySubscriber = value;
    notifyListeners();
  }

  Future<void> confirm(String watcherId) async {
    if (_confirmingId != watcherId || !_pending.add(watcherId)) return;
    final notifySubscriber = _notifySubscriber;
    _errors.remove(watcherId);
    notifyListeners();
    try {
      await _delete(watcherId, notifySubscriber: notifySubscriber);
      // Another row may have been armed while this delete was settling.
      if (_confirmingId == watcherId) {
        _confirmingId = null;
        _notifySubscriber = false;
      }
    } catch (error) {
      _pending.remove(watcherId);
      _errors[watcherId] = chatWatcherDeleteErrorText(error);
    }
    notifyListenersSafe();
  }
}

/// Desktop failure messages are already user-facing; the firing or missing
/// case keeps the desktop modal's fixed copy.
String chatWatcherDeleteErrorText(Object error) => switch (error) {
  RemoteWatcherDeleteException(
    failure: RemoteWatcherDeleteFailure.notFoundOrFiring,
  ) =>
    'Watcher not found or currently firing.',
  RemoteWatcherDeleteException(:final message) when message.trim().isNotEmpty =>
    message,
  _ => 'Could not delete the watcher. Try again.',
};
