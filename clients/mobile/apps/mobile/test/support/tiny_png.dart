import 'dart:typed_data';

/// A real, decodable 1x1 (8-bit RGB) PNG, verified with `sips`/`file`
/// before being embedded here as raw bytes. Widget tests that need to
/// exercise the genuine `Image.memory` preview path (not its
/// `errorBuilder` fallback, which every other fixture in this suite hits
/// via zero-filled bytes) should use this instead of a picker helper that
/// fabricates undecodable content.
final Uint8List tinyPngBytes = Uint8List.fromList(const [
  137, 80, 78, 71, 13, 10, 26, 10, //
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119,
  83, 222, //
  0, 0, 0, 12, 73, 68, 65, 84, 120, 218, 99, 48, 78, 155, 9, 0, 2, 2, 1, 51,
  104, 122, 49, 248, //
  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130, //
]);
