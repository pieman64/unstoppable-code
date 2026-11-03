import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/main.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_transcript_cache_scope.dart';

import 'support/memory_remote_transcript_storage.dart';

void main() {
  testWidgets(
    'CAN-3373 the transcript cache scope sits above the root navigator',
    (tester) async {
      final storage = MemoryRemoteTranscriptStorage();
      await tester.pumpWidget(
        App(
          themeController: ThemeController(
            store: InMemoryThemePreferenceStore(),
          ),
          transcriptStorage: storage,
        ),
      );
      // Routes pushed on the root navigator read the same cache as the shell.
      expect(
        find.ancestor(
          of: find.byType(MaterialApp),
          matching: find.byType(RemoteTranscriptCacheScope),
        ),
        findsOneWidget,
      );
      // Flush the mock restore() timer so no timer is left pending.
      await tester.pump(const Duration(seconds: 1));
      // A launch that finds nobody signed in purges the injected storage.
      expect(storage.log, ['clear']);
    },
  );
}
