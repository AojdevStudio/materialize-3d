import markSmall from "../assets/brand/mark-small-32.svg";
import oflUrl from "../assets/fonts/OFL.txt?url";
import { blogUrl, licenseUrl, release } from "../release";

/** The footer on every page: the project links, then a rule and the legal line. */
export function SiteFooter({ page }: { page: "home" | "privacy" }) {
  return (
    <footer className="site-footer">
      <img src={markSmall} alt="" width={20} height={20} />
      <span>Materialize 3D {release.version}</span>
      <nav aria-label="Project links">
        <a href={release.repoUrl}>Repository</a>
        <a href={release.releasesUrl}>Releases</a>
        <a href={release.docsUrl}>Docs</a>
        <a href={oflUrl}>Font license (SIL OFL 1.1)</a>
        <a href={`${import.meta.env.BASE_URL}licenses/three-LICENSE.txt`}>three.js license (MIT)</a>
      </nav>
      <div className="site-legal">
        <span>© 2026 AOJDevStudios</span>
        <a href={blogUrl}>Blog</a>
        <a href={`${import.meta.env.BASE_URL}privacy`} aria-current={page === "privacy" ? "page" : undefined}>
          Privacy
        </a>
        <a href={licenseUrl}>MIT license</a>
      </div>
    </footer>
  );
}
