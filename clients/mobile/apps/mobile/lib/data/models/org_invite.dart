import 'package:mobile/data/protocol/generated/organization.dart';

/// Lifecycle status of an outgoing invite (mirrors the web `InviteListItem`).
enum InviteStatus {
  active('ACTIVE'),
  redeemed('REDEEMED'),
  revoked('REVOKED'),
  declined('DECLINED'),
  expired('EXPIRED');

  const InviteStatus(this.wire);

  final String wire;

  static InviteStatus fromWire(String wire) => values.firstWhere(
    (e) => e.wire == wire,
    orElse: () => InviteStatus.active,
  );
}

/// An invite the current user has sent, mirroring the web `InviteListItem`
/// (`apps/web/src/lib/invite-service.ts`).  Hand-written because the invite
/// types are web-local, not in `@canopy/protocol`.
class OutgoingInvite {
  const OutgoingInvite({
    required this.id,
    required this.code,
    required this.status,
    required this.createdAt,
    required this.expiresAt,
    this.organizationId,
    this.organizationName,
    this.organizationTeamName,
    this.role,
    this.invitedEmail,
    this.invitedUserExists = false,
    this.redeemedByName,
    this.redeemedByEmail,
    this.redeemedAt,
    this.revokedAt,
    this.declinedAt,
  });

  final String id;

  /// URL-safe token used to build the invite link (`{origin}/invite/{code}`).
  final String code;
  final InviteStatus status;
  final String createdAt;

  /// ISO timestamp; invites have a 14-day TTL server-side.
  final String expiresAt;
  final String? organizationId;
  final String? organizationName;
  final String? organizationTeamName;
  final OrganizationRole? role;
  final String? invitedEmail;

  /// True when the invitee already has an account — they accept from their
  /// dashboard and no invite link is surfaced.
  final bool invitedUserExists;
  final String? redeemedByName;
  final String? redeemedByEmail;
  final String? redeemedAt;
  final String? revokedAt;
  final String? declinedAt;

  factory OutgoingInvite.fromJson(Map<String, dynamic> json) => OutgoingInvite(
    id: json['id'] as String,
    code: json['code'] as String,
    status: InviteStatus.fromWire(json['status'] as String),
    createdAt: json['createdAt'] as String,
    expiresAt: json['expiresAt'] as String,
    organizationId: json['organizationId'] as String?,
    organizationName: json['organizationName'] as String?,
    organizationTeamName: json['organizationTeamName'] as String?,
    role: json['role'] == null
        ? null
        : OrganizationRole.fromWire(json['role'] as String),
    invitedEmail: json['invitedEmail'] as String?,
    invitedUserExists: json['invitedUserExists'] as bool? ?? false,
    redeemedByName: json['redeemedByName'] as String?,
    redeemedByEmail: json['redeemedByEmail'] as String?,
    redeemedAt: json['redeemedAt'] as String?,
    revokedAt: json['revokedAt'] as String?,
    declinedAt: json['declinedAt'] as String?,
  );
}
