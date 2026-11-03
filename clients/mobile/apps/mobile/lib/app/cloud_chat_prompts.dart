import 'package:flutter/widgets.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/ui/features/desktop_app/views/desktop_app_prompt_host.dart';
import 'package:mobile/ui/features/satisfaction/views/satisfaction_prompt_host.dart';

/// Desktop takes the turn it claims; satisfaction waits for a later turn.
Widget buildCloudChatPrompts(
  BuildContext context,
  bool isQuiet,
  Widget child,
) => DesktopAppPromptHost(
  isQuiet: isQuiet,
  child: SatisfactionPromptHost(
    surface: SatisfactionSurface.cloudChat,
    isQuiet: isQuiet,
    child: child,
  ),
);
