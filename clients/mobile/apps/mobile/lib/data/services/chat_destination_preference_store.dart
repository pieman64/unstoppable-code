import 'package:mobile/data/models/chat_destination_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// [ChatDestinationStore] backed by `shared_preferences`. The destination is
/// a non-sensitive local preference.
final class SharedPrefsChatDestinationStore implements ChatDestinationStore {
  static const String _key = 'canopy.new_chat_destination';

  @override
  Future<String?> read() async =>
      (await SharedPreferences.getInstance()).getString(_key);

  @override
  Future<void> write(String destination) async {
    await (await SharedPreferences.getInstance()).setString(_key, destination);
  }
}

/// In-memory [ChatDestinationStore] for tests and previews.
final class InMemoryChatDestinationStore implements ChatDestinationStore {
  InMemoryChatDestinationStore([this._destination]);

  String? _destination;

  @override
  Future<String?> read() async => _destination;

  @override
  Future<void> write(String destination) async => _destination = destination;
}
