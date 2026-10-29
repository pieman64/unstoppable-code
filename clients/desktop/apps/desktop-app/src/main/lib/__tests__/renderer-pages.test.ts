import {
  APP_ADVISOR_RENDERER_PAGE,
  APP_ADVISOR_RENDERER_SEARCH,
  MAIN_WINDOW_RENDERER_PAGE,
  appAdvisorDevServerUrl,
} from '../renderer-pages';

describe('renderer pages', () => {
  it('gives each window its own page', () => {
    expect(MAIN_WINDOW_RENDERER_PAGE).toBe('index.html');
    expect(APP_ADVISOR_RENDERER_PAGE).toBe('app-advisor.html');
    expect(APP_ADVISOR_RENDERER_SEARCH).toBe('?surface=app-advisor');
  });

  it.each(['http://localhost:5173', 'http://localhost:5173/'])(
    'serves App Advisor from its page on the dev server %s',
    (devServerUrl) => {
      expect(appAdvisorDevServerUrl(devServerUrl)).toBe(
        'http://localhost:5173/app-advisor.html?surface=app-advisor',
      );
    },
  );
});
