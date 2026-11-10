import { ChevronDown, Paperclip } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import modelRender from "../assets/landing/dock-mount-model.png";
import { BambuMark } from "./BambuMark";

type Tile = { id: "describe" | "make" | "look" | "print"; title: string; body: string; picture: ReactNode };

const SUGGESTIONS = ["A mount or bracket", "A replacement part", "A desk organizer", "Something from a photo"] as const;

const FILES = [
  { kind: "JSON", name: "params.json" },
  { kind: "HTML", name: "assembly-guide.html" },
  { kind: "3MF", name: "ugreen-dock-mount-revB.3mf" },
] as const;

function PromptPicture() {
  return (
    <div className="pic pic-prompt" aria-hidden="true">
      <div className="ui-card">
        <div className="ui-ask">What are we making?</div>
        <div className="ui-prompt">
          <div className="ui-placeholder">Describe the part, paste a link, or attach a file</div>
          <div className="ui-row">
            <span className="ui-btn">
              <Paperclip size={12} /> Attach
            </span>
            <span className="ui-hint">Photo, PDF, 3MF, STL</span>
            <span className="ui-spacer" />
            <span className="ui-btn ui-btn-ghost">
              Opus 5.5 <ChevronDown size={12} />
            </span>
            <span className="ui-btn ui-btn-primary">Start</span>
          </div>
        </div>
        <div className="ui-chips">
          {SUGGESTIONS.map((label) => (
            <span key={label} className="ui-chip">
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function FilesPicture() {
  const list = useRef<HTMLUListElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { threshold: 0.6 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <ul ref={list} className="pic pic-files" data-seen={seen || undefined} aria-hidden="true">
      {FILES.map((file, i) => (
        <li key={file.name} className="ui-file" style={{ transitionDelay: `${i * 140}ms` }}>
          <span className="ui-badge" data-kind={file.kind}>
            {file.kind}
          </span>
          {file.name}
        </li>
      ))}
    </ul>
  );
}

function GuidePicture() {
  return (
    <div className="pic pic-guide" aria-hidden="true">
      <div className="ui-card">
        <div className="ui-views">
          <span className="ui-tab" data-on>
            Guide
          </span>
          <span className="ui-tab">Model</span>
          <span className="ui-tab">Drawing</span>
          <span className="ui-tab">Files</span>
          <span className="ui-spacer" />
          <span className="ui-tab">Pop out ↗</span>
        </div>
        <div className="ui-guide-head">Dock mount assembly</div>
        <div className="ui-render">
          <img src={modelRender} alt="" width={518} height={459} loading="lazy" />
        </div>
      </div>
    </div>
  );
}

function PrintButtonsPicture() {
  return (
    <div className="pic pic-print" aria-hidden="true">
      <span className="ui-btn">Reveal in Finder</span>
      <span className="ui-btn ui-btn-primary">
        <BambuMark /> Open in Bambu Studio
      </span>
    </div>
  );
}

const tiles = {
  describe: {
    id: "describe",
    title: "Describe",
    body: "Type what you want on the start screen. Add a picture or a link if it helps.",
    picture: <PromptPicture />,
  },
  make: {
    id: "make",
    title: "Make",
    body: "The agent works in the chat's own project folder. It writes and edits files there.",
    picture: <FilesPicture />,
  },
  look: {
    id: "look",
    title: "Look",
    body: "The right panel shows what the agent writes: HTML pages, STL, 3MF, and GLB models in an orbit viewer, and pictures.",
    picture: <GuidePicture />,
  },
  print: {
    id: "print",
    title: "Print",
    body: "Open the 3MF in Bambu Studio or the slicer of your choice, check it, and print from there.",
    picture: <PrintButtonsPicture />,
  },
} as const satisfies Record<Tile["id"], Tile>;

function TileCard({ tile }: { tile: Tile }) {
  return (
    <article className={`tile tile-${tile.id}`}>
      <div className="tile-copy">
        <h3 className="tile-title">{tile.title}</h3>
        <p>{tile.body}</p>
      </div>
      {tile.picture}
    </article>
  );
}

export function HowItWorks() {
  return (
    <section className="section" id="how" aria-labelledby="how-title">
      <h2 id="how-title">How it works</h2>
      <div className="bento">
        <TileCard tile={tiles.describe} />
        <TileCard tile={tiles.make} />
        <TileCard tile={tiles.look} />
        <article className="tile tile-stat">
          <p className="stat-lead">Every job ends in</p>
          <p className="stat-number">3MF</p>
          <p className="stat-label">A print-ready file for your printer, sliced and ready to open.</p>
        </article>
        <TileCard tile={tiles.print} />
      </div>
    </section>
  );
}
