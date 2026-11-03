// Five sequential diff opens with real SharedPreferences storage. Run the
// same harness before/after with flutter drive --profile --no-dds, using
// test_driver/integration_test.dart. The response contains the Dart timeline.
import 'dart:developer';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_diff_cache.dart';
import 'package:mobile/ui/features/remote/views/remote_file_diff_screen.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'package:shared_preferences_platform_interface/types.dart';

import '../test/support/fake_remote_control_repository.dart';

class _RecordingPreferences extends SharedPreferencesStorePlatform {
  _RecordingPreferences(this.inner);
  final SharedPreferencesStorePlatform inner;
  final writes = <String>[];

  @override
  Future<Map<String, Object>> getAll() => inner.getAll();

  @override
  Future<Map<String, Object>> getAllWithParameters(
    GetAllParameters parameters,
  ) => inner.getAllWithParameters(parameters);

  @override
  Future<bool> remove(String key) => inner.remove(key);

  @override
  Future<bool> clear() => inner.clear();

  @override
  Future<bool> setValue(String valueType, String key, Object value) {
    if (key.endsWith('remote-file-diffs-v1') && value is String) {
      writes.add(value);
    }
    return inner.setValue(valueType, key, value);
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('CAN-4879 open five diffs in sequence', (tester) async {
    expect(kProfileMode, isTrue, reason: 'Run with flutter drive --profile');
    final preferences = _RecordingPreferences(
      SharedPreferencesStorePlatform.instance,
    );
    SharedPreferencesStorePlatform.instance = preferences;
    final cache = RemoteFileDiffCache(maxEntries: 32, persist: true);
    cache.clear();
    await cache.flush();
    final repository = FakeRemoteControlRepository()
      ..connectedSessionId = 'synthetic-can-4879';
    repository.readFileDiffHandler = (path, source) async =>
        RemoteFileDiff(filePath: path, patch: '@@ -1 +1 @@\n+${'x' * 90000}\n');
    final vm = RemoteControlViewModel(
      repository: repository,
      fileDiffCache: cache,
    );
    await vm.connect('123456');
    await cache.restoreSession(repository.connectedSessionId);
    final timings = <FrameTiming>[];
    void record(List<FrameTiming> frames) => timings.addAll(frames);
    SchedulerBinding.instance.addTimingsCallback(record);
    final elapsed = Stopwatch()..start();
    await binding.traceAction(
      () async {
        for (var i = 0; i < 5; i++) {
          final task = TimelineTask()
            ..start('CAN4879.openDiff', arguments: {'file': i});
          await tester.pumpWidget(
            ChangeNotifierProvider.value(
              value: vm,
              child: MaterialApp(
                theme: AppTheme.light,
                home: RemoteFileDiffScreen(
                  key: ValueKey(i),
                  workspaceLocalId: 'ws-1',
                  worktreeLocalId: 'wt-1',
                  file: RemoteChangedFile(
                    filePath: 'file-$i.dart',
                    status: 'modified',
                    committed: false,
                    revision: 'revision-1',
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.byType(CircularProgressIndicator), findsNothing);
          task.finish();
        }
        await cache.flush();
      },
      streams: const ['Dart'],
      reportKey: 'timeline_five_diffs',
    );
    elapsed.stop();
    SchedulerBinding.instance.removeTimingsCallback(record);
    binding.reportData!['summary'] = {
      'elapsedMs': elapsed.elapsedMicroseconds / 1000,
      'buildMicros': [
        for (final frame in timings) frame.buildDuration.inMicroseconds,
      ],
      'rasterMicros': [
        for (final frame in timings) frame.rasterDuration.inMicroseconds,
      ],
      'requests': repository.readFileDiffCalls.length,
      'entries': cache.length,
      'storageWrites': preferences.writes.length,
      'storageBytes': preferences.writes.fold<int>(
        0,
        (sum, value) => sum + utf8.encode(value).length,
      ),
    };
    await tester.pumpWidget(const SizedBox());
    vm.dispose();
    cache.clear();
    await cache.flush();
  });
}
