import 'dart:convert';
import 'dart:typed_data';

const deviceLinkProtocol = 'canopy-device-link-prototype/1';
const deviceLinkSubprotocol = 'canopy-device-link-prototype.v1';
const deviceLinkMaxMessageBytes = 32 * 1024;
final _deviceIdPattern = RegExp(r'^[A-Za-z0-9_-]{22}$');

class DeviceLinkException implements Exception {
  const DeviceLinkException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// A development invitation. Its capability stays out of URLs sent over HTTP,
/// persistent storage, diagnostic strings and the application's normal auth.
final class DeviceLinkInvitation {
  DeviceLinkInvitation._(this.baseUri, this.capability);

  factory DeviceLinkInvitation.parse(String input) {
    final uri = Uri.tryParse(input.trim());
    if (uri == null ||
        !uri.hasAuthority ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        (uri.path != '/' && uri.path.isNotEmpty) ||
        !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(uri.fragment)) {
      throw const DeviceLinkException(
        'Enter the invitation from the desktop peer.',
      );
    }
    final loopback = const ['127.0.0.1', 'localhost', '::1'].contains(uri.host);
    if (uri.scheme != 'https' && !(uri.scheme == 'http' && loopback)) {
      throw const DeviceLinkException(
        'The invitation must use HTTPS or local loopback.',
      );
    }
    return DeviceLinkInvitation._(uri.replace(fragment: ''), uri.fragment);
  }

  final Uri baseUri;
  final String capability;

  Uri endpoint(String path) => baseUri.resolve(path);

  @override
  String toString() => 'DeviceLinkInvitation(${baseUri.origin})';
}

Map<String, dynamic> deviceLinkObject(Object? value) {
  if (value is! Map<String, dynamic>) {
    throw const DeviceLinkException('The peer sent an invalid message.');
  }
  return value;
}

String deviceLinkString(Map<String, dynamic> value, String key) {
  final field = value[key];
  if (field is! String || field.isEmpty || field.length > 4096) {
    throw const DeviceLinkException('The peer sent an invalid message.');
  }
  return field;
}

Uint8List encodeDeviceLinkMessage(Map<String, dynamic> value) {
  final bytes = utf8.encode(jsonEncode(value));
  if (bytes.length > deviceLinkMaxMessageBytes) {
    throw const DeviceLinkException('The test message is too large.');
  }
  // One final, uncompressed fragment. Deliberately independent of V8/Portal.
  return Uint8List.fromList([1, ...bytes]);
}

Map<String, dynamic> decodeDeviceLinkMessage(Uint8List bytes) {
  if (bytes.isEmpty ||
      bytes.first != 1 ||
      bytes.length > deviceLinkMaxMessageBytes + 1) {
    throw const DeviceLinkException('The peer sent an unsupported message.');
  }
  try {
    return deviceLinkObject(jsonDecode(utf8.decode(bytes.sublist(1))));
  } on FormatException {
    throw const DeviceLinkException('The peer sent an invalid message.');
  }
}

Uint8List encodeDeviceLinkFrame(String peerId, Uint8List payload) {
  if (!_deviceIdPattern.hasMatch(peerId) ||
      payload.length < 17 ||
      payload.length > 65512) {
    throw const DeviceLinkException('Invalid device frame.');
  }
  return Uint8List.fromList([1, 22, ...ascii.encode(peerId), ...payload]);
}

({String peerId, Uint8List payload}) decodeDeviceLinkFrame(Uint8List bytes) {
  if (bytes.length < 41 ||
      bytes.length > 65536 ||
      bytes[0] != 1 ||
      bytes[1] != 22) {
    throw const DeviceLinkException('Invalid device frame.');
  }
  final peerId = ascii.decode(bytes.sublist(2, 24), allowInvalid: true);
  if (!_deviceIdPattern.hasMatch(peerId)) {
    throw const DeviceLinkException('Invalid peer identity.');
  }
  return (peerId: peerId, payload: Uint8List.sublistView(bytes, 24));
}
