/// One host-supplied composer suggestion: a Remote Control slash command or a
/// Cloud invocable row. Transport-neutral, so the shared composer can rank
/// and insert it without knowing which host produced it.
final class ComposerCommand {
  const ComposerCommand({
    required this.name,
    this.description = '',
    this.displayName,
    this.insertText,
    this.category,
    this.pluginName,
    this.memberName,
    this.unavailableReason,
    this.enableRef,
    this.entryId,
    this.requiresResolution = false,
    this._availableToEnable = false,
  });

  final String name;
  final String description;
  final String? displayName;

  /// Host-projected text that replaces the trigger token; see [insertion].
  final String? insertText;
  final String? category;

  /// Plugin search identity, independent of the invocation text; null for a
  /// standalone item or a legacy row.
  final String? pluginName;

  /// Original member name, before harness-specific name projection.
  final String? memberName;

  /// Why the row is shown but cannot be used. Such rows are disabled.
  final String? unavailableReason;

  /// The host's reference for enabling this row before insertion. Its
  /// presence marks the row as "Available to enable".
  final Map<String, String>? enableRef;

  bool get needsEnable => enableRef != null;

  /// The Portal inventory's opaque id for this row (`entryId`).
  final String? entryId;

  /// The host enables the row and returns the text to insert
  /// (`portal.editor.resolve_invocable`) before anything is inserted.
  final bool requiresResolution;

  final bool _availableToEnable;

  /// Whether the row is listed under "Available to enable": a Portal
  /// `available` row, or a row the host enables through its [enableRef].
  bool get availableToEnable => _availableToEnable || needsEnable;

  /// The text that replaces a [trigger] token: the host's [insertText], or
  /// `<trigger><name> ` when the host supplies none (desktop rule).
  String insertion(String trigger) {
    final text = insertText;
    return text == null || text.isEmpty ? '$trigger$name ' : text;
  }
}
