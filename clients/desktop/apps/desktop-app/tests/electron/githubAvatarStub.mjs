/**
 * Offline stand-in for GitHub owner avatars (CAN-3053).
 *
 * Project headers draw `https://github.com/<owner>.png?size=32` (which
 * redirects to `avatars.githubusercontent.com`). Specs must not depend on
 * github.com, so every avatar request a page makes is answered here:
 *
 * - `'png'` — a 1×1 PNG, so the avatar genuinely loads;
 * - `'error'` — a 404, so the avatar fails and the kind badge must return.
 *
 * Works on an Electron window and a browser page/context alike: all three
 * expose Playwright's `route`. Register before the page first renders a
 * project header so no request escapes to the network.
 */

export const GITHUB_AVATAR_URL_PATTERN =
  /^https:\/\/(?:github\.com|avatars\.githubusercontent\.com)\/.*\.png(?:\?.*)?$/;

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/**
 * @param {{ route: Function }} target Electron window, page, or context
 * @param {'png' | 'error'} mode
 * @returns {Promise<string[]>} the avatar URLs requested so far (live array)
 */
export async function stubGitHubAvatars(target, mode) {
  const requested = [];
  await target.route(GITHUB_AVATAR_URL_PATTERN, async (route) => {
    requested.push(route.request().url());
    if (mode === 'png') {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: ONE_PIXEL_PNG,
      });
      return;
    }
    await route.fulfill({ status: 404, body: '' });
  });
  return requested;
}
