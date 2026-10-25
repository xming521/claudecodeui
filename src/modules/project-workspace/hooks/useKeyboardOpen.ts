import { useEffect, useState, type RefObject } from 'react';

/** Input types that bring up no keyboard. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
]);

/** Height the viewport must lose to count as a keyboard; the URL bar alone takes ~56px. */
const KEYBOARD_MIN_HEIGHT = 120;

const isTextEntry = (element: Element | null): boolean => {
  if (element instanceof HTMLTextAreaElement) {
    return !element.readOnly;
  }
  if (element instanceof HTMLInputElement) {
    return !element.readOnly && !NON_TEXT_INPUT_TYPES.has(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
};

const viewportHeight = () => window.visualViewport?.height ?? window.innerHeight;

/**
 * Used by WorkspaceMobileBar to step aside while the phone keyboard is up,
 * when the bar would sit between it and the composer or terminal. The keyboard
 * counts as up when a text field has focus and the viewport is clearly shorter
 * than it has been at this width. A field that keeps focus after the keyboard
 * is dismissed, or the terminal focusing itself without one, leaves the bar in
 * place. Fields inside `exceptWithin` (the bar's own rename box) do not count.
 */
export function useKeyboardOpen(exceptWithin?: RefObject<HTMLElement | null>): boolean {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let frame = 0;
    let width = window.innerWidth;
    let tallest = viewportHeight();
    const update = () => {
      // During `focusout` focus has not moved yet; read it once it has.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = viewportHeight();
        if (window.innerWidth !== width) {
          // Rotated: heights from the old orientation no longer compare.
          width = window.innerWidth;
          tallest = height;
        }
        tallest = Math.max(tallest, height);
        const active = document.activeElement;
        setIsOpen(
          tallest - height >= KEYBOARD_MIN_HEIGHT
          && isTextEntry(active)
          && !exceptWithin?.current?.contains(active),
        );
      });
    };
    const viewport = window.visualViewport ?? window;
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    viewport.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      viewport.removeEventListener('resize', update);
    };
  }, []);

  return isOpen;
}
