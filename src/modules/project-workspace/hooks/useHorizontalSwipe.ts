import { useEffect, useRef, type RefObject } from 'react';

export type SwipeDirection = 'left' | 'right';

/** Horizontal distance a swipe must cover. */
const SWIPE_MIN_DISTANCE = 60;
/** Vertical drift allowed per pixel of horizontal travel, so a scroll that wanders sideways is not a swipe. */
const SWIPE_MAX_SLOPE = 0.5;

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

/**
 * True when the finger landed on something that would scroll the other way
 * under this swipe: a right swipe drags content toward its start, so a code
 * block or tab row already scrolled away from it takes the gesture.
 */
const scrollsUnderSwipe = (target: Element, area: HTMLElement, direction: SwipeDirection): boolean => {
  for (let element: Element | null = target; element && element !== area.parentElement; element = element.parentElement) {
    if (!(element instanceof HTMLElement) || element.scrollWidth <= element.clientWidth) continue;
    const { overflowX } = getComputedStyle(element);
    if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
    const canScroll = direction === 'right'
      ? element.scrollLeft > 0
      : element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    if (canScroll) return true;
  }
  return false;
};

/**
 * Used by ProjectSidebarRegion for the phone drawer: a right swipe on the main
 * area opens it, a left swipe on the drawer closes it. A one-finger swipe
 * counts when it covers SWIPE_MIN_DISTANCE mostly sideways. It does not count
 * when it starts in a text field or on something that scrolls that way, or
 * when a handler underneath claims the move (the terminal's long-press
 * selection and pinch zoom call preventDefault).
 */
export function useHorizontalSwipe(
  areaRef: RefObject<HTMLElement | null>,
  direction: SwipeDirection,
  enabled: boolean,
  onSwipe: () => void,
) {
  const onSwipeRef = useRef(onSwipe);
  useEffect(() => {
    onSwipeRef.current = onSwipe;
  }, [onSwipe]);

  useEffect(() => {
    const area = areaRef.current;
    if (!enabled || !area) return undefined;

    let start: { x: number; y: number } | null = null;
    const handleStart = (event: TouchEvent) => {
      start = null;
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element)) return;
      if (target.closest(EDITABLE_SELECTOR) || scrollsUnderSwipe(target, area, direction)) return;
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const handleMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || event.defaultPrevented) start = null;
    };
    const handleEnd = (event: TouchEvent) => {
      const origin = start;
      start = null;
      const touch = event.changedTouches[0];
      if (!origin || !touch) return;
      const travel = (touch.clientX - origin.x) * (direction === 'right' ? 1 : -1);
      if (travel >= SWIPE_MIN_DISTANCE && Math.abs(touch.clientY - origin.y) <= travel * SWIPE_MAX_SLOPE) {
        onSwipeRef.current();
      }
    };
    const handleCancel = () => {
      start = null;
    };

    area.addEventListener('touchstart', handleStart, { passive: true });
    area.addEventListener('touchmove', handleMove, { passive: true });
    area.addEventListener('touchend', handleEnd, { passive: true });
    area.addEventListener('touchcancel', handleCancel, { passive: true });
    return () => {
      area.removeEventListener('touchstart', handleStart);
      area.removeEventListener('touchmove', handleMove);
      area.removeEventListener('touchend', handleEnd);
      area.removeEventListener('touchcancel', handleCancel);
    };
  }, [areaRef, direction, enabled]);
}
