import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';

String accountScopeFor(String userId) =>
    '${AppConfig.environment.name}:$userId';

/// Carries a guest's unsent cloud chat drafts into the account they signed in
/// to (CAN-2872); a no-op for any other account change.
Future<void> adoptGuestDraftsOnSignIn(
  AuthViewModel auth,
  ({ChatDraftStore store, String scope}) previous,
  ({ChatDraftStore store, String scope}) next,
) async {
  final guestId = auth.signedInFromGuestId;
  if (guestId == null || previous.scope != accountScopeFor(guestId)) return;
  if ((previous.store, next.store) case (
    final ChatDraftStateStore guest,
    final ChatDraftStateStore account,
  )) {
    await account.adoptGuestDrafts(guest);
  }
}
