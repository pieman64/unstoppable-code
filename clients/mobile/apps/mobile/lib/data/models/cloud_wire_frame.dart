/// Total, browser-contract-compatible boundary for Core's protocol-v1 frames.
/// Mirrors apps/web/src/lib/cloud/core-wire.ts; accepts decoded JSON.
library;

import 'dart:convert';
import 'package:mobile/data/models/cloud_chat.dart';

sealed class CloudWireFrame {
  const CloudWireFrame(this.type, {this.sourceKey});
  final String type;
  final String? sourceKey;
}

final class CloudMessageStart extends CloudWireFrame {
  const CloudMessageStart({required this.isAssistant, super.sourceKey})
    : super('message.start');
  final bool isAssistant;
}

final class CloudMessageDelta extends CloudWireFrame {
  const CloudMessageDelta(this.text, {super.sourceKey})
    : super('message.delta');
  final String text;
}

final class CloudMessageReasoning extends CloudWireFrame {
  const CloudMessageReasoning(this.text, {super.sourceKey})
    : super('message.reasoning');
  final String text;
}

final class CloudMessageFinish extends CloudWireFrame {
  const CloudMessageFinish({
    super.sourceKey,
    this.model,
    this.usage,
    this.cost = const CloudCoreCost(kind: CloudCoreCostKind.pending),
    this.finalText,
    this.reasoningText,
    this.finishReason,
  }) : super('message.finish');
  final Map<String, dynamic>? model;
  final Map<String, dynamic>? usage;
  final CloudCoreCost cost;
  final String? finalText;
  final String? reasoningText;
  final String? finishReason;
}

final class CloudToolFrame extends CloudWireFrame {
  CloudToolFrame(this.activity)
    : super(
        activity.kind == CloudToolActivityKind.call
            ? 'tool.call'
            : 'tool.result',
        sourceKey: activity.sourceKey,
      );
  final CloudChatToolActivity activity;
}

final class CloudArtifactCreated extends CloudWireFrame {
  const CloudArtifactCreated(this.artifact) : super('artifact.created');
  final CloudCoreArtifact artifact;
}

final class CloudHarnessWarning extends CloudWireFrame {
  const CloudHarnessWarning({
    required this.code,
    this.message,
    this.warnings = const [],
    this.filenames = const [],
  }) : super('harness.warning');
  final String code;
  final String? message;
  final List<String> warnings;
  final List<String> filenames;
}

final class CloudHarnessEvent extends CloudWireFrame {
  const CloudHarnessEvent({
    required this.kind,
    this.status,
    this.trigger,
    this.summary,
    this.tokensBefore,
    this.tokensAfter,
    super.sourceKey,
  }) : super('harness.event');
  final String kind;
  final String? status;
  final String? trigger;
  final String? summary;
  final num? tokensBefore;
  final num? tokensAfter;
}

final class CloudWireError extends CloudWireFrame {
  const CloudWireError({this.code, this.message}) : super('error');
  final String? code;
  final String? message;
}

final class CloudWireIgnored extends CloudWireFrame {
  const CloudWireIgnored(this.event, {this.taskId}) : super('ignored');
  final String event;

  /// Set when the frame is agent task (child) activity, which mobile hides.
  final String? taskId;
}

final class CloudWireUnparseable extends CloudWireFrame {
  const CloudWireUnparseable(this.event, this.issue) : super('unparseable');
  final String event;
  final String issue;
}

CloudWireFrame parseCloudWireFrame(String event, Object? data) {
  // Serialization failures and malformed payloads are data, never exceptions
  // that can tear down the stream subscription.
  try {
    return _parse(
      event,
      data is Map && data.keys.every((k) => k is String)
          ? Map<String, dynamic>.from(data)
          : data,
    );
  } on Object {
    return CloudWireUnparseable(event, 'Malformed Core payload');
  }
}

String? _string(Object? v) => v is String ? v : null;
String? _nonempty(Object? v) => v is String && v.isNotEmpty ? v : null;
Map<String, dynamic> _map(Object? v) =>
    v is Map<String, dynamic> ? v : const {};
num? _count(Object? v) => v is num && v.isFinite && v >= 0 ? v : null;
String? _trimmed(Object? v) => _nonempty(_string(v)?.trim());
String _text(Object? v) {
  if (v == null) return '';
  if (v is String) return v;
  try {
    return jsonEncode(v);
  } on Object {
    return '';
  }
}

String? _first(Map<String, dynamic> m, List<String> keys) {
  for (final k in keys) {
    final value = _nonempty(m[k]);
    if (value != null) return value;
  }
  return null;
}

CloudWireFrame _parse(String event, Object? value) {
  // Agent task lifecycle; mobile has no task UI yet.
  if (event == 'task.upsert') return const CloudWireIgnored('task.upsert');
  const supported = {
    'message.start',
    'message.delta',
    'message.reasoning',
    'message.finish',
    'tool.call',
    'tool.result',
    'artifact.created',
    'harness.warning',
    'harness.event',
    'error',
  };
  if (!supported.contains(event)) return CloudWireIgnored(event);
  if (value is! Map<String, dynamic>) {
    return event == 'harness.event'
        ? CloudWireIgnored(event)
        : CloudWireUnparseable(event, 'Expected an object');
  }
  final taskId = _nonempty(value['taskId']);
  if (taskId != null) return CloudWireIgnored(event, taskId: taskId);
  final sourceKey = _nonempty(value['sourceKey']);
  switch (event) {
    case 'message.start':
      return CloudMessageStart(
        isAssistant: value['role'] == 'assistant',
        sourceKey: sourceKey,
      );
    case 'message.delta':
      return CloudMessageDelta(
        _string(value['textDelta']) ?? '',
        sourceKey: sourceKey,
      );
    case 'message.reasoning':
      return CloudMessageReasoning(
        _string(value['reasoningDelta']) ?? _string(value['delta']) ?? '',
        sourceKey: sourceKey,
      );
    case 'message.finish':
      final content = _map(value['finalMessage'])['content'];
      final finalText = content is String
          ? content
          : content is List
          ? content
                .whereType<Map<String, dynamic>>()
                .where((p) => p['type'] == 'text' && p['text'] is String)
                .map((p) => p['text'] as String)
                .join('\n\n')
          : '';
      final thinking = _map(value['thinking']);
      return CloudMessageFinish(
        sourceKey: sourceKey,
        finishReason: _nonempty(value['finishReason']),
        finalText: _nonempty(finalText),
        reasoningText: thinking['reasoningTextAvailable'] == true
            ? _nonempty(thinking['reasoningText'])
            : null,
        model: _model(value['model']),
        usage: _usage(value['usage']),
        cost: _cost(value['cost']),
      );
    case 'tool.call':
    case 'tool.result':
      final call = event == 'tool.call';
      final result = _toolOutput(value['result']);
      final aborted =
          value['status'] is String && value['status'] != 'succeeded';
      final name =
          _string(value['modelToolName']) ?? _string(value['toolName']);
      return CloudToolFrame(
        CloudChatToolActivity(
          kind: call
              ? CloudToolActivityKind.call
              : CloudToolActivityKind.result,
          rawKind: call ? 'call' : 'result',
          raw: Map.unmodifiable(value),
          sourceKey: sourceKey,
          toolCallId: _nonempty(value['toolCallId']),
          toolName: call ? name ?? 'tool' : name,
          input: call ? _text(value['args']) : null,
          output: call
              ? null
              : aborted && result.output.isEmpty
              ? _text(value['error'])
              : result.output,
          isError: call ? null : aborted || result.isError,
        ),
      );
    case 'artifact.created':
      final payload = _map(value['payload']);
      final id = _string(value['toolCallId']) ?? 'unknown';
      final named = _first(payload, ['filePath', 'filename', 'fileName']);
      final name =
          named?.replaceFirst(RegExp(r'^/+'), '') ??
          _string(value['label']) ??
          _first(payload, ['title', 'name']) ??
          'artifact-$id';
      final size = value['sizeBytes'];
      final sizeNumber = size is num
          ? size
          : size is String
          ? num.tryParse(size)
          : null;
      final index = value['artifactIndex'];
      return CloudArtifactCreated(
        CloudCoreArtifact(
          id: _string(value['id']),
          toolCallId: id,
          artifactIndex: index is num && index.isFinite ? index.toInt() : 0,
          kind: _string(value['kind']) ?? 'artifact',
          label: _string(value['label']) ?? name,
          storageKind: value['storageKind'] == 'blob' ? 'blob' : 'inline',
          sizeBytes: sizeNumber != null && sizeNumber.isFinite
              ? size.toString()
              : null,
          fileName: name,
          fileContent: _first(payload, ['content', 'text', 'body', 'markdown']),
          metadata: payload.isEmpty ? null : Map.unmodifiable(payload),
        ),
      );
    case 'error':
      return CloudWireError(
        code: _string(value['errorCode']),
        message: _string(value['message']) ?? _string(value['errorMessage']),
      );
    case 'harness.warning':
      final code = _trimmed(value['warningCode']);
      final message = _trimmed(value['warningMessage']);
      if (code == null ||
          value.containsKey('warningMessage') && message == null) {
        return CloudWireUnparseable(
          event,
          'Expected non-empty warningCode/warningMessage',
        );
      }
      List<String> strings(Object? v) => v is List
          ? v.whereType<String>().where((s) => s.trim().isNotEmpty).toList()
          : const [];
      return CloudHarnessWarning(
        code: code,
        message: message,
        warnings: strings(value['warnings']),
        filenames: strings(value['filenames']),
      );
    case 'harness.event':
      if (value['kind'] == 'compaction') {
        return CloudHarnessEvent(
          kind: 'compaction',
          sourceKey: sourceKey,
          trigger: _trimmed(value['trigger']),
          summary: _trimmed(value['summary']),
          tokensBefore: _count(value['tokensBefore']),
          tokensAfter: _count(value['tokensAfter']),
        );
      }
      if (value['kind'] == 'status' &&
          value.containsKey('status') &&
          (value['status'] == null || value['status'] == 'compacting')) {
        return CloudHarnessEvent(
          kind: 'status',
          sourceKey: sourceKey,
          status: _string(value['status']),
        );
      }
      return CloudWireIgnored(event);
    default:
      return CloudWireIgnored(event);
  }
}

Map<String, dynamic>? _model(Object? value) {
  final raw = _map(value);
  final id = value is String ? _nonempty(value) : _string(raw['id']);
  if (id == null) return null;
  final window = _count(raw['contextWindow']);
  return {
    'id': id,
    'label': ?_nonempty(raw['name']),
    if (window != null && window > 0) 'contextWindow': window,
  };
}

Map<String, dynamic>? _usage(Object? value) {
  final raw = _map(value);
  final input = _map(raw['inputTokenDetails']);
  final output = _map(raw['outputTokenDetails']);
  final candidates = {
    ...raw,
    'cacheReadTokens': input['cacheReadTokens'],
    'cacheWriteTokens': input['cacheWriteTokens'],
    'reasoningTokens': output['reasoningTokens'],
  };
  final result = <String, dynamic>{};
  for (final key in [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'contextTokens',
    'contextWindow',
  ]) {
    final n = _count(candidates[key]);
    if (n != null && (key != 'contextWindow' || n > 0)) result[key] = n;
  }
  return result.isEmpty ? null : Map.unmodifiable(result);
}

CloudCoreCost _cost(Object? value) {
  final raw = _map(value);
  final amount = raw['totalCostUsd'];
  final number = amount is num
      ? amount
      : amount is String
      ? num.tryParse(amount.trim())
      : null;
  if (raw['available'] != true || _count(number) == null) {
    return const CloudCoreCost(kind: CloudCoreCostKind.pending);
  }
  return number == 0
      ? const CloudCoreCost(kind: CloudCoreCostKind.zero)
      : CloudCoreCost(
          kind: CloudCoreCostKind.billable,
          amountUsd: amount.toString(),
        );
}

bool _failed(Map<String, dynamic> body) =>
    body['status'] == 'failed' ||
    body['status'] == 'error' ||
    body['success'] == false ||
    body['error'] != null;

({String output, bool isError}) _toolOutput(Object? value) {
  if (value is Map<String, dynamic>) {
    final nested = _map(value['result']);
    final failed = _failed(value) || value['isError'] == true
        ? value
        : _failed(nested)
        ? nested
        : null;
    if (failed != null) {
      final error = failed['error'];
      final text =
          _first(failed, ['errorText', 'stderr', 'message']) ??
          _nonempty(error) ??
          _first(_map(error), ['message', 'error', 'code']);
      return (output: text ?? _text(value), isError: true);
    }
    return (output: _text(value), isError: false);
  }
  final text = _text(value);
  return (
    output: text,
    isError: RegExp(
      r'^\{\s*"(?:isError"\s*:\s*true|success"\s*:\s*false)\b',
    ).hasMatch(text),
  );
}
