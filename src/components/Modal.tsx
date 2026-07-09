import { useEffect, useRef, ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** id of the heading element inside `children` that labels the dialog. */
  labelledBy: string;
  /** width utility, e.g. "max-w-md" (default) or "max-w-lg". */
  widthClass?: string;
  children: ReactNode;
}

/**
 * Accessible modal shell: backdrop click + Escape to close, role="dialog"
 * with aria-modal, focus moved inside on open, and Tab focus trapped within.
 */
export function Modal({ open, onClose, labelledBy, widthClass = 'max-w-md', children }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab') {
        const items = focusable();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`bg-white rounded-2xl shadow-2xl w-full mx-4 overflow-hidden ${widthClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
