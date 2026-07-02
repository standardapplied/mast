import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  convertTo24Hour,
  formatDateDisplay,
  isDateDisabled,
  isSameDay,
  type TimeValue,
} from "../lib/date-utils";
import { cx } from "./cx";
import { CalendarDot, CaretLeft, CaretRight } from "./icons";
import { Select } from "./Select";

export type DateTimePickerProps = {
  dateValue: Date | null;
  timeValue?: TimeValue | null;
  onDateChange: (date: Date | null) => void;
  onTimeChange?: (time: TimeValue | null) => void;
  label?: string;
  datePlaceholder?: string;
  className?: string;
  minDate?: Date;
  maxDate?: Date;
  minTime?: TimeValue;
  timeIncrement?: number;
  variant?: "datetime" | "date" | "month";
  error?: string;
  editOnly?: boolean;
  disabled?: boolean;
};

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type PopoverPosition = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

/**
 * Date / date+time / month picker ported from light-grid-wapp (desktop popover
 * path): calendar with month/year jump view, segmented hh:mm AM/PM keyboard
 * entry, viewport-aware flip positioning, and a masked MM/DD/YYYY edit-only
 * variant.
 */
export const DateTimePicker = ({
  dateValue,
  timeValue,
  onDateChange,
  onTimeChange,
  label,
  datePlaceholder = "Select date",
  className,
  minDate,
  maxDate,
  minTime,
  timeIncrement = 30,
  variant = "datetime",
  error,
  editOnly = false,
  disabled = false,
}: DateTimePickerProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"date" | "time">("date");
  const [isFocused, setIsFocused] = useState(false);
  const [datePosition, setDatePosition] = useState<PopoverPosition>({
    top: 0,
    left: 0,
    width: 300,
    maxHeight: 420,
  });
  const [timePosition, setTimePosition] = useState<PopoverPosition>({
    top: 0,
    left: 0,
    width: 140,
    maxHeight: 420,
  });

  const hasError = !!error;

  const [viewDate, setViewDate] = useState(() => dateValue || new Date());
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [dateInputValue, setDateInputValue] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const hoursInputRef = useRef<HTMLInputElement>(null);
  const minutesInputRef = useRef<HTMLInputElement>(null);
  const periodInputRef = useRef<HTMLInputElement>(null);

  const hours = timeValue?.hours ?? 12;
  const minutes = timeValue?.minutes ?? 0;
  const period = timeValue?.period ?? "PM";

  useEffect(() => {
    if (!editOnly) return;
    if (dateValue) {
      const month = (dateValue.getMonth() + 1).toString().padStart(2, "0");
      const day = dateValue.getDate().toString().padStart(2, "0");
      setDateInputValue(`${month}/${day}/${dateValue.getFullYear()}`);
    } else {
      setDateInputValue("");
    }
  }, [dateValue, editOnly]);

  useEffect(() => {
    if (dateValue) setViewDate(dateValue);
  }, [dateValue]);

  const updatePosition = useCallback(() => {
    if (!containerRef.current || !isOpen) return;
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);

    animationFrameRef.current = requestAnimationFrame(() => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      const VERTICAL_GAP = 4;
      const VIEWPORT_PADDING = 16;
      const IDEAL_HEIGHT = 330;

      const spaceBelow = viewportHeight - rect.bottom - VERTICAL_GAP;
      const spaceAbove = rect.top - VERTICAL_GAP;
      const shouldShowAbove = spaceBelow < IDEAL_HEIGHT && spaceAbove > spaceBelow;
      const maxHeight = shouldShowAbove
        ? Math.min(IDEAL_HEIGHT, spaceAbove - VIEWPORT_PADDING)
        : Math.min(IDEAL_HEIGHT, spaceBelow - VIEWPORT_PADDING);

      const width = activeTab === "date" ? 300 : 140;
      let left = activeTab === "date" ? rect.left : rect.right - width;
      left = Math.min(left, viewportWidth - width - VIEWPORT_PADDING);
      left = Math.max(left, VIEWPORT_PADDING);

      const position: PopoverPosition = shouldShowAbove
        ? { bottom: viewportHeight - rect.top + VERTICAL_GAP, left, width, maxHeight }
        : { top: rect.bottom + VERTICAL_GAP, left, width, maxHeight };

      if (activeTab === "date") setDatePosition(position);
      else setTimePosition(position);
    });
  }, [isOpen, activeTab]);

  useEffect(() => {
    if (isOpen) updatePosition();
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const daysInMonth = useMemo(
    () => new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate(),
    [viewDate],
  );
  const firstDayOfMonth = useMemo(
    () => new Date(viewDate.getFullYear(), viewDate.getMonth(), 1).getDay(),
    [viewDate],
  );
  const today = useMemo(() => new Date(), []);

  const calendarDays = useMemo(() => {
    const days: (Date | null)[] = [];
    for (let i = 0; i < firstDayOfMonth; i++) days.push(null);
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(new Date(viewDate.getFullYear(), viewDate.getMonth(), i));
    }
    return days;
  }, [viewDate, daysInMonth, firstDayOfMonth]);

  const yearRange = useMemo(() => {
    const currentYear = viewDate.getFullYear();
    const minYear = minDate?.getFullYear() || currentYear - 100;
    const maxYear = maxDate?.getFullYear() || currentYear + 10;
    const years: number[] = [];
    for (let y = minYear; y <= maxYear; y++) years.push(y);
    return years;
  }, [viewDate, minDate, maxDate]);

  const handleDateSelect = useCallback(
    (date: Date) => {
      const selectedDate = new Date(date);
      selectedDate.setHours(0, 0, 0, 0);
      onDateChange(selectedDate);
      setIsOpen(false);
    },
    [onDateChange],
  );

  const handleHoursChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!onTimeChange) return;
      const input = e.target.value;
      if (input === "") return;
      const val = parseInt(input);
      if (isNaN(val) || val < 1 || val > 12) return;

      let newHour = val;
      if (hours >= 1 && hours <= 9 && input.length === 1) {
        newHour = hours * 10 + val;
        if (newHour > 12) newHour = val;
      }
      onTimeChange({ hours: newHour, minutes, period });

      setTimeout(() => {
        if (newHour >= 10 || (input.length === 1 && val > 1)) {
          minutesInputRef.current?.focus();
          minutesInputRef.current?.select();
        } else {
          hoursInputRef.current?.select();
        }
      }, 0);
    },
    [onTimeChange, hours, minutes, period],
  );

  const handleMinutesChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!onTimeChange) return;
      const input = e.target.value;
      if (input === "") return;
      const val = parseInt(input);
      if (isNaN(val) || val < 0 || val > 59) return;

      let newMinutes = val;
      if (minutes >= 0 && minutes <= 5 && input.length === 1) {
        newMinutes = minutes * 10 + val;
        if (newMinutes > 59) newMinutes = val;
      }
      onTimeChange({ hours, minutes: newMinutes, period });

      setTimeout(() => {
        if (newMinutes >= 10 || (input.length === 1 && val > 5)) {
          periodInputRef.current?.focus();
          periodInputRef.current?.select();
        } else {
          minutesInputRef.current?.select();
        }
      }, 0);
    },
    [onTimeChange, hours, minutes, period],
  );

  const handlePeriodChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!onTimeChange) return;
      const lastChar = e.target.value.toUpperCase().slice(-1);
      if (lastChar === "A" && period !== "AM") {
        onTimeChange({ hours, minutes, period: "AM" });
        setTimeout(() => periodInputRef.current?.select(), 0);
      } else if (lastChar === "P" && period !== "PM") {
        onTimeChange({ hours, minutes, period: "PM" });
        setTimeout(() => periodInputRef.current?.select(), 0);
      }
    },
    [onTimeChange, hours, minutes, period],
  );

  const handleHoursKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        minutesInputRef.current?.focus();
        minutesInputRef.current?.select();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (!onTimeChange) return;
        e.preventDefault();
        const delta = e.key === "ArrowUp" ? 1 : -1;
        const newHour = ((hours - 1 + delta + 12) % 12) + 1;
        onTimeChange({ hours: newHour, minutes, period });
        setTimeout(() => hoursInputRef.current?.select(), 0);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        minutesInputRef.current?.focus();
        minutesInputRef.current?.select();
      } else if (e.key.toLowerCase() === "a" || e.key.toLowerCase() === "p") {
        e.preventDefault();
        periodInputRef.current?.focus();
        periodInputRef.current?.select();
      }
    },
    [onTimeChange, hours, minutes, period],
  );

  const handleMinutesKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const target = e.shiftKey ? hoursInputRef : periodInputRef;
        target.current?.focus();
        target.current?.select();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (!onTimeChange) return;
        e.preventDefault();
        const delta = e.key === "ArrowUp" ? 1 : -1;
        const newMinutes = (minutes + delta + 60) % 60;
        onTimeChange({ hours, minutes: newMinutes, period });
        setTimeout(() => minutesInputRef.current?.select(), 0);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        hoursInputRef.current?.focus();
        hoursInputRef.current?.select();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        periodInputRef.current?.focus();
        periodInputRef.current?.select();
      } else if (e.key.toLowerCase() === "a" || e.key.toLowerCase() === "p") {
        e.preventDefault();
        periodInputRef.current?.focus();
        periodInputRef.current?.select();
      }
    },
    [onTimeChange, hours, minutes, period],
  );

  const handlePeriodKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        minutesInputRef.current?.focus();
        minutesInputRef.current?.select();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (!onTimeChange) return;
        e.preventDefault();
        onTimeChange({ hours, minutes, period: period === "AM" ? "PM" : "AM" });
        setTimeout(() => periodInputRef.current?.select(), 0);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        minutesInputRef.current?.focus();
        minutesInputRef.current?.select();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
      }
    },
    [onTimeChange, hours, minutes, period],
  );

  const handleDateInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const allowedKeys = ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"];
    const isNumber = /^[0-9]$/.test(e.key);
    if (!allowedKeys.includes(e.key) && !isNumber && e.key !== "/") {
      e.preventDefault();
      return;
    }

    if (e.key === "Backspace") {
      const input = e.currentTarget;
      const cursorPos = input.selectionStart || 0;
      const value = input.value;
      if (cursorPos > 0 && value[cursorPos - 1] === "/") {
        e.preventDefault();
        setDateInputValue(value.slice(0, cursorPos - 2) + value.slice(cursorPos));
        setTimeout(() => input.setSelectionRange(cursorPos - 2, cursorPos - 2), 0);
      }
    }
  }, []);

  const parseMasked = (value: string): Date | null => {
    const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    const month = parseInt(match[1]!, 10);
    const day = parseInt(match[2]!, 10);
    const year = parseInt(match[3]!, 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day);
    const valid =
      date.getMonth() === month - 1 && date.getDate() === day && date.getFullYear() === year;
    return valid ? date : null;
  };

  const handleDateInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      let value = e.target.value.replace(/[^0-9/]/g, "");

      const parts = value.split("/");
      if (parts.length > 3) value = parts.slice(0, 3).join("/");
      if (parts[0] && parts[0].length > 2) parts[0] = parts[0].slice(0, 2);
      if (parts[1] && parts[1].length > 2) parts[1] = parts[1].slice(0, 2);
      if (parts[2] && parts[2].length > 4) parts[2] = parts[2].slice(0, 4);
      value = parts.join("/");

      const digitsOnly = value.replace(/\//g, "");
      if (digitsOnly.length >= 2 && !value.includes("/")) {
        value = digitsOnly.slice(0, 2).padStart(2, "0") + "/" + digitsOnly.slice(2);
      } else if (digitsOnly.length >= 4 && value.split("/").length === 2) {
        const [mm, rest] = value.split("/") as [string, string];
        value = mm.padStart(2, "0") + "/" + rest.slice(0, 2).padStart(2, "0") + "/" + rest.slice(2);
      }

      setDateInputValue(value);
      const parsed = parseMasked(value);
      if (parsed) onDateChange(parsed);
    },
    [onDateChange],
  );

  const handleDateInputBlur = useCallback(() => {
    setIsFocused(false);

    const parts = dateInputValue.split("/");
    if (parts[0]) parts[0] = parts[0].padStart(2, "0");
    if (parts[1]) parts[1] = parts[1].padStart(2, "0");
    const formatted = parts.join("/");

    const parsed = parseMasked(formatted);
    if (parsed) {
      if (formatted !== dateInputValue) setDateInputValue(formatted);
      onDateChange(parsed);
      return;
    }

    if (dateValue) {
      const month = (dateValue.getMonth() + 1).toString().padStart(2, "0");
      const day = dateValue.getDate().toString().padStart(2, "0");
      setDateInputValue(`${month}/${day}/${dateValue.getFullYear()}`);
    } else {
      setDateInputValue("");
    }
  }, [dateInputValue, dateValue, onDateChange]);

  const displayDate = useMemo(() => {
    if (!dateValue) return datePlaceholder;
    if (variant === "month") {
      return dateValue.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }
    return formatDateDisplay(dateValue);
  }, [dateValue, datePlaceholder, variant]);

  const timeOptions = useMemo(() => {
    const options: Array<TimeValue & { label: string }> = [];
    for (const p of ["AM", "PM"] as const) {
      for (const h of [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
        for (let m = 0; m < 60; m += timeIncrement) {
          if (minTime) {
            const hour24 = convertTo24Hour(h, p);
            const minHour24 = convertTo24Hour(minTime.hours, minTime.period);
            if (hour24 < minHour24) continue;
            if (hour24 === minHour24 && m < minTime.minutes) continue;
          }
          const label = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")} ${p}`;
          options.push({ hours: h, minutes: m, period: p, label });
        }
      }
    }
    return options;
  }, [minTime, timeIncrement]);

  const handleTimeSelect = useCallback(
    (time: TimeValue) => {
      if (!onTimeChange) return;
      onTimeChange(time);
      setIsOpen(false);
    },
    [onTimeChange],
  );

  const fieldLabel = label && (
    <span
      className={cx("field-label", hasError && "is-error", !hasError && isFocused && "is-focused")}
    >
      {label}
    </span>
  );

  const renderCalendar = () => (
    <div className="calendar">
      {!showYearPicker ? (
        <>
          <div className="calendar-header">
            <button
              type="button"
              onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))}
              className="calendar-nav"
              aria-label="Previous month"
            >
              <CaretLeft size={13} />
            </button>
            <button type="button" onClick={() => setShowYearPicker(true)} className="calendar-title">
              {MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}
            </button>
            <button
              type="button"
              onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))}
              className="calendar-nav"
              aria-label="Next month"
            >
              <CaretRight size={13} />
            </button>
          </div>
          <div className="calendar-grid">
            {DAYS.map((day) => (
              <div key={day} className="calendar-dow">
                {day}
              </div>
            ))}
            {calendarDays.map((date, index) => {
              if (!date) return <div key={`empty-${index}`} className="calendar-empty" />;

              const isSelected = isSameDay(date, dateValue);
              const isToday = isSameDay(date, today);
              const isDisabled = isDateDisabled(date, minDate, maxDate);

              return (
                <button
                  key={date.toISOString()}
                  type="button"
                  onClick={() => !isDisabled && handleDateSelect(date)}
                  disabled={isDisabled}
                  className={cx(
                    "calendar-day",
                    isSelected && "is-selected",
                    isToday && !isSelected && "is-today",
                  )}
                  aria-label={date.toLocaleDateString()}
                  aria-pressed={isSelected}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="calendar-header calendar-year-header">
            <button
              type="button"
              onClick={() => setShowYearPicker(false)}
              className="calendar-nav"
              aria-label="Back to calendar"
            >
              <CaretLeft size={13} />
            </button>
            <span className="calendar-title-static">Month &amp; year</span>
            <span className="calendar-nav-spacer" />
          </div>
          <div className="calendar-month-grid">
            {MONTHS.map((month, index) => (
              <button
                key={month}
                type="button"
                onClick={() => {
                  setViewDate(new Date(viewDate.getFullYear(), index, 1));
                  setShowYearPicker(false);
                }}
                className={cx("calendar-cell", index === viewDate.getMonth() && "is-selected")}
              >
                {month.slice(0, 3)}
              </button>
            ))}
          </div>
          <div className="calendar-divider" />
          <div className="calendar-year-grid">
            {yearRange.map((year) => (
              <button
                key={year}
                type="button"
                onClick={() => {
                  setViewDate(new Date(year, viewDate.getMonth(), 1));
                  setShowYearPicker(false);
                }}
                className={cx("calendar-cell", year === viewDate.getFullYear() && "is-selected")}
              >
                {year}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );

  if (variant === "month") {
    const currentYear = new Date().getFullYear();
    const minYear = minDate?.getFullYear() || currentYear - 90;
    const maxYear = maxDate?.getFullYear() || currentYear + 10;
    const selectedYear = dateValue?.getFullYear();
    const selectedMonth = dateValue?.getMonth();

    const availableMonths = MONTHS.map((month, index) => {
      let isMonthDisabled = false;
      if (selectedYear !== undefined) {
        if (minDate && selectedYear === minDate.getFullYear()) {
          isMonthDisabled = index < minDate.getMonth();
        }
        if (maxDate && selectedYear === maxDate.getFullYear()) {
          isMonthDisabled = isMonthDisabled || index > maxDate.getMonth();
        }
      }
      return { value: index.toString(), label: month, disabled: isMonthDisabled };
    }).filter((m) => !m.disabled);

    const years = [];
    for (let y = minYear; y <= maxYear; y++) years.push({ value: y.toString(), label: y.toString() });

    return (
      <div className={cx("field", className)}>
        {fieldLabel}
        <div className="dtp-month-row">
          <Select
            value={selectedMonth?.toString() || ""}
            onChange={(monthValue) => {
              onDateChange(new Date(selectedYear || currentYear, parseInt(monthValue), 1));
            }}
            options={availableMonths}
            placeholder="Month"
            className="dtp-month-select"
          />
          <Select
            value={selectedYear?.toString() || ""}
            onChange={(yearValue) => {
              onDateChange(new Date(parseInt(yearValue), selectedMonth ?? 0, 1));
            }}
            options={years}
            placeholder="Year"
            className="dtp-year-select"
          />
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
    );
  }

  if (editOnly) {
    return (
      <div className={cx("field", className)}>
        {fieldLabel}
        <input
          type="text"
          inputMode="numeric"
          value={dateInputValue}
          onChange={handleDateInputChange}
          onKeyDown={handleDateInputKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={handleDateInputBlur}
          placeholder={datePlaceholder || "MM/DD/YYYY"}
          className={cx("input", hasError && "is-error")}
        />
        {error && <p className="field-error">{error}</p>}
      </div>
    );
  }

  const position = activeTab === "date" ? datePosition : timePosition;

  return (
    <div className={cx("field", className)}>
      {fieldLabel}
      <div ref={containerRef} className="dtp">
        <div className={cx("dtp-control", hasError && "is-error", disabled && "is-disabled")}>
          <button
            type="button"
            onClick={() => {
              if (disabled) return;
              setActiveTab("date");
              setIsOpen(true);
            }}
            disabled={disabled}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            className={cx("dtp-date-btn", !dateValue && "is-placeholder")}
          >
            <span className="dtp-date-text">{displayDate}</span>
            {variant === "date" && <CalendarDot size={14} className="dtp-calendar-icon" />}
          </button>

          {variant === "datetime" && (
            <div className="dtp-time">
              <input
                ref={hoursInputRef}
                type="text"
                inputMode="numeric"
                maxLength={2}
                value={hours.toString().padStart(2, "0")}
                onChange={handleHoursChange}
                onKeyDown={handleHoursKeyDown}
                onBlur={() => setIsFocused(false)}
                onFocus={(e) => {
                  setIsFocused(true);
                  setActiveTab("time");
                  setIsOpen(true);
                  e.target.select();
                }}
                className="dtp-segment"
                aria-label="Hours"
              />
              <span className="dtp-colon">:</span>
              <input
                ref={minutesInputRef}
                type="text"
                inputMode="numeric"
                maxLength={2}
                value={minutes.toString().padStart(2, "0")}
                onChange={handleMinutesChange}
                onKeyDown={handleMinutesKeyDown}
                onBlur={() => setIsFocused(false)}
                onFocus={(e) => {
                  setIsFocused(true);
                  setActiveTab("time");
                  setIsOpen(true);
                  e.target.select();
                }}
                className="dtp-segment"
                aria-label="Minutes"
              />
              <input
                ref={periodInputRef}
                type="text"
                maxLength={2}
                value={period}
                onChange={handlePeriodChange}
                onKeyDown={handlePeriodKeyDown}
                onBlur={() => setIsFocused(false)}
                onFocus={(e) => {
                  setIsFocused(true);
                  setActiveTab("time");
                  setIsOpen(true);
                  e.target.select();
                }}
                className="dtp-segment dtp-period"
                aria-label="AM/PM"
              />
            </div>
          )}
        </div>

        {isOpen && (
          <>
            <div className="dtp-backdrop" onClick={() => setIsOpen(false)} />
            <div
              style={{
                position: "fixed",
                ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
              className="dtp-popover"
            >
              <div className="dtp-popover-scroll">
                {activeTab === "date" ? (
                  renderCalendar()
                ) : (
                  <div className="option-list">
                    {timeOptions.map((option) => {
                      const selected =
                        timeValue?.hours === option.hours &&
                        timeValue?.minutes === option.minutes &&
                        timeValue?.period === option.period;
                      return (
                        <button
                          key={option.label}
                          type="button"
                          onClick={() => handleTimeSelect(option)}
                          className={cx("option", selected && "is-selected")}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
};
