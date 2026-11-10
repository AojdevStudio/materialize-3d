import { useEffect, useState } from "react";
import { ChevronDown, CircleCheck, FilePen, Layers, Paperclip, Plus, Terminal } from "lucide-react";
import { Bar, Button, Card, Check, Collapse, Count, Roll, Row, Stage, States, Tabs, Text, Window, type Act } from "../stageshow/kit";
import markSmall from "../assets/brand/mark-small-32.svg";
import modelRender from "../assets/landing/dock-mount-model.png";
import iconCog from "../assets/landing/line-cog.svg";
import iconLayout from "../assets/landing/line-layout-left.svg";
import iconPrinted from "../assets/landing/line-rating-star.svg";
import iconProjects from "../assets/landing/line-module-three.svg";
import iconReady from "../assets/landing/line-layers-stacked.svg";
import iconSearch from "../assets/landing/line-search-circle.svg";
import iconSun from "../assets/landing/line-weather-sun.svg";
import iconWorking from "../assets/landing/line-loading-half.svg";
import {
  BEATS,
  DOCK,
  GROUPS,
  PRINT_FILES,
  REQUEST,
  SHELF,
  SUGGESTIONS,
  TRACE,
  initial,
  poster,
  type Project,
  type Scene,
  type Status,
  type TraceIcon,
} from "./scene";
import { BambuMark } from "../components/BambuMark";
import "./hero.css";

const GROUP_ICONS: Record<Status, string> = { working: iconWorking, ready: iconReady, printed: iconPrinted };

const TRACE_ICONS: Record<TraceIcon, typeof FilePen> = { file: FilePen, terminal: Terminal, layers: Layers };

/** Where the cursor waits: on empty surface under Start, its first move each loop. */
const REST = { wide: { x: 1080, y: 420 }, compact: { x: 290, y: 296 } };

async function script(a: Act<Scene>) {
  await a.wait(500);
  a.mark("type");
  await a.type("draft", REQUEST, { interval: 28 });
  await a.wait(250);
  await a.click({ at: "start", x: 0.92, y: 0.78 });
  a.mark("work");
  await a.set({ beat: "work" });
  await a.wait(450);
  for (const steps of [1, 2, 3]) {
    await a.set({ steps });
    await a.wait(420);
  }
  await a.wait(500);
  a.mark("guide");
  await a.set({ steps: 4 });
  await a.wait(420);
  await a.set({ steps: 5 });
  await a.wait(300);
  await a.set({ beat: "guide" });
  await a.wait(600);
  await a.set({ steps: 6 });
  await a.wait(1200);
  a.mark("payoff");
  await a.set({ beat: "payoff" });
  await a.wait(4000);
  // The compact crop has no sidebar, so its reset is the job's exit around the window.
  if (a.layout === "wide") {
    a.mark("reset");
    await a.click({ at: "new-project", x: 0.9, y: 0.7 });
  }
  await a.set(initial);
  await a.move(REST[a.layout]);
  await a.wait(300);
}

export function ProductHero() {
  // The kit measures its labels when it mounts, so it mounts again once Inter has loaded.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    void document.fonts.ready.then(() => setFontsReady(true));
  }, []);
  return (
    <Stage<Scene>
      key={fontsReady ? "fonts-ready" : "fonts-loading"}
      width={1360}
      height={740}
      compact={{ below: 900, width: 358, height: 340 }}
      initial={initial}
      poster={poster}
      script={script}
      cursor={{ at: REST }}
      fill
      accent="#1b1b1b"
      tokens={{ "--ss-font": '"Inter", system-ui, sans-serif' }}
      className="m3h"
    >
      {(s, _rect, layout) => {
        const view = BEATS[s.beat];
        return (
          <>
            <div className="m3h-fade">
              <Window className="m3h-window">
                <div className="m3h-app">
                  <Sidebar dock={view.dock} />
                  <div className="m3h-main">
                    <StartView draft={s.draft} on={view.screen === "start"} />
                    <div className="m3h-chatview" data-on={view.screen === "chat" || undefined}>
                      <Chat steps={s.steps} done={view.done} folded={view.done && layout === "compact"} />
                      <Panel guide={view.guide} done={view.done} />
                    </div>
                  </div>
                </div>
              </Window>
            </div>
            {/* Keyed by layout: the kit measures a button's label once, at mount */}
            <PrintCard key={layout} show={view.done} size={layout === "compact" ? "small" : "medium"} />
          </>
        );
      }}
    </Stage>
  );
}

function Sidebar({ dock }: { dock: "working" | "ready" | null }) {
  const count = (status: Status) => SHELF[status].length + (dock === status ? 1 : 0);
  const projects = GROUPS.reduce((n, g) => n + SHELF[g.status].length, 0) + (dock ? 1 : 0);
  return (
    <aside className="m3h-side">
      <div className="m3h-brand">
        <img src={markSmall} alt="" width={20} height={20} />
        <span>Materialize 3D</span>
        <img className="m3h-glyph" src={iconLayout} alt="" width={16} height={16} />
      </div>
      <div className="m3h-actions">
        <Button variant="primary" className="m3h-new" icon={<Plus size={14} />} data-target="new-project">
          New project
        </Button>
        <Button className="m3h-search" aria-label="Search">
          <img src={iconSearch} alt="" width={16} height={16} />
        </Button>
      </div>
      <GroupHead icon={iconProjects} label="Projects" count={projects} />
      {GROUPS.map((group) => (
        <div key={group.status} className="m3h-group">
          <GroupHead icon={GROUP_ICONS[group.status]} label={group.label} count={count(group.status)} />
          {group.status !== "printed" && (
            <Collapse open={dock === group.status}>
              <ProjectRow project={DOCK[group.status]} status={group.status} on={dock === group.status} selected={group.status === "ready"} />
            </Collapse>
          )}
          {SHELF[group.status].map((project) => (
            <ProjectRow key={project.title} project={project} status={group.status} on />
          ))}
        </div>
      ))}
      <div className="m3h-side-foot">
        <img className="m3h-glyph" src={iconCog} alt="" width={16} height={16} />
        <img className="m3h-glyph" src={iconSun} alt="" width={16} height={16} />
      </div>
    </aside>
  );
}

function GroupHead({ icon, label, count }: { icon: string; label: string; count: number }) {
  return (
    <div className="m3h-group-head">
      <img className="m3h-glyph" src={icon} alt="" width={16} height={16} />
      <span>{label}</span>
      <Count className="m3h-count" value={count} />
    </div>
  );
}

function ProjectRow({ project, status, on, selected }: { project: Project; status: Status; on: boolean; selected?: boolean }) {
  return (
    <Row
      className="m3h-row"
      pad={8}
      selected={selected ?? false}
      lead={<Check className="m3h-status" data-status={status} size={14} on={on && status !== "working"} pending={status === "working"} />}
      title={<Text>{project.title}</Text>}
      subtitle={<Text>{project.detail}</Text>}
      meta={<Text>{project.time}</Text>}
    />
  );
}

function StartView({ draft, on }: { draft: string; on: boolean }) {
  return (
    <div className="m3h-start" data-on={on || undefined}>
      <div className="m3h-ask">What are we making?</div>
      <div className="m3h-prompt">
        <div className="m3h-prompt-text" data-cursor="ibeam" data-typing>
          {draft || <span className="m3h-placeholder">Describe the part, paste a link, or attach a file</span>}
        </div>
        <div className="m3h-prompt-row">
          <Button size="small" icon={<Paperclip size={12} />}>
            Attach
          </Button>
          <span className="m3h-hint">Photo, PDF, 3MF, STL</span>
          <span className="m3h-spacer" />
          <Button size="small" variant="ghost" trailingIcon={<ChevronDown size={12} />}>
            Opus 5.5
          </Button>
          <Button size="small" variant="primary" data-target="start">
            Start
          </Button>
        </div>
      </div>
      <div className="m3h-chips">
        {SUGGESTIONS.map((label) => (
          <Button key={label} size="small" className="m3h-chip">
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** `folded`: the compact crop folds the finished trace to its header, making room for the print files. */
function Chat({ steps, done, folded }: { steps: number; done: boolean; folded: boolean }) {
  const elapsed = TRACE[Math.max(steps, 1) - 1]?.elapsed ?? TRACE[0].elapsed;
  return (
    <div className="m3h-chat">
      <div className="m3h-thread">
        <div className="m3h-bubble">{REQUEST}</div>
        <div className="m3h-model">Opus 5.5</div>
        <Collapse open={steps > 0}>
          <div className="m3h-trace-head">
            <States
              className="m3h-trace-mark"
              value={done ? "done" : "working"}
              states={{
                working: <Check className="m3h-status" data-status="working" size={14} on={false} pending style={{ rotate: `${steps * 60}deg` }} />,
                done: <CircleCheck size={14} strokeWidth={1.75} />,
              }}
            />
            <Roll className="m3h-trace-time">{done ? "Worked for 14 min" : `Working for ${elapsed}`}</Roll>
            <Roll className="m3h-trace-steps">{done ? "6 steps" : `step ${Math.max(steps, 1)} of ${TRACE.length}`}</Roll>
          </div>
        </Collapse>
        <div className="m3h-trace">
          {TRACE.map((step, i) => {
            const Glyph = TRACE_ICONS[step.icon];
            return (
              <Collapse key={step.title} open={steps > i && !folded}>
                <div className="m3h-trace-line">
                  <Glyph size={13} strokeWidth={1.75} />
                  <span className="m3h-trace-title">{step.title}</span>
                  {step.detail && <span className="m3h-trace-detail">{step.detail}</span>}
                </div>
              </Collapse>
            );
          })}
        </div>
        <Collapse className="m3h-answer-slot" open={done}>
          <div className="m3h-answer">
            <div className="m3h-answer-title">Your dock mount is ready</div>
            <Bar w="94%" h={6} tone={2} />
            <Bar w="88%" h={6} tone={2} />
            <Bar w="52%" h={6} tone={2} />
            <Bar className="m3h-answer-gap" w="34%" h={7} tone={3} />
            <Bar w="90%" h={6} tone={2} />
            <Bar w="90%" h={6} tone={2} />
          </div>
        </Collapse>
      </div>
      <div className="m3h-composer">
        <span className="m3h-placeholder">Reply, paste a link, or attach a file</span>
        <div className="m3h-prompt-row">
          <Button size="small" icon={<Paperclip size={12} />}>
            Attach
          </Button>
          <span className="m3h-spacer" />
          <Button size="small" variant="ghost" trailingIcon={<ChevronDown size={12} />}>
            Opus 5.5
          </Button>
          <Button size="small" variant="primary">
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function Panel({ guide, done }: { guide: boolean; done: boolean }) {
  return (
    <div className="m3h-panel">
      <div className="m3h-empty" data-on={!guide || undefined}>
        Models, drawings, and guides the agent makes show up here.
      </div>
      <div className="m3h-guide" data-on={guide || undefined}>
        <div className="m3h-views">
          <Tabs items={["Guide", "Model", "Drawing", "Files"]} value={0} />
          <span className="m3h-popout">Pop out ↗</span>
        </div>
        <div className="m3h-guide-card">
          <div className="m3h-guide-head">
            <span>Dock mount assembly</span>
          </div>
          <div className="m3h-render">
            <img src={modelRender} alt="" width={518} height={459} />
          </div>
          <div className="m3h-guide-step">
            <div className="m3h-step-count">Step 6 of 13</div>
            <div className="m3h-step-title">Screw the rails to the plate</div>
            <Bar w="92%" h={6} tone={2} />
            <Bar w="84%" h={6} tone={2} />
            <Bar w="60%" h={6} tone={2} />
            <Bar className="m3h-answer-gap" w="88%" h={6} tone={2} />
            <Bar w="70%" h={6} tone={2} />
          </div>
        </div>
        <div className="m3h-printbar" data-on={done || undefined}>
          <div className="m3h-printbar-copy">
            <div className="m3h-printbar-title">2 print files ready</div>
            <div className="m3h-printbar-sub">PETG Basic · 0.20 mm</div>
          </div>
          <Button size="small">Reveal in Finder</Button>
          <Button size="small" variant="primary" icon={<BambuMark />}>
            Open in Bambu Studio
          </Button>
        </div>
      </div>
    </div>
  );
}

function PrintCard({ show, size }: { show: boolean; size: "small" | "medium" }) {
  return (
    <Card className="m3h-card" gap={10} data-on={show || undefined}>
      <div>
        <div className="m3h-card-title">2 print files ready</div>
        <div className="m3h-card-sub">PETG Basic · 0.20 mm</div>
      </div>
      {PRINT_FILES.map((file) => (
        <div key={file.name} className="m3h-file">
          <div className="m3h-file-name">{file.name}</div>
          <div className="m3h-file-contents">{file.contents}</div>
        </div>
      ))}
      <div className="m3h-card-actions">
        <Button variant="primary" size={size} icon={<BambuMark />}>
          Open in Bambu Studio
        </Button>
        <Button size={size}>Reveal in Finder</Button>
      </div>
    </Card>
  );
}
