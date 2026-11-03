import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'attachment_archive_ledger.dart';

export 'attachment_archive_ledger.dart';

/// Records picker copies after their bytes have been read, so archiving can
/// reclaim them without touching originals or another worktree's files.
class AttachmentCache implements AttachmentArchiveLedger {
  AttachmentCache({Future<List<Directory>> Function()? temporaryDirectories})
    : temporaryDirectories = temporaryDirectories ?? _temporaryDirectories;

  final Future<List<Directory>> Function() temporaryDirectories;
  static const _prefix = 'chat_attachment_cache.v1.';
  static const _pendingArchivesKey = 'chat_attachment_pending_archives.v1';
  static Future<void> _pending = Future.value();
  final Set<String> _archived = {};

  static Future<List<Directory>> _temporaryDirectories() async {
    // Desktop development may use a shared system temp directory containing
    // user originals. Only mobile sandboxes make these roots app-owned.
    if (!Platform.isIOS && !Platform.isAndroid) return [];
    return [await getTemporaryDirectory(), Directory.systemTemp];
  }

  String _key(String workspaceId, String worktreeId) =>
      '$_prefix${jsonEncode([workspaceId, worktreeId])}';

  // Serialize registry updates across service instances. Cleanup is best effort:
  // an inaccessible cache must never turn an accepted archive into a failure.
  Future<void> _enqueue(Future<void> Function() operation) {
    _pending = _pending.then((_) => operation()).catchError((Object error) {
      debugPrint('Attachment cache maintenance failed: ${error.runtimeType}');
    });
    return _pending;
  }

  Future<List<String>> _roots() async => [
    for (final directory in await temporaryDirectories())
      await directory.resolveSymbolicLinks(),
  ];

  Future<String?> _cachedFile(String path, List<String> roots) async {
    if (!p.isAbsolute(path) ||
        await FileSystemEntity.type(path, followLinks: false) !=
            FileSystemEntityType.file) {
      return null;
    }
    final resolved = await File(path).resolveSymbolicLinks();
    return roots.any((root) => p.isWithin(root, resolved)) ? resolved : null;
  }

  /// Records only files inside the app's temporary/cache directories. The
  /// fingerprint prevents a reused picker path from deleting a newer file.
  Future<void> record(
    String workspaceId,
    String worktreeId,
    Iterable<String> paths,
  ) => _enqueue(() async {
    final key = _key(workspaceId, worktreeId);
    final prefs = await SharedPreferences.getInstance();
    final roots = await _roots();
    final entries = {...?prefs.getStringList(key)};
    for (final path in paths) {
      final resolved = await _cachedFile(path, roots);
      if (resolved == null) continue;
      final stat = await File(resolved).stat();
      entries.add(
        jsonEncode([resolved, stat.size, stat.modified.microsecondsSinceEpoch]),
      );
    }
    if (!await prefs.setStringList(key, entries.toList())) return;
    // A picker can finish reading after the archive command has completed.
    if (_archived.contains(key)) await _clear(key, prefs, roots);
  });

  Future<void> clear(String workspaceId, String worktreeId) =>
      _enqueue(() async {
        final key = _key(workspaceId, worktreeId);
        _archived.add(key);
        final prefs = await SharedPreferences.getInstance();
        // Avoid platform calls when this worktree never picked any attachments.
        if (!prefs.containsKey(key)) return;
        await _clear(key, prefs, await _roots());
      });

  /// Persists an accepted archive command before it depends on a live session
  /// event. A reconnect or process restart can then either reclaim an owner
  /// absent from the authoritative snapshot or resume waiting for its command.
  @override
  Future<void> trackArchiveCommand(
    String commandId,
    String workspaceId,
    String worktreeId, {
    DateTime? createdAt,
  }) => _enqueue(() async {
    final prefs = await SharedPreferences.getInstance();
    final entries = {...?prefs.getStringList(_pendingArchivesKey)};
    entries.removeWhere((entry) {
      final pending = _decodePendingArchive(entry);
      return pending?.commandId == commandId;
    });
    entries.add(
      jsonEncode([
        commandId,
        workspaceId,
        worktreeId,
        (createdAt ?? DateTime.now()).millisecondsSinceEpoch,
      ]),
    );
    await prefs.setStringList(_pendingArchivesKey, entries.toList());
  });

  /// Returns archive commands whose terminal cleanup has not been reconciled.
  @override
  Future<List<PendingAttachmentArchive>> pendingArchiveCommands() async {
    var result = const <PendingAttachmentArchive>[];
    await _enqueue(() async {
      final prefs = await SharedPreferences.getInstance();
      result = [
        for (final entry
            in prefs.getStringList(_pendingArchivesKey) ?? const <String>[])
          ?_decodePendingArchive(entry),
      ];
    });
    return result;
  }

  /// Removes a terminal archive command and reclaims its recorded files only
  /// when the archive succeeded (or an authoritative snapshot proves it did).
  @override
  Future<void> finishArchiveCommand(
    String commandId, {
    required bool succeeded,
  }) => _enqueue(() async {
    final prefs = await SharedPreferences.getInstance();
    final entries = prefs.getStringList(_pendingArchivesKey) ?? const [];
    final matching = <PendingAttachmentArchive>[];
    for (final entry in entries) {
      final pending = _decodePendingArchive(entry);
      if (pending?.commandId == commandId) matching.add(pending!);
    }

    if (succeeded && matching.isNotEmpty) {
      final keysWithEntries = [
        for (final pending in matching)
          if (prefs.containsKey(_key(pending.workspaceId, pending.worktreeId)))
            _key(pending.workspaceId, pending.worktreeId),
      ];
      if (keysWithEntries.isNotEmpty) {
        final roots = await _roots();
        for (final key in keysWithEntries) {
          _archived.add(key);
          await _clear(key, prefs, roots);
        }
      } else {
        for (final pending in matching) {
          final key = _key(pending.workspaceId, pending.worktreeId);
          _archived.add(key);
        }
      }
      final cleanupIncomplete = matching.any(
        (pending) =>
            prefs.containsKey(_key(pending.workspaceId, pending.worktreeId)),
      );
      if (cleanupIncomplete) return;
    }

    final remaining = [
      for (final entry in entries)
        if (_decodePendingArchive(entry)?.commandId != commandId) entry,
    ];
    if (remaining.isEmpty) {
      await prefs.remove(_pendingArchivesKey);
    } else {
      await prefs.setStringList(_pendingArchivesKey, remaining);
    }
  });

  static PendingAttachmentArchive? _decodePendingArchive(String entry) {
    try {
      final data = jsonDecode(entry) as List<dynamic>;
      if ((data.length != 3 && data.length != 4) ||
          data.take(3).any((value) => value is! String) ||
          (data.length == 4 && data[3] is! int)) {
        return null;
      }
      return (
        commandId: data[0] as String,
        createdAt: data.length == 4
            ? DateTime.fromMillisecondsSinceEpoch(data[3] as int)
            : null,
        workspaceId: data[1] as String,
        worktreeId: data[2] as String,
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> _clear(
    String key,
    SharedPreferences prefs,
    List<String> roots,
  ) async {
    final otherFingerprints = <String>{
      for (final other in prefs.getKeys())
        if (other.startsWith(_prefix) && other != key)
          for (final entry in prefs.getStringList(other) ?? <String>[]) entry,
    };
    final retry = <String>[];
    for (final entry in prefs.getStringList(key) ?? <String>[]) {
      try {
        final data = jsonDecode(entry) as List<dynamic>;
        final path = data[0] as String;
        if (otherFingerprints.contains(entry)) continue;
        if (await _cachedFile(path, roots) != path) continue;
        final file = File(path);
        final stat = await file.stat();
        if (stat.size == data[1] &&
            stat.modified.microsecondsSinceEpoch == data[2]) {
          await file.delete();
        }
      } on FileSystemException {
        retry.add(entry);
      }
    }
    if (retry.isEmpty) {
      await prefs.remove(key);
    } else {
      await prefs.setStringList(key, retry);
    }
  }
}
