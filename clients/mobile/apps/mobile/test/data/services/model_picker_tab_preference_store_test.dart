import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/model_picker_tab_preference_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('in-memory store round-trips the last tab', () async {
    final store = InMemoryModelPickerTabStore();
    expect(await store.read(), isNull);
    await store.write('codex');
    expect(await store.read(), 'codex');
  });

  test('shared preferences store persists across instances', () async {
    SharedPreferences.setMockInitialValues({});
    expect(await SharedPrefsModelPickerTabStore().read(), isNull);
    await SharedPrefsModelPickerTabStore().write('cursor');
    expect(await SharedPrefsModelPickerTabStore().read(), 'cursor');
  });
}
