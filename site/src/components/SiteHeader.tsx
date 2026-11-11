import type { Ref } from "react";
import { ThemeToggle } from "./ThemeToggle";

/** The page header: the lockup, which goes to `home`, and the theme toggle. Solid once content scrolls under it. */
export function SiteHeader({ home, label, solid, ref }: { home: string; label: string; solid: boolean; ref?: Ref<HTMLElement> }) {
  return (
    <header ref={ref} className="site-header" data-solid={solid || undefined}>
      <a className="lockup" href={home} aria-label={label}>
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="M9 1.5 16 5.2v7.6L9 16.5 2 12.8V5.2z" />
          <path className="lockup-accent" d="M2 5.2 9 9l7-3.8M9 9v7.5" />
        </svg>
        <span>Materialize 3D</span>
      </a>
      <ThemeToggle />
    </header>
  );
}
