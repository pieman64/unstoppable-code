import 'package:mobile/data/models/remote_session.dart';

/// Caches one value derived from a snapshot, keyed on the snapshot's identity
/// plus a caller-supplied generation. Sound because every write to the
/// session snapshot replaces the object rather than mutating it.
final class SnapshotMemo<T extends Object> {
  RemoteSessionSnapshot? _snapshot;
  int _generation = 0;
  T? _value;

  T read(
    RemoteSessionSnapshot? snapshot,
    T Function(RemoteSessionSnapshot? snapshot) derive, {
    int generation = 0,
  }) {
    final cached = _value;
    if (cached != null &&
        identical(_snapshot, snapshot) &&
        _generation == generation) {
      return cached;
    }
    final value = derive(snapshot);
    _snapshot = snapshot;
    _generation = generation;
    _value = value;
    return value;
  }
}
