import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const helperPath = resolve(__dirname, '../../client/src/pages/MonthlySchedule/calendar-day-preview.ts');

function helper() {
  expect(existsSync(helperPath)).toBe(true);
  return require(helperPath);
}

describe('schedule day preview mount boundary', () => {
  it('uses a lazy preview factory only in the detailed main-calendar day', () => {
    const source = readFileSync(resolve(__dirname, '../../client/src/pages/MonthlySchedule/index.tsx'), 'utf8');
    const mainStart = source.indexOf('const StatusCalendarDayButtonWithChanges = useCallback(');
    const compactStart = source.indexOf('const CompactCalendarDayButton = useCallback(');
    expect(source.slice(mainStart, compactStart)).toContain('<CalendarDayPreview');
    expect(source.slice(mainStart, compactStart)).toContain('renderPreview={() => (');
  });

  it('does not render an inactive preview factory', () => {
    const { CalendarDayPreview } = helper();
    const renderPreview = jest.fn(() => 'details');
    const component = new CalendarDayPreview({ children: 'date button', renderPreview });
    const element = component.render();
    expect(renderPreview).not.toHaveBeenCalled();
    expect(element.props.children[0]).toBe('date button');
  });

  it.each([{ hovered: true, focused: false }, { hovered: false, focused: true }])(
    'renders the same preview while active: %j', state => {
      const { CalendarDayPreview } = helper();
      const renderPreview = jest.fn(() => 'details');
      const component = new CalendarDayPreview({ children: 'date button', renderPreview });
      component.state = state;
      const element = component.render();
      expect(renderPreview).toHaveBeenCalledTimes(1);
      expect(element.props.children).toEqual(['date button', 'details']);
    },
  );

  it('keeps keyboard preview when the pointer leaves', () => {
    const { updateCalendarPreviewState } = helper();
    expect(updateCalendarPreviewState({ hovered: true, focused: true }, 'pointer-leave'))
      .toEqual({ hovered: false, focused: true });
  });

  it('keeps hovered preview when keyboard focus leaves', () => {
    const { updateCalendarPreviewState } = helper();
    expect(updateCalendarPreviewState({ hovered: true, focused: true }, 'focus-leave'))
      .toEqual({ hovered: true, focused: false });
  });

  it('becomes inactive only after both pointer and focus leave', () => {
    const { updateCalendarPreviewState } = helper();
    const state = updateCalendarPreviewState({ hovered: false, focused: true }, 'focus-leave');
    expect(state).toEqual({ hovered: false, focused: false });
  });

  it('does not allocate a state object for a repeated signal', () => {
    const { updateCalendarPreviewState } = helper();
    const state = { hovered: false, focused: true };
    expect(updateCalendarPreviewState(state, 'focus-enter')).toBe(state);
  });
});
