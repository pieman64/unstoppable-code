/// The comparable state of one chat's transcript view. Pure Dart, so the
/// engine can produce it and a Flutter adapter can compare it.
library;

import 'package:mobile/data/models/remote_chat.dart';

/// Everything a chat's transcript view shows, as one value: equal revisions
/// mean nothing about that chat changed. [summary] is the snapshot's own row,
/// compared by identity (the model does not override `==`), and
/// [sessionGeneration] keeps a reset counter from matching a pre-reset value.
/// [unsent] counts changes to the chat's durable not-sent rows.
typedef RemoteChatRevision = ({
  int sessionGeneration,
  int transcript,
  int unsent,
  bool awaitingTurn,
  int questionResolutions,
  RemoteChatSummary? summary,
  bool transcriptLoading,
  String? hydrationError,
});
