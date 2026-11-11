import { useEffect, useRef, useState } from "react";
import { DownloadLink, ReleaseNote } from "./components/Download";
import { HowItWorks } from "./components/HowItWorks";
import { ReleaseFacts } from "./components/ReleaseFacts";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
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

/**
 * The header is clear over the story and turns solid once the end section slides under it.
 * It checks a one-pixel mark at the top of the end section against the header's own bottom edge
 * on every scroll and resize, because an instant jump can carry the mark past the viewport
 * without an intersection change, and the header is shorter on phones.
 */
function useSolidHeader() {
  const header = useRef<HTMLElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const bar = header.current;
    const element = mark.current;
    if (!bar || !element) return;
    const update = () => setSolid(element.getBoundingClientRect().top < bar.getBoundingClientRect().bottom);
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return [header, mark, solid] as const;
}

export function App() {
  const [header, endMark, solid] = useSolidHeader();
  return (
    <>
      <a className="skip-link" href="#download">
        Skip to the download
      </a>
      <SiteHeader ref={header} home="#top" label="Materialize 3D, back to top" solid={solid} />

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

      <SiteFooter page="home" />
    </>
  );
}
