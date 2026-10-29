/**
 * @jest-environment jsdom
 *
 * CAN-4072: mount normalizations from the automation form move the clean
 * baseline, even when several arrive in one commit. The form body is
 * replaced here so the test controls exactly which normalizations run.
 */
import { useEffect, type ReactElement } from 'react';
import type { FormState } from '../../../automations/form/automationFormState';
import { useAutomationsStore } from '@/stores/automationsStore';
import {
  activity,
  installAutomationEditEnvironment,
} from './automationEditHarness';

jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): null => null,
}));

interface MockBodyProps {
  readonly state: FormState;
  readonly onChange: (
    next: FormState,
    meta: { readonly origin: 'mount' | 'user' },
  ) => void;
}

jest.mock('../../../automations/form/ActivityFormBody', () => ({
  ActivityFormBody: ({ state, onChange }: MockBodyProps): ReactElement => {
    useEffect(() => {
      // Two fields normalize on mount in the same commit, each building on
      // the one before.
      const first = { ...state, ifCommand: 'test -f ready' };
      onChange(first, { origin: 'mount' });
      onChange({ ...first, name: `${first.name} ` }, { origin: 'mount' });
      // Mount only.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="mock-form-body" />;
  },
}));

const env = installAutomationEditEnvironment();

describe('AutomationEditAdapter mount normalization', () => {
  it('stays clean after several mount normalizations in one commit', async () => {
    useAutomationsStore.setState({ activities: [activity()] });
    env.render();
    await env.openEdit('activity-1');
    await env.settle();

    expect(env.byTestId('mock-form-body')).not.toBeNull();
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');
  });
});
