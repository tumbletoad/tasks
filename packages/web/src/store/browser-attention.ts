// Whether the tab is visible and its window focused, as the browser says: what the Agents page
// tells the service, so the Agent Monitor is asked at the pace of the person's attention.

/** Whether the tab is visible and its window focused, and a way to hear when either changes. */
export interface Attention {
  visible(): boolean;
  focused(): boolean;
  onChange(listener: () => void): () => void;
}

export function browserAttention(): Attention {
  return {
    visible: () => document.visibilityState === "visible",
    focused: () => document.hasFocus(),
    onChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      window.addEventListener("focus", listener);
      window.addEventListener("blur", listener);
      return () => {
        document.removeEventListener("visibilitychange", listener);
        window.removeEventListener("focus", listener);
        window.removeEventListener("blur", listener);
      };
    },
  };
}
