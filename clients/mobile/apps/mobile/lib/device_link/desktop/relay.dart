import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import '../crypto/identity.dart';
import '../protocol.dart';
import 'relay_channel.dart';

/// Developer-only credential input. Kept in memory, never saved with pins.
/// Accepts an existing personal desktop API credential, not Portal auth.
final class DesktopRelayCredentials {
  DesktopRelayCredentials({
    required this.apiUrl,
    required this.apiKey,
    required this.peerDeviceId,
  });
  factory DesktopRelayCredentials.parse(String input) {
    try {
      final json = deviceLinkObject(jsonDecode(input));
      final uri = Uri.parse(deviceLinkString(json, 'apiUrl'));
      if (!uri.hasAuthority ||
          uri.userInfo.isNotEmpty ||
          uri.hasQuery ||
          uri.hasFragment ||
          (uri.path.isNotEmpty && uri.path != '/') ||
          !_secure(uri, 'https')) {
        throw const FormatException();
      }
      final peer = deviceLinkString(json, 'peerDeviceId');
      if (!RegExp(r'^[A-Za-z0-9_-]{22}$').hasMatch(peer)) {
        throw const FormatException();
      }
      return DesktopRelayCredentials(
        apiUrl: uri,
        apiKey: deviceLinkString(json, 'apiKey'),
        peerDeviceId: peer,
      );
    } catch (_) {
      throw const DeviceLinkException(
        'Paste the developer relay credentials with an HTTPS API URL and computer ID.',
      );
    }
  }
  final Uri apiUrl;
  final String apiKey;
  final String peerDeviceId;
  @override
  String toString() => 'DesktopRelayCredentials(${apiUrl.origin}, redacted)';
}

bool _secure(Uri uri, String secureScheme) =>
    uri.scheme == secureScheme ||
    ((uri.scheme == 'http' || uri.scheme == 'ws') &&
        ['127.0.0.1', 'localhost', '::1'].contains(uri.host));

final class DesktopRelayToken {
  DesktopRelayToken({required this.token, required this.relayUrl, this.kind});
  final String token;
  final Uri relayUrl;

  /// The relay device kind the token is bound to. Null is the legacy desktop
  /// profile used by developer API credentials; the relay rejects a hello
  /// whose kind does not match the token.
  final String? kind;
  @override
  String toString() => 'DesktopRelayToken(redacted)';
}

typedef DesktopTokenProvider =
    Future<DesktopRelayToken> Function(String deviceId);

final class DesktopRelayAccessException extends DeviceLinkException {
  const DesktopRelayAccessException(this.statusCode, {this.code})
    : super(
        'Connection access is unavailable. Try again or check your account.',
      );
  final int statusCode;

  /// The token route's machine-readable reason, when it sent one.
  final String? code;

  /// Only this code means the plan lacks Remote Control. Expired sign-in,
  /// disabled features and origin or configuration errors are not upgrades.
  bool get entitlementDenied => code == 'entitlement_denied';
}

/// Account-scoped token for this phone, authorized by the app's sign-in
/// session. The relay binds it to the `mobile` kind.
Future<DesktopRelayToken> fetchMobileRelayToken({
  required Uri origin,
  required String sessionToken,
  required String? twoFactorProof,
  required String deviceId,
}) => _fetchRelayToken(
  origin,
  {
    'Authorization': 'Bearer $sessionToken',
    if (twoFactorProof != null && twoFactorProof.isNotEmpty)
      'x-two-factor-verified': twoFactorProof,
  },
  deviceId,
  kind: 'mobile',
);

Future<DesktopRelayToken> fetchDesktopRelayToken(
  DesktopRelayCredentials credentials,
  String deviceId,
) => _fetchRelayToken(credentials.apiUrl, {
  'Authorization': 'Bearer ${credentials.apiKey}',
}, deviceId);

Future<List<int>> _readBounded(http.StreamedResponse response) async {
  final data = BytesBuilder();
  await for (final chunk in response.stream.timeout(
    const Duration(seconds: 15),
  )) {
    if (data.length + chunk.length > 16384) throw const FormatException();
    data.add(chunk);
  }
  return data.takeBytes();
}

/// The route's `code`, or null when the error body is missing or malformed.
Future<String?> _errorCode(http.StreamedResponse response) async {
  try {
    final json = jsonDecode(utf8.decode(await _readBounded(response)));
    final code = json is Map ? json['code'] : null;
    return code is String && RegExp(r'^[a-z_]{1,64}$').hasMatch(code)
        ? code
        : null;
  } catch (_) {
    return null;
  }
}

Future<DesktopRelayToken> _fetchRelayToken(
  Uri apiUrl,
  Map<String, String> authorization,
  String deviceId, {
  String? kind,
}) async {
  if (!apiUrl.hasAuthority ||
      apiUrl.userInfo.isNotEmpty ||
      apiUrl.hasQuery ||
      apiUrl.hasFragment ||
      !_secure(apiUrl, 'https')) {
    throw const DeviceLinkException('Invalid API URL.');
  }
  final client = http.Client();
  try {
    final request =
        http.Request('POST', apiUrl.resolve('/api/v1/device-relay/token'))
          ..followRedirects = false
          ..headers.addAll({
            ...authorization,
            'Content-Type': 'application/json',
          })
          ..body = jsonEncode({'deviceId': deviceId, 'kind': ?kind});
    final response = await client
        .send(request)
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) {
      if ([401, 403, 404].contains(response.statusCode)) {
        throw DesktopRelayAccessException(
          response.statusCode,
          code: await _errorCode(response),
        );
      }
      throw DeviceLinkException(
        kind == null
            ? 'Relay authentication failed (${response.statusCode}). Use a personal desktop API credential with remote access enabled.'
            : 'Computer connection is temporarily unavailable (${response.statusCode}). Try again.',
      );
    }
    final json = deviceLinkObject(
      jsonDecode(utf8.decode(await _readBounded(response))),
    );
    final uri = Uri.parse(deviceLinkString(json, 'relayUrl'));
    if (!uri.hasAuthority ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        !_secure(uri, 'wss')) {
      throw const FormatException();
    }
    return DesktopRelayToken(
      token: deviceLinkString(json, 'token'),
      relayUrl: uri,
      kind: kind,
    );
  } on DeviceLinkException {
    rethrow;
  } catch (_) {
    throw const DeviceLinkException(
      'Could not authenticate with the device relay.',
    );
  } finally {
    client.close();
  }
}

final class DesktopRelayPeer {
  DesktopRelayPeer._(this.id, this.publicKey, this.name, this.acceptsControl);

  /// Phones, browsers and hosted agents share the account's relay. Only
  /// desktops (an absent kind is a legacy desktop) can be controlled.
  static bool isComputer(Object? value) {
    final kind = value is Map ? value['kind'] : null;
    return kind == null || kind == 'desktop';
  }

  static Future<DesktopRelayPeer> parse(Object? value) async {
    final json = deviceLinkObject(value);
    final id = deviceLinkString(json, 'deviceId');
    final key = deviceLinkString(json, 'publicKey');
    if (await linkDeviceId(key) != id ||
        !['darwin', 'win32', 'linux'].contains(json['platform']) ||
        json['acceptsRemoteControl'] is! bool) {
      throw const FormatException('Invalid relay peer.');
    }
    return DesktopRelayPeer._(
      id,
      key,
      deviceLinkString(json, 'name'),
      json['acceptsRemoteControl'] == true,
    );
  }

  final String id, publicKey, name;
  final bool acceptsControl;
}

/// One account-scoped outbound socket using the unchanged relay v2 contract.
/// Sessions end on socket loss; reconnect always mints a fresh token.
final class DesktopRelay implements DesktopRelayTransport {
  DesktopRelay._(
    this._socket,
    this.identity,
    this.targetId, {
    required this.kind,
    required this.now,
    required this.createPeriodicTimer,
  }) {
    _lastInbound = now();
    _subscription = _socket
        .asyncMap(_receive)
        .listen(
          (_) {},
          onError: (Object error) => close(
            error is DeviceLinkException
                ? error.message
                : 'Relay stream failed (${error.runtimeType}).',
          ),
          onDone: () => close(
            'Relay closed the socket (code ${_socket.closeCode}'
            '${_socket.closeReason?.isNotEmpty == true ? ', ${_socket.closeReason}' : ''}).',
          ),
        );
  }
  static Future<DesktopRelay> connect({
    required DeviceLinkIdentity identity,
    required String deviceName,
    required String targetId,
    required DesktopTokenProvider fetchToken,
    DateTime Function() now = DateTime.now,
    Timer Function(Duration, void Function(Timer)) createPeriodicTimer =
        Timer.periodic,
  }) async {
    final token = await fetchToken(identity.deviceId);
    if (!_secure(token.relayUrl, 'wss') ||
        token.relayUrl.userInfo.isNotEmpty ||
        token.relayUrl.hasQuery ||
        token.relayUrl.hasFragment) {
      throw const DeviceLinkException('Invalid relay URL.');
    }
    final opening = WebSocket.connect(
      token.relayUrl.replace(path: '/v2/connect').toString(),
      protocols: [
        'canopy-device-relay.v2',
        'canopy-relay-token.${token.token}',
      ],
      compression: CompressionOptions.compressionOff,
    );
    WebSocket socket;
    try {
      socket = await opening.timeout(const Duration(seconds: 15));
    } catch (_) {
      unawaited(opening.then((s) => s.close()).catchError((Object _) {}));
      throw const DeviceLinkException('Could not open the device relay.');
    }
    if (socket.protocol != 'canopy-device-relay.v2') {
      await socket.close();
      throw const DeviceLinkException('Unsupported relay protocol.');
    }
    final relay = DesktopRelay._(
      socket,
      identity,
      targetId,
      kind: token.kind,
      now: now,
      createPeriodicTimer: createPeriodicTimer,
    );
    final ready = relay._ready.future.timeout(const Duration(seconds: 15));
    socket.add(
      jsonEncode({
        'type': 'hello',
        'device': {
          'deviceId': identity.deviceId,
          'publicKey': identity.publicKey,
          'name': deviceName,
          'platform': Platform.isIOS || Platform.isMacOS ? 'darwin' : 'linux',
          'kind': ?token.kind,
          'appVersion': 'mobile-prototype',
          'acceptsRemoteControl': false,
        },
      }),
    );
    try {
      await ready;
      return relay;
    } catch (_) {
      await relay.close();
      rethrow;
    }
  }

  /// Static message: the relay does not authenticate device kinds yet.
  static const outdatedRelay =
      'The connection service is out of date. Try again later.';
  final String? kind;
  final DateTime Function() now;
  final Timer Function(Duration, void Function(Timer)) createPeriodicTimer;
  final WebSocket _socket;
  final DeviceLinkIdentity identity;
  final String targetId;
  final peers = <String, DesktopRelayPeer>{};
  final _peerChanges = StreamController<void>.broadcast();
  Stream<void> get peerChanges => _peerChanges.stream;
  final _ready = Completer<void>();
  final _frames = StreamController<Uint8List>.broadcast();
  final _closed = StreamController<void>.broadcast();
  final _channels = <String, DesktopRelayChannel>{};
  DesktopRelayChannel channelFor(String peerId) {
    if (_ended) throw const DeviceLinkException('The relay disconnected.');
    if (_channels.containsKey(peerId)) {
      throw const DeviceLinkException('This computer already has a session.');
    }
    late final DesktopRelayChannel channel;
    channel = DesktopRelayChannel(
      sendFrame: (payload) {
        if (_ended) throw const DeviceLinkException('The relay disconnected.');
        _socket.add(encodeDeviceLinkFrame(peerId, payload));
      },
      onClose: () {
        if (identical(_channels[peerId], channel)) _channels.remove(peerId);
      },
    );
    _channels[peerId] = channel;
    return channel;
  }

  @override
  Stream<Uint8List> get frames => _frames.stream;
  @override
  Stream<void> get closed => _closed.stream;
  StreamSubscription<void>? _subscription;
  Timer? _ping;
  bool _ended = false;
  bool get isClosed => _ended;

  /// Why the socket ended, for diagnostics. Never carries tokens or payloads.
  @override
  String? closeReason;
  late DateTime _lastInbound;
  int? _probeSentAt;
  Completer<void>? _probeAnswered;

  /// Checks the socket still reaches the relay, for example after the app was
  /// in the background. Closes the relay when no matching pong arrives.
  Future<bool> probe({Duration timeout = const Duration(seconds: 3)}) async {
    if (_ended) return false;
    final answered = _probeAnswered ??= Completer<void>();
    final sentAt = _probeSentAt ??= now().millisecondsSinceEpoch;
    _socket.add(jsonEncode({'type': 'ping', 'sentAt': sentAt}));
    try {
      await answered.future.timeout(timeout);
      return !_ended;
    } on TimeoutException {
      await close('The relay did not answer a liveness check.');
      return false;
    }
  }

  Future<void> _receive(dynamic data) async {
    if (_ended) return;
    _lastInbound = now();
    if (data is String) {
      if (data.length > 128 * 1024) throw const FormatException();
      final json = deviceLinkObject(jsonDecode(data));
      switch (json['type']) {
        case 'ready':
          if (_ready.isCompleted ||
              json['deviceId'] != identity.deviceId ||
              json['peers'] is! List) {
            throw const FormatException();
          }
          final features = json['features'];
          // A relay that does not authenticate kinds would ignore ours, so a
          // kind-bound token never connects through it.
          if (kind != null &&
              !(features is List && features.contains('device-kind'))) {
            _ready.completeError(const DeviceLinkException(outdatedRelay));
            await close(outdatedRelay);
            return;
          }
          for (final peer in json['peers'] as List) {
            if (!DesktopRelayPeer.isComputer(peer)) continue;
            final parsed = await DesktopRelayPeer.parse(peer);
            peers[parsed.id] = parsed;
          }
          _ready.complete();
          _ping = createPeriodicTimer(const Duration(seconds: 10), (_) {
            if (now().difference(_lastInbound) > const Duration(seconds: 30)) {
              unawaited(close('No relay traffic for 30 seconds.'));
            } else {
              _socket.add(
                jsonEncode({
                  'type': 'ping',
                  'sentAt': now().millisecondsSinceEpoch,
                }),
              );
            }
          });
        case 'peer.online':
          if (!DesktopRelayPeer.isComputer(json['peer'])) return;
          final peer = await DesktopRelayPeer.parse(json['peer']);
          peers[peer.id] = peer;
          _peerChanges.add(null);
        case 'peer.offline':
          peers.remove(json['deviceId']);
          _peerChanges.add(null);
          const offline = 'The computer went offline.';
          await _channels[json['deviceId']]?.close(offline);
          if (json['deviceId'] == targetId) await close(offline);
        case 'undeliverable':
          const unreachable = 'The relay could not reach the computer.';
          await _channels[json['deviceId']]?.close(unreachable);
          if (json['deviceId'] == targetId) await close(unreachable);
        case 'error':
          throw const DeviceLinkException('The relay refused this connection.');
        case 'pong':
          if (json['sentAt'] case final sentAt? when sentAt == _probeSentAt) {
            _probeSentAt = null;
            _probeAnswered?.complete();
            _probeAnswered = null;
          }
        default:
          throw const FormatException();
      }
      return;
    }
    if (!_ready.isCompleted || data is! List<int> || data.length > 65536) {
      throw const FormatException();
    }
    final frame = decodeDeviceLinkFrame(Uint8List.fromList(data));
    _channels[frame.peerId]?.receive(frame.payload);
    if (frame.peerId == targetId) _frames.add(frame.payload);
  }

  @override
  void send(Uint8List payload) {
    if (_ended) throw const DeviceLinkException('The relay disconnected.');
    _socket.add(encodeDeviceLinkFrame(targetId, payload));
  }

  Future<void> close([String reason = 'Closed by this device.']) async {
    if (_ended) return;
    _ended = true;
    closeReason = reason;
    for (final channel in _channels.values.toList()) {
      await channel.close(reason);
    }
    _ping?.cancel();
    _probeAnswered?.complete();
    _probeAnswered = null;
    if (!_ready.isCompleted) {
      _ready.completeError(
        const DeviceLinkException('The relay closed before registration.'),
      );
    }
    _closed.add(null);
    unawaited(_peerChanges.close());
    unawaited(_closed.close());
    unawaited(_frames.close());
    unawaited(_subscription?.cancel());
    await _socket.close();
  }
}
