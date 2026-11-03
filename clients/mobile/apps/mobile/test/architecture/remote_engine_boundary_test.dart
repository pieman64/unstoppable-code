// Pins the Flutter-independent Remote Control engine boundary (CAN-3524):
// the collaborators extracted from `RemoteControlViewModel` must run and be
// tested without Flutter, so their whole import closure stays pure Dart.
// Lifecycle and route visibility reach them as plain inputs.
//
// Runs under `flutter test`, whose working directory is the package root.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Engine collaborators. Add each extraction that joins the engine.
const engineRoots = [
  'lib/ui/features/remote/view_models/app_advisor_controller.dart',
  'lib/ui/features/remote/view_models/background_process_patch.dart',
  'lib/ui/features/remote/view_models/background_tray/view_model.dart',
  'lib/ui/features/remote/view_models/watcher_patch.dart',
  'lib/ui/features/remote/view_models/watcher_slice_store.dart',
  'lib/ui/core/chat/view_models/chat_attachment_draft.dart',
  'lib/ui/core/chat/view_models/chat_attachment_stager.dart',
  'lib/ui/features/remote/view_models/chat_send_coordinator.dart',
  'lib/ui/features/remote/view_models/chat_transcript_store.dart',
  'lib/ui/features/remote/view_models/composer_overrides_controller.dart',
  'lib/ui/features/remote/view_models/hook_descriptor_patch.dart',
  'lib/ui/features/remote/view_models/hydration_coordinator.dart',
  'lib/ui/features/remote/view_models/overview_refresh_scheduler.dart',
  'lib/ui/features/remote/view_models/owned_command_registry.dart',
  'lib/ui/features/remote/view_models/pipeline_chat_follow_up_coordinator.dart',
  'lib/ui/features/remote/view_models/pipeline_content_reader.dart',
  'lib/ui/features/remote/view_models/pipeline_dispatcher.dart',
  'lib/ui/features/remote/view_models/pipeline_input_form.dart',
  'lib/ui/features/remote/view_models/pipeline_run_tracker.dart',
  'lib/ui/features/remote/view_models/pending_chat_attachment_store.dart',
  'lib/ui/features/remote/view_models/pending_question_tracker.dart',
  'lib/ui/features/remote/view_models/picker_copy_recorder.dart',
  'lib/ui/features/remote/view_models/pr_state_tracker.dart',
  'lib/ui/features/remote/view_models/project_clone_coordinator.dart',
  'lib/ui/features/remote/view_models/provider_usage_tracker.dart',
  'lib/ui/features/remote/view_models/provisional_worktree_chat_creator.dart',
  'lib/ui/features/remote/view_models/read_receipt_tracker.dart',
  'lib/ui/features/remote/view_models/remote_chat_revision.dart',
  'lib/ui/features/remote/view_models/remote_chat_tabs_controller.dart',
  'lib/ui/features/remote/view_models/remote_client_engine.dart',
  'lib/ui/features/remote/view_models/remote_composer_effort.dart',
  'lib/ui/features/remote/view_models/remote_control_state.dart',
  'lib/ui/features/remote/view_models/remote_identity.dart',
  'lib/ui/features/remote/view_models/remote_session_controller.dart',
  'lib/ui/features/remote/view_models/remote_session_store.dart',
  'lib/ui/features/remote/view_models/remote_shell_reducer.dart',
  'lib/ui/features/remote/view_models/remote_unsent_sends.dart',
  'lib/ui/features/remote/view_models/snapshot_memo.dart',
  'lib/ui/features/remote/view_models/worktree_activity_load_tracker.dart',
  'lib/ui/features/remote/view_models/worktree_archive_coordinator.dart',
  'lib/ui/features/remote/view_models/worktree_create_coordinator.dart',
  'lib/data/models/turn_outcome.dart',
  'lib/data/repositories/remote_transcript_cache.dart',
  'lib/data/models/turn_timer.dart',
  'lib/services/attachment_archive_ledger.dart',
];

/// Pure Dart packages the engine may reach through its data layer.
const allowedPackages = ['http', 'crypto'];

final _directive = RegExp(r'''^\s*(?:import|export)\s+['"]([^'"]+)['"]''');

/// Every `lib/` file reachable from [root], mapped to the external URIs it
/// imports.
Map<String, List<String>> importClosure(String root) {
  final closure = <String, List<String>>{};
  final pending = [root];
  while (pending.isNotEmpty) {
    final path = pending.removeLast();
    if (closure.containsKey(path)) continue;
    final external = closure[path] = [];
    for (final line in File(path).readAsLinesSync()) {
      final uri = _directive.firstMatch(line)?.group(1);
      if (uri == null) continue;
      if (uri.startsWith('package:mobile/')) {
        pending.add('lib/${uri.substring('package:mobile/'.length)}');
      } else if (uri.startsWith('package:') || uri.startsWith('dart:')) {
        external.add(uri);
      } else {
        pending.add(File(path).parent.uri.resolve(uri).toFilePath());
      }
    }
  }
  return closure;
}

bool isAllowed(String uri) {
  if (uri.startsWith('dart:')) return uri != 'dart:ui';
  final package = uri.substring('package:'.length).split('/').first;
  return allowedPackages.contains(package);
}

void main() {
  for (final root in engineRoots) {
    test('$root imports no Flutter or platform code', () {
      final violations = [
        for (final MapEntry(key: path, value: uris) in importClosure(
          root,
        ).entries)
          for (final uri in uris)
            if (!isAllowed(uri)) '$path: $uri',
      ];
      expect(violations, isEmpty);
    });
  }
}
