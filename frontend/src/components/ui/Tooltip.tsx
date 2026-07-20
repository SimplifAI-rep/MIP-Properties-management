import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type TooltipProps = {
  content: string;
  children: ReactNode;
  className?: string;
  /** Hide the ? hint when the child already signals help (e.g. dense badges). */
  hideHint?: boolean;
};

type Position = { top: number; left: number };

export function Tooltip({ content, children, className, hideHint = false }: TooltipProps) {
  const tipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const update = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      setPosition({
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
      });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  return (
    <span
      className={`tooltip${className ? ` ${className}` : ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span
        ref={triggerRef}
        className="tooltip-trigger"
        tabIndex={0}
        aria-describedby={open ? tipId : undefined}
      >
        {children}
        {hideHint ? null : (
          <span className="tooltip-hint" aria-hidden="true">
            ?
          </span>
        )}
      </span>
      {open && position
        ? createPortal(
            <span
              id={tipId}
              role="tooltip"
              className="tooltip-content tooltip-content-fixed"
              style={{ top: position.top, left: position.left }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
