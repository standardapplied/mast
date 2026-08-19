import { useEffect, useRef, useState, type ReactNode } from "react";
import { debounce } from "../lib/date-utils";
import { Checkbox } from "./Checkbox";
import { cx } from "./cx";
import { DropdownPanel } from "./DropdownPanel";
import { CaretDown, Spinner } from "./icons";

export type SelectOption = {
  value: string;
  label: string;
  icon?: ReactNode;
  description?: string;
  disabled?: boolean;
};

export type SelectProps = {
  value?: string;
  onChange?: (value: string) => void;
  options?: SelectOption[];
  fetchOptions?: (search: string) => Promise<SelectOption[]>;
  initialOption?: SelectOption | null;
  placeholder?: string;
  className?: string;
  searchable?: boolean;
  label?: string;
  error?: string;
  disabled?: boolean;
  /** Multi-select: option rows carry a Switch, the panel stays open. */
  multiple?: boolean;
  values?: string[];
  onToggle?: (value: string, selected: boolean) => void;
};

/**
 * Custom select ported from light-grid-wapp: plain option list, searchable
 * filtering, or server-backed search via `fetchOptions` (debounced, aborting
 * stale requests). Renders through the viewport-aware DropdownPanel. In
 * `multiple` mode each option row toggles a Switch and the panel stays open;
 * the trigger shows the placeholder with a selected count.
 */
export function Select({
  value,
  onChange,
  options = [],
  fetchOptions,
  initialOption,
  placeholder = "Select...",
  className,
  searchable = false,
  label,
  error,
  disabled = false,
  multiple = false,
  values = [],
  onToggle,
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [serverOptions, setServerOptions] = useState<SelectOption[]>([]);
  const [selectedServerOption, setSelectedServerOption] = useState<SelectOption | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const comboboxRef = useRef<HTMLDivElement>(null);
  const selectedButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debouncedFetchRef = useRef<ReturnType<typeof debounce<[string]>> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const allOptions = fetchOptions ? serverOptions : options;
  const filteredOptions =
    searchable && !fetchOptions
      ? allOptions.filter((opt) => opt.label.toLowerCase().includes(searchValue.toLowerCase()))
      : allOptions;

  const selectedOption =
    allOptions.find((opt) => opt.value === value) ||
    (selectedServerOption?.value === value ? selectedServerOption : null) ||
    (initialOption?.value === value ? initialOption : null);

  useEffect(() => {
    if (!fetchOptions || !isOpen) return;

    const run = (search: string) => {
      abortRef.current?.abort();
      setIsLoading(true);
      abortRef.current = new AbortController();

      fetchOptions(search)
        .then((results) => {
          if (!abortRef.current?.signal.aborted) setServerOptions(results);
        })
        .catch((err) => {
          if (err instanceof Error && err.name !== "AbortError") {
            console.error("Failed to fetch options:", err);
          }
        })
        .finally(() => {
          if (!abortRef.current?.signal.aborted) setIsLoading(false);
        });
    };

    if (!debouncedFetchRef.current) debouncedFetchRef.current = debounce(run, 300);

    if (searchValue === "") {
      debouncedFetchRef.current.cancel();
      run(searchValue);
    } else {
      debouncedFetchRef.current(searchValue);
    }
  }, [searchValue, fetchOptions, isOpen]);

  useEffect(() => {
    if (isOpen) {
      selectedButtonRef.current?.scrollIntoView({ behavior: "instant", block: "nearest" });
    } else {
      setSearchValue("");
    }
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      // The option list portals to document.body, so a click on an option is
      // outside containerRef; closing on that mousedown would swallow the click
      // before it selects. Treat any click inside the floating panel as inside.
      if (containerRef.current?.contains(target)) return;
      if (target.closest?.(".dropdown-panel")) return;
      setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      debouncedFetchRef.current?.cancel();
      abortRef.current?.abort();
    };
  }, []);

  const handleSelect = (optionValue: string) => {
    if (multiple) {
      onToggle?.(optionValue, !values.includes(optionValue));
      return;
    }
    if (fetchOptions) {
      const selected = serverOptions.find((opt) => opt.value === optionValue);
      if (selected) setSelectedServerOption(selected);
    }
    onChange?.(optionValue);
    setIsOpen(false);
  };

  const hasError = !!error;
  const triggerText = multiple
    ? placeholder
    : selectedOption?.label || placeholder;

  return (
    <div ref={containerRef} className={cx("select", className)}>
      {label && (
        <span
          className={cx("field-label", hasError && "is-error", !hasError && isFocused && "is-focused")}
        >
          {label}
        </span>
      )}

      {searchable ? (
        <div
          ref={comboboxRef}
          className={cx("select-combobox", hasError && "is-error", disabled && "is-disabled")}
        >
          <input
            ref={searchInputRef}
            type="text"
            value={isOpen ? searchValue : selectedOption?.label || ""}
            onChange={(e) => {
              setSearchValue(e.target.value);
              if (!isOpen) setIsOpen(true);
            }}
            onFocus={() => {
              setIsFocused(true);
              setSearchValue("");
              if (fetchOptions) setIsLoading(true);
              setIsOpen(true);
            }}
            onBlur={() => setIsFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setIsOpen(false);
                searchInputRef.current?.blur();
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            className="select-search"
          />
          {isLoading ? <Spinner size={14} /> : <CaretDown size={14} className={cx("select-caret", isOpen && "is-open")} />}
        </div>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => !disabled && setIsOpen(!isOpen)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          disabled={disabled}
          className={cx("select-trigger", hasError && "is-error")}
        >
          <span className={cx("select-value", !multiple && !selectedOption && "is-placeholder")}>
            {!multiple && selectedOption?.icon}
            {triggerText}
            {multiple && values.length > 0 && values.length < options.length && (
              <span className="select-count">{values.length}</span>
            )}
          </span>
          <CaretDown size={14} className={cx("select-caret", isOpen && "is-open")} />
        </button>
      )}

      <DropdownPanel triggerRef={searchable ? comboboxRef : triggerRef} isOpen={isOpen} maxHeight={240}>
        <div className="option-list">
          {isLoading && filteredOptions.length === 0 ? (
            <div className="option-empty">
              <Spinner size={16} />
            </div>
          ) : filteredOptions.length === 0 ? (
            <div className="option-empty">No options found</div>
          ) : (
            filteredOptions.map((option) => (
              <button
                key={option.value}
                ref={!multiple && option.value === value ? selectedButtonRef : null}
                type="button"
                disabled={option.disabled}
                onClick={() => handleSelect(option.value)}
                className={cx("option", !multiple && option.value === value && "is-selected")}
                data-testid={`option-${option.value}`}
              >
                {multiple && (
                  <Checkbox checked={values.includes(option.value)} disabled={option.disabled} asIndicator />
                )}
                {option.icon}
                <span className="option-body">
                  <span className="option-label">{option.label}</span>
                  {option.description && (
                    <span className="option-description">{option.description}</span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </DropdownPanel>

      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
