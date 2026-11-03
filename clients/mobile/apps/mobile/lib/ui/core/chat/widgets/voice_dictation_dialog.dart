import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';

/// Explains why dictation could not start, the way the desktop voice error
/// modal does: a title, one line on what is blocked, the steps to fix it,
/// and a deep link into the app's settings where the platform offers one.
Future<void> showVoiceDictationIssueDialog(
  BuildContext context,
  VoiceDictationIssue issue,
) {
  final (title, steps) = switch (issue) {
    VoiceDictationIssue.permissionDenied => (
      'Allow microphone access',
      const [
        'Open the system settings for this app.',
        'Turn on Microphone and Speech Recognition.',
        'Come back and select the microphone again.',
      ],
    ),
    VoiceDictationIssue.unavailable => (
      'Speech recognition is unavailable',
      const [
        'Check that a speech recognition service is installed and enabled.',
        'Make sure the device language has dictation support.',
        'Come back and select the microphone again.',
      ],
    ),
    VoiceDictationIssue.failed => (
      'Voice dictation stopped',
      const ['Check your connection and select the microphone again.'],
    ),
  };
  return showDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      key: const ValueKey('voice-dictation-dialog'),
      title: Text(title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text("Voice dictation can't start until this is fixed."),
          const SizedBox(height: 12),
          for (final (index, step) in steps.indexed)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text('${index + 1}. $step'),
            ),
        ],
      ),
      actions: [
        TextButton(
          key: const ValueKey('voice-dictation-close'),
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('Close'),
        ),
        // iOS resolves `app-settings:` to this app's page in Settings; Android
        // has no URL equivalent without a native intent, so it gets the steps.
        if (issue == VoiceDictationIssue.permissionDenied &&
            defaultTargetPlatform == TargetPlatform.iOS)
          FilledButton(
            key: const ValueKey('voice-dictation-settings'),
            onPressed: () {
              Navigator.of(dialogContext).pop();
              openExternalUrl('app-settings:');
            },
            child: const Text('Open Settings'),
          ),
      ],
    ),
  );
}
