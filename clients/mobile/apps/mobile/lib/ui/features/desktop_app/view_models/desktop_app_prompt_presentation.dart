import 'package:flutter/widgets.dart';

/// What the user did with the desktop app prompt. [dismissed] covers swipe
/// down, tapping outside, and the system back gesture.
enum DesktopAppPromptAction { share, copy, notNow, dismissed }

/// The user's choice, with the Share button's global rect so the share sheet
/// can anchor to it on iPad.
typedef DesktopAppPromptChoice = ({
  DesktopAppPromptAction action,
  Rect? shareOrigin,
});

typedef DesktopAppPromptPresenter =
    Future<DesktopAppPromptChoice> Function(BuildContext context);
