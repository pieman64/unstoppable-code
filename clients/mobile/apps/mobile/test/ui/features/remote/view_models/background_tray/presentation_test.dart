import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/presentation.dart';

void main() {
  test(
    'task detail prefers progress, falls back to summary and hides the title',
    () {
      BackgroundTrayTask task({String? progress, String? summary}) =>
          BackgroundTrayTask(
            RemoteBackgroundProcess(
              localId: 'task',
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
              chatId: 'chat',
              toolUseId: '',
              kind: RemoteBackgroundProcessKind.task,
              description: 'Check packages',
              status: RemoteBackgroundProcessStatus.running,
              canStop: true,
              lastDescription: progress,
              summary: summary,
            ),
          );
      expect(
        backgroundTrayTaskDetail(
          task(progress: 'Checking imports', summary: 'Summary'),
        ),
        'Checking imports',
      );
      expect(
        backgroundTrayTaskDetail(task(summary: 'Packages checked')),
        'Packages checked',
      );
      expect(
        backgroundTrayTaskDetail(
          task(progress: 'Check packages', summary: 'Summary'),
        ),
        isNull,
      );
      expect(backgroundTrayTaskDetail(task(summary: 'Check packages')), isNull);
    },
  );

  test(
    'agent activity falls back to the latest friendly step, retaining wire family',
    () {
      BackgroundTrayAgent agent(String? activity) => BackgroundTrayAgent(
        id: 'review',
        title: 'Review',
        kind: BackgroundTrayAgentKind.claude,
        status: BackgroundTrayAgentStatus.running,
        activity: activity,
        steps: const [
          BackgroundTrayAgentStep(
            id: 'step',
            toolName: 'custom_read',
            toolFamily: 'read',
            input: '{"file_path":"/workspace/release.dart"}',
          ),
        ],
      );
      expect(
        backgroundTrayAgentActivity(agent('Checking changes')),
        'Checking changes',
      );
      expect(backgroundTrayAgentActivity(agent('Review')), 'Read release.dart');
      expect(backgroundTrayAgentActivity(agent(null)), 'Read release.dart');
    },
  );
}
