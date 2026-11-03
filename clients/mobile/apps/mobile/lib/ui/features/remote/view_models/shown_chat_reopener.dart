import 'package:mobile/data/models/remote_chat.dart';

import 'remote_identity.dart';

/// Reopens the chat a screen shows each time it comes on screen: first
/// shown, switched to, shown again after another route, or shown in a new
/// pairing. Rebuilds that keep showing the same chat reopen nothing
/// (CAN-4427).
final class ShownChatReopener {
  ShownChatReopener({required this.reopen, required this.afterFrame});

  /// Reopens [target]; see `HydrationCoordinator.reopenChatTranscript`.
  final void Function(RemoteChatTarget target) reopen;

  /// Runs a callback after the current frame. [show] can run during a
  /// build, where reopening must not notify.
  final void Function(void Function() callback) afterFrame;

  ({RemoteChatKey? chat, int sessionGeneration})? _shown;
  RemoteChatTarget? _target;
  int _shows = 0;

  /// [target] is the loadable chat on screen now, or null when the screen
  /// is not current or shows no loadable chat.
  void show(RemoteChatTarget? target, {required int sessionGeneration}) {
    final shown = target == null
        ? null
        : (
            chat: remoteChatKeyForTarget(target),
            sessionGeneration: sessionGeneration,
          );
    _target = target;
    if (shown == _shown) return;
    _shown = shown;
    if (shown == null) return;
    final show = ++_shows;
    afterFrame(() {
      // Only the latest showing reopens, and not after the screen left it.
      final target = _target;
      if (show == _shows && target != null) reopen(target);
    });
  }
}
