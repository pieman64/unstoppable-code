import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/desktop_app_prompt_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  const account = 'production:7';

  test(
    'an account that never dismissed the prompt reads as not dismissed',
    () async {
      SharedPreferences.setMockInitialValues({});
      expect(
        await SharedPrefsDesktopAppPromptStore().isDismissed(account),
        isFalse,
      );
    },
  );

  test(
    'a dismissal survives a new store instance, as after a relaunch',
    () async {
      SharedPreferences.setMockInitialValues({});
      await SharedPrefsDesktopAppPromptStore().markDismissed(account);
      expect(
        await SharedPrefsDesktopAppPromptStore().isDismissed(account),
        isTrue,
      );
      final prefs = await SharedPreferences.getInstance();
      expect(
        prefs.getBool(SharedPrefsDesktopAppPromptStore.keyFor(account)),
        isTrue,
      );
    },
  );

  test('each account has its own flag', () async {
    SharedPreferences.setMockInitialValues({});
    final store = SharedPrefsDesktopAppPromptStore();
    await store.markDismissed(account);
    expect(await store.isDismissed('production:8'), isFalse);
    // The same numeric id on another server is a different account.
    expect(await store.isDismissed('staging:7'), isFalse);
  });

  test('the key is versioned and names the account', () {
    expect(
      SharedPrefsDesktopAppPromptStore.keyFor(account),
      'mobile.desktop_app_prompt_v1.production:7',
    );
  });

  test('a value of the wrong type reads as not dismissed', () async {
    SharedPreferences.setMockInitialValues({
      SharedPrefsDesktopAppPromptStore.keyFor(account): 'yes',
    });
    expect(
      await SharedPrefsDesktopAppPromptStore().isDismissed(account),
      isFalse,
    );
  });

  test('in-memory store can simulate a failed write', () async {
    final store = InMemoryDesktopAppPromptStore()
      ..failWritesWith = StateError('disk full');
    await expectLater(store.markDismissed(account), throwsStateError);
    expect(await store.isDismissed(account), isFalse);
  });
}
