import { useEffect, useState } from 'react';
import { dmyToIso, isoToDmy } from '../../utils/dateFormat';

interface DateInputDMYProps {
  label?: string;
  value?: string;
  onChange: (iso: string | undefined) => void;
  className?: string;
  inputClassName?: string;
}

/** Text date input that displays and accepts dd/mm/yyyy; stores ISO internally. */
export function DateInputDMY({
  label,
  value,
  onChange,
  className = 'text-sm',
  inputClassName = 'field',
}: DateInputDMYProps) {
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
      <input
        type="text"
        inputMode="numeric"
        className={`${inputClassName} ${invalid ? 'border-rose-500' : ''}`}
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
      {invalid ? (
        <span className="mt-1 block text-xs text-negative">Use dd/mm/yyyy</span>
      ) : null}
    </label>
  );
}
