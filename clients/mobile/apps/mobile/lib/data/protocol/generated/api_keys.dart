// dart format off
// GENERATED FILE. Do not edit by hand.
// Maintainer-generated API bindings; verify with the adjacent public digest manifest.

/// Provenance of a user API key as exposed across the API boundary.
///
/// - `MANUAL`: created by a user through the API-keys UI.
/// - `OAUTH_DESKTOP`: minted by the desktop OAuth-style authorization-code flow.
/// - `GUEST`: minted for a guest (anonymous) desktop session by the guest-mint   flow. Kept distinct from `OAUTH_DESKTOP` so guest keys are auditable and   revocable separately.
/// - `SERVICE_ACCOUNT`: minted by a human admin for an API-only service   account.
/// - `COWORK_SESSION`: short-lived, scoped credential minted for one   agentic-core cowork session (LLM proxy, MCP proxy, and agent actions).
enum UserApiKeySource {
  manual('MANUAL'),
  oauthDesktop('OAUTH_DESKTOP'),
  guest('GUEST'),
  serviceAccount('SERVICE_ACCOUNT'),
  coworkSession('COWORK_SESSION'),
  ;

  const UserApiKeySource(this.wire);

  final String wire;

  static UserApiKeySource fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown UserApiKeySource: $wire'),
      );
}

class UserApiKeyListItem {
  const UserApiKeyListItem({required this.createdAt, this.createdIp, required this.id, this.lastUsedAt, required this.name, required this.source});

  final String createdAt;
  final String? createdIp;
  final String id;
  final String? lastUsedAt;
  final String name;
  final UserApiKeySource source;

  factory UserApiKeyListItem.fromJson(Map<String, dynamic> json) => UserApiKeyListItem(
        createdAt: json['createdAt'] as String,
        createdIp: json['createdIp'] as String?,
        id: json['id'] as String,
        lastUsedAt: json['lastUsedAt'] as String?,
        name: json['name'] as String,
        source: UserApiKeySource.fromWire(json['source'] as String),
      );
}

class UserApiKeyCreateResponse {
  const UserApiKeyCreateResponse({required this.token, required this.userApiKey});

  final String token;
  final UserApiKeyListItem userApiKey;

  factory UserApiKeyCreateResponse.fromJson(Map<String, dynamic> json) => UserApiKeyCreateResponse(
        token: json['token'] as String,
        userApiKey: UserApiKeyListItem.fromJson(json['userApiKey'] as Map<String, dynamic>),
      );
}
