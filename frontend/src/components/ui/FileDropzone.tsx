import { useRef, useState, type ReactNode } from 'react';

/**
 * Upload control with a real (focusable, truly disabled) button plus drag & drop.
 * Replaces the label-wrapping-a-hidden-input pattern, where a disabled input
 * left the button looking clickable while doing nothing.
 */
export function FileDropzone({
  label,
  busyLabel = 'Uploading…',
  hint = 'or drag the Excel file here',
  accept = '.xlsx,.xls',
  busy = false,
  disabled = false,
  disabledHint,
  onFile,
  children,
}: {
  label: string;
  busyLabel?: string;
  hint?: string;
  accept?: string;
  busy?: boolean;
  disabled?: boolean;
  /** Shown instead of the hint when the control is unavailable. */
  disabledHint?: string;
  onFile: (file: File) => void;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const blocked = disabled || busy;

  return (
    <div
      onDragOver={(event) => {
        if (blocked) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        setDragOver(false);
        if (blocked) return;
        event.preventDefault();
        const file = event.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
      className={`rounded-lg border border-dashed px-4 py-5 text-center transition-colors ${
        dragOver
          ? 'border-slate-500 bg-slate-50 dark:border-slate-400 dark:bg-slate-800/60'
          : 'border-slate-300 dark:border-slate-600'
      }`}
    >
      {children ? <div className="mb-3">{children}</div> : null}
      <button
        type="button"
        className="btn-primary"
        disabled={blocked}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? busyLabel : label}
      </button>
      <p className="mt-2 text-xs muted-text">
        {blocked && disabledHint ? disabledHint : hint}
      </p>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
    </div>
  );
}
