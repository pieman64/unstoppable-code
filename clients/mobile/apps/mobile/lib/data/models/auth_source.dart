// Linked authentication sources for the signed-in user, as returned by
// `GET /api/account/auth-sources` (Contract B3).
//
// Hand-written (not code-generated) because the web contract types
// (`AuthSource`, `AuthSourcesUser`, `AuthSourcesResponse` in
// `apps/web/src/lib/account-api-contracts.ts`) type `providerId` as a branded
// string-union (`AuthProviderId`) that the mobile codegen renders as broken
// empty classes. Here `providerId` is a plain `String`, accepting any provider
// id Better Auth reports. Dates are kept as ISO-8601 `String`s, matching the
// hand-written `AuthUser` style.

/// A single linked authentication source (Contract B3).
final class AuthSource {
  const AuthSource({
    required this.providerId,
    required this.accountId,
    required this.label,
    required this.linkedAt,
    required this.canUnlink,
  });

  /// `'google' | 'github' | 'credential'`, or any id Better Auth reports.
  final String providerId;

  /// Better Auth account id for this source (disambiguates unlink — B4).
  final String accountId;

  /// Display label, e.g. `'Google'`, `'GitHub'`, `'Email and password'`.
  final String label;

  /// ISO-8601 timestamp of when the source was linked.
  final String linkedAt;

  /// False when this is the only remaining auth source (cannot be removed).
  final bool canUnlink;

  factory AuthSource.fromJson(Map<String, dynamic> json) => AuthSource(
    providerId: json['providerId'] as String? ?? '',
    accountId: json['accountId'] as String? ?? '',
    label: json['label'] as String? ?? '',
    linkedAt: json['linkedAt'] as String? ?? '',
    canUnlink: json['canUnlink'] as bool? ?? false,
  );

  /// Returns a copy of this source with the given fields replaced.
  AuthSource copyWith({
    String? providerId,
    String? accountId,
    String? label,
    String? linkedAt,
    bool? canUnlink,
  }) => AuthSource(
    providerId: providerId ?? this.providerId,
    accountId: accountId ?? this.accountId,
    label: label ?? this.label,
    linkedAt: linkedAt ?? this.linkedAt,
    canUnlink: canUnlink ?? this.canUnlink,
  );
}

/// Account summary embedded in the auth-sources response (Contract B3).
final class AuthSourcesUser {
  const AuthSourcesUser({
    required this.name,
    required this.email,
    required this.twoFactorEnabled,
  });

  final String name;
  final String email;
  final bool twoFactorEnabled;

  factory AuthSourcesUser.fromJson(Map<String, dynamic> json) =>
      AuthSourcesUser(
        name: json['name'] as String? ?? '',
        email: json['email'] as String? ?? '',
        twoFactorEnabled: json['twoFactorEnabled'] as bool? ?? false,
      );
}

/// `200` body for `GET /api/account/auth-sources` (Contract B3).
final class AuthSourcesResponse {
  const AuthSourcesResponse({required this.user, required this.sources});

  final AuthSourcesUser user;
  final List<AuthSource> sources;

  factory AuthSourcesResponse.fromJson(Map<String, dynamic> json) {
    final rawUser = json['user'];
    final rawSources = json['sources'];
    return AuthSourcesResponse(
      user: rawUser is Map<String, dynamic>
          ? AuthSourcesUser.fromJson(rawUser)
          : const AuthSourcesUser(name: '', email: '', twoFactorEnabled: false),
      sources: rawSources is List<dynamic>
          ? rawSources
                .whereType<Map<String, dynamic>>()
                .map(AuthSource.fromJson)
                .toList(growable: false)
          : const [],
    );
  }
}
