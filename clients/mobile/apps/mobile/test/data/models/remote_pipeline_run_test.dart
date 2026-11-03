import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';

Map<String, dynamic> runJson({
  Object? jobs = _absent,
  bool truncated = false,
  List<Map<String, dynamic>> statusReasons = const [],
}) => {
  'localId': 'exec-1',
  'pipelineId': 'pipe-1',
  'pipelineName': 'CI',
  'workspaceLocalId': 'ws-1',
  'worktreeLocalId': 'wt-1',
  'status': 'running',
  'startedAt': '2026-09-16T10:00:00.000Z',
  'triggerSource': 'chat',
  'truncated': truncated,
  'progress': {'completedSteps': 2, 'totalSteps': 5},
  'statusReasons': statusReasons,
  if (!identical(jobs, _absent)) 'jobs': jobs,
};

const Object _absent = Object();

void main() {
  group('RemotePipelineRun.fromJson', () {
    test('parses a run with jobs, variants and steps', () {
      final run = RemotePipelineRun.fromJson(
        runJson(
          jobs: [
            {
              'jobId': 'build',
              'name': 'Build',
              'status': 'success',
              'needs': <String>[],
              'steps': [
                {
                  'stepId': 'compile',
                  'name': 'Compile',
                  'status': 'success',
                  'attempt': 1,
                  'outputTail': 'done\n',
                },
              ],
            },
            {
              'jobId': 'test',
              'name': 'Test',
              'status': 'running',
              'needs': ['build'],
              'steps': <Map<String, dynamic>>[],
              'variants': [
                {
                  'jobId': 'test_0',
                  'name': 'Test (linux)',
                  'status': 'running',
                  'matrix': {'os': 'linux'},
                  'steps': [
                    {'stepId': 'run', 'name': 'Run', 'status': 'running'},
                  ],
                },
              ],
            },
          ],
        ),
      );

      expect(run, isNotNull);
      expect(run!.localId, 'exec-1');
      expect(run.pipelineName, 'CI');
      expect(run.status, 'running');
      expect(run.triggerSource, 'chat');
      expect(run.progress?.completedSteps, 2);
      expect(run.progress?.totalSteps, 5);
      expect(run.isRoot, isTrue);
      expect(run.hasDetail, isTrue);
      expect(run.jobs!.map((j) => j.jobId), ['build', 'test']);
      expect(run.jobs!.first.steps.single.outputTail, 'done\n');
      expect(run.jobs!.last.needs, ['build']);
      expect(run.jobs!.last.variants.single.jobId, 'test_0');
      expect(run.jobs!.last.variants.single.matrix['os'], 'linux');
      expect(run.jobs!.last.variants.single.steps.single.stepId, 'run');
    });

    test('absent needs stay distinguishable from no dependencies', () {
      // The desktop always emits `needs` (empty when a job has none), so a
      // missing field means an older desktop with no dependency data.
      final run = RemotePipelineRun.fromJson(
        runJson(
          jobs: [
            {'jobId': 'old', 'name': 'Old', 'status': 'running'},
            {
              'jobId': 'root',
              'name': 'Root',
              'status': 'running',
              'needs': <String>[],
            },
          ],
        ),
      )!;
      expect(run.jobs!.first.needs, isNull);
      expect(run.jobs!.last.needs, isEmpty);
    });

    test('absent jobs parse to null, an empty array parses to empty', () {
      expect(RemotePipelineRun.fromJson(runJson())!.jobs, isNull);
      expect(RemotePipelineRun.fromJson(runJson())!.hasDetail, isFalse);
      final empty = RemotePipelineRun.fromJson(
        runJson(jobs: <Map<String, dynamic>>[]),
      )!;
      expect(empty.jobs, isEmpty);
      expect(empty.hasDetail, isTrue);
    });

    test('a row without a usable id is not a run', () {
      expect(RemotePipelineRun.fromJson(const {'status': 'running'}), isNull);
      expect(
        RemotePipelineRun.fromJson(const {'localId': '', 'status': 'x'}),
        isNull,
      );
    });

    test('malformed members are dropped, not thrown', () {
      final run = RemotePipelineRun.fromJson({
        'localId': 'exec-1',
        'status': 'running',
        'progress': 'nope',
        'statusReasons': 'nope',
        'jobs': [
          'nope',
          {'name': 'no id'},
          {'jobId': 'ok', 'name': 'Ok', 'status': 'pending', 'steps': 'nope'},
        ],
      })!;
      expect(run.progress, isNull);
      expect(run.statusReasons, isEmpty);
      expect(run.jobs!.map((j) => j.jobId), ['ok']);
      expect(run.jobs!.single.steps, isEmpty);
    });

    test('runId is accepted as the legacy id key', () {
      final run = RemotePipelineRun.fromJson(const {
        'runId': 'exec-legacy',
        'status': 'success',
      });
      expect(run?.localId, 'exec-legacy');
    });
  });

  group('RemotePipelineRun.mergeWith', () {
    RemotePipelineRun detailed() => RemotePipelineRun.fromJson(
      runJson(
        statusReasons: const [
          {'id': 'r1', 'kind': 'pause', 'code': 'usage_limit'},
        ],
        jobs: [
          {
            'jobId': 'build',
            'name': 'Build',
            'status': 'running',
            'steps': [
              {
                'stepId': 'compile',
                'name': 'Compile',
                'status': 'running',
                'outputTail': 'line 1\n',
              },
              {'stepId': 'link', 'name': 'Link', 'status': 'pending'},
            ],
          },
        ],
      ),
    )!;

    test('a retried active run clears the previous finish time', () {
      final completed = RemotePipelineRun.fromJson(
        runJson()
          ..['status'] = 'failure'
          ..['finishedAt'] = '2026-09-16T10:05:00.000Z',
      )!;

      final merged = completed.mergeWith(
        RemotePipelineRun.fromJson(runJson()..['status'] = 'pending')!,
      );

      expect(merged.status, 'pending');
      expect(merged.finishedAt, isNull);
    });

    for (final (attempt, iteration) in [(2, 1), (1, 2)]) {
      test('step output clears for attempt $attempt iteration $iteration', () {
        final previous = RemotePipelineRun.fromJson(
          runJson(
            jobs: [
              {
                'jobId': 'build',
                'status': 'failure',
                'steps': [
                  {
                    'stepId': 'compile',
                    'status': 'failure',
                    'attempt': 1,
                    'iteration': 1,
                    'outputTail': 'previous output\n',
                  },
                ],
              },
            ],
          ),
        )!;
        final incoming = RemotePipelineRun.fromJson(
          runJson(
            jobs: [
              {
                'jobId': 'build',
                'status': 'running',
                'steps': [
                  {
                    'stepId': 'compile',
                    'status': 'running',
                    'attempt': attempt,
                    'iteration': iteration,
                  },
                ],
              },
            ],
          ),
        )!;

        expect(
          previous.mergeWith(incoming).jobs!.single.steps.single.outputTail,
          isNull,
        );
      });
    }

    test('a truncated update never erases detail already held', () {
      final merged = detailed().mergeWith(
        RemotePipelineRun.fromJson(
          (runJson(truncated: true)..remove('pipelineName'))
            ..['status'] = 'success'
            ..['finishedAt'] = '2026-09-16T10:05:00.000Z',
        )!,
      );

      expect(merged.status, 'success');
      expect(merged.finishedAt, '2026-09-16T10:05:00.000Z');
      expect(merged.jobs!.single.steps.first.outputTail, 'line 1\n');
      expect(merged.statusReasons.single.code, 'usage_limit');
      // The truncated payload omits pipelineName (it falls back to the raw
      // execution id), so without the `pipelineName == localId` heuristic in
      // `mergeWith` the run's display name would flip to 'exec-1' on every
      // truncated tick.
      expect(merged.pipelineName, 'CI');
    });

    test('a truncated update keeps a detail-rich pause over the desktop\'s '
        'too_large stub', () {
      // Mirrors `pipelines-service.ts`'s re-attached checkpoint when a run
      // event exceeds the transfer budget: same id, kind, jobId, stepId,
      // but no `request` — so title/message/fieldLabels are all absent.
      final withPause = RemotePipelineRun.fromJson(
        runJson()
          ..['pendingPauses'] = [
            {
              'id': 'cp-1',
              'kind': 'input',
              'jobId': 'deploy',
              'stepId': 'confirm',
              'request': {
                'title': 'Pick a target',
                'message': 'Choose an environment',
                'fields': [
                  {'key': 'env', 'label': 'Environment'},
                ],
              },
            },
          ],
      )!;

      final merged = withPause.mergeWith(
        RemotePipelineRun.fromJson(
          runJson(truncated: true)
            ..['pendingPauses'] = [
              {
                'id': 'cp-1',
                'kind': 'input',
                'jobId': 'deploy',
                'stepId': 'confirm',
                'requestUnavailableReason': 'too_large',
              },
            ],
        )!,
      );

      expect(merged.pendingPauses.single.id, 'cp-1');
      expect(merged.pendingPauses.single.title, 'Pick a target');
      expect(merged.pendingPauses.single.message, 'Choose an environment');
      expect(merged.pendingPauses.single.fieldLabels, ['Environment']);
    });

    test('a settled update clears reasons a resumed run no longer has', () {
      final merged = detailed().mergeWith(
        RemotePipelineRun.fromJson(
          runJson(jobs: <Map<String, dynamic>>[])..['status'] = 'running',
        )!,
      );
      expect(merged.statusReasons, isEmpty);
      expect(merged.jobs, isEmpty);
    });

    test('a step keeps its fetched output when an update omits it', () {
      final merged = detailed().mergeWith(
        RemotePipelineRun.fromJson(
          runJson(
            jobs: [
              {
                'jobId': 'build',
                'name': 'Build',
                'status': 'running',
                'steps': [
                  {'stepId': 'compile', 'name': 'Compile', 'status': 'running'},
                  {
                    'stepId': 'link',
                    'name': 'Link',
                    'status': 'running',
                    'outputTail': 'linking\n',
                  },
                ],
              },
            ],
          ),
        )!,
      );

      expect(merged.jobs!.single.steps.first.outputTail, 'line 1\n');
      expect(merged.jobs!.single.steps.last.outputTail, 'linking\n');
    });

    test('an update with no jobs at all leaves existing jobs in place', () {
      final merged = detailed().mergeWith(
        RemotePipelineRun.fromJson(runJson()..['status'] = 'failure')!,
      );
      expect(merged.status, 'failure');
      expect(merged.jobs, isNotNull);
      expect(merged.jobs!.single.jobId, 'build');
    });
  });

  group('RemotePipelineRun chat links (CAN-3619)', () {
    Map<String, dynamic> link(
      String turn, {
      String chatId = 'chat-a',
      String relation = 'launched',
    }) => {'chatId': chatId, 'userMessageId': turn, 'relation': relation};

    RemotePipelineRun parse(Map<String, dynamic> json) =>
        RemotePipelineRun.fromJson(json)!;

    test('an older desktop sends no links', () {
      expect(parse(runJson()).chatTurns, isNull);
    });

    test('parses links, dropping malformed and duplicate entries', () {
      final run = parse({
        ...runJson(),
        'chatTurns': [
          link('u-1'),
          link('u-1'),
          link('u-2', relation: 'watching'),
          link('u-3', relation: 'unknown'),
          {'chatId': '', 'userMessageId': 'u-4', 'relation': 'launched'},
          {'chatId': 'chat-a', 'relation': 'launched'},
          'not-a-link',
        ],
      });
      expect(run.chatTurns, const [
        RemotePipelineRunChatTurn(
          chatId: 'chat-a',
          userMessageId: 'u-1',
          relation: 'launched',
        ),
        RemotePipelineRunChatTurn(
          chatId: 'chat-a',
          userMessageId: 'u-2',
          relation: 'watching',
        ),
      ]);
    });

    test('an update without links keeps the held links', () {
      final held = parse({
        ...runJson(),
        'chatTurns': [link('u-1')],
      });
      final merged = held.mergeWith(parse(runJson(truncated: true)));
      expect(merged.chatTurns!.single.userMessageId, 'u-1');
    });

    test('an explicit empty list clears links, even when truncated', () {
      final held = parse({
        ...runJson(),
        'chatTurns': [link('u-1')],
      });
      final merged = held.mergeWith(
        parse({...runJson(truncated: true), 'chatTurns': const []}),
      );
      expect(merged.chatTurns, isEmpty);
    });

    test('a links-only change replaces the links and keeps the jobs', () {
      final held = parse({
        ...runJson(
          jobs: [
            {'jobId': 'build', 'name': 'Build', 'status': 'running'},
          ],
        ),
        'chatTurns': [link('u-1')],
      });
      final merged = held.mergeWith(
        parse({
          ...runJson(truncated: true),
          'chatTurns': [link('u-2', relation: 'watching')],
        }),
      );
      expect(merged.chatTurns!.single.userMessageId, 'u-2');
      expect(merged.jobs!.single.jobId, 'build');
    });
  });

  group('keepHeldPipelineRunChatTurns (CAN-3619)', () {
    const linked = [
      {'chatId': 'chat-a', 'userMessageId': 'u-1', 'relation': 'launched'},
    ];

    test('rows without chatTurns keep the held links; explicit lists win', () {
      final kept =
          keepHeldPipelineRunChatTurns(
                [
                  {'localId': 'exec-1', 'status': 'failed'},
                  {'localId': 'exec-2', 'chatTurns': <Object?>[]},
                  {'localId': 'exec-3', 'chatTurns': null},
                  {'localId': 'exec-4'},
                ],
                [
                  {
                    'localId': 'exec-1',
                    'status': 'running',
                    'chatTurns': linked,
                  },
                  {'localId': 'exec-2', 'chatTurns': linked},
                  {'localId': 'exec-3', 'chatTurns': linked},
                  {'localId': 'exec-5', 'chatTurns': linked},
                ],
              )!
              as List;
      expect(kept, [
        {'localId': 'exec-1', 'status': 'failed', 'chatTurns': linked},
        {'localId': 'exec-2', 'chatTurns': <Object?>[]},
        {'localId': 'exec-3', 'chatTurns': linked},
        {'localId': 'exec-4'},
      ]);
    });

    test('returns the incoming rows themselves when nothing is kept', () {
      final incoming = [
        {'localId': 'exec-1', 'chatTurns': linked},
      ];
      expect(
        identical(
          keepHeldPipelineRunChatTurns(incoming, [
            {'localId': 'exec-1', 'chatTurns': <Object?>[]},
          ]),
          incoming,
        ),
        isTrue,
      );
      expect(
        identical(keepHeldPipelineRunChatTurns(incoming, null), incoming),
        isTrue,
      );
      expect(keepHeldPipelineRunChatTurns(null, incoming), isNull);
    });
  });

  group('chat follow-up availability (CAN-3719)', () {
    RemotePipelineRun run(Object? chatFollowUp, {bool truncated = false}) =>
        RemotePipelineRun.fromJson({
          ...runJson(truncated: truncated),
          'status': 'failure',
          'chatFollowUp': ?chatFollowUp,
        })!;

    test('parses saved plan and report availability', () {
      final both = run({'planAvailable': true, 'reportAvailable': true});
      expect(both.chatFollowUp?.planAvailable, isTrue);
      expect(both.chatFollowUp?.reportAvailable, isTrue);

      final planOnly = run({'planAvailable': true, 'reportAvailable': false});
      expect(planOnly.chatFollowUp?.planAvailable, isTrue);
      expect(planOnly.chatFollowUp?.reportAvailable, isFalse);
    });

    test('absent or malformed availability is unknown', () {
      expect(run(null).chatFollowUp, isNull);
      expect(run('yes').chatFollowUp, isNull);
      final partial = run({'reportAvailable': true});
      expect(partial.chatFollowUp?.planAvailable, isFalse);
      expect(partial.chatFollowUp?.reportAvailable, isTrue);
    });

    test('an update without availability keeps the held facts', () {
      final held = run({'planAvailable': true, 'reportAvailable': true});
      expect(
        held
            .mergeWith(run(null, truncated: true))
            .chatFollowUp
            ?.reportAvailable,
        isTrue,
      );
      expect(held.mergeWith(run(null)).chatFollowUp?.planAvailable, isTrue);
    });

    test('an explicit update replaces and can clear availability', () {
      final held = run({'planAvailable': true, 'reportAvailable': true});
      final cleared = held.mergeWith(
        run({'planAvailable': false, 'reportAvailable': false}),
      );
      expect(cleared.chatFollowUp?.planAvailable, isFalse);
      expect(cleared.chatFollowUp?.reportAvailable, isFalse);
    });
  });
}
