import { release } from "../release";

/** The download, labelled with the release's architecture. */
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

/** While the release is not the chat studio, the page says so next to every download. */
export function ReleaseNote() {
  if (release.studio) return null;
  return (
    <p className="release-note">
      The chat studio is not in a release yet. This download is {release.version}, the earlier sign app.
    </p>
  );
}
