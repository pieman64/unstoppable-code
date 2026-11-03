import 'package:flutter/material.dart';
import 'package:mobile/data/services/api_client.dart';

/// Shows a destructive confirmation dialog; returns true when confirmed.
Future<bool> confirmDestructive(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  Key? confirmKey,
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: confirmKey,
          style: FilledButton.styleFrom(
            backgroundColor: Theme.of(dialogContext).colorScheme.error,
          ),
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return result ?? false;
}

/// Runs [action], showing a SnackBar on failure so 403 / 409 (last-owner)
/// errors are surfaced, never swallowed.
///
/// Prefers the server's own 4xx sentence over [failureMessage]: those are
/// deliberate, user-facing copy — a lapsed org's "Your organization's trial has
/// ended. Subscribe to Team to restore team features." says far more than
/// "Could not create the sub-team." A 5xx or transport failure falls back to
/// [failureMessage], because the server's words there describe an internal
/// fault. The raw exception is never rendered.
Future<void> guardAction(
  BuildContext context,
  Future<void> Function() action,
  String failureMessage, {
  String? Function(Object error)? failureMessageBuilder,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    await action();
  } catch (error) {
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          failureMessageBuilder?.call(error) ??
              presentableErrorMessage(error) ??
              failureMessage,
        ),
      ),
    );
  }
}
