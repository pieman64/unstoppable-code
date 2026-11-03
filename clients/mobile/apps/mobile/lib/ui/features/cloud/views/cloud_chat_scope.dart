import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';

/// The two cloud models one [CloudChatScope] owns. Built by one factory so
/// they can share a repository instance and agree on availability.
typedef CloudChatModels = ({
  CloudChatViewModel session,
  CloudChatsViewModel list,
});

/// Owns the cloud chat models above the root Navigator: the single selected
/// session ([CloudChatViewModel]) and the workspaces/chats list
/// ([CloudChatsViewModel]). The .value providers make the same instances
/// visible to pushed routes, and account/org changes clear both.
class CloudChatScope extends StatefulWidget {
  const CloudChatScope({super.key, required this.create, required this.child});
  final CloudChatModels Function() create;
  final Widget child;
  @override
  State<CloudChatScope> createState() => _CloudChatScopeState();
}

class _CloudChatScopeState extends State<CloudChatScope> {
  late final CloudChatModels _models = widget.create();
  CloudChatViewModel get _model => _models.session;
  CloudChatsViewModel get _list => _models.list;
  late final AuthViewModel _auth = context.read<AuthViewModel>();
  late (String?, String?) _account;
  int _appliedModelSelection = 0;
  (String?, String?) get _currentAccount => (
    _auth.status == AuthStatus.authenticated ? _auth.user?.id : null,
    _auth.activeOrgId,
  );
  @override
  void initState() {
    super.initState();
    _account = _currentAccount;
    _auth.addListener(_authChanged);
    _model.addListener(_recordChatActivity);
    _model.addListener(_applyModelSelection);
    _model.authenticationFailures.addListener(_authenticationFailed);
    _list.authenticationFailures.addListener(_authenticationFailed);
  }

  /// Keeps the list's activity overlay current for whichever chat the
  /// session is bound to, so Recents still orders it after the session moves
  /// on to another chat.
  void _recordChatActivity() {
    final chatId = _model.state?.chatId;
    final latest = _model.latestUserMessageAt;
    if (chatId == null || latest == null) return;
    _list.recordChatActivity(chatId, latest);
  }

  /// Copies the mode and model the server saved with each accepted turn into
  /// the list, which the composer chip reads.
  void _applyModelSelection() {
    final selection = _model.acceptedModelSelection;
    if (selection == null || selection.revision == _appliedModelSelection) {
      return;
    }
    _appliedModelSelection = selection.revision;
    _list.applyAcceptedModelSelection(
      selection.chatId,
      modelSelectionMode: selection.modelSelectionMode,
      modelDefinitionId: selection.modelDefinitionId,
    );
  }

  void _authenticationFailed() {
    unawaited(_auth.revalidateSessionAfterAuthenticationFailure());
  }

  void _authChanged() {
    final next = _currentAccount;
    if (_account == next) return;
    _account = next;
    _model.close();
    _list.reset();
  }

  @override
  void dispose() {
    _auth.removeListener(_authChanged);
    _model.removeListener(_recordChatActivity);
    _model.removeListener(_applyModelSelection);
    _model.authenticationFailures.removeListener(_authenticationFailed);
    _list.authenticationFailures.removeListener(_authenticationFailed);
    _model.dispose();
    _list.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MultiProvider(
    providers: [
      ChangeNotifierProvider<CloudChatViewModel>.value(value: _model),
      ChangeNotifierProvider<CloudChatsViewModel>.value(value: _list),
    ],
    child: widget.child,
  );
}
