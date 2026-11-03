import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/ui/core/typography.dart';

// Account name prompts and the one-time API key token dialog, unchanged from
// the former inline Account sections.

/// Prompts for a single-line name value; returns null when cancelled.
Future<String?> promptForName(
  BuildContext context, {
  String title = 'New API key',
  String label = 'Name',
  String? hint = 'e.g. CI token',
  String confirmLabel = 'Create',
  String initial = '',
}) {
  final controller = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: controller,
        autofocus: true,
        textInputAction: TextInputAction.done,
        onSubmitted: (value) => Navigator.of(dialogContext).pop(value),
        decoration: InputDecoration(labelText: label, hintText: hint),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(dialogContext).pop(controller.text),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
}

/// Shows the one-time plaintext token with a copy affordance.
Future<void> showApiKeyToken(BuildContext context, String token) {
  return showDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('API key created'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            "Copy this token now — you won't be able to see it again.",
          ),
          const SizedBox(height: 12),
          SelectableText(
            token,
            style: const TextStyle(fontFamily: AppTypography.monoFamily),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: token));
            if (dialogContext.mounted) {
              Navigator.of(dialogContext).pop();
            }
          },
          child: const Text('Copy'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('Done'),
        ),
      ],
    ),
  );
}
