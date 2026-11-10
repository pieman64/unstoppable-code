import 'dart:async';

import 'package:flutter/widgets.dart';

import 'home_recent_chats.dart';

/// Hosts a recent chat inside the shell and waits for its cleanup before
/// opening another. A newer navigation choice cancels an unfinished open.
class HomeRecentChatController extends ChangeNotifier {
  Widget? get page => _page;
  Widget? _page;
  Completer<void>? _closed;
  Future<void>? _opening;
  int _generation = 0;
  bool _disposed = false;

  Future<void> open(HomeRecentChat chat, BuildContext context) async {
    close();
    final generation = _generation;
    await _opening;
    if (_disposed || generation != _generation || !context.mounted) return;
    final opening = chat.open(context, (page) {
      if (_disposed || generation != _generation || !context.mounted) {
        return Future.value();
      }
      final closed = Completer<void>();
      _closed = closed;
      _page = page;
      notifyListeners();
      return closed.future;
    });
    _opening = opening;
    try {
      await opening;
    } finally {
      if (identical(_opening, opening)) _opening = null;
    }
  }

  void close() {
    _generation++;
    final closed = _closed;
    _closed = null;
    final hadPage = _page != null;
    _page = null;
    if (hadPage && !_disposed) notifyListeners();
    if (closed != null) {
      // Unmount the outgoing screen before releasing its model's selection.
      // Its dispose must not hide a new chat using the same connection.
      unawaited(
        WidgetsBinding.instance.endOfFrame.then((_) => closed.complete()),
      );
    }
  }

  @override
  void dispose() {
    _disposed = true;
    close();
    super.dispose();
  }
}
