import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/mapper.dart';

import 'fixtures.dart';

void main() {
  test(
    'task projection preserves process identity, progress and settlement',
    () {
      final live = task('shell');
      expect(live.id, 'shell');
      expect(live.title, 'Task shell');
      expect(live.process.toolUseId, 'tool-shell');
      expect(live.process.lastDescription, 'Compiling');
      expect(live.settledAt, isNull);
      expect(
        task('done', status: RemoteBackgroundProcessStatus.stopped).settledAt,
        2000,
      );
      expect(
        task(
          'future',
          kind: RemoteBackgroundProcessKind.unknown,
          status: RemoteBackgroundProcessStatus.unknown,
        ).kind,
        BackgroundTrayKind.task,
      );
    },
  );

  test(
    'Claude part joins its task by tool use id and caps steps at the newest 20',
    () {
      final rows = mapBackgroundTrayAgents(
        [
          message([
            nativeAgent(
              subBlocks: [
                {
                  'kind': 'thinking',
                  'data': {'text': 'not a step'},
                },
                for (var i = 0; i < 22; i++)
                  {
                    'kind': 'tool_use',
                    'data': {
                      'toolUseId': 'read-$i',
                      'name': 'Read',
                      'input': {'path': '$i.dart'},
                    },
                  },
              ],
            ),
          ]),
        ],
        [task('agent', kind: RemoteBackgroundProcessKind.agent)],
      );
      final row = rows.single;
      expect(
        (row.id, row.kind, row.status),
        (
          'claude:tool-agent',
          BackgroundTrayAgentKind.claude,
          BackgroundTrayAgentStatus.running,
        ),
      );
      expect((row.taskId, row.startedAt), ('agent', 1000));
      expect(row.meta, 'Claude · reviewer');
      expect(row.prompt, 'Review it.');
      expect(row.target?.id, 'tool-agent');
      expect(row.steps, hasLength(20));
      expect(row.steps.first.id, 'read-2');
      expect(row.steps.last.input, '{"path":"21.dart"}');
    },
  );

  test(
    'live agent processes supply fallback rows without a transcript target',
    () {
      final row = mapBackgroundTrayAgents([], [
        task('agent', kind: RemoteBackgroundProcessKind.agent),
        task('shell'),
        task(
          'settled',
          kind: RemoteBackgroundProcessKind.agent,
          status: RemoteBackgroundProcessStatus.completed,
        ),
        task(
          'no-owner',
          kind: RemoteBackgroundProcessKind.agent,
          toolUseId: '',
        ),
      ]).single;
      expect(row.id, 'claude:tool-agent');
      expect(row.taskId, 'agent');
      expect(row.activity, 'Compiling');
      expect(row.target, isNull);
    },
  );

  test(
    'queued process stays queued and native agent uses process activity',
    () {
      final queued = mapBackgroundTrayAgents([], [
        task(
          'queued',
          kind: RemoteBackgroundProcessKind.agent,
          status: RemoteBackgroundProcessStatus.queued,
        ),
      ]).single;
      expect(queued.status, BackgroundTrayAgentStatus.queued);
      final native = mapBackgroundTrayAgents(
        [
          message([nativeAgent()]),
        ],
        [task('agent', kind: RemoteBackgroundProcessKind.agent)],
      ).single;
      expect(native.activity, 'Compiling');
    },
  );

  test(
    'latest parts replace earlier agents, including nested settled parts',
    () {
      final rows = mapBackgroundTrayAgents(
        [
          message([nativeAgent(), delegate()]),
          message([
            nativeAgent(running: false),
            nativeAgent(
              toolUseId: 'outer',
              subBlocks: [
                {'kind': 'agent', 'data': delegate(status: 'completed').data},
              ],
            ),
          ]),
        ],
        [task('agent', kind: RemoteBackgroundProcessKind.agent)],
      );
      expect(rows.map((row) => row.id), ['claude:outer']);
    },
  );

  test(
    'foreground Claude agents leave; live Codex children need no background flag',
    () {
      final rows = mapBackgroundTrayAgents([
        message([
          nativeAgent(background: false),
          nativeAgent(toolUseId: 'codex', provider: 'codex', background: false),
        ]),
      ], []);
      final row = rows.single;
      expect(row.id, 'codex:codex');
      expect(row.meta, 'Codex · gpt-6-sol · high');
      expect(row.taskId, isNull);
      expect(row.target, isNull);
    },
  );

  test(
    'background delegates include pending and approval, never terminal or foreground',
    () {
      final rows = mapBackgroundTrayAgents([
        message([
          delegate(),
          delegate(id: 'pending', status: 'pending', approval: true),
          delegate(id: 'approval', approval: true),
          delegate(id: 'done', status: 'completed'),
          delegate(id: 'foreground', executionMode: 'foreground'),
          const ChatPart(kind: 'agent', data: {'delegation': 'malformed'}),
          const ChatPart(kind: 'agent'),
        ]),
      ], []);
      expect(rows.map((row) => (row.id, row.status)), [
        ('managed:d1', BackgroundTrayAgentStatus.running),
        ('managed:pending', BackgroundTrayAgentStatus.queued),
        ('managed:approval', BackgroundTrayAgentStatus.approval),
      ]);
      expect(rows.first.meta, 'Delegate · GPT-6 Sol');
      expect(rows.first.target?.kind, BackgroundTrayAgentTargetKind.managed);
    },
  );

  test(
    'pipeline rows use current host status and dedupe linked turns and receipts',
    () {
      final hostRun = pipeline('live');
      final rows = mapBackgroundTrayPipelineRuns(
        target: target,
        messages: [
          message([
            receipt('live', folded: true),
            receipt('live'),
            receipt('missing'),
          ]),
        ],
        pipelineRuns: [
          hostRun,
          pipeline('unlinked', linked: false),
          pipeline('other-chat', chatId: 'elsewhere'),
        ],
      );
      final row = rows.single;
      expect(row.id, 'canopy:pipeline_run:execution:live');
      expect(row.title, 'Receipt live');
      expect(row.status, BackgroundTrayRunStatus.running);
      expect(
        row.startedAt,
        DateTime.parse('2026-10-25T09:59:00Z').millisecondsSinceEpoch,
      );
      expect(row.pipelineRun, same(hostRun));
      expect(
        mapBackgroundTrayPipelineRuns(
          target: target,
          messages: [],
          pipelineRuns: [hostRun],
        ).single.id,
        row.id,
      );
    },
  );

  test('pipeline selection excludes foreign scopes, hidden and child runs', () {
    final rows = mapBackgroundTrayPipelineRuns(
      target: target,
      messages: [
        message([receipt('no-link', error: true)]),
      ],
      pipelineRuns: [
        pipeline('other-ws', workspace: 'other'),
        pipeline('other-wt', worktree: 'other'),
        pipeline('hidden', hidden: true),
        pipeline('child', parent: 'root'),
        pipeline('no-link', linked: false),
      ],
    );
    expect(rows, isEmpty);
  });

  test('pipeline status aliases and input questions map to drawer states', () {
    final rows = mapBackgroundTrayPipelineRuns(
      target: target,
      messages: [],
      pipelineRuns: [
        pipeline(
          'input',
          status: 'paused',
          pauses: [
            const RemotePipelinePauseCheckpoint(
              id: 'p',
              kind: 'input',
              jobId: 'j',
              stepId: 's',
              title: 'Approve deploy',
            ),
          ],
        ),
        for (final status in [
          'paused',
          'success',
          'completed',
          'failed',
          'timed_out',
          'cancelled',
          'queued',
          'future',
        ])
          pipeline(status, status: status),
      ],
    );
    expect(rows.first.question, 'Approve deploy');
    expect(rows.map((row) => row.status), [
      BackgroundTrayRunStatus.needsInput,
      BackgroundTrayRunStatus.paused,
      BackgroundTrayRunStatus.succeeded,
      BackgroundTrayRunStatus.succeeded,
      BackgroundTrayRunStatus.failed,
      BackgroundTrayRunStatus.failed,
      BackgroundTrayRunStatus.cancelled,
      BackgroundTrayRunStatus.running,
      BackgroundTrayRunStatus.running,
    ]);
  });
}
