import 'package:mobile/data/models/chat_message.dart';

/// Questions delivered by a renderer round-trip rather than canonical chat
/// state. The source retains the host's request and originating chat identity.
abstract interface class DeviceChatQuestions {
  Stream<void> get updates;
  List<AskUserQuestionState> pendingFor(String chatId);
  Future<void> answer(
    String chatId,
    String requestId,
    List<AskUserQuestionAnswer> answers,
  );
  Future<void> dismiss(String chatId, String requestId);
}
