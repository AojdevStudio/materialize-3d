/**
 * Drives the story from the scroll. It maps the scroll offset to the story position P,
 * eases toward it, and on each frame poses the 3D scene and writes the copy, the part
 * labels, the readout, the agent log, and the rail. It draws only while P is still
 * moving, so nothing repaints while the reader is still.
 *
 * React renders every element once. This module only sets their opacity, position,
 * and the readout's text, through the data attributes ScrollStory puts on them.
 */
import type { Vector3 } from "three";
import { loadModels } from "./assets";
import { PRINT } from "./facts";
import { StoryScene, type Palette, type Point, type PrinterPart } from "./scene";
import {
  RAIL,
  STAGES,
  clamp,
  copyAt,
  labelAlpha,
  overlaysAt,
  positionAt,
  readoutAt,
  scrollFor,
  smoothstep,
  stageAt,
  storyFraction,
  trackLength,
  type Motion,
  type ReadoutView,
  type StageId,
} from "./timeline";

/** Below this width the story uses its phone framing. Matches the stylesheet's breakpoint. */
const PHONE = 760;

function pick<T extends Element>(root: ParentNode, selector: string, kind: new () => T): T {
  const element = root.querySelector(selector);
  if (!(element instanceof kind)) throw new Error(`The story has no ${selector}`);
  return element;
}

function fade(element: HTMLElement | SVGElement, alpha: number, y?: number) {
  const value = alpha < 0.004 ? "0" : Math.min(1, alpha).toFixed(3);
  if (element.style.opacity !== value) element.style.opacity = value;
  if (y !== undefined) element.style.transform = y ? `translate3d(0, ${y.toFixed(1)}px, 0)` : "";
}

function text(element: HTMLElement, value: string) {
  if (element.textContent !== value) element.textContent = value;
}

type Label = { target: PrinterPart; element: HTMLElement; line: SVGPathElement; dot: SVGCircleElement; width: number; height: number };
type Placed = { label: Label; alpha: number; anchor: Point; y: number };

/**
 * Places a column's labels at their anchors' heights, keeping `gap` between them and
 * the column between `top` and `bottom`. `placed` is sorted by anchor height.
 */
function stack(placed: Placed[], gap: number, top: number, bottom: number) {
  for (const [i, item] of placed.entries()) {
    const above = placed[i - 1];
    item.y = Math.max(item.anchor.y, above ? above.y + gap : top);
  }
  for (const [i, item] of [...placed.entries()].reverse()) {
    const below = placed[i + 1];
    item.y = Math.min(item.y, below ? below.y - gap : bottom);
  }
}

/** Starts the story in `root`. Returns a function that stops it. */
export function startStory(root: HTMLElement, motion: Motion, onStatus: (status: string | null) => void): () => void {
  const canvas = pick(root, ".story-canvas", HTMLCanvasElement);
  const track = pick(root, ".story-track", HTMLElement);
  const blocks = STAGES.map((stage) => ({ stage, element: pick(root, `[data-stage="${stage.id}"]`, HTMLElement) }));
  const readout = {
    box: pick(root, ".readout", HTMLElement),
    kick: pick(root, '[data-readout="kick"]', HTMLElement),
    kickNote: pick(root, '[data-readout="kickNote"]', HTMLElement),
    value: pick(root, '[data-readout="value"]', HTMLElement),
    of: pick(root, '[data-readout="of"]', HTMLElement),
    unit: pick(root, '[data-readout="unit"]', HTMLElement),
    line: pick(root, '[data-readout="line"]', HTMLElement),
    note: pick(root, '[data-readout="note"]', HTMLElement),
  } satisfies Record<keyof ReadoutView | "box", HTMLElement>;
  const log = pick(root, ".story-log", HTMLElement);
  const logLines = STAGES.flatMap((stage) => (stage.log ? [{ id: stage.id, element: pick(log, `[data-log="${stage.id}"]`, HTMLElement) }] : []));
  const params = pick(root, ".story-params", HTMLElement);
  const rail = pick(root, ".story-rail", HTMLElement);
  const railMark = pick(rail, ".rail-mark", HTMLElement);
  const stops = RAIL.map((stop) => ({ stop, button: pick(rail, `[data-rail="${stop.label}"]`, HTMLButtonElement) }));

  let scene: StoryScene | null = null;
  let labels: Label[] = [];
  let dimensions: { point: Vector3; vertical: boolean; element: HTMLElement; width: number }[] = [];
  let width = 0;
  let height = 0;
  let phone = false;
  /** px per vh, read from the track so it matches CSS even while a phone's toolbar slides. */
  let vh = 1;
  let top = 0;
  let P = 0;
  let target = 0;
  let raf = 0;
  let stopped = false;

  const scrollVh = () => (window.scrollY - top) / vh;

  function palette(): Palette {
    const style = getComputedStyle(document.documentElement);
    return {
      paper: style.getPropertyValue("--paper").trim(),
      ink: style.getPropertyValue("--ink").trim(),
      accent: style.getPropertyValue("--accent-ink").trim(),
      dark: document.documentElement.dataset.theme === "dark",
    };
  }

  function forgetSizes() {
    for (const label of labels) label.width = label.height = 0;
    for (const dimension of dimensions) dimension.width = 0;
  }

  function measure(force: boolean) {
    vh = track.offsetHeight / trackLength(motion);
    top = root.getBoundingClientRect().top + window.scrollY;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // A phone's toolbar sliding in and out changes only the height a little. Keep the frame steady then.
    if (!force && phone && w === width && Math.abs(h - height) < 120) return;
    width = w;
    height = h;
    phone = w < PHONE;
    scene?.resize(width, height, phone);
    forgetSizes();
  }

  function placeLabels(scene: StoryScene) {
    const bounds = scene.explodedBounds();
    const columns: Record<"left" | "right", Placed[]> = { left: [], right: [] };
    const widest = { left: 0, right: 0 };
    for (const label of labels) {
      if (!label.width) {
        label.width = label.element.offsetWidth;
        label.height = label.element.offsetHeight;
      }
      widest[label.target.part.side] = Math.max(widest[label.target.part.side], label.width);
      const alpha = labelAlpha(label.target.part, P);
      if (alpha <= 0.004) {
        fade(label.element, 0);
        label.line.style.display = label.dot.style.display = "none";
        continue;
      }
      columns[label.target.part.side].push({ label, alpha, anchor: scene.partAnchor(label.target, { x: 0, y: 0 }), y: 0 });
    }
    // The columns stand clear of the fully exploded printer, inside the page gutter and left of the rail.
    const pad = phone ? 10 : 28;
    const right = Math.min(bounds.right + pad, width - widest.right - (phone ? 24 : 150));
    const left = Math.max(bounds.left - pad, widest.left + (phone ? 12 : 48));
    const gap = phone ? 17 : 24;
    for (const side of ["left", "right"] as const) {
      const column = columns[side].sort((a, b) => a.anchor.y - b.anchor.y);
      stack(column, gap, phone ? 64 : 84, height - (phone ? 16 : 24));
      for (const { label, alpha, anchor, y } of column) {
        const x = side === "right" ? right : left - label.width;
        const end = side === "right" ? right - 8 : left + 8;
        const knee = side === "right" ? end - 14 : end + 14;
        label.element.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - label.height / 2).toFixed(1)}px, 0)`;
        fade(label.element, alpha);
        const length = Math.hypot(knee - anchor.x, y - anchor.y) + 14;
        label.line.style.display = label.dot.style.display = "inline";
        label.line.setAttribute("d", `M${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)}L${knee.toFixed(1)} ${y.toFixed(1)}L${end.toFixed(1)} ${y.toFixed(1)}`);
        label.line.style.strokeDasharray = length.toFixed(1);
        label.line.style.strokeDashoffset = (length * (1 - alpha)).toFixed(1);
        label.dot.setAttribute("cx", anchor.x.toFixed(1));
        label.dot.setAttribute("cy", anchor.y.toFixed(1));
        label.dot.style.opacity = alpha.toFixed(2);
      }
    }
  }

  function placeDimensions(scene: StoryScene, alpha: number) {
    for (const dimension of dimensions) {
      fade(dimension.element, alpha);
      if (alpha <= 0.004) continue;
      if (!dimension.width) dimension.width = dimension.element.offsetWidth;
      const at = scene.dimensionAnchor(dimension.point, { x: 0, y: 0 });
      const x = dimension.vertical ? at.x + 10 : at.x - dimension.width / 2;
      const y = dimension.vertical ? at.y - 7 : at.y + (dimension.point.y > 0 ? -21 : 7);
      dimension.element.style.transform = `translate3d(${clamp(x, 6, width - dimension.width - 6).toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  }

  function frame() {
    const scrolled = window.scrollY - top;
    // The end section slides up over the last stage. The readout, log, and rail leave as it comes.
    const over = clamp((scrolled - (trackLength(motion) - 100) * vh) / (60 * vh));
    const hud = 1 - smoothstep(0, 0.5, over);
    const stage = stageAt(P);
    const overlays = overlaysAt(P);

    if (scene) {
      scene.pose(P);
      scene.render();
      placeLabels(scene);
      placeDimensions(scene, overlays.dimensions);
    }
    for (const { stage: blockStage, element } of blocks) {
      const { alpha, y } = copyAt(blockStage, P, motion);
      fade(element, alpha * hud, y);
      element.style.pointerEvents = alpha * hud > 0.5 ? "auto" : "none";
    }

    const view = readoutAt(P, PRINT);
    for (const key of ["kick", "kickNote", "value", "of", "unit", "line", "note"] as const) text(readout[key], view[key]);
    fade(readout.box, hud);
    fade(log, overlays.log * hud);
    for (const line of logLines) line.element.toggleAttribute("data-on", line.id === stage.id);
    fade(params, overlays.params);

    fade(rail, hud);
    rail.inert = hud < 0.5;
    railMark.style.top = `${(storyFraction(P, motion) * 100).toFixed(2)}%`;
    for (const { stop, button } of stops) {
      if (stop.label === stage.rail) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    }
  }

  function tick() {
    raf = 0;
    const gap = target - P;
    P = motion === "still" || Math.abs(gap) < 0.02 ? target : P + gap * 0.16;
    frame();
    if (P !== target) raf = requestAnimationFrame(tick);
  }

  function invalidate() {
    if (!raf && !stopped) raf = requestAnimationFrame(tick);
  }

  function onScroll() {
    target = positionAt(scrollVh(), motion);
    invalidate();
  }

  function onResize() {
    measure(false);
    onScroll();
  }

  function goTo(id: StageId, t: number) {
    window.scrollTo({ top: top + scrollFor(id, t, motion) * vh, behavior: motion === "full" ? "smooth" : "auto" });
  }

  // Keyboard focus inside a stage's copy brings that stage on screen.
  function onFocus(event: FocusEvent) {
    const focused = event.target;
    if (!(focused instanceof Element)) return;
    const block = blocks.find(({ element }) => element.contains(focused));
    if (block && block.stage.id !== stageAt(P).id) goTo(block.stage.id, block.stage.still);
  }

  const themeWatch = new MutationObserver(() => {
    scene?.setPalette(palette());
    invalidate();
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const railClicks = stops.map(({ stop, button }) => {
    const [id, t] = stop.target;
    const onClick = () => goTo(id, t);
    button.addEventListener("click", onClick);
    return () => button.removeEventListener("click", onClick);
  });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  root.addEventListener("focusin", onFocus);
  void document.fonts.ready.then(() => {
    forgetSizes();
    invalidate();
  });

  measure(true);
  target = P = positionAt(scrollVh(), motion);
  invalidate();

  loadModels()
    .then((models) => {
      if (stopped) return;
      const loaded = new StoryScene(canvas, models);
      loaded.setPalette(palette());
      loaded.resize(width, height, phone);
      labels = loaded.parts.map((target) => ({
        target,
        element: pick(root, `[data-part="${target.part.name}"]`, HTMLElement),
        line: pick(root, `[data-line="${target.part.name}"] path`, SVGPathElement),
        dot: pick(root, `[data-line="${target.part.name}"] circle`, SVGCircleElement),
        width: 0,
        height: 0,
      }));
      dimensions = loaded.dimensions.map(({ dimension, point }, i) => ({
        point,
        vertical: dimension.offset[0] !== 0,
        element: pick(root, `[data-dimension="${i}"]`, HTMLElement),
        width: 0,
      }));
      scene = loaded;
      onStatus(null);
      invalidate();
    })
    .catch((error: unknown) => {
      if (stopped) return;
      onStatus(`The 3D view did not load. ${error instanceof Error ? error.message : String(error)}`);
    });

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    themeWatch.disconnect();
    for (const remove of railClicks) remove();
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    root.removeEventListener("focusin", onFocus);
    scene?.dispose();
  };
}
