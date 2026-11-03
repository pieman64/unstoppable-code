/// Model-aware effort levels for the chat composer.
///
/// A Dart port of the shared model-catalog helpers in
/// `packages/protocol/src/models/index.ts` and
/// `packages/protocol/src/thinking/index.ts`. Remote Control, cloud chats and
/// cloud drafts resolve their levels here, so the level a composer shows is
/// the level it sends.
library;

import 'package:mobile/data/models/chat_message.dart';

/// Every effort level, weakest first (`THINKING_LEVELS`).
const List<String> kThinkingLevelOrder = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

/// The levels a provider offers when its catalog row declares none
/// (`providerFallbackThinkingLevels`). Providers without thinking get none.
List<String> providerFallbackThinkingLevels(String? providerHint) =>
    switch (providerHint) {
      'unknown' || 'cursor' || 'copilot' || 'opencode' => const [],
      'codex' => const ['off', 'medium', 'high', 'xhigh'],
      _ => const ['off', 'medium', 'high', 'xhigh', 'max'],
    };

/// The effort levels a composer offers for [modelId], in canonical order
/// (`resolveModelCatalogThinkingLevels`).
///
/// 1. The row's declared levels: those of its `harnessChoices` entry for
///    [providerHint], then its `supportedThinkingLevels`, exactly as sent,
///    including an empty set. Without a [modelId] the default row stands in.
/// 2. The row's legacy `thinkingLevels`, also exactly as sent. Unlike the
///    TypeScript helper, an explicit empty legacy set hides effort: absent
///    means fall back, empty means the model does not think.
/// 3. [providerFallbackThinkingLevels] for [providerHint].
///
/// An empty result means the model does not think: hide the control and
/// send no level.
List<String> resolveThinkingLevels(
  List<ModelOption> catalog,
  String? modelId,
  String? providerHint,
) {
  final selected = catalogRow(catalog, modelId);
  final declared =
      selected?.harnessThinkingLevels[providerHint] ??
      selected?.supportedThinkingLevels;
  if (declared != null) return _ordered(declared);
  final legacy = selected?.thinkingLevels;
  if (legacy != null) return _ordered(legacy);
  return providerFallbackThinkingLevels(providerHint);
}

/// [modelId]'s catalog row. Without a model id the declared default row
/// stands in, as the model picker shows it.
ModelOption? catalogRow(List<ModelOption> catalog, String? modelId) {
  final id = modelId == null || modelId.isEmpty ? null : modelId;
  return catalog.where((option) => option.id == id).firstOrNull ??
      (id == null
          ? catalog.where((option) => option.isDefault).firstOrNull
          : null);
}

List<String> _ordered(List<String> levels) => [
  for (final level in kThinkingLevelOrder)
    if (levels.contains(level)) level,
];

/// Clamps [level] to the nearest supported level at or below it, so a stored
/// value the active model does not support displays as a real level. If none
/// is at or below it, uses the weakest supported level (or `off` for an empty
/// set). (`clampThinkingLevelToSupported` port.)
String clampThinkingLevelTo(String level, List<String> supported) {
  if (supported.contains(level)) return level;
  final ceiling = kThinkingLevelOrder.indexOf(level);
  for (var i = ceiling - 1; i >= 0; i--) {
    final candidate = kThinkingLevelOrder[i];
    if (supported.contains(candidate)) return candidate;
  }
  for (final candidate in kThinkingLevelOrder) {
    if (supported.contains(candidate)) return candidate;
  }
  return 'off';
}
