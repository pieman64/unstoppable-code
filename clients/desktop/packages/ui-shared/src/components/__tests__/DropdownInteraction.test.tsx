import { renderToStaticMarkup } from 'react-dom/server';
import {
  BUTTON_PRESS_CLASS,
  DROPDOWN_TRIGGER_INTERACTION_CLASS,
  buttonClassName,
} from '../Button';
import { ControlSelect } from '../ControlSelect';
import { Select } from '../Field';
import { PickerTrigger } from '../PickerMenu';
import { SettingsSelect } from '../SettingsSelect';

/**
 * Every dropdown trigger presses, hovers, and holds its open look like the
 * secondary `Button` (designer feedback, 2026-10-30), from one definition.
 */
const noop = (): undefined => undefined;

function classesOf(html: string, tag: 'button' | 'select'): string[] {
  const match = new RegExp(`<${tag}[^>]*class="([^"]*)"`).exec(html);
  if (!match?.[1]) throw new Error(`No <${tag}> in ${html}`);
  return match[1].split(/\s+/);
}

const tokens = (classes: string): string[] => classes.split(/\s+/);

describe('dropdown trigger interaction', () => {
  it('is the secondary Button press, hover, and held open look', () => {
    const button = tokens(buttonClassName({ variant: 'secondary' }));
    expect(button).toEqual(
      expect.arrayContaining(tokens(DROPDOWN_TRIGGER_INTERACTION_CLASS)),
    );
    expect(button).toEqual(expect.arrayContaining(tokens(BUTTON_PRESS_CLASS)));
    expect(DROPDOWN_TRIGGER_INTERACTION_CLASS).toContain('active:scale-97');
    expect(DROPDOWN_TRIGGER_INTERACTION_CLASS).toContain('aria-expanded:');
  });

  it('gives Select the same open and pressed classes as Button', () => {
    const select = classesOf(
      renderToStaticMarkup(
        <Select
          aria-label="Environment"
          options={[{ value: 'a', label: 'A' }]}
          value="a"
          onValueChange={noop}
        />,
      ),
      'button',
    );
    expect(select).toEqual(
      expect.arrayContaining(tokens(DROPDOWN_TRIGGER_INTERACTION_CLASS)),
    );
    // The field keeps its shape and edge.
    expect(select).toContain('rounded-lg');
    expect(select).toContain('shadow-field');
  });

  it('shares it with the Settings dropdown and the field picker trigger', () => {
    const settings = classesOf(
      renderToStaticMarkup(
        <SettingsSelect
          aria-label="Role"
          options={[{ value: 'a', label: 'A' }]}
          value="a"
          onValueChange={noop}
        />,
      ),
      'button',
    );
    const picker = classesOf(
      renderToStaticMarkup(
        <PickerTrigger variant="field">Branch</PickerTrigger>,
      ),
      'button',
    );
    for (const classes of [settings, picker]) {
      expect(classes).toEqual(
        expect.arrayContaining(tokens(DROPDOWN_TRIGGER_INTERACTION_CLASS)),
      );
    }
    expect(picker).toContain('shadow-field');
  });

  it('presses the native dropdown like a button', () => {
    const native = classesOf(
      renderToStaticMarkup(
        <ControlSelect aria-label="Sound" value="a" onChange={noop}>
          <option value="a">A</option>
        </ControlSelect>,
      ),
      'select',
    );
    expect(native).toEqual(
      expect.arrayContaining(tokens(DROPDOWN_TRIGGER_INTERACTION_CLASS)),
    );
  });
});
