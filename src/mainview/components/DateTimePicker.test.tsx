import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DateTimePicker } from "./DateTimePicker";

let root: Root;
let container: HTMLElement;

function render(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(ui));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DateTimePicker", () => {
  test("opens the calendar and selecting a day reports midnight of that day", () => {
    const onDateChange = mock(() => {});
    render(<DateTimePicker variant="date" dateValue={null} onDateChange={onDateChange} />);

    const trigger = container.querySelector<HTMLButtonElement>(".dtp-date-btn");
    expect(trigger?.textContent).toContain("Select date");
    act(() => trigger?.click());

    const days = container.querySelectorAll<HTMLButtonElement>(".calendar-day");
    expect(days.length).toBeGreaterThanOrEqual(28);
    const fifteenth = [...days].find((d) => d.textContent === "15");
    act(() => fifteenth?.click());

    expect(onDateChange).toHaveBeenCalledTimes(1);
    const reported = (onDateChange.mock.calls[0] as unknown[])[0] as Date;
    expect(reported.getDate()).toBe(15);
    expect(reported.getHours()).toBe(0);
    expect(container.querySelector(".dtp-popover")).toBeNull();
  });

  test("disables days outside min/max bounds", () => {
    const now = new Date();
    const min = new Date(now.getFullYear(), now.getMonth(), 10);
    const max = new Date(now.getFullYear(), now.getMonth(), 20);
    render(
      <DateTimePicker variant="date" dateValue={null} onDateChange={() => {}} minDate={min} maxDate={max} />,
    );

    act(() => container.querySelector<HTMLButtonElement>(".dtp-date-btn")?.click());
    const days = [...container.querySelectorAll<HTMLButtonElement>(".calendar-day")];
    expect(days.find((d) => d.textContent === "5")?.disabled).toBe(true);
    expect(days.find((d) => d.textContent === "15")?.disabled).toBe(false);
    expect(days.find((d) => d.textContent === "25")?.disabled).toBe(true);
  });

  test("editOnly masks and parses MM/DD/YYYY input", () => {
    const onDateChange = mock(() => {});
    render(<DateTimePicker variant="date" editOnly dateValue={null} onDateChange={onDateChange} />);

    const input = container.querySelector<HTMLInputElement>("input.input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      if (!input) return;
      setter?.call(input, "07/15/2026");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onDateChange).toHaveBeenCalledTimes(1);
    const reported = (onDateChange.mock.calls[0] as unknown[])[0] as Date;
    expect([reported.getFullYear(), reported.getMonth(), reported.getDate()]).toEqual([2026, 6, 15]);
  });

  test("month variant reports the first of the chosen month", () => {
    const onDateChange = mock(() => {});
    render(<DateTimePicker variant="month" dateValue={new Date(2026, 3, 1)} onDateChange={onDateChange} />);

    const monthTrigger = container.querySelector<HTMLButtonElement>(".dtp-month-select .select-trigger");
    expect(monthTrigger?.textContent).toContain("April");
    act(() => monthTrigger?.click());

    const july = [...document.querySelectorAll<HTMLButtonElement>(".option")].find(
      (o) => o.textContent === "July",
    );
    act(() => july?.click());

    const reported = (onDateChange.mock.calls[0] as unknown[])[0] as Date;
    expect([reported.getFullYear(), reported.getMonth(), reported.getDate()]).toEqual([2026, 6, 1]);
  });
});
