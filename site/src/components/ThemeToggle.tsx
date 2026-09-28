import { useState } from "react";

type Theme = "light" | "dark";

/** Must match the key read by the pre-paint script in index.html. */
const THEME_KEY = "m3d-theme";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Toggles dark mode on <html data-theme> and remembers the choice in localStorage. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const dark = theme === "dark";

  function toggle() {
    const next: Theme = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage can be blocked (private mode); the toggle still works for this visit.
    }
    setTheme(next);
  }

  return (
    <button type="button" className="theme-toggle" aria-pressed={dark} onClick={toggle}>
      <span className="theme-toggle-dot" aria-hidden="true" />
      Dark mode
    </button>
  );
}
