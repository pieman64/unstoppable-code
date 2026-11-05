import 'package:mobile/data/models/chat_message.dart';
import '../protocol.dart';

/// Display metadata from the existing registry. Selection and execution remain
/// canonical chat commands validated by the computer, not mobile policy.
List<ModelOption> deviceRegistryModels(Map<String, dynamic> registry) {
  if (registry['claude'] is! List || registry['codex'] is! List) {
    throw const FormatException('Missing model registry');
  }
  final assignments = <String, Map<String, dynamic>>{};
  final rawAssignments = registry['harnessAssignments'];
  if (rawAssignments is Map) {
    for (final raw in (rawAssignments['assignments'] as List? ?? const [])) {
      final row = deviceLinkObject(raw);
      assignments['${row['source']}/${row['modelId']}'] = row;
    }
  }
  final rows = <String, ModelOption>{};
  for (final provider in [
    'claude',
    'codex',
    'cursor',
    'copilot',
    'opencode',
    'ollama',
    'aiGatewayModels',
  ]) {
    final source = provider == 'aiGatewayModels' ? 'ai-gateway' : provider;
    final assignmentSource =
        ['claude', 'codex', 'cursor', 'copilot', 'opencode'].contains(provider)
        ? '$provider-managed'
        : source;
    for (final raw in registry[provider] as List? ?? const []) {
      final row = deviceLinkObject(raw);
      if (row['selectable'] == false) continue;
      final id = row['id'];
      if (id is! String || id.isEmpty) {
        throw const FormatException('Invalid model id');
      }
      final assignment = assignments['$assignmentSource/$id'];
      final harness =
          assignment?['harness'] ??
          row['harness'] ??
          row['recommendedHarness'] ??
          provider;
      final model = ModelOption.fromJson({
        ...row,
        'id': id,
        'provider': provider == 'aiGatewayModels' ? harness : provider,
        'harness': harness,
        'source': source,
        'kind': 'model',
      });
      rows.putIfAbsent(id, () => model);
    }
  }
  final aliases = registry['aliases'];
  for (final raw in registry['agents'] as List? ?? const []) {
    final agent = deviceLinkObject(raw), baseId = agent['baseModel'];
    final base =
        rows[baseId] ?? (aliases is Map ? rows[aliases[baseId]] : null);
    // A default-inheriting Agent requires an owner-specific default lookup.
    // Never guess it from the currently selected chat or collection order.
    if (base == null) continue;
    final id = agent['id'];
    if (id is! String || id.isEmpty) {
      throw const FormatException('Invalid Agent id');
    }
    rows[id] = ModelOption(
      id: id,
      label: agent['name'] as String? ?? id,
      provider: base.provider,
      kind: 'agent',
      available: agent['available'] == true && base.available,
      harness: base.harness,
      supportedThinkingLevels: base.supportedThinkingLevels,
      contextWindow: base.contextWindow,
      vendor: base.vendor,
      unavailableReason: agent['unavailableReason'] as String?,
    );
  }
  return List.unmodifiable(rows.values);
}
