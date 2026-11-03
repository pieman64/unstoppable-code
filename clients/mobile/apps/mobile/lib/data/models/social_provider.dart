/// Social OAuth providers supported by the mobile sign-in flow.
enum SocialProvider {
  unstoppable('unstoppable-domains', 'Unstoppable Domains'),
  google('google', 'Google'),
  github('github', 'GitHub'),
  apple('apple', 'Apple');

  const SocialProvider(this.wire, this.label);

  /// The provider id sent to the mobile OAuth start endpoint.
  /// The backend selects social or generic OAuth for browser-based providers.
  final String wire;

  /// Human-readable label for the sign-in button.
  final String label;
}
