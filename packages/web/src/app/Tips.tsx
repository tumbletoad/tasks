// The page's one tooltip: the small label an element carries in `data-tip`, shown beside it after a
// short rest of the mouse, and at once when the keyboard brings focus to it. It is never the only
// way to learn what a control does: the element's accessible name, or its `aria-description` when
// the label says more than the name, carries the same words, so the label itself is hidden from
// assistive technology. Escape closes it (WCAG 1.4.13): a label
// the mouse brought, and nothing else; a label of the focused control goes with what Escape closes
// there, so one press still closes the task or the editor. The pointer may move onto a label, and
// it stays while the pointer is on either.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import css from "./Tips.module.css";
import { classes } from "./css.ts";

const styles = classes(css, ["tip"]);

/** How long the mouse rests on an element before its label shows. */
const REST_MS = 500;
/** How long the label waits for the pointer to come onto it before it goes. */
const GRACE_MS = 150;
const GAP = 6;
const MARGIN = 8;

interface Shown {
  readonly text: string;
  readonly anchor: DOMRect;
}

const tipOf = (target: EventTarget | null): HTMLElement | undefined => {
  if (!(target instanceof Element)) return undefined;
  const element = target.closest<HTMLElement>("[data-tip]");
  return element === null || element.dataset["tip"] === "" ? undefined : element;
};

export function Tips() {
  const [shown, setShown] = useState<Shown | undefined>(undefined);
  const [place, setPlace] = useState<{ left: number; top: number } | undefined>(undefined);
  const label = useRef<HTMLDivElement>(null);
  /** The pointer is on the label. */
  const over = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The element whose label shows, or is about to. */
    let current: HTMLElement | undefined;
    let visible = false;
    /** The label shows for keyboard focus, not for the mouse. */
    let focused = false;
    const show = (element: HTMLElement, delay: number, byFocus = false) => {
      clearTimeout(timer);
      current = element;
      focused = byFocus;
      timer = setTimeout(() => {
        const text = element.dataset["tip"];
        if (!element.isConnected || text === undefined || text === "") return;
        visible = true;
        setShown({ text, anchor: element.getBoundingClientRect() });
      }, delay);
    };
    const hide = () => {
      clearTimeout(timer);
      current = undefined;
      over.current = false;
      if (!visible) return;
      visible = false;
      setShown(undefined);
    };
    const onOver = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (label.current?.contains(event.target as Node) === true) {
        clearTimeout(timer);
        return;
      }
      const element = tipOf(event.target);
      if (element === current) return;
      if (element === undefined) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!over.current) hide();
        }, GRACE_MS);
        return;
      }
      // From one labelled element to the next, the label follows at once.
      show(element, visible ? 0 : REST_MS);
    };
    const onFocus = (event: FocusEvent) => {
      const element = tipOf(event.target);
      if (element !== undefined && element === event.target && element.matches(":focus-visible")) {
        show(element, 0, true);
      } else hide();
    };
    const onBlur = () => {
      hide();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !visible) return;
      if (!focused) {
        event.preventDefault();
        event.stopPropagation();
      }
      hide();
    };
    const onScroll = () => {
      hide();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  // Below its element, or above when there is no room; never past the window's edges.
  useLayoutEffect(() => {
    const element = label.current;
    if (shown === undefined || element === null) {
      setPlace(undefined);
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    const { anchor } = shown;
    const below = anchor.bottom + GAP;
    const top = below + height > window.innerHeight - MARGIN ? anchor.top - GAP - height : below;
    const left = Math.min(
      Math.max(MARGIN, anchor.left + anchor.width / 2 - width / 2),
      window.innerWidth - MARGIN - width,
    );
    setPlace({ left, top: Math.max(MARGIN, top) });
  }, [shown]);

  if (shown === undefined) return null;
  return (
    <div
      ref={label}
      className={styles.tip}
      role="tooltip"
      aria-hidden="true"
      data-placed={place !== undefined}
      style={place === undefined ? undefined : { left: place.left, top: place.top }}
      onPointerEnter={() => {
        over.current = true;
      }}
      onPointerLeave={() => {
        over.current = false;
      }}
    >
      {shown.text}
    </div>
  );
}
