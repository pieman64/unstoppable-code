import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:mobile/data/models/remote_file_diff.dart';

/// Identity of one cached diff read. Besides the request fields it carries
/// the changed-file row's status and line counts, so a file that keeps
/// changing on the desktop misses the cache as soon as its roster row moves
/// instead of serving a stale patch.
class RemoteFileDiffCacheKey {
  const RemoteFileDiffCacheKey({
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.repoId,
    required this.path,
    required this.source,
    required this.status,
    required this.insertions,
    required this.deletions,
    this.revision,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;
  final String? repoId;
  final String path;
  final RemoteDiffSource source;
  final String status;
  final String? revision;
  final int? insertions;
  final int? deletions;

  bool sameRequest(RemoteFileDiffCacheKey other) =>
      other.workspaceLocalId == workspaceLocalId &&
      other.worktreeLocalId == worktreeLocalId &&
      other.repoId == repoId &&
      other.path == path &&
      other.source == source;

  Map<String, Object?> toJson() => {
    'workspace': workspaceLocalId,
    'worktree': worktreeLocalId,
    'repo': repoId,
    'path': path,
    'source': source.wireValue,
    'status': status,
    'insertions': insertions,
    'deletions': deletions,
    'revision': revision,
  };

  static RemoteFileDiffCacheKey? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final workspace = value['workspace'];
    final worktree = value['worktree'];
    final path = value['path'];
    final status = value['status'];
    final revision = value['revision'];
    final repo = value['repo'];
    final insertions = value['insertions'];
    final deletions = value['deletions'];
    final source = RemoteDiffSource.values
        .where((source) => source.wireValue == value['source'])
        .firstOrNull;
    if (workspace is! String ||
        worktree is! String ||
        path is! String ||
        status is! String ||
        source == null ||
        revision is! String ||
        revision.isEmpty ||
        (repo != null && repo is! String) ||
        (insertions != null && insertions is! int) ||
        (deletions != null && deletions is! int)) {
      return null;
    }
    return RemoteFileDiffCacheKey(
      workspaceLocalId: workspace,
      worktreeLocalId: worktree,
      repoId: repo,
      path: path,
      source: source,
      status: status,
      revision: revision,
      insertions: insertions,
      deletions: deletions,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is RemoteFileDiffCacheKey &&
      other.workspaceLocalId == workspaceLocalId &&
      other.worktreeLocalId == worktreeLocalId &&
      other.repoId == repoId &&
      other.path == path &&
      other.source == source &&
      other.revision == revision &&
      other.status == status &&
      other.insertions == insertions &&
      other.deletions == deletions;

  @override
  int get hashCode => Object.hash(
    workspaceLocalId,
    worktreeLocalId,
    repoId,
    path,
    source,
    revision,
    status,
    insertions,
    deletions,
  );
}

/// A bounded, short-lived LRU. Hits require revalidation: roster revisions
/// identify metadata rather than patch contents. Older hosts without revisions
/// keep memory-only entries. Storage failures are cache misses.
class RemoteFileDiffCache {
  RemoteFileDiffCache({
    required this.maxEntries,
    this.maxBytes = 512 * 1024,
    this.persist = false,
    DateTime Function()? clock,
  }) : assert(maxEntries > 0),
       _clock = clock ?? DateTime.now;

  static const _storageKey = 'remote-file-diffs-v1';
  static const _maxAge = Duration(minutes: 15);
  static const _writeDelay = Duration(milliseconds: 500);
  final int maxEntries;
  final int maxBytes;
  final bool persist;
  final DateTime Function() _clock;
  final _entries = <RemoteFileDiffCacheKey, _CachedDiff>{};
  final _pendingReads = <RemoteFileDiffCacheKey, int>{};
  int _readSequence = 0;
  String? _sessionId;
  int _generation = 0;
  int _entryBytes = 0;
  String _prefix = '{"sessionId":null,"entries":[';
  int _prefixBytes = '{"sessionId":null,"entries":['.length;
  Timer? _writeTimer;
  Future<void>? _writes;
  Future<void>? _restoration;

  int get length => _entries.length;
  int get _bytes =>
      _prefixBytes +
      2 +
      _entryBytes +
      (_entries.isEmpty ? 0 : _entries.length - 1);

  Future<void> restoreSession(String? sessionId) {
    if (sessionId != null && sessionId == _sessionId) {
      return _restoration ?? Future<void>.value();
    }
    final restoration = _restoreSession(sessionId);
    _restoration = restoration;
    unawaited(
      restoration.whenComplete(() {
        if (identical(_restoration, restoration)) _restoration = null;
      }),
    );
    return restoration;
  }

  Future<RemoteFileDiff?> getAfterRestore(RemoteFileDiffCacheKey key) async {
    await _restoration;
    return get(key);
  }

  void _reset(String? sessionId) {
    ++_generation;
    _restoration = null;
    _writeTimer?.cancel();
    _writeTimer = null;
    _sessionId = sessionId;
    _prefix = '{"sessionId":${jsonEncode(sessionId)},"entries":[';
    _prefixBytes = utf8.encode(_prefix).length;
    _entries.clear();
    _entryBytes = 0;
    _pendingReads.clear();
  }

  Future<void> _restoreSession(String? sessionId) async {
    _reset(sessionId);
    if (sessionId == null) {
      if (persist) _write(null);
      return;
    }
    final generation = _generation;
    if (!persist) return;
    try {
      await _writes;
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_storageKey);
      if (generation != _generation || raw == null) return;
      final restored = await _decodeOffThread(
        raw,
        sessionId,
        maxBytes,
        maxEntries,
        _clock(),
      );
      if (generation != _generation) return;
      for (final entry in restored) {
        // Network reads during restoration win, including newer revisions.
        if (_entries.keys.any((key) => key.sameRequest(entry.key))) continue;
        _entries[entry.key] = entry.value;
        _entryBytes += entry.value.bytes;
      }
      _trim();
      _persist();
    } catch (_) {
      // Malformed or unavailable storage cannot block reads.
    }
  }

  bool _recent(DateTime savedAt) => _isRecent(savedAt, _clock());

  _CachedDiff? _remove(RemoteFileDiffCacheKey key) {
    final removed = _entries.remove(key);
    if (removed != null) _entryBytes -= removed.bytes;
    return removed;
  }

  void _removeWhere(bool Function(RemoteFileDiffCacheKey, _CachedDiff) test) {
    for (final key in _entries.keys.toList()) {
      if (test(key, _entries[key]!)) _remove(key);
    }
  }

  RemoteFileDiff? get(RemoteFileDiffCacheKey key) {
    _removeWhere((other, _) => other.sameRequest(key) && other != key);
    final entry = _entries[key];
    if (entry == null) return null;
    if (!_recent(entry.savedAt)) {
      _remove(key);
      return null;
    }
    // Touch the LRU without changing byte accounting or writing storage.
    _entries.remove(key);
    _entries[key] = entry;
    return entry.diff;
  }

  /// Fences concurrent reads, including two screens requesting the same file.
  int beginRead(RemoteFileDiffCacheKey key) {
    _pendingReads.removeWhere((other, _) => other.sameRequest(key));
    final id = ++_readSequence;
    _pendingReads[key] = id;
    while (_pendingReads.length > maxEntries) {
      _pendingReads.remove(_pendingReads.keys.first);
    }
    return id;
  }

  void put(RemoteFileDiffCacheKey key, RemoteFileDiff diff, {int? readId}) {
    if (readId != null && _pendingReads[key] != readId) return;
    _pendingReads.remove(key);
    if (diff.filePath != key.path) return;
    _remove(key);
    final entry = _CachedDiff.encode(key, diff, _clock());
    if (_prefixBytes + 2 + entry.bytes > maxBytes) {
      _persist();
      return;
    }
    _removeWhere((other, _) => other.sameRequest(key));
    _entries[key] = entry;
    _entryBytes += entry.bytes;
    _trim();
    _persist();
  }

  void _trim() {
    _removeWhere((_, entry) => !_recent(entry.savedAt));
    while (_entries.isNotEmpty &&
        (_entries.length > maxEntries || _bytes > maxBytes)) {
      _remove(_entries.keys.first);
    }
  }

  void _persist() {
    if (!persist || _sessionId == null) return;
    _writeTimer ??= Timer(_writeDelay, _persistNow);
  }

  void _persistNow() {
    _writeTimer?.cancel();
    _writeTimer = null;
    final rows = [
      for (final entry in _entries.entries)
        if (entry.key.revision?.isNotEmpty == true) entry.value.encoded,
    ];
    // Each row was encoded once on insertion. Joining cannot revisit a diff
    // or escape its patch again, and only runs once per write window.
    _write(rows.isEmpty ? null : '$_prefix${rows.join(',')}]}');
  }

  void _write(String? value) {
    _writes = (_writes ?? Future<void>.value()).then((_) async {
      try {
        final prefs = await SharedPreferences.getInstance();
        if (value == null) {
          await prefs.remove(_storageKey);
        } else {
          await prefs.setString(_storageKey, value);
        }
      } catch (_) {
        // Best effort: fetching a diff must not depend on disk availability.
      }
    });
  }

  Future<void> flush() async {
    if (_writeTimer != null) _persistNow();
    await _writes;
  }

  void clearWorktree({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    _pendingReads.removeWhere(
      (key, _) =>
          key.workspaceLocalId == workspaceLocalId &&
          key.worktreeLocalId == worktreeLocalId,
    );
    _removeWhere(
      (key, _) =>
          key.workspaceLocalId == workspaceLocalId &&
          key.worktreeLocalId == worktreeLocalId,
    );
    _persist();
  }

  void clear() {
    _reset(null);
    if (persist) _write(null);
  }
}

bool _isRecent(DateTime savedAt, DateTime now) {
  final age = now.difference(savedAt);
  return !age.isNegative && age <= RemoteFileDiffCache._maxAge;
}

// This closure captures only the bounded string and decode parameters, never
// a cache, widget, preferences instance or UI-isolate state.
Future<List<MapEntry<RemoteFileDiffCacheKey, _CachedDiff>>> _decodeOffThread(
  String raw,
  String sessionId,
  int maxBytes,
  int maxEntries,
  DateTime now,
) => Isolate.run(
  () => _decodeEntries(raw, sessionId, maxBytes, maxEntries, now),
);

List<MapEntry<RemoteFileDiffCacheKey, _CachedDiff>> _decodeEntries(
  String raw,
  String sessionId,
  int maxBytes,
  int maxEntries,
  DateTime now,
) {
  if (utf8.encode(raw).length > maxBytes) return const [];
  final data = jsonDecode(raw);
  if (data is! Map<String, dynamic> || data['sessionId'] != sessionId) {
    return const [];
  }
  final entries = data['entries'];
  if (entries is! List) return const [];
  final restored = <MapEntry<RemoteFileDiffCacheKey, _CachedDiff>>[];
  for (final row in entries.take(maxEntries)) {
    if (row is! Map<String, dynamic>) continue;
    final key = RemoteFileDiffCacheKey.fromJson(row['key']);
    final diffJson = row['diff'];
    final savedAt = row['savedAt'];
    if (key == null ||
        diffJson is! Map<String, dynamic> ||
        savedAt is! String) {
      continue;
    }
    final timestamp = DateTime.tryParse(savedAt);
    if (timestamp == null || !_isRecent(timestamp, now)) continue;
    final diff = RemoteFileDiff.fromJson(diffJson);
    if (diff.filePath != key.path) continue;
    restored.add(MapEntry(key, _CachedDiff.encode(key, diff, timestamp)));
  }
  return restored;
}

class _CachedDiff {
  const _CachedDiff(this.diff, this.savedAt, this.encoded, this.bytes);

  factory _CachedDiff.encode(
    RemoteFileDiffCacheKey key,
    RemoteFileDiff diff,
    DateTime savedAt,
  ) {
    final encoded = jsonEncode({
      'key': key.toJson(),
      'savedAt': savedAt.toUtc().toIso8601String(),
      'diff': {
        'filePath': diff.filePath,
        'patch': diff.patch,
        'repoId': diff.repoId,
        'rangeLabel': diff.rangeLabel,
        'files': [
          {
            'filePath': diff.filePath,
            'insertions': diff.insertions,
            'deletions': diff.deletions,
          },
        ],
      },
    });
    return _CachedDiff(diff, savedAt, encoded, utf8.encode(encoded).length);
  }

  final RemoteFileDiff diff;
  final DateTime savedAt;
  final String encoded;
  final int bytes;
}
