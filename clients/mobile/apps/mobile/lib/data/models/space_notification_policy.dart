/// One space's saved notification choice, as the server holds it
/// (`/api/v1/notification-spaces/{spaceId}`, CAN-3615).
///
/// A space is a desktop code worktree or a Cowork Work Entry. Mirrors the
/// fields of `SpaceNotificationSnapshot` in
/// `packages/protocol/src/space-notifications` that a client relies on.
library;

/// A notification level a user can pin on a space. No override (`null`
/// wherever a level is optional) delivers All activity.
enum SpaceNotificationLevel {
  all('all'),
  attention('attention'),
  mute('mute');

  const SpaceNotificationLevel(this.wireValue);

  final String wireValue;

  /// The level for [value], or null when it is not one of the three wire
  /// values.
  static SpaceNotificationLevel? fromWire(Object? value) {
    for (final level in values) {
      if (level.wireValue == value) return level;
    }
    return null;
  }
}

/// The server's acknowledged state for one notification space.
class SpaceNotificationPolicy {
  const SpaceNotificationPolicy({
    required this.spaceId,
    required this.revision,
    required this.override,
    required this.writesEnabled,
  });

  final String spaceId;

  /// Increases with every saved change. A save names the revision it was
  /// made against, so a stale save is refused instead of overwriting.
  final int revision;

  /// The user's own choice; null is no override (All activity).
  final SpaceNotificationLevel? override;

  /// False while the server is not accepting changes. The saved choice is
  /// still shown, read-only.
  final bool writesEnabled;

  /// Parses a snapshot, or returns null when it cannot be trusted: a missing
  /// space id or revision, or an override this client does not recognize
  /// (showing "All activity" for an unknown level would misstate the choice).
  /// An absent `writesEnabled` fails closed.
  static SpaceNotificationPolicy? tryParse(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final spaceId = json['spaceId'];
    final revision = json['revision'];
    final rawOverride = json['override'];
    final override = SpaceNotificationLevel.fromWire(rawOverride);
    if (spaceId is! String || spaceId.isEmpty) return null;
    if (revision is! int || revision < 0) return null;
    if (rawOverride != null && override == null) return null;
    return SpaceNotificationPolicy(
      spaceId: spaceId,
      revision: revision,
      override: override,
      writesEnabled: json['writesEnabled'] == true,
    );
  }
}
