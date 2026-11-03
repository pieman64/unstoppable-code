import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:provider/provider.dart';

/// The signed-in account's draft store, provided above `MaterialApp` so every
/// route pushed on the root navigator reads the same one. [store] is null
/// while no account is signed in and while the account's store is opening.
final class ChatDraftStoreHolder extends ChangeNotifier {
  ChatDraftStoreHolder([ChatDraftStore? store]) : _store = store;

  ChatDraftStore? _store;

  ChatDraftStore? get store => _store;

  set store(ChatDraftStore? value) {
    if (identical(value, _store)) return;
    _store = value;
    notifyListeners();
  }
}

/// The account's draft store, or null without a [ChatDraftStoreHolder] above
/// [context] (widget tests that mount a screen directly) or while it is still
/// opening. Callers fall back to a screen-local `InMemoryChatDraftStore`.
ChatDraftStore? maybeChatDraftStore(BuildContext context) {
  try {
    return Provider.of<ChatDraftStoreHolder>(context, listen: false).store;
  } on ProviderNotFoundException {
    return null;
  }
}
