import { buildTelephoneHref } from '../../client/src/pages/MonthlySchedule/personnel-contact-links';

describe('personnel contact links', () => {
  it.each([
    ['199 5944-1925', 'tel:13800003494'],
    ['+86 (159) 5130-1358', 'tel:+8615951301358'],
    ['0513-12345678', 'tel:051312345678'],
  ])('normalizes a callable telephone number without changing its display value', (value, expected) => {
    expect(buildTelephoneHref(value)).toBe(expected);
  });

  it.each([
    '',
    '1234',
    'javascript:alert(1)',
    '13800003494#123',
    '++8615951301358',
  ])('rejects an unsafe or non-callable telephone value: %s', (value) => {
    expect(buildTelephoneHref(value)).toBeNull();
  });
});
