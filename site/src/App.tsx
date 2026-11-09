import { ThemeToggle } from "./components/ThemeToggle";
import { ReleaseFacts } from "./components/ReleaseFacts";
import shotStudio from "./assets/screens/studio-cube-sliced.png";
import oflUrl from "./assets/fonts/OFL.txt?url";
import { checksumPublished, dmgFileName, release } from "./release";

type Step = { title: string; body: string };

const steps: readonly Step[] = [
  {
    title: "Talk to it",
    body: "Describe the part you need in plain words. Drop or paste a photo, such as a product shot or a picture from your phone, or paste a link. The agent sees the picture.",
  },
  {
    title: "Preview",
    body: "Each chat has its own project folder, and the agent works there. When it writes a file, the app shows it. Models open in a 3D view you can turn, and drawings open as pages. The newest file opens by itself.",
  },
  {
    title: "Assembly guide",
    body: "The agent writes an interactive HTML guide that shows how the parts go together. It opens in the preview like any other page.",
  },
  {
    title: "3MF to Bambu Studio",
    body: "Every job ends in a print-ready 3MF. The agent slices it with Bambu Studio for the Bambu Lab P2S. In the Files tab, click Open in Bambu Studio and print from there.",
  },
];

const inStudio = [
  "Chat with one agent. Each chat has its own project folder.",
  "Drop or paste a picture, or paste a link",
  "A GPT helper the agent can hand a task to, such as a technical drawing",
  "A preview that shows HTML pages, and STL, 3MF, and GLB models in a 3D view",
  "A Files tab with Reveal in Finder, and Open in Bambu Studio for a 3MF",
  "Slicing with Bambu Studio to a 3MF for the Bambu Lab P2S",
] as const;

const notInStudio = [
  "A printer connection",
  "CAD tools or editors in the app",
  "Accounts",
  "Settings screens",
  "An approval step",
] as const;

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Materialize 3D, top of page">
          <span className="wordmark-serif">Materialize</span>
          <span className="wordmark-3d">3D</span>
        </a>
        <nav aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#requirements">Requirements</a>
          <a href="#install">Install</a>
          <a href="#roadmap">Roadmap</a>
        </nav>
        <ThemeToggle />
      </header>

      <main id="main">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">
              Describe a part. <em>Print</em> the 3MF.
            </h1>
            <p className="lede">
              Materialize 3D is a Mac app where you talk to an AI agent about a part you need. The
              agent makes the model and shows it to you while it works. The job ends in a print-ready
              3MF that opens in Bambu Studio.
            </p>
            <a className="download" href={release.dmgUrl}>
              Download for Mac ({release.architecture})
            </a>
            <ReleaseFacts />
            <p className="hero-note">
              The chat studio is not in a release yet. This download is {release.version}, the earlier
              sign app. <a href={release.releasesUrl}>All releases</a>
            </p>
          </div>
          <figure className="hero-shot">
            <img
              src={shotStudio}
              width={1440}
              height={900}
              alt="Materialize 3D with a chat on the left and a 20 mm calibration cube in the preview on the right, with Open in Bambu Studio above it."
              fetchPriority="high"
            />
            <figcaption>
              Real app, before release: the agent made a 20 mm calibration cube and sliced it to a P2S
              3MF. The preview shows the 3MF, ready to open in Bambu Studio.
            </figcaption>
          </figure>
        </section>

        <section id="how" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol className="steps">
            {steps.map((step, i) => (
              <li key={step.title} className="step">
                <div className="step-copy">
                  <span className="step-num">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="requirements" aria-labelledby="req-title">
          <h2 id="req-title">Requirements</h2>
          <p className="req-note">
            These are for the chat studio. The {release.version} download is the earlier sign app, and
            it uses an Anthropic or OpenAI API key instead of a sign-in.
          </p>
          <dl className="facts facts-wide">
            <dt>Mac</dt>
            <dd>{release.architecture}. Tested on {release.testedMacOS}.</dd>
            <dt>Bambu Studio</dt>
            <dd>
              Version <code>{release.bambuStudio.version}</code>, free, installed separately from{" "}
              <a href={release.bambuStudio.releaseUrl}>Bambu Lab's official release page</a>. The app
              never installs or bundles it. If you use another version, keep it and put this one in
              its own folder.
            </dd>
            <dt>AI login</dt>
            <dd>Your own sign-in with an AI provider, such as Claude or ChatGPT. The agent runs on it.</dd>
            <dt>uv</dt>
            <dd>
              uv and a Python it can run. The agent builds models with them. The app tells you if
              either is missing.
            </dd>
            <dt>Printer</dt>
            <dd>Bambu Lab P2S. The agent slices for its 0.4 mm nozzle.</dd>
            <dt>Not offered</dt>
            <dd>Intel Mac, Windows, and Linux downloads.</dd>
          </dl>
        </section>

        <section id="install" aria-labelledby="install-title">
          <h2 id="install-title">Install</h2>
          <ol className="install">
            <li>
              Download <a href={release.dmgUrl}>{dmgFileName}</a>.
              {checksumPublished && (
                <>
                  {" "}
                  Check it with <code>shasum -a 256 {dmgFileName}</code>. It should print{" "}
                  <code className="hash">{release.sha256}</code>.
                </>
              )}
            </li>
            <li>Open the DMG.</li>
            <li>Drag Materialize 3D to Applications.</li>
            <li>
              Launch it from Applications.
              {!release.notarized && (
                <>
                  {" "}
                  This build has no Apple notarization yet, so macOS blocks the first launch. Open
                  System Settings, then Privacy &amp; Security, and click Open Anyway for Materialize
                  3D.
                </>
              )}
            </li>
            <li>Follow the steps the app shows on first launch.</li>
          </ol>
        </section>

        <section id="scope" aria-labelledby="scope-title">
          <h2 id="scope-title">In the studio and planned</h2>
          <div className="scope">
            <div>
              <h3>In the studio</h3>
              <ul>
                {inStudio.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Not in the studio</h3>
              <ul>
                {notInStudio.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div id="roadmap">
              <h3>Planned</h3>
              <p>
                A printer connection is planned as an optional add-on. It is not built, and there are
                no dates.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <span className="wordmark-serif">Materialize</span>
        <span>3D {release.version}</span>
        <nav aria-label="Project links">
          <a href={release.repoUrl}>Repository</a>
          <a href={release.releasesUrl}>Releases</a>
          <a href={release.docsUrl}>Docs</a>
          <a href={oflUrl}>Font licenses (SIL OFL 1.1)</a>
        </nav>
      </footer>
    </>
  );
}
