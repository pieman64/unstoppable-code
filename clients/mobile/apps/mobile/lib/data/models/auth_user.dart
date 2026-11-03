/// Better Auth user object, as returned in the `user` field of the
/// `POST /api/auth/sign-in/email` response.
///
/// Hand-written (not code-generated) because Better Auth's types live in the
/// auth library, not in `@canopy/protocol`.  Mirrors the exact server shape so
/// the future real `AuthRepository` parses responses without drift.  Dates are
/// kept as ISO-8601 [String]s, matching the generated protocol layer.
final class AuthUser {
  const AuthUser({
    required this.id,
    required this.email,
    required this.emailVerified,
    required this.name,
    required this.image,
    required this.role,
    required this.status,
    required this.twoFactorEnabled,
    required this.createdAt,
    required this.updatedAt,
    this.isAnonymous = false,
  });

  final String id;
  final String email;
  final bool emailVerified;
  final String name;
  final String? image;

  /// Better Auth additional field: one of `VIEWER`, `DEVELOPER`, `ADMIN`.
  final String role;

  /// Better Auth additional field: one of `PENDING`, `ACTIVE`, `INACTIVE`.
  final String status;

  /// Added by the Better Auth `twoFactor` plugin.  When `true`, sign-in does
  /// not grant a full session until the 2FA challenge is completed.
  final bool twoFactorEnabled;

  final String createdAt;
  final String updatedAt;

  /// Added by the Better Auth `anonymous` plugin: a guest session (CAN-2872)
  /// with no sign-in method, which merges into a real account on sign-in.
  final bool isAnonymous;

  factory AuthUser.fromJson(Map<String, dynamic> json) => AuthUser(
    id: json['id'] as String,
    email: json['email'] as String? ?? '',
    emailVerified: json['emailVerified'] as bool? ?? false,
    name: json['name'] as String? ?? '',
    image: json['image'] as String?,
    role: json['role'] as String? ?? 'DEVELOPER',
    status: json['status'] as String? ?? 'PENDING',
    twoFactorEnabled: json['twoFactorEnabled'] as bool? ?? false,
    createdAt: json['createdAt'] as String? ?? '',
    updatedAt: json['updatedAt'] as String? ?? '',
    isAnonymous: json['isAnonymous'] as bool? ?? false,
  );
}
