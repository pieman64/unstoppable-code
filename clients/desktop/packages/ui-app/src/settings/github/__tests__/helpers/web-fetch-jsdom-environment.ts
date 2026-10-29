import { TestEnvironment } from 'jest-environment-jsdom';

/**
 * jsdom's DOM with Node's real Fetch `Response`, `Headers` and `Request`, for
 * the GitHub for cloud suites that answer requests with real responses (the
 * environment `apps/web/src/test/web-fetch-jsdom.mjs` gives the web suites),
 * plus `TextEncoder`, which the settings table's input size check uses.
 */
export default class WebFetchJsdomEnvironment extends TestEnvironment {
  constructor(...args: ConstructorParameters<typeof TestEnvironment>) {
    super(...args);
    Object.assign(this.global, {
      Response,
      Headers,
      Request,
      TextEncoder,
      TextDecoder,
    });
  }
}
