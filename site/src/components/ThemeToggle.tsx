import { useState } from "react";
import { currentTheme, THEME_KEY, type Theme } from "../site";

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
    <button type="button" className="theme-toggle" aria-pressed={dark} aria-label="Dark mode" onClick={toggle}>
      <span>Dark</span>
      <i aria-hidden="true" />
    </button>
  );
}
