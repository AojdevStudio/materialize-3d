import { release } from "../release";

export function DownloadLink() {
  return (
    <a className="cta-primary" href={release.dmgUrl}>
      Download for Mac ({release.architecture})
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <path d="M7 1v9M3 6.5 7 10.5l4-4M1.5 13h11" />
      </svg>
    </a>
  );
}
