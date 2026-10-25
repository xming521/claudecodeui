import assert from 'node:assert/strict';
import { useRef } from 'react';

import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useHorizontalSwipe, type SwipeDirection } from '@/modules/project-workspace/hooks/useHorizontalSwipe';

/**
 * On phones the sidebar drawer only opened from the ☰ button. A right swipe
 * across the main area now opens it and a left swipe on the drawer closes it,
 * without taking drags that belong to text fields, sideways scrollers or the
 * terminal's long-press selection.
 */

function Area({ direction, onSwipe }: { direction: SwipeDirection; onSwipe: () => void }) {
  const areaRef = useRef<HTMLDivElement>(null);
  useHorizontalSwipe(areaRef, direction, true, onSwipe);
  return (
    <div ref={areaRef}>
      <p>transcript</p>
      <textarea aria-label="composer" />
      <pre data-testid="code" style={{ overflowX: 'auto' }}>code</pre>
    </div>
  );
}

type Point = { x: number; y: number };

const touchEvent = (type: string, touches: Point[], changed: Point[]) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const toTouches = (points: Point[]) => points.map(({ x, y }) => ({ clientX: x, clientY: y }));
  Object.defineProperty(event, 'touches', { value: toTouches(touches) });
  Object.defineProperty(event, 'changedTouches', { value: toTouches(changed) });
  return event;
};

const swipe = (target: Element, from: Point, to: Point) => {
  target.dispatchEvent(touchEvent('touchstart', [from], [from]));
  target.dispatchEvent(touchEvent('touchmove', [to], [to]));
  target.dispatchEvent(touchEvent('touchend', [], [to]));
};

const renderArea = (direction: SwipeDirection = 'right') => {
  const onSwipe = vi.fn();
  render(<Area direction={direction} onSwipe={onSwipe} />);
  return onSwipe;
};

test('a sideways right swipe opens, a short or steep one does not', () => {
  const onSwipe = renderArea();
  const transcript = screen.getByText('transcript');

  swipe(transcript, { x: 40, y: 300 }, { x: 80, y: 300 });
  swipe(transcript, { x: 40, y: 300 }, { x: 140, y: 380 });
  assert.equal(onSwipe.mock.calls.length, 0);

  swipe(transcript, { x: 40, y: 300 }, { x: 140, y: 330 });
  assert.equal(onSwipe.mock.calls.length, 1);
});

test('the drawer closes on a left swipe only', () => {
  const onSwipe = renderArea('left');
  const transcript = screen.getByText('transcript');

  swipe(transcript, { x: 40, y: 300 }, { x: 140, y: 300 });
  assert.equal(onSwipe.mock.calls.length, 0);

  swipe(transcript, { x: 240, y: 300 }, { x: 140, y: 300 });
  assert.equal(onSwipe.mock.calls.length, 1);
});

test('swipes in a text field or on a scrolled code block are left to them', () => {
  const onSwipe = renderArea();
  swipe(screen.getByLabelText('composer'), { x: 40, y: 300 }, { x: 140, y: 300 });

  const code = screen.getByTestId('code');
  Object.defineProperty(code, 'scrollWidth', { configurable: true, value: 900 });
  Object.defineProperty(code, 'clientWidth', { configurable: true, value: 300 });
  code.scrollLeft = 120;
  swipe(code, { x: 40, y: 300 }, { x: 140, y: 300 });
  assert.equal(onSwipe.mock.calls.length, 0);

  // Scrolled back to its start, the block cannot move further right.
  code.scrollLeft = 0;
  swipe(code, { x: 40, y: 300 }, { x: 140, y: 300 });
  assert.equal(onSwipe.mock.calls.length, 1);
});

test('a drag claimed underneath (terminal selection) is not a swipe', () => {
  const onSwipe = renderArea();
  const terminal = screen.getByText('transcript');
  terminal.addEventListener('touchmove', (event) => event.preventDefault());
  swipe(terminal, { x: 40, y: 300 }, { x: 140, y: 300 });
  assert.equal(onSwipe.mock.calls.length, 0);
});
