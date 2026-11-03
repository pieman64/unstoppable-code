import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';

/// The two cloud chat models `CloudChatScope` provides in production, as
/// plain providers for tests that mount `HomeShell` without the root scope.
///
/// Defaults to the zero-latency in-memory mock so no test touches the
/// network; pass [repository] to script workspaces or failures. Pass
/// [draftStore] to provide it and attach it to the session, as
/// `ChatDraftStoreScope` does in production.
List<SingleChildWidget> cloudChatTestProviders({
  CloudChatRepository? repository,
  ChatDraftStore? draftStore,
}) {
  final shared = repository ?? MockCloudChatRepository(latency: Duration.zero);
  return [
    ChangeNotifierProvider<CloudChatsViewModel>(
      create: (_) => CloudChatsViewModel(repository: shared),
    ),
    ChangeNotifierProvider<CloudChatViewModel>(
      create: (_) => CloudChatViewModel(
        repository: shared,
        openStream: (_, {after}) => const Stream.empty(),
        observeLifecycle: false,
      )..attachDraftStore(draftStore),
    ),
    if (draftStore != null)
      ChangeNotifierProvider<ChatDraftStoreHolder>.value(
        value: ChatDraftStoreHolder(draftStore),
      ),
  ];
}
