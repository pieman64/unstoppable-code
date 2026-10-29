import { renderToStaticMarkup } from 'react-dom/server';
import { NoticeList, NoticeListItem } from '../NoticeList';

describe('NoticeList', () => {
  it('renders an inline-safe list of spans with list roles', () => {
    const html = renderToStaticMarkup(
      <NoticeList data-testid="issues">
        <NoticeListItem>jobs.build.steps[1]: `run` is required.</NoticeListItem>
        <NoticeListItem>
          on.dispatch.inputs.branch: unknown type.
        </NoticeListItem>
      </NoticeList>,
    );
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('<li');
    expect(html).toContain(
      '<span role="list" class="mt-2 block space-y-0.5" data-testid="issues">',
    );
    expect(html.match(/role="listitem"/g)).toHaveLength(2);
  });

  it('draws the bullet as hidden text that the item text hangs past', () => {
    const html = renderToStaticMarkup(
      <NoticeListItem>Only item</NoticeListItem>,
    );
    expect(html).toContain('class="block pl-4 -indent-4"');
    expect(html).toContain(
      '<span aria-hidden="true" class="mr-1.5">•</span>Only item',
    );
  });
});
