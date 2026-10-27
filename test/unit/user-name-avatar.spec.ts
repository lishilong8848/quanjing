import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UserNameAvatar } from '../../client/src/components/UserNameAvatar';

describe('user name avatar', () => {
  it.each([
    ['马进宇', '进宇'],
    ['梅冰冰', '冰冰'],
    ['施小东', '小东'],
    ['  刘小杏  ', '小杏'],
    ['李', '李'],
    ['A𠮷野', '𠮷野'],
    ['', '用户'],
  ])('renders the last two characters of %s without an image request', (name, text) => {
    const markup = renderToStaticMarkup(createElement(UserNameAvatar, { name }));
    expect(markup).toContain(`>${text}</span>`);
    expect(markup).not.toContain('<img');
  });

  it('does not retain the previous name after switching to guest', () => {
    const markup = renderToStaticMarkup(createElement(UserNameAvatar, {
      name: '马进宇', isGuest: true,
    }));
    expect(markup).toContain('>游客</span>');
    expect(markup).not.toContain('进宇');
  });

  it('shows a pending identity without displaying a stale name', () => {
    const markup = renderToStaticMarkup(createElement(UserNameAvatar, {
      name: '马进宇', isLoading: true,
    }));
    expect(markup).toContain('>…</span>');
    expect(markup).not.toContain('进宇');
  });
});
