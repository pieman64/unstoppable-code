import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';

/// What a new-chat draft takes along when it moves to another destination
/// (CAN-2932): the typed text, and the project to select there. [projectId]
/// is the project the user picked on the next destination; otherwise the
/// next destination selects its project named [projectName], if any.
typedef CarriedDraft = ({String text, String? projectName, String? projectId});

/// Moves a new-chat draft from one destination's draft screen to the next.
///
/// The visible draft screen [attach]es a callback that hands over its draft
/// and stops saving it under its own target. Before switching destinations
/// the host calls [handOver]; the next draft screen [take]s what was carried
/// when it mounts.
final class NewChatDraftCarry {
  CarriedDraft Function()? _release;
  CarriedDraft? _pending;
  final List<ComposerDraftHandoff> _sourceReleases = [];

  /// Keep the source saved until the receiving composer has flushed its copy.
  void preserveSource(ComposerDraftHandoff release) =>
      _sourceReleases.add(release);

  void adopt(ComposerDraftBinding drafts, DraftTarget target) {
    final sources = _sourceReleases.where((s) => s.target == target).toList();
    for (final source in sources) {
      source.cancelRelease();
      _sourceReleases.remove(source);
    }
    drafts.adopt(target, returningFrom: sources.lastOrNull);
  }

  /// Adopts a destination and releases retained sources only after its store
  /// confirms the write. Rebuilds of the same target do not repeat adoption.
  void adoptStored(
    ComposerDraftBinding drafts,
    DraftTarget target,
    ChatDraftPort store,
  ) {
    if (target == drafts.target) return;
    adopt(drafts, target);
    confirmStored(store.flush());
  }

  void confirmStored(Future<bool> stored) {
    final releases = List<ComposerDraftHandoff>.of(_sourceReleases);
    unawaited(
      stored.then(
        (persisted) {
          if (!persisted) return;
          for (final release in releases) {
            release();
            _sourceReleases.remove(release);
          }
        },
        onError: (Object _, StackTrace _) {
          // A failed destination write must leave the source recoverable.
          // Sources stay queued until a successful flush or re-adoption.
        },
      ),
    );
  }

  void attach(CarriedDraft Function() release) => _release = release;

  /// Detaches [release] if it is still the attached callback.
  void detach(CarriedDraft Function() release) {
    // Equality, not identity: a screen attaches a method tear-off.
    if (_release == release) _release = null;
  }

  /// Takes the visible draft out of its screen, ready for the next one,
  /// which selects [projectId] when it is given.
  void handOver({String? projectId}) {
    final release = _release;
    _release = null;
    if (release == null) return;
    final carried = release();
    if (carried.text.isEmpty &&
        carried.projectName == null &&
        projectId == null) {
      _pending = null;
      return;
    }
    _pending = (
      text: carried.text,
      projectName: carried.projectName,
      projectId: projectId,
    );
  }

  /// The handed-over draft, once; null when nothing was carried.
  CarriedDraft? take() {
    final pending = _pending;
    _pending = null;
    return pending;
  }
}

/// A new-chat draft's project as the host's project pill shows it
/// (CAN-2932). The host lists every destination's projects; a pick on the
/// draft's own destination goes back through [select].
final class DraftProjectSelection {
  const DraftProjectSelection({
    required this.id,
    required this.name,
    required this.enabled,
    required this.select,
    this.icon,
  });

  /// The selected project on the draft's destination; null when none is.
  final String? id;
  final String? name;

  /// The selected project's folder icon, in its color where it has one.
  final Widget? icon;

  /// False while the draft cannot change project, such as during its first
  /// send.
  final bool enabled;

  /// Selects a project of the draft's own destination by id.
  final ValueChanged<String> select;
}

/// Builds the host's project pill for a draft's [DraftProjectSelection].
typedef DraftProjectPillBuilder =
    Widget Function(BuildContext context, DraftProjectSelection selection);
