import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/member_detail.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/member_detail_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Manages state for the member-detail (drill-down) screen: the subject member's
/// static profile (passed in from the members list) plus their loaded per-member
/// data — shared plans, approved plans, pipelines, and the gated usage rollup.
///
/// The [member] profile (name/email/role) is not re-fetched: there is no member
/// GET endpoint, so it is supplied from the already-loaded org detail.
/// [canViewStats] is the org's `canViewUsageStats` gate; when false the usage
/// section is hidden and never requested.
final class MemberDetailViewModel extends ChangeNotifier
    with DisposeSafeNotifier {
  MemberDetailViewModel({
    required this.repository,
    required this.member,
    required this.canViewStats,
  });

  final MemberDetailRepository repository;

  /// The subject member's static profile, from the members list.
  final OrganizationMember member;

  /// Whether the viewer clears the org's `usageStatsMinRole`. Drives whether the
  /// usage section is shown and whether a gated usage request is made.
  final bool canViewStats;

  bool _isLoading = false;
  MemberDetailData? _data;
  Object? _error;

  /// True while the initial/refresh load is in flight.
  bool get isLoading => _isLoading;

  /// The loaded member data, or `null` until the first successful load.
  MemberDetailData? get data => _data;

  /// Non-null when the most recent [load] ended with an error.
  Object? get error => _error;

  /// The structured org-billing lapse payload when the most recent load
  /// failed because the organization lost its team features, else null.
  OrgTeamsLapsedError? get planLapse => errorOrgTeamsLapse(_error);

  /// User-presentable copy for the most recent load failure, or null when
  /// only generic copy is honest (5xx, transport). Never a raw exception dump.
  String? get errorMessage => presentableErrorMessage(_error);

  /// Loads the member's plans, pipelines, approved plans, and gated usage,
  /// replacing any existing state.
  Future<void> load() async {
    _isLoading = true;
    _error = null;
    notifyListenersSafe();
    try {
      _data = await repository.load(canViewStats: canViewStats);
    } catch (e) {
      _error = e;
      _data = null;
    } finally {
      _isLoading = false;
      notifyListenersSafe();
    }
  }
}
