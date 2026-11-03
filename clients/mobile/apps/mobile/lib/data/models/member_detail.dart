import 'package:mobile/data/protocol/generated/usage.dart';

/// Hand-written member-profile list models.
///
/// These mirror the web `SharedPlanSummary`, `ApprovedPlanSummary`, and
/// `PipelineApiItem` contracts returned by
/// `GET /api/account/organizations/{orgId}/members/{memberId}/{plans,approved-plans,pipelines}`.
///
/// They are hand-written (not generated) because those wire shapes contain
/// branded string-union fields — the shared-plan `shareScope`/`owner.type`, the
/// pipeline `shareScope`/`owner.type`, and the approved-plan `reviewStatus` — and
/// the mobile protocol codegen cannot emit branded string-union types (it renders
/// broken empty classes). Every such union field is stored here as a plain
/// [String] and parsed defensively so an unrecognized server value never throws.

/// One page of a cursor-paged member-profile list. Mirrors the server's
/// `{ data, nextCursor }` envelope after unwrapping `data`.
class MemberListPage<T> {
  const MemberListPage({required this.items, required this.nextCursor});

  final List<T> items;

  /// Keyset continuation token; `null` when no further pages remain.
  final String? nextCursor;
}

/// A TEAM/ORGANIZATION-shared plan authored by a member (web `SharedPlanSummary`).
///
/// Only the fields the mobile profile renders are modelled; `shareScope` and
/// `owner.type` are plain [String]s (branded unions on the web side).
class MemberSharedPlan {
  const MemberSharedPlan({
    required this.id,
    required this.title,
    required this.shareScope,
    required this.ownerType,
    this.ownerName,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String title;

  /// Wire share scope (e.g. `TEAM` / `ORGANIZATION`); plain string, not a union.
  final String shareScope;

  /// Wire owner discriminant (e.g. `team` / `organization`); plain string.
  final String ownerType;

  /// Owner display name when the server provides one.
  final String? ownerName;
  final String createdAt;
  final String updatedAt;

  factory MemberSharedPlan.fromJson(Map<String, dynamic> json) {
    final owner = json['owner'];
    final ownerMap = owner is Map<String, dynamic>
        ? owner
        : const <String, dynamic>{};
    return MemberSharedPlan(
      id: _asString(json['id']),
      title: _asString(json['title']),
      shareScope: _asString(json['shareScope']),
      ownerType: _asString(ownerMap['type']),
      ownerName: _asOptionalString(ownerMap['name']),
      createdAt: _asString(json['createdAt']),
      updatedAt: _asString(json['updatedAt']),
    );
  }
}

/// An approved (telemetry) plan a member has started implementing
/// (web `ApprovedPlanSummary`). `reviewStatus` is a nullable plain [String].
class MemberApprovedPlan {
  const MemberApprovedPlan({
    required this.id,
    required this.title,
    this.reviewStatus,
    this.planVersion,
    required this.implementationStartedAt,
    required this.updatedAt,
  });

  final String id;
  final String title;

  /// Wire review status (e.g. `APPROVED`); nullable plain string, not a union.
  final String? reviewStatus;
  final num? planVersion;

  /// ISO timestamp the owner started implementing this plan.
  final String implementationStartedAt;
  final String updatedAt;

  factory MemberApprovedPlan.fromJson(Map<String, dynamic> json) =>
      MemberApprovedPlan(
        id: _asString(json['id']),
        title: _asString(json['title']),
        reviewStatus: _asOptionalString(json['reviewStatus']),
        planVersion: json['planVersion'] is num
            ? json['planVersion'] as num
            : null,
        implementationStartedAt: _asString(json['implementationStartedAt']),
        updatedAt: _asString(json['updatedAt']),
      );
}

/// A TEAM/ORGANIZATION-shared pipeline authored by a member
/// (web `PipelineApiItem`). `shareScope` and `owner.type` are plain [String]s.
class MemberPipeline {
  const MemberPipeline({
    required this.id,
    required this.name,
    required this.description,
    required this.icon,
    required this.version,
    required this.shareScope,
    required this.ownerType,
    this.ownerName,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String name;
  final String description;
  final String icon;
  final String version;

  /// Wire share scope; plain string, not a union.
  final String shareScope;

  /// Wire owner discriminant; plain string.
  final String ownerType;

  /// Owner display name when the server provides one.
  final String? ownerName;
  final String createdAt;
  final String updatedAt;

  factory MemberPipeline.fromJson(Map<String, dynamic> json) {
    final owner = json['owner'];
    final ownerMap = owner is Map<String, dynamic>
        ? owner
        : const <String, dynamic>{};
    return MemberPipeline(
      id: _asString(json['id']),
      name: _asString(json['name']),
      description: _asString(json['description']),
      icon: _asString(json['icon']),
      version: _asString(json['version']),
      shareScope: _asString(json['shareScope']),
      ownerType: _asString(ownerMap['type']),
      ownerName: _asOptionalString(ownerMap['name']),
      createdAt: _asString(json['createdAt']),
      updatedAt: _asString(json['updatedAt']),
    );
  }
}

/// The assembled member-detail payload: the member's shared plans, approved
/// plans, and pipelines, plus their optional usage rollup. `usage` is `null`
/// when the viewer cannot clear the org's `usageStatsMinRole` (the section is
/// simply omitted — no gated data is requested) or when the usage load failed.
class MemberDetailData {
  const MemberDetailData({
    required this.sharedPlans,
    required this.approvedPlans,
    required this.pipelines,
    this.usage,
  });

  final List<MemberSharedPlan> sharedPlans;
  final List<MemberApprovedPlan> approvedPlans;
  final List<MemberPipeline> pipelines;

  /// Per-member usage rollup, or `null` when not viewable / unavailable.
  final TeamUsageResponse? usage;
}

String _asString(Object? value) => value is String ? value : '';

String? _asOptionalString(Object? value) => value is String ? value : null;
