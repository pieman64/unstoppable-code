import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_presentation.dart';

const DesktopAppPromptChoice _dismissed = (
  action: DesktopAppPromptAction.dismissed,
  shareOrigin: null,
);

Future<DesktopAppPromptChoice> showDesktopAppPromptSheet(
  BuildContext context,
) async {
  final choice = await showModalBottomSheet<DesktopAppPromptChoice>(
    context: context,
    useSafeArea: true,
    // Lets the sheet grow, and scroll, at large text sizes.
    isScrollControlled: true,
    builder: (_) => const DesktopAppPromptSheet(),
  );
  return choice ?? _dismissed;
}

/// Shares a link to the desktop app (CAN-4424).
/// Actions are stacked in reading order so screen-reader focus follows
/// heading → explanation → Share link → Copy link → Not now.
class DesktopAppPromptSheet extends StatelessWidget {
  const DesktopAppPromptSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    void choose(DesktopAppPromptAction action, {Rect? shareOrigin}) =>
        Navigator.of(context).pop((action: action, shareOrigin: shareOrigin));

    return SingleChildScrollView(
      key: const ValueKey('desktop-app-prompt-sheet'),
      padding: EdgeInsets.fromLTRB(
        16,
        8,
        16,
        16 + MediaQuery.viewPaddingOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            header: true,
            child: Text(
              'Get the desktop app',
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            '${Brand.productDisplayName} on your computer runs agents in '
            'your own projects, and your phone stays in sync with it. Send '
            'yourself the link to download it there.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colors.foregroundSecondary,
            ),
          ),
          const SizedBox(height: 16),
          Builder(
            builder: (buttonContext) => CanopyButton(
              key: const ValueKey('desktop-app-prompt-share'),
              label: 'Share link',
              expand: true,
              onPressed: () => choose(
                DesktopAppPromptAction.share,
                shareOrigin: _globalRectOf(buttonContext),
              ),
            ),
          ),
          const SizedBox(height: 8),
          CanopyButton(
            key: const ValueKey('desktop-app-prompt-copy'),
            label: 'Copy link',
            expand: true,
            variant: CanopyButtonVariant.inline,
            // The default accent label is under 4.5:1 on the sheet surface.
            foregroundColor: colors.foreground,
            onPressed: () => choose(DesktopAppPromptAction.copy),
          ),
          CanopyButton(
            key: const ValueKey('desktop-app-prompt-not-now'),
            label: 'Not now',
            expand: true,
            variant: CanopyButtonVariant.inline,
            foregroundColor: colors.foregroundSecondary,
            onPressed: () => choose(DesktopAppPromptAction.notNow),
          ),
        ],
      ),
    );
  }

  static Rect? _globalRectOf(BuildContext context) {
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return null;
    return box.localToGlobal(Offset.zero) & box.size;
  }
}
