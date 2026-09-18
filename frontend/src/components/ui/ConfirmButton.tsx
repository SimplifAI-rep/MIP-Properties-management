import { useEffect, useState } from 'react';
import { VerifySpinner } from '../verifyGroups';

/**
 * Two-step button for bulk actions that touch many rows at once.
 * First click arms it, second click runs it; it disarms itself after a few seconds.
 */
export function ConfirmButton({
  label,
  confirmLabel = 'Yes',
  onConfirm,
  disabled = false,
  pending = false,
  className = 'btn-secondary text-xs',
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  pending?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (pending) return <VerifySpinner />;

  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        className="btn-danger text-xs"
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="btn-secondary text-xs"
        onClick={() => setArmed(false)}
      >
        Cancel
      </button>
    </span>
  );
}
