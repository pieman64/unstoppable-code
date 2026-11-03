import 'dart:math';

final Random _secure = Random.secure();

/// RFC 4122 version-4 UUID as lowercase hyphenated text.
///
/// The `/api/cloud` routes reject a `clientRequestId` or a created chat's
/// `externalId` that is not a UUID, so every id the mobile client mints for
/// them comes from here. [random] is injectable for deterministic tests and
/// defaults to a cryptographically secure source.
String randomUuidV4({Random? random}) {
  final source = random ?? _secure;
  final bytes = List<int>.generate(16, (_) => source.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}
