import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:mobile/device_link/store.dart';

/// Non-sensitive UI choices. Every account, server, computer and context has
/// its own record; the selected computer itself lives in the pairing store.
final class ComputerChatSelectionStore implements DeviceLinkStore {
  ComputerChatSelectionStore({
    required String accountId,
    required String origin,
    required String computerId,
    required String contextId,
  }) : _key =
           'computer-chat-selection.v1:${jsonEncode([origin, accountId, computerId, contextId])}';
  final String _key;
  @override
  Future<String?> read() async =>
      (await SharedPreferences.getInstance()).getString(_key);
  @override
  Future<void> write(String value) async {
    if (!await (await SharedPreferences.getInstance()).setString(_key, value)) {
      throw StateError('Could not save chat selections');
    }
  }
}
