import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:provider/provider.dart';

/// How long the launch view waits for the account's draft store.
const Duration kChatDraftStoreOpenTimeout = Duration(seconds: 3);

/// Opens the signed-in account's draft store and provides it above the root
/// navigator through a [ChatDraftStoreHolder], so pushed routes read the same
/// store as the shell. Mount it above `MaterialApp`. The caller supplies the
/// account signal and its scoped key without coupling this feature to auth.
///
/// When the account changes, the old store is flushed before the next
/// account's store opens; signing out leaves no store. A store that cannot open, or does not open within
/// [kChatDraftStoreOpenTimeout], falls back to an [InMemoryChatDraftStore].
class ChatDraftStoreScope extends StatefulWidget {
  const ChatDraftStoreScope({
    super.key,
    required this.open,
    required this.account,
    required this.accountScope,
    required this.child,
  });

  final Future<ChatDraftStore> Function(String accountScope) open;
  final Listenable account;
  final String? Function() accountScope;
  final Widget child;

  @override
  State<ChatDraftStoreScope> createState() => _ChatDraftStoreScopeState();
}

class _ChatDraftStoreScopeState extends State<ChatDraftStoreScope>
    with WidgetsBindingObserver {
  final ChatDraftStoreHolder _holder = ChatDraftStoreHolder();
  String? _accountScope;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.account.addListener(_accountChanged);
    _switchTo(widget.accountScope());
  }

  @override
  void didUpdateWidget(covariant ChatDraftStoreScope oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.account, widget.account)) {
      oldWidget.account.removeListener(_accountChanged);
      widget.account.addListener(_accountChanged);
    }
    _accountChanged();
  }

  void _accountChanged() {
    final next = widget.accountScope();
    if (next != _accountScope) _switchTo(next);
  }

  /// Releases the current store at once, so nothing built for the next
  /// account can read the previous account's drafts, then opens [scope]'s.
  void _switchTo(String? scope) {
    _accountScope = scope;
    final generation = ++_generation;
    if (_holder.store case final old?) {
      unawaited(old.flush());
      _holder.store = null;
    }
    if (scope != null) unawaited(_open(scope, generation));
  }

  Future<void> _open(String scope, int generation) async {
    final opening = widget.open(scope);
    ChatDraftStore store;
    try {
      store = await opening.timeout(kChatDraftStoreOpenTimeout);
    } on TimeoutException {
      debugPrint('Chat drafts unavailable: open timed out');
      store = InMemoryChatDraftStore();
      // A store that opens late is never used; release it.
      unawaited(opening.then((late) => late.flush(), onError: (Object _) {}));
    } catch (error) {
      debugPrint('Chat drafts unavailable: ${error.runtimeType}');
      store = InMemoryChatDraftStore();
    }
    if (!mounted || generation != _generation) {
      unawaited(store.flush());
      return;
    }
    _holder.store = store;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        unawaited(_holder.store?.flush());
      case AppLifecycleState.resumed:
        break;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.account.removeListener(_accountChanged);
    _generation++;
    if (_holder.store case final store?) {
      unawaited(store.flush());
    }
    _holder.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      ChangeNotifierProvider<ChatDraftStoreHolder>.value(
        value: _holder,
        child: widget.child,
      );
}
