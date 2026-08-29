import { useEffect, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

/**
 * A dropdown that can show an icon per option.
 *
 * A native `<select>` cannot render markup inside `<option>`, and its chevron
 * position is browser-controlled and unstyleable. This is the smallest thing
 * that solves both.
 */
export function Select({ value, options, onChange, ariaLabel }: SelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="select" ref={rootRef}>
      <button
        type="button"
        className={`select-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {selected?.icon && <span className="select-icon">{selected.icon}</span>}
        <span className="select-label">{selected?.label ?? value}</span>
        <svg className="select-chevron" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <ul className="select-menu" role="listbox">
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? "selected" : ""}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.icon && <span className="select-icon">{option.icon}</span>}
                <span className="select-label">{option.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
