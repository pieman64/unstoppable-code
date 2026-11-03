import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// What the user did with the satisfaction prompt. [dismissed] covers swipe
/// down, tapping outside, and the system back gesture.
enum SatisfactionPromptChoice { yes, no, notNow, dismissed }

Future<SatisfactionPromptChoice> showSatisfactionPromptSheet(
  BuildContext context,
) async {
  final choice = await showModalBottomSheet<SatisfactionPromptChoice>(
    context: context,
    useSafeArea: true,
    builder: (_) => const SatisfactionPromptSheet(),
  );
  return choice ?? SatisfactionPromptChoice.dismissed;
}

/// "Are you enjoying the app?" with Yes / Not really / Not now. Actions are
/// stacked in reading order so screen-reader focus follows heading → Yes →
/// Not really → Not now.
class SatisfactionPromptSheet extends StatelessWidget {
  const SatisfactionPromptSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    void choose(SatisfactionPromptChoice choice) =>
        Navigator.of(context).pop(choice);

    return Padding(
      key: const ValueKey('satisfaction-prompt-sheet'),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            header: true,
            child: Text(
              'Are you enjoying the app?',
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium,
            ),
          ),
          const SizedBox(height: 16),
          CanopyButton(
            key: const ValueKey('satisfaction-prompt-yes'),
            label: 'Yes',
            expand: true,
            onPressed: () => choose(SatisfactionPromptChoice.yes),
          ),
          const SizedBox(height: 8),
          CanopyButton(
            key: const ValueKey('satisfaction-prompt-no'),
            label: 'Not really',
            expand: true,
            variant: CanopyButtonVariant.inline,
            // The default accent label is 4.39:1 on the sheet surface, under
            // the 4.5:1 WCAG AA minimum for this text size.
            foregroundColor: AppColors.of(context).foreground,
            onPressed: () => choose(SatisfactionPromptChoice.no),
          ),
          CanopyButton(
            key: const ValueKey('satisfaction-prompt-not-now'),
            label: 'Not now',
            expand: true,
            variant: CanopyButtonVariant.inline,
            foregroundColor: AppColors.of(context).foregroundSecondary,
            onPressed: () => choose(SatisfactionPromptChoice.notNow),
          ),
        ],
      ),
    );
  }
}
