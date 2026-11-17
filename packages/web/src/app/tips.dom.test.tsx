// @vitest-environment happy-dom
//
// The tooltip waits for the mouse to stay a moment, so passing over controls flashes nothing, and
// shows at once for keyboard focus, where a person has nothing to wait for.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Tips } from "./Tips.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let button: HTMLButtonElement;

const label = () => document.querySelector('[role="tooltip"]')?.textContent ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  button = document.createElement("button");
  button.dataset["tip"] = "Settings";
  document.body.append(button);
  root = createRoot(container);
  act(() => {
    root.render(<Tips />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  button.remove();
  vi.useRealTimers();
});

describe("[A7.3.12.m5-11.tips] when the tooltip shows", () => {
  test("for the mouse after it stays a moment, not as it passes", () => {
    act(() => {
      button.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(label()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(label()).toBe("Settings");
  });

  test("for keyboard focus at once", () => {
    act(() => {
      button.focus();
      vi.advanceTimersByTime(0);
    });
    expect(label()).toBe("Settings");
  });
});
