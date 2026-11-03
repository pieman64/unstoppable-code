import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_controller.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';

/// Routes one successful cloud chat turn to the end-of-turn prompts. The
/// desktop app prompt goes first; a turn it takes still counts toward the
/// satisfaction prompt but cannot raise it, so the two never stack
/// (CAN-4424). Remote Control turns go to the satisfaction prompt alone: a
/// paired desktop is never offered the desktop app.
Future<void> recordCloudChatTurn(
  String turnKey, {
  required DesktopAppPromptController desktopApp,
  required SatisfactionPromptController satisfaction,
}) async {
  final claimed = await desktopApp.claimSuccessfulTurn();
  await satisfaction.recordSuccessfulTurn(turnKey);
  if (claimed) satisfaction.deferPrompt();
}
