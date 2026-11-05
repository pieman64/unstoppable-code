import 'dart:convert';
import '../protocol.dart';

final class ComputerConnectSetupRejected extends DeviceLinkException {
  const ComputerConnectSetupRejected(super.message);
}

/// Account credentials are stored separately from the installation's pairing
/// identity. The server and account are checked even if storage is mis-keyed.
final class ComputerConnectCredential {
  const ComputerConnectCredential(this.id, this.token);
  final String id, token;
  @override
  String toString() => 'ComputerConnectCredential(redacted)';
}

final class SavedComputer {
  const SavedComputer(this.id, this.name, {this.reconnect = true});
  final String id, name;
  final bool reconnect;
  Map<String, Object> toJson() => {
    'id': id,
    'name': name,
    'reconnect': reconnect,
  };
}

final class SavedComputerConnection {
  SavedComputerConnection({required this.accountId, required this.origin});
  final String accountId, origin;
  ComputerConnectCredential? credential;
  bool creatingCredential = false;
  String? selectedId;
  final computers = <String, SavedComputer>{};

  void restore(String raw) {
    try {
      final data = deviceLinkObject(jsonDecode(raw));
      if (data['version'] != 1 ||
          data['accountId'] != accountId ||
          data['origin'] != origin) {
        throw const FormatException();
      }
      final next = <String, SavedComputer>{};
      for (final value in data['computers'] as List) {
        final row = deviceLinkObject(value);
        final id = deviceLinkString(row, 'id');
        if (!RegExp(r'^[A-Za-z0-9_-]{22}$').hasMatch(id) ||
            row['reconnect'] is! bool) {
          throw const FormatException();
        }
        next[id] = SavedComputer(
          id,
          deviceLinkString(row, 'name'),
          reconnect: row['reconnect'],
        );
      }
      final key = data['credential'];
      final restoredKey = key == null
          ? null
          : ComputerConnectCredential(
              deviceLinkString(deviceLinkObject(key), 'id'),
              deviceLinkString(deviceLinkObject(key), 'token'),
            );
      final selected = data['selectedId'];
      if ((selected != null && !next.containsKey(selected)) ||
          data['creatingCredential'] is! bool) {
        throw const FormatException();
      }
      credential = restoredKey;
      creatingCredential = data['creatingCredential'];
      selectedId = selected;
      computers.addAll(next);
    } catch (_) {
      throw const DeviceLinkException(
        'Saved connection settings could not be read. They were preserved.',
      );
    }
  }

  String encode() => jsonEncode({
    'version': 1,
    'accountId': accountId,
    'origin': origin,
    'credential': credential == null
        ? null
        : {'id': credential!.id, 'token': credential!.token},
    'creatingCredential': creatingCredential,
    'selectedId': selectedId,
    'computers': computers.values.map((c) => c.toJson()).toList(),
  });
}
