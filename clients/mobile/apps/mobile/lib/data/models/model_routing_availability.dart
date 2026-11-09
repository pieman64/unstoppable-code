/// Host-projected Auto model routing state. The computer owns admission.
enum ModelRoutingAvailability {
  /// Not loaded yet.
  loading,
  available,

  /// Routing is rolled out, but the account has no AI Credits to spend.
  noCredits,

  /// Routing is not offered to this account, or availability is unknown.
  hidden,
}
