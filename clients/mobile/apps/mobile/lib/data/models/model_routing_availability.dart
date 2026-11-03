/// Account-level Auto (model routing) availability from
/// `GET /api/cloud/model-routing-availability`: the rollout and AI Credits
/// gates. Server routing stays authoritative for each turn.
enum ModelRoutingAvailability {
  /// Not loaded yet.
  loading,
  available,

  /// Routing is rolled out, but the account has no AI Credits to spend.
  noCredits,

  /// Routing is not offered to this account, or availability is unknown.
  hidden;

  /// Maps the wire `state`; anything unexpected hides Auto, as on web.
  static ModelRoutingAvailability fromWire(Object? state) => switch (state) {
    'available' => available,
    'no-credits' => noCredits,
    _ => hidden,
  };
}
