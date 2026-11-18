/** The live site's address. The search and share tags, robots.txt, and sitemap.xml name it. */
export const SITE_URL = "https://materialize-3d.pages.dev/";

export type Theme = "light" | "dark";

/** The localStorage key that remembers the dark mode choice. */
export const THEME_KEY = "m3d-theme";

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
