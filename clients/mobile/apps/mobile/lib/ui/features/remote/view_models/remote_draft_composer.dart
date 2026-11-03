import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_effort.dart';

/// The chat a new chat starts beside (CAN-2932). Its model, thinking, Plan
/// and Fast settings seed the draft's composer, as web's New Task seeds from
/// `referenceChatForTarget` and `coworkReferenceChatFor`.
typedef RemoteDraftReference = ({
  String? model,
  String? modelLabel,
  String? providerType,
  String? thinkingLevel,
  bool? planMode,
  bool? fastMode,
  List<ModelOption> availableModels,
  bool hasProjectedModelCatalog,
  ProviderAvailability? providerAvailability,
});

/// A code project's reference chat: the newest worktree chat in
/// [workspaceLocalId], within [worktreeLocalId] when given, the active one
/// first.
RemoteDraftReference? remoteDraftWorktreeReference(
  List<RemoteChatSummary> summaries, {
  required String workspaceLocalId,
  String? worktreeLocalId,
}) {
  final candidates =
      summaries
          .where(
            (chat) =>
                chat.scope == RemoteChatScope.worktree &&
                chat.workspaceLocalId == workspaceLocalId &&
                (worktreeLocalId == null ||
                    chat.worktreeLocalId == worktreeLocalId),
          )
          .toList()
        ..sort((a, b) {
          final aActive = a.active ?? false;
          final bActive = b.active ?? false;
          if (aActive != bActive) return aActive ? -1 : 1;
          return (b.lastMessageAt ?? b.createdAt ?? '').compareTo(
            a.lastMessageAt ?? a.createdAt ?? '',
          );
        });
  final chat = candidates.firstOrNull;
  if (chat == null) return null;
  return (
    model: chat.model,
    modelLabel: chat.modelLabel,
    providerType: chat.providerType,
    thinkingLevel: chat.thinkingLevel,
    planMode: chat.planMode,
    fastMode: chat.fastMode,
    availableModels: chat.availableModels,
    hasProjectedModelCatalog: chat.hasProjectedModelCatalog,
    providerAvailability: chat.providerAvailability,
  );
}

/// A Cowork project's reference chat: its most recently active chat that is
/// not archived. Cowork chats carry no thinking, Plan or Fast settings.
RemoteDraftReference? remoteDraftCoworkReference(
  List<RemoteStandaloneChat> chats,
) {
  final candidates = chats.where((chat) => chat.archived != true).toList()
    ..sort((a, b) => (b.lastMessageAt ?? '').compareTo(a.lastMessageAt ?? ''));
  final chat = candidates.firstOrNull;
  if (chat == null) return null;
  return (
    model: chat.model,
    modelLabel: chat.modelLabel,
    providerType: chat.providerType,
    thinkingLevel: null,
    planMode: null,
    fastMode: null,
    availableModels: chat.availableModels,
    hasProjectedModelCatalog: chat.hasProjectedModelCatalog,
    providerAvailability: chat.providerAvailability,
  );
}

/// The desktop's model catalog for a chat that does not exist yet: the
/// reference chat's own, including an explicitly empty owner-filtered list.
/// Only a missing catalog falls back to one another desktop chat carries (worktree
/// chats first, then Cowork chats), as `RemoteChatScreen` does for a new
/// tab. The cloud's shell catalog never applies: its ids are not desktop
/// model ids.
({List<ModelOption> models, ProviderAvailability? availability})
remoteDraftModelCatalog({
  required RemoteDraftReference? reference,
  required List<ModelOption> projected,
  required ProviderAvailability? projectedAvailability,
  required List<RemoteStandaloneChat> standaloneChats,
}) {
  final carried = reference?.availableModels ?? const <ModelOption>[];
  final carrier = standaloneChats
      .where((chat) => chat.availableModels.isNotEmpty)
      .firstOrNull;
  return (
    models: (reference?.hasProjectedModelCatalog ?? false)
        ? carried
        : projected.isNotEmpty
        ? projected
        : carrier?.availableModels ?? const [],
    availability:
        reference?.providerAvailability ??
        projectedAvailability ??
        standaloneChats
            .map((chat) => chat.providerAvailability)
            .nonNulls
            .firstOrNull,
  );
}

/// What a computer draft's composer chose before its chat exists. A null
/// field was never touched and follows the reference chat.
final class RemoteDraftComposerChoices {
  const RemoteDraftComposerChoices({
    this.model,
    this.thinkingLevel,
    this.fastMode,
    this.planMode,
  });

  final String? model;
  final String? thinkingLevel;
  final bool? fastMode;
  final bool? planMode;

  /// A touched value replaces this one; a touched value is never untouched
  /// again.
  RemoteDraftComposerChoices copyWith({
    String? model,
    String? thinkingLevel,
    bool? fastMode,
    bool? planMode,
  }) => RemoteDraftComposerChoices(
    model: model ?? this.model,
    thinkingLevel: thinkingLevel ?? this.thinkingLevel,
    fastMode: fastMode ?? this.fastMode,
    planMode: planMode ?? this.planMode,
  );
}

/// A computer draft's composer as it shows and sends (CAN-2932), resolved
/// the way web's `resolveNewTaskComposerControls` does for a desktop
/// project: the user's choices, else the reference chat's settings, else
/// the catalog default. A code project starts at High thinking without a
/// reference chat; a Cowork chat starts at Off and sends thinking and Fast
/// only once they are touched.
final class RemoteDraftComposer {
  const RemoteDraftComposer({
    required this.choices,
    required this.reference,
    required this.catalog,
    required this.cowork,
    this.availability,
  });

  final RemoteDraftComposerChoices choices;
  final RemoteDraftReference? reference;
  final List<ModelOption> catalog;
  final ProviderAvailability? availability;
  final bool cowork;

  /// The same composer with [next] as its choices.
  RemoteDraftComposer withChoices(RemoteDraftComposerChoices next) =>
      RemoteDraftComposer(
        choices: next,
        reference: reference,
        catalog: catalog,
        availability: availability,
        cowork: cowork,
      );

  String? get _modelId => choices.model ?? reference?.model;

  /// The catalog entry the composer shows: the chosen or reference model,
  /// else, with neither, the catalog's default.
  ModelOption? get selectedModel {
    final id = _modelId;
    if (id == null) {
      return catalog.where((option) => option.isDefault).firstOrNull;
    }
    return catalog.where((option) => option.id == id).firstOrNull;
  }

  /// The model the first send names: the chosen or reference model. The
  /// catalog default is only shown, as on web; null leaves the desktop's
  /// default.
  String? get modelId => _modelId;

  /// The reference chat's label stands in for a model the catalog lacks.
  String? get modelLabel =>
      selectedModel?.label ??
      (choices.model == null ? reference?.modelLabel : null);

  String? get providerType =>
      selectedModel?.provider ??
      (choices.model == null ? reference?.providerType : null);

  bool get planMode =>
      !cowork && (choices.planMode ?? reference?.planMode ?? false);

  bool get fastMode => choices.fastMode ?? reference?.fastMode ?? false;

  /// The same model-aware effort selection used by an existing remote chat.
  RemoteComposerEffort get effort => RemoteComposerEffort.resolve(
    catalog: catalog,
    modelId: selectedModel?.id ?? _modelId,
    providerType: providerType,
    level:
        choices.thinkingLevel ??
        (cowork ? 'off' : reference?.thinkingLevel ?? 'high'),
    fastMode: fastMode,
  );

  /// The first send's composer selections, in `portal.chat.send` /
  /// `portal.standalone_chat.send` shape: what the composer shows, except
  /// that a Cowork chat sends thinking and Fast only once touched. Null when
  /// nothing applies.
  RemoteChatSendOptions? sendOptions({String? inputMode}) {
    final resolved = effort;
    final sendsThinking = !cowork || choices.thinkingLevel != null;
    final thinkingLevel = !sendsThinking || resolved.levels.isEmpty
        ? null
        : resolved.level;
    final sendsFast =
        providerType == 'codex' && (!cowork || choices.fastMode != null);
    final modelId = this.modelId;
    final options = RemoteChatSendOptions(
      model: modelId,
      providerType: modelId == null ? null : providerType,
      planMode: cowork ? null : planMode,
      thinkingLevel: thinkingLevel,
      fastMode: sendsFast ? fastMode : null,
      inputMode: inputMode,
    );
    return options.isEmpty ? null : options;
  }
}
