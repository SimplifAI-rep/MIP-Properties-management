import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip';

export interface FilterOption {
  value: string;
  label: string;
}

interface SearchableMultiSelectProps {
  label: string;
  tip?: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
}

export function SearchableMultiSelect({
  label,
  tip,
  options,
  selected,
  onChange,
  placeholder = 'All',
  searchPlaceholder = 'Search…',
}: SearchableMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const summary = useMemo(() => {
    if (selected.length === 0) return placeholder;
    if (selected.length === 1) {
      return options.find((option) => option.value === selected[0])?.label ?? selected[0];
    }
    return `${selected.length} selected`;
  }, [options, placeholder, selected]);

  function toggle(value: string) {
    if (selectedSet.has(value)) {
      onChange(selected.filter((item) => item !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  function selectAllVisible() {
    const merged = new Set(selected);
    filtered.forEach((option) => merged.add(option.value));
    onChange([...merged]);
  }

  function clearAll() {
    onChange([]);
  }

  const labelNode = tip ? <Tooltip content={tip}>{label}</Tooltip> : label;

  return (
    <div className="text-sm relative" ref={rootRef}>
      <span className="label-text">{labelNode}</span>
      <button
        type="button"
        className="field w-full text-left flex items-center justify-between gap-2"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={selected.length === 0 ? 'text-muted' : ''}>{summary}</span>
        <span className="text-muted text-xs">{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <div
          id={listId}
          className="absolute z-30 mt-1 w-full min-w-[14rem] rounded-md border border-border panel shadow-lg"
        >
          <div className="border-b border-border p-2 space-y-2">
            <input
              type="search"
              className="field"
              placeholder={searchPlaceholder}
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onClick={(event) => event.stopPropagation()}
            />
            <div className="flex gap-2">
              <button type="button" className="btn-secondary text-xs" onClick={selectAllVisible}>
                Select all
              </button>
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={selected.length === 0}
                onClick={clearAll}
              >
                Clear
              </button>
            </div>
          </div>
          <ul className="max-h-56 overflow-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted">No matches</li>
            ) : (
              filtered.map((option) => {
                const checked = selectedSet.has(option.value);
                return (
                  <li key={option.value}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(option.value)}
                      />
                      <span className="truncate">{option.label}</span>
                    </label>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
