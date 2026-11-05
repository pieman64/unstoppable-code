import 'dart:async';
import '../crypto/identity.dart';
import '../protocol.dart';
import '../store.dart';
import 'relay.dart';
import 'session.dart';
import 'ipc.dart';
import 'hub.dart';
import 'relay_channel.dart';

/// Connection I/O used by the mobile connection model.
abstract interface class DesktopLinkConnection implements DesktopIpc {
  DesktopLinkHub get hub;
  Future<DeviceLinkIdentity> identity();
  Future<Map<String, dynamic>> connect({
    required String peerDeviceId,
    required DesktopTokenProvider fetchToken,
    required void Function(String) onCode,
    bool allowPairing = true,
  });
  Future<Map<String, dynamic>> readHostInfo();
  Future<void> disconnect();
  Future<void> forget();
  Future<void> dispose();
}

/// Identity, pins and session lifetime for the existing desktop protocol.
/// API credentials remain in the caller's memory; only identity/pins persist.
final class DesktopLinkRepository implements DesktopLinkConnection {
  DesktopLinkRepository({
    required DeviceLinkStore store,
    required String deviceName,
    this.createPeriodicTimer = Timer.periodic,
  }) : hub = DesktopLinkHub(store: store, deviceName: deviceName),
       _ownsHub = true;
  DesktopLinkRepository.shared(
    this.hub, {
    this.createPeriodicTimer = Timer.periodic,
  }) : _ownsHub = false;
  final Timer Function(Duration, void Function(Timer)) createPeriodicTimer;
  @override
  final DesktopLinkHub hub;
  final bool _ownsHub;
  DeviceLinkStore get store => hub.store;
  DesktopRelayChannel? _channel;
  DesktopSession? _session;
  String? _peerId;
  StreamSubscription<Map<String, dynamic>>? _subscription;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  @override
  Stream<Map<String, dynamic>> get events => _events.stream;
  int _generation = 0;
  bool _disposed = false;
  @override
  Future<DeviceLinkIdentity> identity() => hub.identity();

  @override
  Future<Map<String, dynamic>> connect({
    required String peerDeviceId,
    required DesktopTokenProvider fetchToken,
    required void Function(String) onCode,
    bool allowPairing = true,
  }) async {
    await disconnect();
    final generation = _generation;
    final ownIdentity = await identity();
    if (_disposed || generation != _generation) {
      throw const DeviceLinkException('Connection cancelled.');
    }
    final relay = await hub.relay(fetchToken);
    if (_disposed || generation != _generation) {
      throw const DeviceLinkException('Connection cancelled.');
    }
    _peerId = peerDeviceId;
    try {
      final peer = relay.peers[peerDeviceId];
      if (peer == null || !peer.acceptsControl) {
        throw const DeviceLinkException(
          'This computer is offline or remote access is turned off.',
        );
      }
      final pin = hub.pinnedKey(peer.id);
      if (pin == null && !allowPairing) {
        throw const DeviceLinkException('Pair this computer again to connect.');
      }
      if (pin != null && pin != peer.publicKey) {
        throw const DeviceLinkException('The computer identity changed.');
      }
      final channel = relay.channelFor(peer.id);
      _channel = channel;
      final session = DesktopSession(
        channel,
        ownIdentity,
        peer,
        createPeriodicTimer: createPeriodicTimer,
      );
      _session = session;
      _subscription = session.events.listen((event) {
        if (!_disposed && generation == _generation) _events.add(event);
      });
      if (pin == null) {
        await session.pair(hub.deviceName, (code) {
          if (!_disposed && generation == _generation) onCode(code);
        });
        if (_disposed || generation != _generation) {
          throw const DeviceLinkException('Connection cancelled.');
        }
        await hub.remember(peer.id, peer.publicKey);
        if (_disposed || generation != _generation) {
          throw const DeviceLinkException('Connection cancelled.');
        }
      }
      return await session.openControl();
    } catch (_) {
      if (generation == _generation) await disconnect();
      rethrow;
    }
  }

  /// Re-reads hello using this peer session's negotiated contract.
  @override
  Future<Map<String, dynamic>> readHostInfo() async {
    final session = _session;
    if (session == null) {
      throw const DeviceLinkException('Connect to a computer first.');
    }
    return session.readHostInfo();
  }

  @override
  Future<Object?> invoke(
    String channel, [
    List<Object?> args = const [],
    Duration? timeout,
  ]) async {
    final session = _session;
    if (session == null) {
      throw const DeviceLinkException('Connect to a computer first.');
    }
    final params = {'channel': channel, 'args': args, 'surface': 'main'};
    return timeout == null
        ? session.request('ipc.invoke', params)
        : session.request('ipc.invoke', params, timeout: timeout);
  }

  @override
  Future<void> forget() async {
    await disconnect();
    final peerId = _peerId;
    if (peerId != null) await hub.forget(peerId);
  }

  @override
  Future<void> disconnect() async {
    _generation++;
    final session = _session;
    final channel = _channel;
    final subscription = _subscription;
    _session = null;
    _channel = null;
    _subscription = null;
    await subscription?.cancel();
    await session?.close();
    await channel?.close();
    if (_ownsHub) await hub.disconnect();
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    await disconnect();
    await _events.close();
    if (_ownsHub) await hub.dispose();
  }
}
