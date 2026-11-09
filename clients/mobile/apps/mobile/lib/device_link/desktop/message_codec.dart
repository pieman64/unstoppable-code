import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// V8 value serializer v15, as used by Node's v8.serialize. This prototype
/// supports DTO objects/arrays, primitive values, Date and byte buffers.
/// Unsupported structured-clone types fail explicitly, never coerce to JSON.
/// Format reference: v8/src/objects/value-serializer.cc and node/lib/v8.js.
const desktopUndefined = _Undefined();

final class _Undefined {
  const _Undefined();
}

const desktopMaxFragmentBytes = 65470;

/// The largest reply mobile requests is `file:read-content`: 5 MiB of UTF-8
/// text, which V8 sends as up to 10 MiB of UTF-16 when it has one character
/// past U+00FF. An oversized message ends the session, so this leaves room.
const desktopMaxMessageBytes = 12 * 1024 * 1024;

/// Outgoing messages may be larger than incoming ones: one attachment import
/// carries a whole file. The desktop accepts far more.
const desktopMaxOutgoingMessageBytes = 16 * 1024 * 1024;

List<Uint8List> encodeDesktopMessage(Object? value) {
  final writer = _Writer();
  writer.value(value, 0);
  final bytes = writer.bytes.takeBytes();
  if (bytes.length > desktopMaxOutgoingMessageBytes) {
    throw const FormatException('Desktop message exceeds mobile limit.');
  }
  return [
    for (
      var offset = 0;
      offset < bytes.length;
      offset += desktopMaxFragmentBytes
    )
      Uint8List.fromList([
        offset + desktopMaxFragmentBytes >= bytes.length ? 1 : 0,
        ...bytes.sublist(
          offset,
          (offset + desktopMaxFragmentBytes).clamp(0, bytes.length),
        ),
      ]),
  ];
}

final class DesktopMessageAssembler {
  DesktopMessageAssembler({this.maxBytes = desktopMaxMessageBytes});
  final int maxBytes;
  final _parts = BytesBuilder(copy: false);
  bool? _compressed;
  ({Object? value})? push(Uint8List fragment) {
    if (fragment.isEmpty || fragment[0] > 3) {
      throw const FormatException('Invalid desktop fragment.');
    }
    final flags = fragment[0];
    if (flags & 1 == 0 && fragment.length != desktopMaxFragmentBytes + 1) {
      throw const FormatException('Incomplete desktop fragment.');
    }
    final compressed = flags & 2 != 0;
    if (_compressed != null && compressed != _compressed) {
      throw const FormatException('Mixed desktop fragments.');
    }
    _compressed = compressed;
    if (_parts.length + fragment.length - 1 > maxBytes) {
      throw const FormatException('Desktop message exceeds mobile limit.');
    }
    _parts.add(Uint8List.sublistView(fragment, 1));
    if (flags & 1 == 0) return null;
    var bytes = _parts.takeBytes();
    _compressed = null;
    if (compressed) {
      final bounded = _BoundedSink(maxBytes);
      try {
        final inflater = ZLibDecoder(raw: true).startChunkedConversion(bounded);
        inflater.add(bytes);
        inflater.close();
        bytes = bounded.bytes.takeBytes();
      } catch (_) {
        throw const FormatException(
          'Invalid or oversized compressed desktop message.',
        );
      }
    }
    final reader = _Reader(bytes);
    return (value: reader.read());
  }
}

final class _BoundedSink implements Sink<List<int>> {
  _BoundedSink(this.max);
  final int max;
  final bytes = BytesBuilder(copy: false);
  @override
  void add(List<int> data) {
    if (bytes.length + data.length > max) {
      throw const FormatException(
        'Inflated desktop message exceeds mobile limit.',
      );
    }
    bytes.add(data);
  }

  @override
  void close() {}
}

final class _Writer {
  final bytes = BytesBuilder()..add([255, 15]);
  final _references = HashMap<Object, int>.identity();
  void uint(int n) {
    do {
      final next = n & 127;
      n >>= 7;
      bytes.addByte(next | (n == 0 ? 0 : 128));
    } while (n != 0);
  }

  void value(Object? v, int depth) {
    if (depth > 128 || bytes.length > desktopMaxOutgoingMessageBytes) {
      throw const FormatException('Desktop value is too large or nested.');
    }
    if (v == null) {
      bytes.addByte(48);
      return;
    }
    if (identical(v, desktopUndefined)) {
      bytes.addByte(95);
      return;
    }
    if (v is bool) {
      bytes.addByte(v ? 84 : 70);
      return;
    }
    if (v is int && v >= -2147483648 && v <= 2147483647) {
      bytes.addByte(73);
      uint((v << 1) ^ (v >> 31));
      return;
    }
    if (v is num) {
      bytes.addByte(78);
      bytes.add(
        (ByteData(
          8,
        )..setFloat64(0, v.toDouble(), Endian.little)).buffer.asUint8List(),
      );
      return;
    }
    if (v is String) {
      final encoded = utf8.encode(v);
      bytes.addByte(83);
      uint(encoded.length);
      bytes.add(encoded);
      return;
    }
    final reference = _references[v];
    if (reference != null) {
      bytes.addByte(94);
      uint(reference);
      return;
    }
    _references[v] = _references.length;
    if (v is Uint8List) {
      bytes.addByte(92);
      uint(1);
      uint(v.length);
      bytes.add(v);
      return;
    }
    if (v is DateTime) {
      bytes.addByte(68);
      bytes.add(
        (ByteData(8)..setFloat64(
              0,
              v.millisecondsSinceEpoch.toDouble(),
              Endian.little,
            ))
            .buffer
            .asUint8List(),
      );
      return;
    }
    if (v is List) {
      bytes.addByte(65);
      uint(v.length);
      for (final element in v) {
        value(element, depth + 1);
      }
      bytes.addByte(36);
      uint(0);
      uint(v.length);
      return;
    }
    if (v is Map<String, dynamic>) {
      bytes.addByte(111);
      for (final entry in v.entries) {
        value(entry.key, depth + 1);
        value(entry.value, depth + 1);
      }
      bytes.addByte(123);
      uint(v.length);
      return;
    }
    throw const FormatException('Unsupported desktop value type.');
  }
}

final class _Reader {
  _Reader(this.bytes);
  final Uint8List bytes;
  int offset = 0;
  final references = <Object?>[];
  Never invalid() =>
      throw const FormatException('Unsupported or malformed V8 desktop value.');
  int byte() {
    if (offset >= bytes.length) invalid();
    return bytes[offset++];
  }

  int peek() {
    while (offset < bytes.length && bytes[offset] == 0) {
      offset++;
    }
    if (offset >= bytes.length) invalid();
    return bytes[offset];
  }

  int uint() {
    var n = 0;
    for (var shift = 0; shift < 56; shift += 7) {
      final b = byte();
      n |= (b & 127) << shift;
      if (b < 128) return n;
    }
    invalid();
  }

  Uint8List raw(int length) {
    if (length < 0 || offset + length > bytes.length) invalid();
    final result = Uint8List.sublistView(bytes, offset, offset + length);
    offset += length;
    return result;
  }

  double doubleValue() =>
      ByteData.sublistView(raw(8)).getFloat64(0, Endian.little);
  Object? read() {
    if (byte() != 255) invalid();
    final version = uint();
    if (version < 15 || version > 16) invalid();
    final result = value(0);
    while (offset < bytes.length && bytes[offset] == 0) {
      offset++;
    }
    if (offset != bytes.length) invalid();
    return result;
  }

  Object? value(int depth) {
    if (depth > 128 || references.length > 100000) invalid();
    peek();
    switch (byte()) {
      case 95:
        return desktopUndefined;
      case 48:
        return null;
      case 84:
        return true;
      case 70:
        return false;
      case 73:
        final n = uint();
        return (n >> 1) ^ -(n & 1);
      case 85:
        return uint();
      case 78:
        return doubleValue();
      case 83:
        return utf8.decode(raw(uint()));
      case 34:
        return latin1.decode(raw(uint()));
      case 99:
        final b = raw(uint());
        if (b.length.isOdd) invalid();
        final data = ByteData.sublistView(b);
        return String.fromCharCodes([
          for (var i = 0; i < b.length; i += 2)
            data.getUint16(i, Endian.little),
        ]);
      case 94:
        final id = uint();
        if (id >= references.length) invalid();
        return references[id];
      case 111:
        final map = <String, dynamic>{};
        references.add(map);
        var count = 0;
        while (peek() != 123) {
          final key = value(depth + 1);
          if (key is! String && key is! int) invalid();
          map[key.toString()] = value(depth + 1);
          count++;
        }
        byte();
        if (uint() != count) invalid();
        return map;
      case 65:
        final length = uint();
        if (length > bytes.length) invalid();
        final list = <Object?>[];
        references.add(list);
        for (var i = 0; i < length; i++) {
          list.add(value(depth + 1));
        }
        if (byte() != 36 || uint() != 0 || uint() != length) invalid();
        return list;
      case 97:
        final length = uint();
        if (length > bytes.length) invalid();
        final list = List<Object?>.filled(length, desktopUndefined);
        references.add(list);
        var count = 0;
        while (peek() != 64) {
          final key = value(depth + 1);
          if (key is! int || key < 0 || key >= length) invalid();
          list[key] = value(depth + 1);
          count++;
        }
        byte();
        if (uint() != count || uint() != length) invalid();
        return list;
      case 68:
        final ms = doubleValue();
        if (!ms.isFinite) invalid();
        final date = DateTime.fromMillisecondsSinceEpoch(
          ms.toInt(),
          isUtc: true,
        );
        references.add(date);
        return date;
      case 66:
        final buffer = Uint8List.fromList(raw(uint()));
        references.add(buffer);
        return buffer;
      case 92:
        final type = uint();
        final data = Uint8List.fromList(raw(uint()));
        // Node host-object tags 1/2/10 are Uint8Array/clamped/Buffer.
        if (type != 1 && type != 2 && type != 10) invalid();
        references.add(data);
        return data;
      default:
        invalid();
    }
  }
}
