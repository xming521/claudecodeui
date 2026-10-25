import assert from 'node:assert/strict';
import { useRef } from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test } from 'vitest';

import { useKeyboardOpen } from '@/modules/project-workspace/hooks/useKeyboardOpen';

/**
 * The phone bar at the bottom of the workspace hides while the keyboard is up.
 * Focus alone is not the keyboard: the terminal focuses itself when its tab
 * opens, and a box keeps focus after the back gesture closes the keyboard.
 * Both left the bar hidden, with no way to switch tabs but the side menu.
 */

function Probe() {
  const barRef = useRef<HTMLDivElement>(null);
  const isOpen = useKeyboardOpen(barRef);
  return (
    <>
      <textarea aria-label="composer" />
      <div ref={barRef}><input aria-label="rename" /></div>
      <output aria-label="keyboard">{isOpen ? 'open' : 'closed'}</output>
    </>
  );
}

const setViewportHeight = (height: number) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  window.dispatchEvent(new Event('resize'));
};

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

const keyboard = () => screen.getByLabelText('keyboard').textContent;

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
});

afterEach(() => {
  (document.activeElement as HTMLElement | null)?.blur();
});

test('a focused box with the full viewport is not a keyboard', async () => {
  render(<Probe />);
  act(() => screen.getByLabelText('composer').focus());
  await nextFrame();
  assert.equal(keyboard(), 'closed');
});

test('the keyboard opens with focus plus a shorter viewport and closes when the viewport grows back', async () => {
  render(<Probe />);
  act(() => screen.getByLabelText('composer').focus());
  act(() => setViewportHeight(480));
  await waitFor(() => assert.equal(keyboard(), 'open'));

  // Back gesture: the keyboard goes, focus stays in the box.
  act(() => setViewportHeight(800));
  await waitFor(() => assert.equal(keyboard(), 'closed'));
  assert.equal(document.activeElement, screen.getByLabelText('composer'));
});

test('the URL bar showing is not a keyboard', async () => {
  render(<Probe />);
  act(() => screen.getByLabelText('composer').focus());
  act(() => setViewportHeight(744));
  await nextFrame();
  assert.equal(keyboard(), 'closed');
});

test('typing in the bar itself keeps the bar', async () => {
  render(<Probe />);
  act(() => screen.getByLabelText('rename').focus());
  act(() => setViewportHeight(480));
  await nextFrame();
  assert.equal(keyboard(), 'closed');
});
