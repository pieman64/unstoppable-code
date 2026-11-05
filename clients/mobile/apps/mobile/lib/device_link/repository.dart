import 'dart:async';
import 'dart:convert';

import 'crypto/identity.dart';
import 'protocol.dart';
import 'transport.dart';
import 'store.dart';
export 'store.dart';

/// Owns only the prototype identity and peer pins. It cannot read or mutate
/// the normal app's account, Portal pairing or transcript state.
final class DeviceLinkRepository {
  DeviceLinkRepository({required this._store, required this._connect});
  final DeviceLinkStore _store;
  final DeviceLinkConnector _connect;
  DeviceLinkIdentity? _identity;
  Future<DeviceLinkIdentity>? _loadingIdentity;
  final _pins = <String, String>{};
  DeviceLinkTransport? _transport;
  StreamSubscription<Map<String, dynamic>>? _subscription;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  int _generation = 0;
  bool _disposed = false;
  String? get peerName => _transport?.peerName;
  Stream<Map<String, dynamic>> get events => _events.stream;

  Future<DeviceLinkIdentity> _loadIdentity() =>
      _loadingIdentity ??= _readIdentity();

  Future<DeviceLinkIdentity> _readIdentity() async {
    final current = _identity;
    if (current != null) return current;
    final saved = await _store.read();
    if (saved != null) {
      try {
        final record = deviceLinkObject(jsonDecode(saved));
        if (record['version'] != 1) throw const FormatException();
        final identity = await DeviceLinkIdentity.fromSeed(
          linkBytes(deviceLinkString(record, 'seed'), 32),
        );
        final pins = deviceLinkObject(record['pins']);
        for (final entry in pins.entries) {
          if (entry.value is! String ||
              await linkDeviceId(entry.value) != entry.key) {
            throw const FormatException();
          }
          _pins[entry.key] = entry.value;
        }
        return _identity = identity;
      } catch (_) {
        _pins.clear();
        throw const DeviceLinkException(
          'The prototype identity could not be read. Its saved data was preserved.',
        );
      }
    }
    final identity = await DeviceLinkIdentity.fromSeed(linkRandomBytes(32));
    await _save(identity, _pins);
    return _identity = identity;
  }

  Future<void> _save(
    DeviceLinkIdentity identity,
    Map<String, String> pins,
  ) async => _store.write(
    jsonEncode({
      'version': 1,
      'seed': linkBase64(await identity.keyPair.extractPrivateKeyBytes()),
      'pins': pins,
    }),
  );

  Future<void> connect(
    String invitationText, {
    required void Function(String code) onPairingCode,
  }) async {
    await disconnect();
    final generation = _generation;
    final invitation = DeviceLinkInvitation.parse(invitationText);
    final identity = await _loadIdentity();
    if (_disposed || generation != _generation) return;
    final transport = await _connect(invitation, identity);
    if (_disposed || generation != _generation) {
      await transport.close();
      return;
    }
    _transport = transport;
    _subscription = transport.events.listen((event) {
      if (!_disposed && generation == _generation) _events.add(event);
    });
    try {
      final pin = _pins[transport.peerId];
      if (pin != null && pin != transport.peerPublicKey) {
        throw const DeviceLinkException('The desktop peer key changed.');
      }
      if (pin == null) {
        await transport.pair((code) {
          if (!_disposed && generation == _generation) onPairingCode(code);
        });
        if (_disposed || generation != _generation) return;
        final pins = {..._pins, transport.peerId: transport.peerPublicKey};
        await _save(identity, pins);
        if (_disposed || generation != _generation) return;
        _pins.addAll(pins);
      }
      await transport.openControl();
    } catch (_) {
      if (generation == _generation) await disconnect();
      rethrow;
    }
  }

  Future<String> echo(String text) async {
    final transport = _transport;
    if (transport == null) {
      throw const DeviceLinkException('Connect to the desktop peer first.');
    }
    return transport.echo(text);
  }

  Future<void> forgetPeers() async {
    await disconnect();
    final identity = await _loadIdentity();
    await _save(identity, {});
    _pins.clear();
  }

  Future<void> disconnect() async {
    _generation++;
    final transport = _transport;
    _transport = null;
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();
    await transport?.close();
  }

  Future<void> dispose() async {
    _disposed = true;
    await disconnect();
    await _events.close();
  }
}
