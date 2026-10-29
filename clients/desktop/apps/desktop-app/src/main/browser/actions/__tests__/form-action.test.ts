import { mergeFormActionTargetState } from '../form-action';
import type { BrowserActionTargetState } from '@canopy/desktop-shared/types/browser';

const described: BrowserActionTargetState = {
  tagName: 'input',
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  inViewport: true,
  disabled: false,
  focused: true,
};

describe('the final form receipt target', () => {
  it('lets post-settle live state supersede an earlier action observation', () => {
    expect(
      mergeFormActionTargetState(
        { ...described, value: 'live' },
        { value: 'earlier' },
      ),
    ).toMatchObject({ value: 'live' });
  });

  it('does not merge an earlier public value or validity message into a now-secret field', () => {
    const target = mergeFormActionTargetState(
      { ...described, valueRedacted: true, invalid: true },
      { value: 'private value', validationMessage: 'private message' },
    );
    expect(target).toMatchObject({ valueRedacted: true, invalid: true });
    expect(target).not.toHaveProperty('value');
    expect(target).not.toHaveProperty('validationMessage');
  });

  it('does not merge candidates, selected state, or an option-derived name into a now-secret list', () => {
    const target = mergeFormActionTargetState(
      { ...described, tagName: 'select', optionsRedacted: true },
      {
        value: 'private value',
        name: 'Private label',
        selectedOptions: [{ value: 'private value', label: 'Private label' }],
        options: [
          {
            value: 'private value',
            label: 'Private label',
            selected: true,
            disabled: false,
          },
        ],
      },
    );
    expect(target).toMatchObject({ optionsRedacted: true });
    for (const field of ['value', 'name', 'selectedOptions', 'options'])
      expect(target).not.toHaveProperty(field);
    expect(JSON.stringify(target)).not.toContain('private');
    expect(JSON.stringify(target)).not.toContain('Private');
  });
});
