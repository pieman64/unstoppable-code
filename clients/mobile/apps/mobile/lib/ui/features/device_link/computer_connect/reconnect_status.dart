import 'dart:async';

/// Keeps brief outages quiet without changing connection or retry policy.
final class ComputerReconnectStatus {
  ComputerReconnectStatus({required this.onChanged, required this.createTimer});

  static const grace = Duration(seconds: 30);
  final void Function() onChanged;
  final Timer Function(Duration, void Function()) createTimer;
  Timer? _timer;
  String? _computerId;
  bool _online = false;
  bool _offline = false;
  bool get offline => _offline;

  void update({required String? computerId, required bool online}) {
    if (_computerId == computerId && _online == online) return;
    reset();
    _computerId = computerId;
    _online = online;
    if (computerId == null || online) return;
    _timer = createTimer(grace, () {
      _timer = null;
      _offline = true;
      onChanged();
    });
  }

  /// Returning to the app gives foreground reconnection a fresh grace period.
  void reset() {
    _timer?.cancel();
    _timer = null;
    _computerId = null;
    _online = false;
    _offline = false;
  }

  void dispose() => reset();
}
