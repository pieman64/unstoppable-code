import 'package:mobile/data/models/chat_message.dart';
import '../desktop/ipc.dart';
import 'models.dart';
import 'settings.dart';

/// Commands retain the desktop's pending-request identity and chat scope.
final class DeviceChatDecisions {
  DeviceChatDecisions(DesktopIpc ipc) : _commands = DeviceChatSettings(ipc);
  final DeviceChatSettings _commands;

  Future<void> answer(
    DeviceChatRef ref,
    String requestId,
    List<AskUserQuestionAnswer> answers,
  ) => _commands.command(ref, {
    'type': 'chat.answer_question',
    'chatId': ref.id,
    'questionId': requestId,
    'answers': answers.map((a) => a.toJson()).toList(),
  });

  Future<void> dismiss(DeviceChatRef ref, String requestId) =>
      _commands.command(ref, {
        'type': 'chat.dismiss_question',
        'chatId': ref.id,
        'questionId': requestId,
      });
}
