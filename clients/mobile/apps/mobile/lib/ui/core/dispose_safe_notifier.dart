import 'package:flutter/foundation.dart';

/// Mixin for [ChangeNotifier]-based view models whose async work can complete
/// after the notifier has been disposed.
///
/// View models created by `ChangeNotifierProvider` are disposed when their
/// provider leaves the widget tree — e.g. the authenticated shell is torn down
/// on sign-out or an organization switch. An initial load kicked off with a
/// cascade (`..loadFeed()`, `..loadUsage()`, `..load()`) can still be awaiting
/// repository work at that point; when it resolves, calling [notifyListeners]
/// on the now-disposed notifier throws "A `<T>` was used after being disposed".
///
/// Routing post-await notifications through [notifyListenersSafe] makes that a
/// no-op instead of a runtime error.
mixin DisposeSafeNotifier on ChangeNotifier {
  bool _disposed = false;

  /// Whether [dispose] has already run.
  bool get isDisposed => _disposed;

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  /// Notifies listeners only while the notifier is still alive; a no-op once
  /// [dispose] has run.
  void notifyListenersSafe() {
    if (!_disposed) notifyListeners();
  }
}
