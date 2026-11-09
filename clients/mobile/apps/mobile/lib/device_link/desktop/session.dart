import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import '../crypto/handshake.dart';
import '../crypto/identity.dart';
import '../crypto/secure_channel.dart';
import '../protocol.dart';
import 'message_codec.dart';
import 'relay.dart';
import 'relay_channel.dart';
import 'ipc.dart';
import 'request_queue.dart';
import 'version.dart';
import 'orchestrator_window.dart';

/// Initiator-only desktop session and RPC. No new host methods or adapter.
final class DesktopSession {
  DesktopSession(
    this._relay,
    this._identity,
    DesktopRelayPeer peer, {
    this.controllerKind,
    this.createPeriodicTimer = Timer.periodic,
  }) : peerId = peer.id,
       peerPublicKey = peer.publicKey,
       peerName = peer.name {
    _subscription = _relay.frames
        .asyncMap(_receive)
        .listen(
          (_) {},
          onError: (Object error) => _end(
            error is DeviceLinkException
                ? error.message
                : 'Unreadable message from the computer (${error.runtimeType}).',
          ),
          onDone: () => _end(_relay.closeReason ?? 'The relay channel ended.'),
        );
    _relaySubscription = _relay.closed.listen(
      (_) => _end(_relay.closeReason ?? 'The relay channel ended.'),
    );
  }
  final Timer Function(Duration, void Function(Timer)) createPeriodicTimer;
  final DesktopRelayTransport _relay;
  final DeviceLinkIdentity _identity;
  final String peerId;
  final String peerPublicKey;
  final String peerName;

  /// Display metadata only. The host must authorize the relay-bound kind.
  final String? controllerKind;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  StreamSubscription<void>? _subscription;
  StreamSubscription<void>? _relaySubscription;
  DesktopMessageAssembler _assembler = DesktopMessageAssembler();
  final _requests = <int, Completer<Object?>>{};
  final _requestQueue = DesktopRequestQueue();
  DeviceLinkHandshake? _handshake;
  Completer<DeviceLinkKeys>? _handshakeResult;
  DeviceLinkSecureChannel? _channel;
  Future<void> _writes = Future.value();
  final orchestratorWindow = DesktopOrchestratorWindow();
  int _nextId = 1;
  bool _ended = false;
  int? _protocolVersion;
  Timer? _keepalive;

  Stream<Map<String, dynamic>> get events => _events.stream;

  void _sendEnvelope(int type, Uint8List sessionId, List<int> body) {
    if (_ended) throw const DeviceLinkException('The connection ended.');
    _relay.send(Uint8List.fromList([type, ...sessionId, ...body]));
  }

  Future<DeviceLinkKeys> _establish(String purpose) async {
    if (_channel != null) {
      await _send({'kind': 'close', 'reason': 'new_session'});
    }
    _channel = null;
    _assembler = DesktopMessageAssembler();
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
        _end('The handshake could not be sent.');
      }
      return await response;
    } catch (_) {
      _end('The secure handshake did not finish.');
      throw const DeviceLinkException('The secure connection did not finish.');
    }
  }

  Future<void> _receive(dynamic data) async {
    if (_ended) return;
    final handshake = _handshake;
    if (handshake == null || data is! Uint8List || data.length < 17) return;
    final bytes = data;
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
        if (_ended) return;
        _channel = DeviceLinkSecureChannel(keys);
        _handshakeResult?.complete(keys);
        _handshakeResult = null;
        _keepalive = createPeriodicTimer(const Duration(seconds: 15), (_) {
          unawaited(
            _send({
              'kind': 'event',
              'name': 'rpc.keepalive',
              'payload': null,
            }).catchError((Object _) => _end('A keepalive could not be sent.')),
          );
        });
      case 0x20:
        final channel = _channel;
        if (channel == null) {
          throw const DeviceLinkException('No secure session.');
        }
        final decoded = _assembler.push(
          await channel.open(
            body,
            Uint8List.fromList([32, ...handshake.sessionId]),
          ),
        );
        if (decoded == null) return;
        final message = deviceLinkObject(decoded.value);
        if (message['kind'] == 'response' && message['id'] is int) {
          final pending = _requests.remove(message['id']);
          if (pending == null) return;
          if (message['ok'] == true) {
            pending.complete(message['value']);
          } else {
            pending.completeError(
              DesktopIpcRefusal(
                message['error'] is Map &&
                        (message['error'] as Map)['message'] is String
                    ? ((message['error'] as Map)['message'] as String)
                          .substring(
                            0,
                            ((message['error'] as Map)['message'] as String)
                                .length
                                .clamp(0, 4096),
                          )
                    : 'The desktop refused the request.',
                code: message['error'] is Map
                    ? (message['error'] as Map)['code'] as String?
                    : null,
              ),
            );
          }
        } else if (message['kind'] == 'event') {
          if (message['name'] == 'session.ended') {
            _end('The computer ended the session.');
            return;
          }
          if (message['name'] != 'rpc.keepalive') _events.add(message);
        } else if (message['kind'] == 'request') {
          final value = orchestratorWindow.handle(
            message['method'] is String ? message['method'] as String : '',
            message['params'],
          );
          await _send({
            'kind': 'response',
            'id': message['id'],
            'ok': value != null,
            'value': ?value,
            if (value == null)
              'error': {
                'message': 'This request is unavailable on mobile.',
                'code': 'remote_unknown_method',
              },
          });
        } else if (message['kind'] == 'close') {
          _end('The computer closed the session.');
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
      for (final fragment in encodeDesktopMessage(value)) {
        final sealed = await channel.seal(fragment, aad);
        _sendEnvelope(32, handshake.sessionId, sealed);
      }
    });
    _writes = operation.catchError((Object _) {});
    return operation;
  }

  Future<Object?> request(
    String method,
    Map<String, dynamic> params, {
    Duration timeout = const Duration(seconds: 15),
  }) => _requestQueue.run(() => _request(method, params, timeout));

  Future<Object?> _request(
    String method,
    Map<String, dynamic> params,
    Duration timeout,
  ) async {
    final id = _nextId++;
    final result = Completer<Object?>();
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

  Future<void> setOrchestratorVisible(bool visible) async {
    orchestratorWindow.visible = visible;
    if (_ended || _protocolVersion == null) return;
    await _send({
      'kind': 'event',
      'name': 'appAdvisor.windowState',
      'payload': orchestratorWindow.state,
    });
  }

  Future<void> pair(String name, void Function(String code) onCode) async {
    final keys = await _establish('pair');
    onCode(keys.code);
    final result = deviceLinkObject(
      await request('pair.request', {
        'name': name,
        'platform': 'darwin',
        'kind': ?controllerKind,
      }, timeout: const Duration(seconds: 125)),
    );
    if (result['approved'] != true) {
      throw const DeviceLinkException('Pairing was declined or expired.');
    }
  }

  Future<Map<String, dynamic>> openControl() async {
    await _establish('control');
    try {
      var hello = await _hello(minimumDesktopRemoteProtocolVersion);
      final version = readDesktopRemoteProtocolVersion(hello);
      // An unmatched hello identifies the host but grants no IPC access. Send
      // its advertised version back on the same authenticated, pinned session.
      if (version != minimumDesktopRemoteProtocolVersion) {
        hello = await _hello(version);
        _checkVersion(hello, version);
      }
      if (_ended) {
        throw const DeviceLinkException(
          'The connection to the computer ended.',
        );
      }
      _protocolVersion = version;
      return hello;
    } catch (_) {
      _end('The control session could not open.');
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _hello(int version) async => deviceLinkObject(
    await request('session.hello', {
      'version': {'protocolVersion': version, 'appVersion': 'mobile-prototype'},
    }),
  );

  void _checkVersion(Map<String, dynamic> hello, int expected) {
    if (readDesktopRemoteProtocolVersion(hello) != expected) {
      throw const DeviceLinkException(
        'The computer connection version changed. Reconnect to try again.',
      );
    }
  }

  Future<Map<String, dynamic>> readHostInfo() async {
    final version = _protocolVersion;
    if (_ended || version == null) {
      throw const DeviceLinkException('Connect to a computer first.');
    }
    try {
      final hello = await _hello(version);
      _checkVersion(hello, version);
      return hello;
    } catch (_) {
      _end('Host information could not be refreshed.');
      rethrow;
    }
  }

  void _end(String reason) {
    if (_ended) return;
    _ended = true;
    _protocolVersion = null;
    _keepalive?.cancel();
    const error = DeviceLinkException('The connection to the computer ended.');
    _requestQueue.close(
      const DesktopIpcNotSent('The connection to the computer ended.'),
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
    _events.add({'kind': 'closed', 'reason': reason});
    unawaited(_events.close());
  }

  Future<void> close() async {
    if (!_ended && _channel != null) {
      try {
        await _send({'kind': 'close', 'reason': 'closed'});
      } catch (_) {}
    }
    _end('Closed by this device.');
    await _subscription?.cancel();
    await _relaySubscription?.cancel();
  }
}
