import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/satisfaction_prompt_store.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  const key = SharedPrefsSatisfactionPromptStore.key;
  final sample = SatisfactionState(
    successfulTurnCount: 3,
    successDays: const ['2026-09-01'],
    snoozedUntil: DateTime.utc(2026, 10, 1),
  );

  test('unset reads as the initial state', () async {
    SharedPreferences.setMockInitialValues({});
    expect(
      await SharedPrefsSatisfactionPromptStore().read(),
      SatisfactionState.initial,
    );
  });

  test('round-trips a written state', () async {
    SharedPreferences.setMockInitialValues({});
    final store = SharedPrefsSatisfactionPromptStore();
    await store.write(sample);
    expect(await store.read(), sample);
    final prefs = await SharedPreferences.getInstance();
    expect(jsonDecode(prefs.getString(key) ?? ''), sample.toJson());
  });

  test('corrupt JSON reads as the initial state', () async {
    SharedPreferences.setMockInitialValues({key: '{not json'});
    expect(
      await SharedPrefsSatisfactionPromptStore().read(),
      SatisfactionState.initial,
    );
  });

  test('an unknown version reads as the initial state', () async {
    SharedPreferences.setMockInitialValues({
      key: jsonEncode({'version': 2, 'successfulTurnCount': 9}),
    });
    expect(
      await SharedPrefsSatisfactionPromptStore().read(),
      SatisfactionState.initial,
    );
  });

  test('in-memory store can simulate a failed write', () async {
    final store = InMemorySatisfactionPromptStore()
      ..failWritesWith = StateError('disk full');
    await expectLater(store.write(sample), throwsStateError);
    expect(store.current, SatisfactionState.initial);
  });
}
