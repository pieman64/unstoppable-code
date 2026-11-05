import 'dart:typed_data';
import 'desktop/message_codec.dart';

/// Optional JS object fields can be present with `undefined`. Omit those
/// fields at the shared DTO boundary while keeping the wire codec lossless.
Object? deviceChatDto(Object? value) {
  if (identical(value, desktopUndefined)) return null;
  if (value is Map<String, dynamic>) {
    return <String, dynamic>{
      for (final entry in value.entries)
        if (!identical(entry.value, desktopUndefined))
          entry.key: deviceChatDto(entry.value),
    };
  }
  if (value is Uint8List) return value;
  if (value is List) return value.map(deviceChatDto).toList();
  return value;
}
