import 'dart:async';
import 'package:flutter/foundation.dart';
import '../desktop_link_model.dart';

/// Keeps brief foreground reconnects quiet without delaying connection state.
final class DeviceReconnectNoticeDelay extends ChangeNotifier {
  DeviceReconnectNoticeDelay(
    this.connection,
    this._foreground, {
    this.createTimer = Timer.new,
  }) {
    connection.addListener(_sync);
    _sync();
  }

  final DesktopLinkModel connection;
  final Timer Function(Duration, void Function()) createTimer;
  bool _foreground;
  bool _visible = false;
  Timer? _timer;
  bool get visible => _visible;

  void setForeground(bool value) {
    _foreground = value;
    _sync();
  }

  void _sync() {
    if (!_foreground || !connection.reconnecting) {
      _timer?.cancel();
      _timer = null;
      if (_visible) {
        _visible = false;
        notifyListeners();
      }
      return;
    }
    if (_visible || _timer != null) return;
    _timer = createTimer(const Duration(seconds: 5), () {
      _timer = null;
      _visible = true;
      notifyListeners();
    });
  }

  @override
  void dispose() {
    connection.removeListener(_sync);
    _timer?.cancel();
    super.dispose();
  }
}
