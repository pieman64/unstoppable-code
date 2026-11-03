import 'package:mobile/data/models/model_picker_tab_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// [ModelPickerTabStore] backed by `shared_preferences`. The tab is a
/// non-sensitive local preference.
final class SharedPrefsModelPickerTabStore implements ModelPickerTabStore {
  static const String _key = 'canopy.model_picker_tab';

  @override
  Future<String?> read() async =>
      (await SharedPreferences.getInstance()).getString(_key);

  @override
  Future<void> write(String tab) async {
    await (await SharedPreferences.getInstance()).setString(_key, tab);
  }
}

/// In-memory [ModelPickerTabStore] for tests and previews.
final class InMemoryModelPickerTabStore implements ModelPickerTabStore {
  InMemoryModelPickerTabStore([this._tab]);

  String? _tab;

  @override
  Future<String?> read() async => _tab;

  @override
  Future<void> write(String tab) async => _tab = tab;
}
