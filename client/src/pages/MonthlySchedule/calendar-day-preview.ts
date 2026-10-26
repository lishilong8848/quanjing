import { Component, createElement, type FocusEvent, type ReactNode } from 'react';

type PreviewState = { hovered: boolean; focused: boolean };
type PreviewSignal = 'pointer-enter' | 'pointer-leave' | 'focus-enter' | 'focus-leave';

export function updateCalendarPreviewState(state: PreviewState, signal: PreviewSignal): PreviewState {
  const key = signal.startsWith('pointer-') ? 'hovered' : 'focused';
  const active = signal.endsWith('-enter');
  return state[key] === active ? state : { ...state, [key]: active };
}

export class CalendarDayPreview extends Component<{
  children: ReactNode;
  renderPreview: () => ReactNode;
}, PreviewState> {
  state: PreviewState = { hovered: false, focused: false };

  private update = (signal: PreviewSignal) => {
    this.setState(current => {
      const next = updateCalendarPreviewState(current, signal);
      return next === current ? null : next;
    });
  };

  private handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) this.update('focus-leave');
  };

  render() {
    return createElement('div', {
      className: 'group relative h-full',
      onMouseEnter: () => this.update('pointer-enter'),
      onMouseLeave: () => this.update('pointer-leave'),
      onFocusCapture: () => this.update('focus-enter'),
      onBlurCapture: this.handleBlur,
    }, this.props.children,
    this.state.hovered || this.state.focused ? this.props.renderPreview() : null);
  }
}
