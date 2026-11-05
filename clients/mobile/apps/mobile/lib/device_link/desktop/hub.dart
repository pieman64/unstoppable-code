import 'dart:async';
import 'dart:convert';
import '../crypto/identity.dart';
import '../protocol.dart';
import '../store.dart';
import 'relay.dart';

/// Account connection resources. Peer sessions never own this socket or store.
/// The composition root creates one hub per authenticated account/environment.
final class DesktopLinkHub {
  DesktopLinkHub({required this.store, required this.deviceName});
  final DeviceLinkStore store;

  /// How paired computers name this phone, in pairing and the relay presence.
  final String deviceName;
  Future<DeviceLinkIdentity>? _loading;
  final _pins = <String, String>{};
  Future<void> _writes = Future.value();
  DesktopRelay? _relay;
  Future<DesktopRelay>? _opening;
  int _generation = 0;
  bool _disposed = false;

  Future<DeviceLinkIdentity> identity() {
    if (_loading case final current?) return current;
    late final Future<DeviceLinkIdentity> pending;
    pending = _load().then(
      (identity) => identity,
      onError: (Object error, StackTrace stack) {
        if (identical(_loading, pending)) _loading = null;
        Error.throwWithStackTrace(error, stack);
      },
    );
    return _loading = pending;
  }

  Future<DeviceLinkIdentity> _load() async {
    final saved = await store.read();
    if (saved != null) {
      try {
        final record = deviceLinkObject(jsonDecode(saved));
        if (record['version'] != 1) throw const FormatException();
        final identity = await DeviceLinkIdentity.fromSeed(
          linkBytes(deviceLinkString(record, 'seed'), 32),
        );
        final next = <String, String>{};
        for (final entry in deviceLinkObject(record['pins']).entries) {
          if (entry.value is! String ||
              await linkDeviceId(entry.value) != entry.key) {
            throw const FormatException();
          }
          next[entry.key] = entry.value;
        }
        _pins.addAll(next);
        return identity;
      } catch (_) {
        throw const DeviceLinkException(
          'The saved device identity could not be read. It was preserved.',
        );
      }
    }
    final identity = await DeviceLinkIdentity.fromSeed(linkRandomBytes(32));
    await _save(identity, {});
    return identity;
  }

  Future<void> _save(
    DeviceLinkIdentity identity,
    Map<String, String> pins,
  ) async => store.write(
    jsonEncode({
      'version': 1,
      'seed': linkBase64(await identity.keyPair.extractPrivateKeyBytes()),
      'pins': pins,
    }),
  );

  String? pinnedKey(String peerId) => _pins[peerId];
  Future<void> remember(String peerId, String publicKey) => _mutatePins((pins) {
    if (pins[peerId] != null && pins[peerId] != publicKey) {
      throw const DeviceLinkException('The computer identity changed.');
    }
    pins[peerId] = publicKey;
  });
  Future<void> forget(String peerId) =>
      _mutatePins((pins) => pins.remove(peerId));
  Future<void> _mutatePins(void Function(Map<String, String>) change) {
    final operation = _writes.then((_) async {
      final own = await identity();
      final next = {..._pins};
      change(next);
      await _save(own, next);
      _pins
        ..clear()
        ..addAll(next);
    });
    _writes = operation.catchError((Object _) {});
    return operation;
  }

  Future<DesktopRelay> relay(DesktopTokenProvider tokens) {
    if (_disposed) throw const DeviceLinkException('The connection ended.');
    final current = _relay;
    if (current != null && !current.isClosed) return Future.value(current);
    return _opening ??= _open(tokens);
  }

  Future<DesktopRelay> _open(DesktopTokenProvider tokens) async {
    final generation = _generation;
    try {
      final opened = await DesktopRelay.connect(
        identity: await identity(),
        deviceName: deviceName,
        targetId: '',
        fetchToken: tokens,
      );
      if (_disposed || generation != _generation) {
        await opened.close();
        throw const DeviceLinkException('Connection cancelled.');
      }
      return _relay = opened;
    } finally {
      if (generation == _generation) _opening = null;
    }
  }

  Future<void> disconnect() async {
    _generation++;
    final current = _relay;
    _relay = null;
    _opening = null;
    await current?.close();
  }

  Future<void> dispose() async {
    _disposed = true;
    await disconnect();
    await _writes;
  }
}
