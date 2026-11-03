import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:provider/provider.dart';

/// The signed-in account's [RemoteTranscriptCache], provided above the root
/// navigator. Null while no account is signed in.
final class RemoteTranscriptCacheHolder {
  RemoteTranscriptCache? cache;
}

/// The account's transcript cache, or null without a
/// [RemoteTranscriptCacheScope] above [context] or while signed out.
RemoteTranscriptCache? maybeRemoteTranscriptCache(BuildContext context) {
  try {
    return Provider.of<RemoteTranscriptCacheHolder>(
      context,
      listen: false,
    ).cache;
  } on ProviderNotFoundException {
    return null;
  }
}

/// Owns the lifetime of persisted Remote Control chat tails (CAN-3373): one
/// [RemoteTranscriptCache] per signed-in account, and deletion of every
/// stored tail when that account stops being the signed-in one — sign-out,
/// an account change (even without a sign-out in between), or this scope
/// being torn down for a new environment. A launch that finds nobody signed
/// in deletes them too. A process restart keeps them.
///
/// Mount it above `MaterialApp`. The caller supplies the account signal and
/// its scoped key without coupling this feature to auth.
class RemoteTranscriptCacheScope extends StatefulWidget {
  const RemoteTranscriptCacheScope({
    super.key,
    required this.account,
    required this.accountScope,
    required this.signedOut,
    required this.create,
    required this.purge,
    required this.child,
  });

  final Listenable account;

  /// The signed-in account's key, `<environment>:<userId>`; null otherwise.
  final String? Function() accountScope;

  /// Whether nobody is signed in, as opposed to a launch still restoring.
  final bool Function() signedOut;
  final RemoteTranscriptCache Function(String accountScope) create;

  /// Deletes every stored tail, after any write already issued.
  final Future<void> Function() purge;
  final Widget child;

  @override
  State<RemoteTranscriptCacheScope> createState() =>
      _RemoteTranscriptCacheScopeState();
}

class _RemoteTranscriptCacheScopeState
    extends State<RemoteTranscriptCacheScope> {
  final RemoteTranscriptCacheHolder _holder = RemoteTranscriptCacheHolder();
  String? _accountScope;

  /// Whether the stored tails were deleted since the last account left.
  bool _purged = false;

  @override
  void initState() {
    super.initState();
    widget.account.addListener(_accountChanged);
    _accountChanged();
  }

  @override
  void didUpdateWidget(covariant RemoteTranscriptCacheScope oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.account, widget.account)) {
      oldWidget.account.removeListener(_accountChanged);
      widget.account.addListener(_accountChanged);
    }
    _accountChanged();
  }

  void _accountChanged() {
    final next = widget.accountScope();
    if (next == _accountScope) {
      if (next == null && widget.signedOut()) _purge();
      return;
    }
    final left = _accountScope;
    _accountScope = next;
    // Released at once, so nothing built for the next account reads it.
    _holder.cache?.close();
    _holder.cache = null;
    if (left != null) {
      _purged = false;
      _purge();
    } else if (widget.signedOut()) {
      _purge();
    }
    if (next != null) {
      _purged = false;
      _holder.cache = widget.create(next);
    }
  }

  void _purge() {
    if (_purged) return;
    _purged = true;
    unawaited(widget.purge());
  }

  @override
  void dispose() {
    widget.account.removeListener(_accountChanged);
    if (_holder.cache case final cache?) {
      cache.close();
      _holder.cache = null;
      unawaited(widget.purge());
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      Provider<RemoteTranscriptCacheHolder>.value(
        value: _holder,
        child: widget.child,
      );
}
