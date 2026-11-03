/// Transient surfaces consume back before the shell changes destinations.
/// A handler returns true only when it handled this press.
final class HomeBackHandlers {
  final List<bool Function()> _handlers = [];

  void add(bool Function() handler) => _handlers.add(handler);
  void remove(bool Function() handler) => _handlers.remove(handler);

  bool consume() {
    for (final handler in _handlers.reversed.toList()) {
      if (handler()) return true;
    }
    return false;
  }
}
