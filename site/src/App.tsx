import { useEffect, useRef, useState } from "react";
import { DownloadLink, ReleaseNote } from "./components/Download";
import { HowItWorks } from "./components/HowItWorks";
import { ReleaseFacts } from "./components/ReleaseFacts";
import { ThemeToggle } from "./components/ThemeToggle";
import markSmall from "./assets/brand/mark-small-32.svg";
import oflUrl from "./assets/fonts/OFL.txt?url";
import { checksumPublished, dmgFileName, release } from "./release";
import { ScrollStory } from "./story/ScrollStory";

type Requirement = { label: string; text: string };

const requirements: readonly Requirement[] = [
  {
    label: "Mac",
    text: "Apple Silicon and macOS 26.0 or later. Intel Macs, Windows, and Linux release builds are not offered.",
  },
  {
    label: "AI sign-in",
    text: "One inference provider: Claude, ChatGPT, or OpenCode Go, by subscription or by API key. Your provider's plan or API charges apply. The app is free.",
  },
  {
    label: "Bambu Studio",
    text: "Bambu Studio 02.08.02.61, installed separately. The agent slices with it. The app never installs or bundles it.",
  },
  { label: "uv", text: "uv and a Python it can run." },
  {
    label: "Printer",
    text: "To print, a Bambu Lab P2S with a 0.4 mm nozzle. The agent slices for its presets. Materialize 3D does not send jobs to the printer.",
  },
];

/** What a download of this release goes through, in order. Each step states the release's honest state. */
const installSteps = [
  <>
    Download <a href={release.dmgUrl}>{dmgFileName}</a>.
    {checksumPublished && (
      <>
        {" "}
        Check it with <code>shasum -a 256 {dmgFileName}</code>. It should print{" "}
        <code className="hash">{release.sha256}</code>.
      </>
    )}
  </>,
  <>Open the DMG.</>,
  <>Drag Materialize 3D to Applications.</>,
  <>
    Launch it from Applications.
    {!release.notarized && (
      <>
        {" "}
        This build has no Apple notarization yet, so macOS blocks the first launch. Open System Settings, then
        Privacy &amp; Security, and click Open Anyway for Materialize 3D.
      </>
    )}
  </>,
  <>Add your Anthropic or OpenAI API key in Settings, under Agent.</>,
  <>
    If Settings, under Bambu Studio, does not show version{" "}
    <a href={release.bambuStudio.releaseUrl}>{release.bambuStudio.version}</a>, click Choose Bambu Studio and
    select that copy.
  </>,
];

/** Height of the fixed header. */
const HEADER = 64;

/**
 * The header is clear over the story and turns solid once the end section slides under it.
 * A one-pixel mark at the top of the end section crosses the header's foot at that moment.
 */
function useSolidHeader() {
  const mark = useRef<HTMLSpanElement>(null);
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const element = mark.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setSolid(entry.boundingClientRect.top < HEADER);
      },
      { rootMargin: `-${HEADER}px 0px 0px 0px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [mark, solid] as const;
}

export function App() {
  const [endMark, solid] = useSolidHeader();
  return (
    <>
      <a className="skip-link" href="#download">
        Skip to the download
      </a>
      <header className="site-header" data-solid={solid || undefined}>
        <a className="lockup" href="#top" aria-label="Materialize 3D, back to top">
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M9 1.5 16 5.2v7.6L9 16.5 2 12.8V5.2z" />
            <path className="lockup-accent" d="M2 5.2 9 9l7-3.8M9 9v7.5" />
          </svg>
          <span>Materialize 3D</span>
        </a>
        <ThemeToggle />
      </header>

      <main id="main">
        <ScrollStory />

        <section className="end" id="download" aria-labelledby="end-title">
          <span ref={endMark} className="end-mark" aria-hidden="true" />
          <div className="end-top">
            <div className="end-head">
              <p className="kick">The end of the scroll</p>
              <h2 id="end-title" className="end-title">
                Materialize <b>3D</b>
              </h2>
            </div>
            <div>
              <p className="end-line">Describe a part. Print the 3MF.</p>
              <p className="end-lede">
                Materialize 3D is a Mac app where you describe a 3D-printable object in a chat, and an agent makes
                it. The agent writes the model, previews it, and slices it to a print-ready 3MF for your printer.
              </p>
              <div className="cta">
                <DownloadLink />
                <a className="cta-secondary" href={release.repoUrl}>
                  GitHub
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M3 11 11 3M5 3h6v6" />
                  </svg>
                </a>
              </div>
              <ReleaseNote />
            </div>
            <ReleaseFacts />
          </div>

          <HowItWorks />

          <div className="end-columns">
            <section id="requirements" aria-labelledby="req-title">
              <h2 id="req-title" className="end-heading">
                Requirements
              </h2>
              <dl className="rows">
                {requirements.map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.text}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section id="install" aria-labelledby="install-title">
              <h2 id="install-title" className="end-heading">
                Install
              </h2>
              <ol className="install-steps">
                {installSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </section>
          </div>

          <p className="fine">
            <span>Layer counts and temperatures on this page are illustrative</span>
            <span>Printer model built in Blender for this page</span>
          </p>
        </section>
      </main>

      <footer className="site-footer">
        <img src={markSmall} alt="" width={20} height={20} />
        <span>Materialize 3D {release.version}</span>
        <nav aria-label="Project links">
          <a href={release.repoUrl}>Repository</a>
          <a href={release.releasesUrl}>Releases</a>
          <a href={release.docsUrl}>Docs</a>
          <a href={oflUrl}>Font license (SIL OFL 1.1)</a>
        </nav>
      </footer>
    </>
  );
}
