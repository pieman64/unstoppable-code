// The chat composer's effort control: a trigger under the box that opens a
// panel with a slider across the model's levels (None to Ultra). The trigger
// carries the committed level as `data-thinking-level`; the slider moves one
// stop per arrow key and commits each move.
import { expect } from '@playwright/test';

export const CHAT_EFFORT_TRIGGER_TEST_ID = 'chat-input-thinking-level-button';

/**
 * Opens the effort panel from `trigger` and returns its slider. The panel
 * renders in the window's floating layer, so it is looked up on `window`.
 */
export async function openEffortSlider(
  window,
  trigger,
  testId = CHAT_EFFORT_TRIGGER_TEST_ID,
) {
  await trigger.click();
  const slider = window.getByTestId(`${testId}-slider`);
  await expect(slider).toBeVisible();
  return slider;
}

/**
 * Moves the slider one stop off its current level: right, or left from the
 * last stop. Returns once the move has been pressed; callers assert the
 * committed level.
 */
export async function stepEffortAway(slider) {
  const now = Number(await slider.getAttribute('aria-valuenow'));
  const max = Number(await slider.getAttribute('aria-valuemax'));
  await slider.press(now < max ? 'ArrowRight' : 'ArrowLeft');
}

/** Closes the effort panel. */
export async function closeEffortPanel(window) {
  await window.keyboard.press('Escape');
}

/**
 * Reads every stop's name off the slider (None, Low, …), then returns it to
 * the stop it started on. Each move commits, so the level ends where it began.
 */
export async function readEffortStops(slider) {
  const start = Number(await slider.getAttribute('aria-valuenow'));
  const max = Number(await slider.getAttribute('aria-valuemax'));
  await slider.press('Home');
  const stops = [await slider.getAttribute('aria-valuetext')];
  for (let stop = 1; stop <= max; stop += 1) {
    await slider.press('ArrowRight');
    stops.push(await slider.getAttribute('aria-valuetext'));
  }
  await slider.press('Home');
  for (let stop = 0; stop < start; stop += 1) {
    await slider.press('ArrowRight');
  }
  return stops;
}
