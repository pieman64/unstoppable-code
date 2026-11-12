import 'dart:convert';
import 'display.dart';
export 'display.dart' show pipelineDisplay;
import 'package:mobile/data/models/computer_activity/pipeline_content.dart';
import '../chats/dto.dart';
import '../chats/models.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';

/// Mobile display mapping over existing pipeline IPC. Paths stay opaque and
/// are returned to the computer only as lookup/execution context.
final class DevicePipelineIpc {
  DevicePipelineIpc(this.ipc);
  final DesktopIpc ipc;
  final _lookups = <String, Object>{};
  String _key(DeviceChatRef ref, String id, String source) =>
      '${ref.projectId}/${ref.worktreeId}/$source/$id';
  Future<Object?> _read(String channel, [List<Object?> args = const []]) async {
    final result = deviceLinkObject(
      deviceChatDto(await ipc.invoke(channel, args)),
    );
    if (result['success'] == false) {
      throw DesktopIpcRefusal(
        result['error'] as String? ??
            'The computer could not complete this pipeline request.',
      );
    }
    if (result['success'] != true) {
      throw const DeviceLinkException(
        'The computer sent an invalid pipeline reply.',
      );
    }
    return result['data'];
  }

  Future<Map<String, dynamic>> state(DeviceChatRef ref, String id) async {
    final row = deviceLinkObject(await _read('pipelines:get-execution', [id]));
    if (row['id'] != id ||
        row['project_id'] != ref.projectId ||
        row['worktree_id'] != ref.worktreeId) {
      throw const DeviceLinkException(
        'The computer sent a pipeline for a different worktree.',
      );
    }
    return row;
  }

  Future<Map<String, dynamic>> request(
    DeviceChatRef ref,
    String action,
    Map<String, Object?> args,
    bool Function() isCurrent, {
    void Function()? onMutationSent,
  }) async {
    final id = args['executionId'] as String?;
    if (action == 'executions') {
      final rows = await _read('pipelines:list-executions');
      return {
        'runs': [
          for (final raw in rows as List? ?? const [])
            if (raw is Map<String, dynamic> &&
                raw['project_id'] == ref.projectId &&
                raw['worktree_id'] == ref.worktreeId)
              pipelineDisplay(raw),
        ],
      };
    }
    if (action == 'list') {
      final cwd = await ipc.invoke('worktree:get-path', [ref.scope]);
      final lists = await Future.wait([
        _read('pipelines:list'),
        _read('pipelines:discover-project', [cwd]),
      ]);
      final rows = <Map<String, dynamic>>[];
      for (final raw in [
        ...lists[0] as List? ?? const [],
        ...lists[1] as List? ?? const [],
      ]) {
        final row = deviceLinkObject(raw),
            pipelineId = deviceLinkString(deviceLinkObject(raw), 'id');
        final source = deviceLinkString(row, 'source');
        _lookups[_key(ref, pipelineId, source)] = source == 'project'
            ? {'id': pipelineId, 'cwd': cwd, 'filePath': row['filePath']}
            : {'id': pipelineId, 'source': source};
        rows.add({...row, 'pipelineId': pipelineId, 'origin': row['source']});
      }
      return {'pipelines': rows};
    }
    if (action == 'definition' || action == 'run') {
      final pipelineId = args['pipelineId'] as String,
          source = args['origin'] as String,
          key = _key(
            ref,
            args['pipelineId'] as String,
            args['origin'] as String,
          );
      final definition = deviceLinkObject(
        await _read('pipelines:get', [
          _lookups[key] ?? {'id': pipelineId, 'source': source},
        ]),
      );
      final content = deviceLinkObject(definition['content']);
      if (action == 'definition') {
        final metadata = content['pipeline'] is Map
            ? content['pipeline'] as Map
            : content;
        final on = metadata['on'];
        final dispatch = on is Map ? on['dispatch'] : null;
        return {
          'dispatchInputs': dispatch is Map ? dispatch['inputs'] ?? {} : {},
        };
      }
      final cwd = await ipc.invoke('worktree:get-path', [ref.scope]);
      final info = deviceLinkObject(definition['info']);
      if (!isCurrent()) {
        throw const DeviceLinkException('The computer connection changed.');
      }
      onMutationSent?.call();
      final row = deviceLinkObject(
        await _read('pipelines:execute', [
          content,
          {
            ...ref.scope,
            'pipelineId': pipelineId,
            'cwd': cwd,
            'scope': 'worktree',
            'eventName': 'dispatch',
            'inputs': args['inputs'],
            'modelConfig': ?args['modelConfig'],
            if (info['source'] == 'project')
              'pipelineFilePath': info['filePath'],
            'pipelinePreferenceLocator': info['source'] == 'project'
                ? {'type': 'file', 'value': info['filePath']}
                : {'type': 'stored', 'source': source, 'value': pipelineId},
          },
        ]),
      );
      return {'executionId': deviceLinkString(row, 'id')};
    }
    final current = await state(ref, id!);
    if (action == 'get') return pipelineDisplay(current);
    if (['cancel', 'retry', 'resume'].contains(action)) {
      if (!isCurrent()) {
        throw const DeviceLinkException('The computer connection changed.');
      }
      final channel = {
        'cancel': 'pipelines:cancel-execution',
        'retry': 'pipelines:retry-execution',
        'resume': 'pipelines:resume',
      }[action]!;
      final result = deviceLinkObject(
        await _read(channel, [
          id,
          if (action == 'resume')
            {
              'statusReasonIds': [
                for (final reason
                    in current['status_reasons'] as List? ?? const [])
                  if (reason is Map && reason['id'] is String) reason['id'],
              ],
            },
        ]),
      );
      // Validate the returned scope as well as the pre-mutation read.
      if (result['project_id'] != ref.projectId ||
          result['worktree_id'] != ref.worktreeId) {
        throw const DeviceLinkException(
          'The pipeline connection changed. Refresh its state.',
        );
      }
      return pipelineDisplay(result);
    }
    if (action == 'log') {
      final output = await _content(id, {
        'kind': 'step_output',
        'jobId': args['jobId'] as String,
        'stepId': args['stepId'] as String,
      }, current);
      final display = pipelineDisplay(current);
      for (final job in display['jobs'] as List) {
        for (final physical in [job, ...job['variants'] as List? ?? const []]) {
          if (physical['jobId'] != args['jobId']) continue;
          for (final step in physical['steps'] as List) {
            if (step['stepId'] == args['stepId']) {
              step['outputTail'] = pipelineOutputTail(output.text);
            }
          }
        }
      }
      return {'run': display};
    }
    throw const DeviceLinkException(
      'This pipeline action has not been ported yet.',
    );
  }

  Future<RemotePipelineContentDocument> content(
    DeviceChatRef ref,
    String id,
    Map<String, Object> source,
  ) async {
    return _content(id, source, await state(ref, id));
  }

  Future<RemotePipelineContentDocument> _content(
    String id,
    Map<String, Object> source,
    Map<String, dynamic> current,
  ) async {
    if (source['kind'] == 'report') {
      final outputs = deviceLinkObject(
        current['report_outputs'] ?? <String, dynamic>{},
      );
      final json =
          outputs['report_file'] == null && outputs['report_json_file'] != null;
      final result = deviceLinkObject(
        await _read('pipelines:read-report-file', [id, json ? 'json' : 'text']),
      );
      final text = result['content'] as String? ?? '';
      return RemotePipelineContentDocument(
        format: json
            ? RemotePipelineContentFormat.text
            : RemotePipelineContentFormat.markdown,
        text: json && text.isNotEmpty
            ? const JsonEncoder.withIndent('  ').convert(jsonDecode(text))
            : text,
      );
    }
    final jobs = deviceLinkObject(current['jobs']);
    final job = jobs[source['jobId']];
    final step = job is Map && job['steps'] is Map
        ? (job['steps'] as Map)[source['stepId']]
        : null;
    if (step is! Map) {
      throw const DeviceLinkException(
        'This pipeline step is no longer available.',
      );
    }
    final result = deviceLinkObject(
      await _read('pipelines:read-step-log', [
        {
          'executionId': id,
          'jobId': source['jobId'],
          'stepId': source['stepId'],
          'attempt': pipelineAttempt(deviceLinkObject(job)),
          'iteration': pipelineIteration(deviceLinkObject(job)),
          'recovery': step['recovery_count'] ?? 0,
          if (step['log_file'] is String) 'logFilePath': step['log_file'],
        },
        {'format': 'text'},
      ]),
    );
    return RemotePipelineContentDocument(
      format: RemotePipelineContentFormat.text,
      text:
          result['text'] as String? ??
          (result['lines'] as List? ?? const []).join('\n'),
    );
  }
}

String pipelineOutputTail(String text) {
  final bytes = utf8.encode(text);
  if (bytes.length <= 2048) return text;
  var start = bytes.length - 2048;
  while (start < bytes.length && bytes[start] & 0xc0 == 0x80) {
    start++;
  }
  return utf8.decode(bytes.sublist(start));
}
