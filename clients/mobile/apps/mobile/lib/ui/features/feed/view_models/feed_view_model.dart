import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';
import 'package:mobile/ui/features/feed/view_models/feed_sharing_guidance.dart';

/// Manages state for the activity-feed screen.
///
/// Consumers observe via [ListenableBuilder] or [AnimatedBuilder].
/// All public fields are immutable from the consumer's perspective:
/// mutating state goes through [loadFeed], [loadMore] and [setFilters].
///
/// One generation counter orders every request: a first-page load or a filter
/// change starts a new generation, and only responses from the current
/// generation may commit rows, cursors, evidence, errors or loading flags. A
/// context change replaces the whole view model (the shell keys it by
/// organization), so rows never cross contexts.
final class FeedViewModel extends ChangeNotifier with DisposeSafeNotifier {
  FeedViewModel({required this.repository});

  final FeedRepository repository;

  Set<FeedItemType> _types = const {};
  String _query = '';
  String? _actorId;
  String? _actorLabel;
  int _loadGeneration = 0;
  Future<void>? _firstPage;
  bool _isLoading = false;
  bool _hasLoaded = false;
  bool _isLoadingMore = false;
  List<FeedItem> _items = const [];
  String? _nextCursor;
  Object? _error;
  Object? _loadMoreError;
  FeedSharingStatus? _sharingStatus;

  /// True while a first-page load is in flight. Rows from the previous load
  /// stay readable meanwhile.
  bool get isLoading => _isLoading;

  /// Whether the active filters have had a successful first page. Until then
  /// an empty [items] means "not loaded yet", not "no activity".
  bool get hasLoaded => _hasLoaded;

  /// True while the next page is in flight.
  bool get isLoadingMore => _isLoadingMore;

  /// The loaded feed items, in server order. Empty until the first successful
  /// load.
  List<FeedItem> get items => List.unmodifiable(_items);

  /// Whether the server reported another page.
  bool get hasMore => _nextCursor != null;

  /// Non-null when the most recent first-page load ended with an error.
  /// [items] then still holds the previous rows, if any.
  Object? get error => _error;

  /// Non-null when the most recent [loadMore] failed.
  Object? get loadMoreError => _loadMoreError;

  /// The structured org-billing lapse payload when the most recent load
  /// failed because the organization lost its team features, else null.
  OrgTeamsLapsedError? get planLapse => errorOrgTeamsLapse(_error);

  /// User-presentable copy for the most recent load failure, or null when
  /// only generic copy is honest (5xx, transport). Never a raw exception dump.
  String? get errorMessage => presentableErrorMessage(_error);

  /// What to say about the viewer's own sharing. Silent before the first page
  /// for the active filters, after a failure, under filters, and when there is
  /// no evidence (Personal). A refresh keeps the settled guidance until its
  /// own sharing read lands, so rows do not move while it runs.
  FeedSharingGuidance get sharingGuidance {
    final status = _sharingStatus;
    if (status == null || !_hasLoaded || _error != null || hasActiveFilters) {
      return FeedSharingGuidance.none;
    }
    return resolveFeedSharingGuidance(status);
  }

  /// The active item-type filter (empty means all types).
  Set<FeedItemType> get activeTypes => Set.unmodifiable(_types);

  /// The active free-text query (empty means none).
  String get query => _query;

  /// The active actor filter (a member's user externalId), or null for all.
  String? get actorId => _actorId;

  /// A human label for the active actor filter (e.g. name/email), when known.
  /// Present only so the UI can show which member is selected; it is not sent
  /// to the backend.
  String? get actorLabel => _actorLabel;

  /// Whether any filter is currently narrowing the feed.
  bool get hasActiveFilters =>
      _types.isNotEmpty || _query.isNotEmpty || _actorId != null;

  /// Reloads the first page for the active filters, keeping the current rows
  /// readable until it succeeds. A reload reads as deep as the rows already
  /// read. Calls made while a first-page load is in flight join it, so tab,
  /// resume and pull signals coalesce.
  Future<void> loadFeed() => _firstPage ??= _loadFirstPage();

  Future<void> _loadFirstPage() async {
    final generation = ++_loadGeneration;
    _isLoading = true;
    _isLoadingMore = false;
    _error = null;
    _loadMoreError = null;
    notifyListenersSafe();

    // The advisory read runs beside the page and never holds it. The page
    // commits a read that already landed; a later read lands on its own. The
    // settled guidance stays until then, and a newer load drops both.
    var pageLoaded = false;
    var sharingLanded = false;
    FeedSharingStatus? sharingStatus;
    unawaited(
      _readSharingStatus().then((status) {
        sharingLanded = true;
        sharingStatus = status;
        if (!pageLoaded || generation != _loadGeneration) return;
        _sharingStatus = status;
        notifyListenersSafe();
      }),
    );

    try {
      final first = await _fetchPage(null);
      if (generation != _loadGeneration) return;
      // Work can sync late, with event times between the rows already read,
      // so the refresh reads again down to the last read row. Rows tied with
      // it may sort on either side, so only that row unchanged, or a row
      // older than it, ends the read. The new rows and cursor then replace
      // the old ones.
      final rows = [...first.items];
      final ids = {for (final item in rows) item.id};
      var next = first.nextCursor;
      if (items.lastOrNull case final last?) {
        final depth = DateTime.parse(last.occurredAt);
        bool reachesLast(FeedItem row) =>
            (row.id == last.id && row.occurredAt == last.occurredAt) ||
            DateTime.parse(row.occurredAt).isBefore(depth);
        var page = first;
        while (next != null && !page.items.any(reachesLast)) {
          final cursor = next;
          page = await _fetchPage(cursor);
          if (generation != _loadGeneration) return;
          rows.addAll(page.items.where((item) => ids.add(item.id)));
          // A repeated cursor would loop forever; treat it as the end.
          next = page.nextCursor == cursor ? null : page.nextCursor;
        }
      }
      _items = rows;
      _nextCursor = next;
      if (sharingLanded) _sharingStatus = sharingStatus;
      _hasLoaded = true;
      pageLoaded = true;
    } catch (e) {
      if (generation != _loadGeneration) return;
      _error = e;
    } finally {
      // Only the newest load settles; older loads returned early above.
      if (generation == _loadGeneration) {
        _isLoading = false;
        _firstPage = null;
        notifyListenersSafe();
      }
    }
  }

  Future<FeedPageResponse> _fetchPage(String? cursor) => repository.fetchFeed(
    cursor: cursor,
    types: _types.isEmpty ? null : _types.toList(),
    query: _query.isEmpty ? null : _query,
    actorId: _actorId,
  );

  /// Sharing evidence is advisory: its failure never fails the feed page.
  Future<FeedSharingStatus?> _readSharingStatus() async {
    try {
      return await repository.fetchSharingStatus();
    } catch (_) {
      return null;
    }
  }

  /// Appends the next page. A no-op without a cursor or while any page is in
  /// flight. A first-page load or filter change discards a pending append.
  Future<void> loadMore() async {
    final cursor = _nextCursor;
    if (cursor == null || _isLoading || _isLoadingMore) return;
    final generation = _loadGeneration;
    _isLoadingMore = true;
    _loadMoreError = null;
    notifyListenersSafe();

    try {
      final page = await _fetchPage(cursor);
      if (generation != _loadGeneration) return;
      // Keyset pages can overlap when new work lands between requests.
      final seen = {for (final item in _items) item.id};
      _items = [..._items, ...page.items.where((item) => seen.add(item.id))];
      // A repeated cursor would loop forever; treat it as the end.
      final next = page.nextCursor;
      _nextCursor = next == cursor ? null : next;
    } catch (e) {
      if (generation != _loadGeneration) return;
      _loadMoreError = e;
    } finally {
      if (generation == _loadGeneration) {
        _isLoadingMore = false;
        notifyListenersSafe();
      }
    }
  }

  /// Replaces the active filters and reloads the feed.
  ///
  /// [actorId] is a member's user externalId (null clears the actor filter);
  /// [actorLabel] is an optional display label kept only for the UI.
  ///
  /// The previous rows belong to the old filters, so they are cleared rather
  /// than shown under the new ones while the request is in flight.
  Future<void> setFilters({
    required Set<FeedItemType> types,
    required String query,
    String? actorId,
    String? actorLabel,
  }) {
    _types = {...types};
    _query = query.trim();
    final trimmedActorId = actorId?.trim();
    _actorId = (trimmedActorId == null || trimmedActorId.isEmpty)
        ? null
        : trimmedActorId;
    _actorLabel = _actorId == null ? null : actorLabel;
    _items = const [];
    _nextCursor = null;
    _hasLoaded = false;
    return _firstPage = _loadFirstPage();
  }

  /// Clears all filters and reloads.
  Future<void> clearFilters() => setFilters(types: const {}, query: '');
}
