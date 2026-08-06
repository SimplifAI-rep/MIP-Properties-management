import { useRef } from 'react';

type FileFieldProps = {
  accept?: string;
  className?: string;
  file?: File | null;
  emptyLabel?: string;
  onChange: (file: File | null) => void;
};

export function FileField({
  accept,
  className,
  file,
  emptyLabel = 'Choose file',
  onChange,
}: FileFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(event) => {
          onChange(event.target.files?.[0] ?? null);
          // Allow re-selecting the same file after clear/change.
          event.target.value = '';
        }}
      />
      <button
        type="button"
        className="field w-full truncate text-left"
        onClick={() => inputRef.current?.click()}
      >
        {file ? file.name : emptyLabel}
      </button>
    </div>
  );
}
