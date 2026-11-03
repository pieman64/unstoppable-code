/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { FormField } from '../FormField';
import { ToggleField } from '../ToggleField';

/**
 * The shared FormField lays its control out in a flex column, which stretches
 * a child to the field's width. The pipeline wrapper keeps its control at its
 * own size, so a switch is not a full-width click and focus target.
 */
describe('pipeline FormField', () => {
  it('keeps a switch at its own size instead of stretching it across the field', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <FormField label="Continue on error">
        <ToggleField
          checked={false}
          onChange={(): void => undefined}
          label="Continue on error"
        />
      </FormField>,
    );
    const toggle = container.querySelector('button[role="switch"]');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    // Not a direct item of the stretching flex column.
    expect(toggle?.parentElement?.className).not.toContain('flex-col');
  });
});
