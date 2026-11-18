import { release } from "../release";

/** The release record under the download button. */
export function ReleaseFacts() {
  return (
    <dl className="release-facts">
      <dt>Version</dt>
      <dd>
        {release.version}, tested on {release.testedMacOS}
      </dd>
      <dt>SHA-256</dt>
      <dd>
        <span className="hash">{release.sha256}</span>
      </dd>
      <dt>Apple</dt>
      <dd>Signed and notarized by Apple</dd>
    </dl>
  );
}
