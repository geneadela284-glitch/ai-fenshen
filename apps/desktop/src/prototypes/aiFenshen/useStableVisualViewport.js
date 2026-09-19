import { useLayoutEffect } from 'react';
import { calculateKeyboardInset } from './prototypeState.js';

const KEYBOARD_THRESHOLD = 120;

function resetOuterDocumentScroll() {
  document.documentElement.scrollLeft = 0;
  document.documentElement.scrollTop = 0;
  document.body.scrollLeft = 0;
  document.body.scrollTop = 0;
  if (window.scrollX !== 0 || window.scrollY !== 0) {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }
}

export default function useStableVisualViewport(rootRef, { mockKeyboardInset = 0 } = {}) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const viewport = window.visualViewport;
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true
      || window.navigator?.standalone === true;
    const overlayViewportHeight = standalone
      ? (CSS.supports('height: 100lvh') ? '100lvh' : '100vh')
      : (CSS.supports('height: 100dvh') ? '100dvh' : '100vh');
    let frame = 0;
    let resetFrame = 0;
    let lastHeight = '';
    const previousScrollRestoration = history.scrollRestoration;

    document.documentElement.classList.add('af-prototype-active');
    document.body.classList.add('af-prototype-active');
    document.documentElement.dataset.afStandalone = standalone ? 'true' : 'false';
    document.body.dataset.afStandalone = standalone ? 'true' : 'false';
    root.dataset.afStandalone = standalone ? 'true' : 'false';
    history.scrollRestoration = 'manual';
    resetOuterDocumentScroll();

    const update = () => {
      frame = 0;
      // Some installed apps reserve a solid status bar outside the web viewport.
      // In that mode lvh can still include the bar; measure available height.
      // Existing edge-to-edge installs keep their accepted lvh behavior.
      const safeTop = Number.parseFloat(getComputedStyle(root).getPropertyValue('--af-system-safe-top')) || 0;
      const dynamicViewportHeight = standalone && safeTop === 0
        ? `${Math.round(window.innerHeight)}px`
        : overlayViewportHeight;
      const measuredOffset = mockKeyboardInset || (viewport
        ? calculateKeyboardInset({ innerHeight: window.innerHeight, visualViewportHeight: viewport.height, offsetTop: viewport.offsetTop })
        : 0);
      const keyboardOpen = measuredOffset >= KEYBOARD_THRESHOLD;
      const height = mockKeyboardInset
        ? `calc(${dynamicViewportHeight} - ${mockKeyboardInset}px)`
        : keyboardOpen && viewport
          ? `${Math.round(viewport.height)}px`
          : dynamicViewportHeight;
      if (height !== lastHeight) {
        root.style.setProperty('--af-app-height', height);
        lastHeight = height;
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    const scheduleOuterReset = () => {
      if (resetFrame) window.cancelAnimationFrame(resetFrame);
      resetFrame = window.requestAnimationFrame(() => {
        resetFrame = window.requestAnimationFrame(() => {
          resetFrame = 0;
          resetOuterDocumentScroll();
        });
      });
    };

    const handlePageShow = () => {
      resetOuterDocumentScroll();
      schedule();
    };

    const handleFocusOut = (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        scheduleOuterReset();
      }
    };

    schedule();
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('pageshow', handlePageShow, { passive: true });
    document.addEventListener('focusout', handleFocusOut, { passive: true });
    viewport?.addEventListener('resize', schedule, { passive: true });
    viewport?.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (resetFrame) window.cancelAnimationFrame(resetFrame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('focusout', handleFocusOut);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      history.scrollRestoration = previousScrollRestoration;
      delete document.documentElement.dataset.afStandalone;
      delete document.body.dataset.afStandalone;
      delete root.dataset.afStandalone;
      document.documentElement.classList.remove('af-prototype-active');
      document.body.classList.remove('af-prototype-active');
    };
  }, [mockKeyboardInset, rootRef]);
}
