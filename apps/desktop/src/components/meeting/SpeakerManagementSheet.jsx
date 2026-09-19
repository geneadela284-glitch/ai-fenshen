import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import './SpeakerManagement.css';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"]):not([disabled])'
].join(',');

function focusableElements(dialog) {
  return dialog ? [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)] : [];
}

export function focusBusyDialog(dialog) {
  dialog?.focus();
}

export function trapModalTabKey(event, dialog, documentImpl = globalThis.document) {
  if (event.key !== 'Tab' || !dialog) return;
  const focusable = focusableElements(dialog);
  if (!focusable.length) {
    event.preventDefault();
    focusBusyDialog(dialog);
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = documentImpl?.activeElement;
  if (!focusable.includes(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function containModalFocus(event, dialog) {
  if (!dialog || dialog.contains(event.target)) return;
  const first = focusableElements(dialog)[0];
  if (first) first.focus();
  else focusBusyDialog(dialog);
}

export function SpeakerManagementSheet({ open, onClose, busy = false, children }) {
  const generatedId = useId();
  const titleId = `meeting-speaker-sheet-title-${generatedId.replace(/:/g, '')}`;
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const dialog = dialogRef.current;
    const previouslyFocusedElement = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const handleDocumentKeyDown = (event) => trapModalTabKey(event, dialog, document);
    const handleDocumentFocus = (event) => containModalFocus(event, dialog);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleDocumentKeyDown, true);
    document.addEventListener('focusin', handleDocumentFocus, true);
    const focusFrame = globalThis.requestAnimationFrame?.(() => closeButtonRef.current?.focus());

    return () => {
      if (focusFrame !== undefined) globalThis.cancelAnimationFrame?.(focusFrame);
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
      document.removeEventListener('focusin', handleDocumentFocus, true);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocusedElement instanceof HTMLElement) previouslyFocusedElement.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open && busy) focusBusyDialog(dialogRef.current);
  }, [busy, open]);

  if (!open || typeof document === 'undefined') return null;

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) onClose?.();
      return;
    }
  }

  function handleBackdrop(event) {
    if (event.target === event.currentTarget && !busy) onClose?.();
  }

  return createPortal(
    <div className="meeting-speaker-sheet" onMouseDown={handleBackdrop}>
      <section
        className="meeting-speaker-sheet-panel"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="meeting-speaker-sheet-header">
          <div>
            <p className="meeting-speaker-eyebrow">会议内容校正</p>
            <h2 className="meeting-speaker-sheet-title" id={titleId}>说话人管理</h2>
          </div>
          <button
            className="meeting-speaker-button meeting-speaker-sheet-close"
            type="button"
            ref={closeButtonRef}
            onClick={onClose}
            disabled={busy}
            aria-label="关闭说话人管理"
          >
            关闭
          </button>
        </header>
        <div className="meeting-speaker-sheet-body">{children}</div>
      </section>
    </div>,
    document.body
  );
}

export default SpeakerManagementSheet;
