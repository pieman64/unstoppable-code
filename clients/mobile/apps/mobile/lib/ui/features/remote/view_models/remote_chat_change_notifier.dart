import 'package:flutter/foundation.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

import 'remote_chat_revision.dart';

/// Notifies only when one chat's [RemoteChatRevision] changes, so a widget
/// showing that chat ignores every other chat and client concern.
///
/// Re-reads [read] on each [source] notification. A null [read] (no chat
/// bound yet) never notifies. Removing the listener from a disposed source
/// is safe, so the owner may dispose this in either order.
final class RemoteChatChangeNotifier extends ChangeNotifier
    with DisposeSafeNotifier {
  RemoteChatChangeNotifier({
    required Listenable source,
    RemoteChatRevision Function()? read,
  }) : _source = source,
       _read = read,
       _revision = read?.call() {
    if (read != null) source.addListener(_onSourceChanged);
  }

  final Listenable _source;
  final RemoteChatRevision Function()? _read;
  RemoteChatRevision? _revision;

  void _onSourceChanged() {
    final read = _read;
    if (read == null || isDisposed) return;
    final next = read();
    if (next == _revision) return;
    _revision = next;
    notifyListenersSafe();
  }

  @override
  void dispose() {
    if (_read != null) _source.removeListener(_onSourceChanged);
    super.dispose();
  }
}
