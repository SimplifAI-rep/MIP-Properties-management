import { useEffect, useId, useState } from 'react';
import { dmyToIso, isoToDmy } from '../../utils/dateFormat';

interface DateInputDMYProps {
  label?: string;
  value?: string;
  onChange: (iso: string | undefined) => void;
  className?: string;
  inputClassName?: string;
  required?: boolean;
}

/** Text date input (dd/mm/yyyy) with a calendar picker; stores ISO internally. */
export function DateInputDMY({
  label,
  value,
  onChange,
  className = 'text-sm',
  inputClassName = 'field',
  required = false,
}: DateInputDMYProps) {
  const pickerId = useId();
  const [text, setText] = useState(() => isoToDmy(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(isoToDmy(value));
    setInvalid(false);
  }, [value]);

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      setInvalid(false);
      setText('');
      onChange(undefined);
      return;
    }
    const iso = dmyToIso(trimmed);
    if (!iso) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(isoToDmy(iso));
    onChange(iso);
  }

  return (
    <label className={className}>
      {label ? <span className="label-text">{label}</span> : null}
      <div className="relative flex items-center gap-1">
        <input
          type="text"
          inputMode="numeric"
          required={required}
          className={`${inputClassName} min-w-0 flex-1 ${invalid ? 'border-rose-500' : ''}`}
          placeholder="dd/mm/yyyy"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
          }}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
        />
        <span className="relative inline-flex shrink-0">
          <span className="btn-icon pointer-events-none" aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c0-.69.56-1.25 1.25-1.25h10.5c.69 0 1.25.56 1.25 1.25v8.25c0 .69-.56 1.25-1.25 1.25H6c-.69 0-1.25-.56-1.25-1.25V7.5Z"
                clipRule="evenodd"
              />
            </svg>
          </span>
          <input
            id={pickerId}
            type="date"
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label={label ? `Pick ${label}` : 'Pick date'}
            title="Open calendar"
            value={value ?? ''}
            onChange={(event) => {
              const next = event.target.value || undefined;
              setInvalid(false);
              setText(isoToDmy(next));
              onChange(next);
            }}
          />
        </span>
      </div>
      {invalid ? (
        <span className="mt-1 block text-xs text-negative">Use dd/mm/yyyy</span>
      ) : null}
    </label>
  );
}
