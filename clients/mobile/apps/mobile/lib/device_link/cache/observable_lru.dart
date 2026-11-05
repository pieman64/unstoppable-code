import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

/// In-memory data only. Owners supply identity, lifecycle and value weights;
/// transport, refresh policy and widgets do not belong in this store.
final class ObservableLru<K extends Object, V extends Object> {
  ObservableLru({
    required this.maxEntries,
    required this.maxWeight,
    required this.weigh,
  }) : assert(maxEntries > 0),
       assert(maxWeight > 0);

  final int maxEntries, maxWeight;
  final int Function(V) weigh;
  final _entries = <K, ({V value, int weight})>{};
  final _retained = <K, int>{};
  final _updates = StreamController<K>.broadcast();
  bool _closed = false;
  int _weight = 0;

  Stream<K> get updates => _updates.stream;
  Iterable<K> get keys => _entries.keys.toList(growable: false);
  int get length => _entries.length;
  int get weight => _weight;
  V? peek(K key) => _entries[key]?.value;

  V? read(K key) {
    final entry = _entries.remove(key);
    if (entry != null) _entries[key] = entry;
    return entry?.value;
  }

  void put(K key, V value) {
    if (_closed) return;
    final previous = _entries.remove(key);
    final weight = weigh(value);
    _weight += weight - (previous?.weight ?? 0);
    _entries[key] = (value: value, weight: weight);
    _trim();
    _updates.add(key);
  }

  /// Visible entries stay resident. Their weight may exceed the budget until
  /// released, at which point normal eviction applies. Releases are idempotent.
  void Function() retain(K key) {
    if (_closed) return () {};
    _retained.update(key, (count) => count + 1, ifAbsent: () => 1);
    read(key);
    var released = false;
    return () {
      if (released || _closed) return;
      released = true;
      final count = _retained[key]!;
      if (count == 1) {
        _retained.remove(key);
      } else {
        _retained[key] = count - 1;
      }
      _trim();
    };
  }

  void _trim() {
    for (final key in keys) {
      if (_entries.length <= maxEntries && _weight <= maxWeight) break;
      if (_retained.containsKey(key)) continue;
      _weight -= _entries.remove(key)!.weight;
      _updates.add(key);
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _entries.clear();
    _retained.clear();
    _weight = 0;
    await _updates.close();
  }
}

/// Conservative payload weight, not a VM heap measurement. Avoids JSON
/// serialization on streaming updates and counts shared objects only once.
int payloadWeight(Object? value) {
  final seen = HashSet<Object>.identity();
  int visit(Object? item) {
    if (item == null) return 8;
    if (!seen.add(item)) return 0;
    if (item is String) return 32 + item.length * 2;
    if (item is TypedData) return 32 + item.lengthInBytes;
    if (item is Map) {
      return 64 +
          item.entries.fold<int>(
            0,
            (sum, entry) => sum + 32 + visit(entry.key) + visit(entry.value),
          );
    }
    if (item is List) {
      return 32 + item.fold<int>(0, (sum, v) => sum + 8 + visit(v));
    }
    return 16;
  }

  return visit(value);
}
