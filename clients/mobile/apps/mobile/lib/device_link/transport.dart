import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'crypto/handshake.dart';
import 'crypto/identity.dart';
import 'crypto/secure_channel.dart';
import 'protocol.dart';

typedef DeviceLinkConnector =
    Future<DeviceLinkTransport> Function(
      DeviceLinkInvitation invitation,
      DeviceLinkIdentity identity,
    );

abstract interface class DeviceLinkTransport {
  String get peerId;
  String get peerPublicKey;
  String get peerName;
  Stream<Map<String, dynamic>> get events;
  Future<void> pair(void Function(String code) onCode);
  Future<void> openControl();
  Future<String> echo(String text);
  Future<void> close();
}

/// Independent IO transport. Nothing here knows about Portal sessions,
/// cursors, commands, auth tokens or models.
final class IoDeviceLinkTransport implements DeviceLinkTransport {
  IoDeviceLinkTransport._(
    this._socket,
    this._identity,
    this.peerId,
    this.peerPublicKey,
    this.peerName, {
    required this.createPeriodicTimer,
  }) {
    _subscription = _socket
        .asyncMap(_receive)
        .listen((_) {}, onError: (Object _) => _end(), onDone: _end);
  }

  static Future<DeviceLinkTransport> connect(
    DeviceLinkInvitation invitation,
    DeviceLinkIdentity identity, {
    Timer Function(Duration, void Function(Timer)) createPeriodicTimer =
        Timer.periodic,
  }) async {
    final client = http.Client();
    try {
      final request = http.Request('GET', invitation.endpoint('/bootstrap'))
        ..followRedirects = false
        ..headers['Authorization'] = 'Bearer ${invitation.capability}';
      final response = await client
          .send(request)
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) {
        throw const DeviceLinkException(
          'The invitation expired or the desktop peer is unavailable.',
        );
      }
      final body = BytesBuilder();
      await for (final chunk in response.stream.timeout(
        const Duration(seconds: 10),
      )) {
        if (body.length + chunk.length > 4096) {
          throw const DeviceLinkException('Invalid desktop identity.');
        }
        body.add(chunk);
      }
      final bootstrap = deviceLinkObject(
        jsonDecode(utf8.decode(body.takeBytes())),
      );
      if (bootstrap['protocol'] != deviceLinkProtocol) {
        throw const DeviceLinkException(
          'The desktop peer uses a different prototype version.',
        );
      }
      final id = deviceLinkString(bootstrap, 'deviceId');
      final publicKey = deviceLinkString(bootstrap, 'publicKey');
      if (await linkDeviceId(publicKey) != id) {
        throw const DeviceLinkException('Invalid desktop identity.');
      }
      final uri = invitation
          .endpoint('/connect')
          .replace(scheme: invitation.baseUri.scheme == 'https' ? 'wss' : 'ws');
      final opening = WebSocket.connect(
        uri.toString(),
        protocols: [
          deviceLinkSubprotocol,
          'canopy-device-link-token.${invitation.capability}',
        ],
        headers: {'x-canopy-device-id': identity.deviceId},
        compression: CompressionOptions.compressionOff,
      );
      WebSocket socket;
      try {
        socket = await opening.timeout(const Duration(seconds: 10));
      } on TimeoutException {
        // Future.timeout cannot cancel a late WebSocket upgrade.
        unawaited(
          opening
              .then((lateSocket) => lateSocket.close())
              .catchError((Object _) {}),
        );
        rethrow;
      }
      if (socket.protocol != deviceLinkSubprotocol) {
        await socket.close();
        throw const DeviceLinkException(
          'The desktop peer uses an unsupported connection protocol.',
        );
      }
      socket.pingInterval = const Duration(seconds: 15);
      return IoDeviceLinkTransport._(
        socket,
        identity,
        id,
        publicKey,
        deviceLinkString(bootstrap, 'name'),
        createPeriodicTimer: createPeriodicTimer,
      );
    } on DeviceLinkException {
      rethrow;
    } catch (_) {
      throw const DeviceLinkException(
        'Could not reach the desktop peer. Check the invitation and try again.',
      );
    } finally {
      client.close();
    }
  }

  final Timer Function(Duration, void Function(Timer)) createPeriodicTimer;
  final WebSocket _socket;
  final DeviceLinkIdentity _identity;
  @override
  final String peerId;
  @override
  final String peerPublicKey;
  @override
  final String peerName;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  StreamSubscription<void>? _subscription;
  final _requests = <int, Completer<Map<String, dynamic>>>{};
  DeviceLinkHandshake? _handshake;
  Completer<DeviceLinkKeys>? _handshakeResult;
  DeviceLinkSecureChannel? _channel;
  Future<void> _writes = Future.value();
  int _nextId = 1;
  bool _ended = false;
  Timer? _keepalive;

  @override
  Stream<Map<String, dynamic>> get events => _events.stream;

  void _sendEnvelope(int type, Uint8List sessionId, List<int> body) {
    if (_ended) throw const DeviceLinkException('The connection ended.');
    _socket.add(
      encodeDeviceLinkFrame(
        peerId,
        Uint8List.fromList([type, ...sessionId, ...body]),
      ),
    );
  }

  Future<DeviceLinkKeys> _establish(String purpose) async {
    if (_channel != null) {
      await _send({'kind': 'close', 'reason': 'new_session'});
    }
    _channel = null;
    _keepalive?.cancel();
    final handshake = await DeviceLinkHandshake.create(
      identity: _identity,
      peerId: peerId,
      pinnedPublicKey: peerPublicKey,
      purpose: purpose,
    );
    if (_ended) throw const DeviceLinkException('The connection ended.');
    _handshake = handshake;
    final result = Completer<DeviceLinkKeys>();
    _handshakeResult = result;
    final response = result.future.timeout(const Duration(seconds: 15));
    try {
      try {
        _sendEnvelope(
          0x10,
          handshake.sessionId,
          utf8.encode(jsonEncode(handshake.start())),
        );
      } catch (_) {
        _end();
      }
      return await response;
    } catch (_) {
      _end();
      throw const DeviceLinkException('The secure connection did not finish.');
    }
  }

  Future<void> _receive(dynamic data) async {
    if (_ended) return;
    if (data is! List<int> || data.length > 65536) {
      throw const DeviceLinkException('Invalid frame.');
    }
    final frame = decodeDeviceLinkFrame(Uint8List.fromList(data));
    final handshake = _handshake;
    if (frame.peerId != peerId || handshake == null) {
      throw const DeviceLinkException('Unexpected peer.');
    }
    final bytes = frame.payload;
    if (linkBase64(bytes.sublist(1, 17)) != linkBase64(handshake.sessionId)) {
      // A response to the just-closed pairing session can still be in flight.
      return;
    }
    final body = Uint8List.sublistView(bytes, 17);
    switch (bytes.first) {
      case 0x11:
        final hello3 = await handshake.receiveHello2(
          deviceLinkObject(jsonDecode(utf8.decode(body))),
        );
        _sendEnvelope(
          0x12,
          handshake.sessionId,
          utf8.encode(jsonEncode(hello3)),
        );
      case 0x13:
        final keys = await handshake.receiveHello4(
          deviceLinkObject(jsonDecode(utf8.decode(body))),
        );
        _channel = DeviceLinkSecureChannel(keys);
        _handshakeResult?.complete(keys);
        _handshakeResult = null;
        _keepalive = createPeriodicTimer(const Duration(seconds: 15), (_) {
          unawaited(
            _send({
              'kind': 'event',
              'name': 'rpc.keepalive',
              'payload': null,
            }).catchError((Object _) => _end()),
          );
        });
      case 0x20:
        final channel = _channel;
        if (channel == null) {
          throw const DeviceLinkException('No secure session.');
        }
        final message = decodeDeviceLinkMessage(
          await channel.open(
            body,
            Uint8List.fromList([32, ...handshake.sessionId]),
          ),
        );
        if (message['kind'] == 'response' && message['id'] is int) {
          final pending = _requests.remove(message['id']);
          if (pending == null) return;
          if (message['ok'] == true) {
            pending.complete(deviceLinkObject(message['value']));
          } else {
            pending.completeError(
              const DeviceLinkException(
                'The desktop peer refused the request.',
              ),
            );
          }
        } else if (message['kind'] == 'event') {
          if (message['name'] != 'rpc.keepalive') _events.add(message);
        } else if (message['kind'] == 'close') {
          _end();
        } else {
          throw const DeviceLinkException('Unsupported peer message.');
        }
      default:
        throw const DeviceLinkException('The secure connection ended.');
    }
  }

  Future<void> _send(Map<String, dynamic> value) {
    // Async encryption must preserve wire order and nonce order, even when
    // a keepalive races an application request.
    final operation = _writes.then((_) async {
      final channel = _channel;
      final handshake = _handshake;
      if (_ended || channel == null || handshake == null) {
        throw const DeviceLinkException('The connection ended.');
      }
      final aad = Uint8List.fromList([32, ...handshake.sessionId]);
      final sealed = await channel.seal(encodeDeviceLinkMessage(value), aad);
      _sendEnvelope(32, handshake.sessionId, sealed);
    });
    _writes = operation.catchError((Object _) {});
    return operation;
  }

  Future<Map<String, dynamic>> _request(
    String method,
    Map<String, dynamic> params, {
    Duration timeout = const Duration(seconds: 15),
  }) async {
    if (_requests.length >= 8) {
      throw const DeviceLinkException('Too many requests are waiting.');
    }
    final id = _nextId++;
    final result = Completer<Map<String, dynamic>>();
    _requests[id] = result;
    // Attach the completion/error handler before a concurrent disconnect can
    // reject a request during encryption.
    final response = result.future.timeout(timeout);
    unawaited(
      _send({
        'kind': 'request',
        'id': id,
        'method': method,
        'params': params,
      }).catchError((Object _) {
        if (_requests.remove(id) != null) {
          result.completeError(
            const DeviceLinkException('The request could not be sent.'),
          );
        }
      }),
    );
    try {
      return await response;
    } on TimeoutException {
      throw const DeviceLinkException(
        'The desktop peer did not answer. Reconnect to try again.',
      );
    } finally {
      _requests.remove(id);
    }
  }

  @override
  Future<void> pair(void Function(String code) onCode) async {
    final keys = await _establish('pair');
    onCode(keys.code);
    final result = await _request('pair.request', {
      'protocol': deviceLinkProtocol,
    }, timeout: const Duration(seconds: 125));
    if (result['protocol'] != deviceLinkProtocol ||
        result['approved'] != true) {
      throw const DeviceLinkException('Pairing was declined or expired.');
    }
  }

  @override
  Future<void> openControl() async {
    await _establish('control');
    final hello = await _request('session.hello', {
      'protocol': deviceLinkProtocol,
    });
    if (hello['protocol'] != deviceLinkProtocol ||
        hello['capabilities'] is! List ||
        !(hello['capabilities'] as List).contains('echo')) {
      throw const DeviceLinkException(
        'The desktop peer does not support this prototype.',
      );
    }
  }

  @override
  Future<String> echo(String text) async {
    if (utf8.encode(text).length > 8192) {
      throw const DeviceLinkException('Use a shorter test message.');
    }
    return deviceLinkString(
      await _request('connection.echo', {'text': text}),
      'text',
    );
  }

  void _end() {
    if (_ended) return;
    _ended = true;
    _keepalive?.cancel();
    final error = const DeviceLinkException(
      'The connection ended. Reconnect when the desktop peer is available.',
    );
    final handshake = _handshakeResult;
    _handshakeResult = null;
    if (handshake != null && !handshake.isCompleted) {
      handshake.completeError(error);
    }
    for (final request in _requests.values) {
      request.completeError(error);
    }
    _requests.clear();
    _events.add({'kind': 'closed'});
    unawaited(_events.close());
    unawaited(_socket.close());
  }

  @override
  Future<void> close() async {
    _end();
    await _subscription?.cancel();
  }
}
