import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/services/workspace_context_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  group('CAN-4429 SharedPrefsWorkspaceContextStore', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('saves per environment and account', () async {
      const production = SharedPrefsWorkspaceContextStore(
        namespace: 'production',
      );
      const staging = SharedPrefsWorkspaceContextStore(namespace: 'staging');

      await production.write(
        'user-1',
        const WorkspaceContext.organization('org-a'),
      );
      await production.write('user-2', const WorkspaceContext.personal());

      expect(
        await production.read('user-1'),
        const WorkspaceContext.organization('org-a'),
      );
      expect(
        await production.read('user-2'),
        const WorkspaceContext.personal(),
      );
      expect(await staging.read('user-1'), isNull);
    });

    test('unknown or corrupt values read as nothing saved', () async {
      const store = SharedPrefsWorkspaceContextStore(namespace: 'production');
      for (final value in ['', 'organization:', 'team:org-a', 'Personal']) {
        SharedPreferences.setMockInitialValues({
          'canopy.workspace_context.production.user-1': value,
        });
        expect(await store.read('user-1'), isNull, reason: value);
      }
    });
  });
}
