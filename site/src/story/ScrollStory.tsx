import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DownloadLink, ReleaseNote } from "../components/Download";
import { DIMENSIONS, PARAM_ROWS, PRINT, TBD_ROWS } from "./facts";
import { PARTS } from "./parts";
import { RAIL, STAGES, minutes, railPosition, readoutAt, trackLength, type Motion, type StageId } from "./timeline";
import "./story.css";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeToMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Reduced motion turns the scrubbed story into one still per stage. */
function useMotion(): Motion {
  return useSyncExternalStore(subscribeToMotion, () => (window.matchMedia(REDUCED_MOTION).matches ? "still" : "full"));
}

function Sheet({ rows }: { rows: readonly (readonly [label: string, value: string, file?: "file"])[] }) {
  return (
    <dl className="sheet">
      {rows.map(([label, value, file]) => (
        <div key={label + value}>
          <dt>{label}</dt>
          <dd className={file ? "file" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const ScrollHint = ({ children }: { children: ReactNode }) => (
  <p className="hint">
    <svg viewBox="0 0 9 22" aria-hidden="true">
      <path d="M4.5 0v20M1 16.5l3.5 4 3.5-4" />
    </svg>
    {children}
  </p>
);

/** Each stage's copy, in story order. Every product fact here is in the agent's own log or files. */
const COPY: Record<StageId, ReactNode> = {
  hero: (
    <>
      <p className="kick">Free for macOS</p>
      <h1>
        Materialize <b>3D</b>
      </h1>
      <p className="lead">Describe a part. Print the 3MF.</p>
      <div className="cta">
        <DownloadLink />
        <a className="text-link" href="#install">
          Install guide
        </a>
      </div>
      <ReleaseNote />
      <Sheet
        rows={[
          ["Outer", "392 × 406 × 478 mm"],
          ["Build volume", "256 × 256 × 256 mm"],
          ["Motion", "CoreXY"],
          ["Enclosure", "Glass lid, front door"],
        ]}
      />
      <ScrollHint>Scroll. It comes apart from the top.</ScrollHint>
    </>
  ),
  explode: (
    <>
      <p className="kick">Teardown</p>
      <h2>Top down</h2>
      <p>Lid first. Then every part between you and the build plate.</p>
    </>
  ),
  dive: (
    <>
      <p className="kick">Build plate</p>
      <h2>256 × 256 mm</h2>
      <p>Textured PEI. Everything above it exists to put plastic here.</p>
    </>
  ),
  print: (
    <>
      <p className="kick">The print</p>
      <h2>Right shelf</h2>
      <p>One of five printed parts of a dock mount. 100 × 80 × 30 mm, tray side down.</p>
      <Sheet
        rows={[
          ["File", "ugreen-dock-mount-revB.3mf", "file"],
          ["Holds", "Back plate, 2 rails, 2 shelves"],
        ]}
      />
    </>
  ),
  slices: (
    <>
      <p className="kick">Rewind · 13:58</p>
      <h2>Sliced</h2>
      <p>Sliced 2 print files, PETG Basic.</p>
      <Sheet
        rows={[
          ["Rev B", "ugreen-dock-mount-revB.3mf", "file"],
          ["Holds", "Back plate, 2 rails, 2 shelves"],
          ["Rev C", "ugreen-dock-mount-revC-adapter.3mf", "file"],
          ["Holds", "Arm adapter, 4 walls, 40% infill"],
        ]}
      />
      <p className="hint">Nobody drew this part. Scroll back to where it started.</p>
    </>
  ),
  guide: (
    <>
      <p className="kick">Rewind · 9:47</p>
      <h2>Assembly guide</h2>
      <p>Wrote assembly-guide.html, 13 steps.</p>
      <p>The shelf you watched print takes its place on the mount.</p>
    </>
  ),
  adapter: (
    <>
      <p className="kick">Rewind · 6:05</p>
      <h2>Revision C</h2>
      <p>Added the revision C arm adapter.</p>
      <p>It hangs the cradle on the monitor arm.</p>
    </>
  ),
  parts: (
    <>
      <p className="kick">Rewind · 0:39</p>
      <h2>Five parts</h2>
      <p>Built 5 printed parts, manifold3d, no overlaps.</p>
      <p>Back plate, two rails, two shelves.</p>
    </>
  ),
  drawing: (
    <>
      <p className="kick">Rewind · 0:26</p>
      <h2>Drawing</h2>
      <p>Astra drew drawing.html, clearances checked.</p>
      <p>The solids flatten into lines and sizes.</p>
    </>
  ),
  params: (
    <>
      <p className="kick">Rewind · 0:12</p>
      <h2>Sizes</h2>
      <p>Wrote params.json, unknown sizes marked TBD.</p>
      <p>Under the drawing, only numbers.</p>
    </>
  ),
  request: (
    <>
      <p className="kick">
        <span>0:00</span>
        <span>The request</span>
      </p>
      <h2 className="say">
        Make a mount for my UGREEN dock under the monitor arm. Photo attached.{"\u2060"}
        <i aria-hidden="true" />
      </h2>
      <p className="request-note">That is all you type. 13:58 later, 2 print files.</p>
    </>
  ),
};

const LOG = STAGES.flatMap((stage) => (stage.log ? [{ id: stage.id, ...stage.log }] : []));

/** The readout before the story starts moving. The director rewrites it as P changes. */
const FIRST_READOUT = readoutAt(0, PRINT);

function Params() {
  return (
    <pre className="story-params">
      <span className="c">params.json</span>
      {"\n{\n"}
      {PARAM_ROWS.map(({ key, value }) => (
        <Fragment key={key}>
          {"  "}
          <span className="k">"{key}"</span>: {value},{"\n"}
        </Fragment>
      ))}
      {"  "}
      <span className="k">"tbd"</span>
      {": {\n"}
      {TBD_ROWS.map(({ key, status }, i) => (
        <Fragment key={key}>
          {"    "}
          <span className="k">"{key}"</span>: <span className="t">"{status}"</span>
          {i < TBD_ROWS.length - 1 ? ",\n" : "\n"}
        </Fragment>
      ))}
      {"  }\n}"}
    </pre>
  );
}

/**
 * The scroll story: a printer that comes apart top down, the right shelf printing on
 * its plate, and a rewind through how the agent made it. The 3D view and the timing
 * load on demand. All text is DOM text here, in story order.
 */
export function ScrollStory() {
  const motion = useMotion();
  const root = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<string | null>("Loading the 3D model");

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    import("./director").then(
      ({ startStory }) => {
        if (!cancelled) stop = startStory(element, motion, setStatus);
      },
      (error: unknown) => {
        if (!cancelled) setStatus(`The 3D view did not load. ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [motion]);

  return (
    <section ref={root} className="story" id="top" aria-label="Scroll story" data-motion={motion}>
      <div className="story-view">
        <canvas
          className="story-canvas"
          role="img"
          aria-label="A 3D printer built in Blender for this page. As you scroll it comes apart from the top down to the build plate, the right shelf of a dock mount prints on the plate, and the story rewinds through how the agent made it."
        />
        <svg className="story-lines" aria-hidden="true">
          {PARTS.map((part) => (
            <g key={part.name} data-line={part.name}>
              <path />
              <circle r="2.2" />
            </g>
          ))}
        </svg>
        {STAGES.map((stage) => (
          <section key={stage.id} className="stage-copy" data-stage={stage.id}>
            {COPY[stage.id]}
          </section>
        ))}
        <ol className="story-labels" aria-label="Printer parts, top down">
          {PARTS.map((part, i) => (
            <li key={part.name} data-part={part.name}>
              <span className="part-index">{String(i + 1).padStart(2, "0")}</span>
              <span className="part-long">{part.label}</span>
              <span className="part-short">{part.short}</span>
            </li>
          ))}
        </ol>
        <ul className="story-dimensions" aria-label="Drawing sizes in millimetres">
          {DIMENSIONS.map((dimension, i) => (
            <li key={i} data-dimension={i}>
              <b>{dimension.value}</b>
              {dimension.text && ` ${dimension.text}`}
            </li>
          ))}
        </ul>
        <Params />
        <div className="readout">
          <p className="kick">
            <span data-readout="kick">{FIRST_READOUT.kick}</span>
            <span data-readout="kickNote">{FIRST_READOUT.kickNote}</span>
          </p>
          <p className="readout-value">
            <span data-readout="value">{FIRST_READOUT.value}</span>
            <span className="of" data-readout="of">
              {FIRST_READOUT.of}
            </span>
            <span className="unit" data-readout="unit">
              {FIRST_READOUT.unit}
            </span>
          </p>
          <p className="readout-line" data-readout="line">
            {FIRST_READOUT.line}
          </p>
          <p className="readout-note" data-readout="note">
            {FIRST_READOUT.note}
          </p>
        </div>
        <div className="story-log" role="group" aria-label="Agent log">
          <p className="kick">
            <span>Agent log</span>
            <span>Elapsed</span>
          </p>
          <ol>
            {LOG.map((entry) => (
              <li key={entry.id} data-log={entry.id}>
                <b>{minutes(entry.seconds)}</b>
                <span>{entry.line}</span>
              </li>
            ))}
          </ol>
        </div>
        <nav className="story-rail" aria-label="Story stages">
          {RAIL.map((stop) => (
            <button
              key={stop.label}
              type="button"
              data-rail={stop.label}
              aria-label={`Go to ${stop.label}`}
              style={{ top: `${(railPosition(stop, motion) * 100).toFixed(2)}%` }}
            >
              {stop.label}
            </button>
          ))}
          <span className="rail-mark" aria-hidden="true" />
        </nav>
        <p className="story-status" role="status">
          {status}
        </p>
      </div>
      <div className="story-track" style={{ height: `${trackLength(motion)}vh` }} />
    </section>
  );
}
