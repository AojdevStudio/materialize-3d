/**
 * Drives the story from the scroll. It maps the scroll offset to the story position P,
 * eases toward it, and on each frame poses the 3D scene and writes the copy, the part
 * labels, the readout, the agent's trace card, and the rail. It draws only while P is
 * still moving, so nothing repaints while the reader is still.
 *
 * React renders every element once. This module only sets their opacity, position,
 * and the text of the readout and the trace card, through the data attributes
 * ScrollStory puts on them.
 */
import type { Vector3 } from "three";
import { loadModels } from "./assets";
import { PRINT } from "./facts";
import { StoryScene, type Palette, type Point, type PrinterPart } from "./scene";
import {
  COPY_STAGES,
  RAIL,
  TRACE,
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
  traceAt,
  trackLength,
  type Motion,
  type ReadoutView,
  type StageId,
} from "./timeline";

/** Below this width, held upright, the story uses its phone framing. Matches the stylesheet's phone layout. */
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

/** How far a trace line is in. Its height and opacity follow it in CSS. */
function lineIn(element: HTMLElement, amount: number) {
  const value = amount < 0.004 ? "0" : Math.min(1, amount).toFixed(3);
  if (element.style.getPropertyValue("--in") !== value) element.style.setProperty("--in", value);
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
  const blocks = COPY_STAGES.map((stage) => ({ stage, element: pick(root, `[data-stage="${stage.id}"]`, HTMLElement), box: new DOMRect(), crowds: false }));
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
  const traceBox = pick(root, ".story-trace", HTMLElement);
  const trace = {
    card: pick(traceBox, ".trace-card", HTMLElement),
    kick: pick(traceBox, '[data-trace="kick"]', HTMLElement),
    head: pick(traceBox, '[data-trace="head"]', HTMLElement),
    count: pick(traceBox, '[data-trace="count"]', HTMLElement),
    lines: TRACE.map((stage) => pick(traceBox, `[data-step="${stage.id}"]`, HTMLElement)),
  };
  const params = pick(root, ".story-params", HTMLElement);
  const rail = pick(root, ".story-rail", HTMLElement);
  const railMark = pick(rail, ".rail-mark", HTMLElement);
  const stops = RAIL.map((stop) => ({ stop, button: pick(rail, `[data-rail="${stop.label}"]`, HTMLButtonElement) }));

  let scene: StoryScene | null = null;
  let labels: Label[] = [];
  let dimensions: { point: Vector3; vertical: boolean; element: HTMLElement; width: number; height: number }[] = [];
  let width = 0;
  let height = 0;
  let phone = false;
  /** px per vh, read from the track so it matches CSS even while a phone's toolbar slides. */
  let vh = 1;
  let top = 0;
  /** Where the readout sits, and whether params.json or the full trace card reaches into it. */
  let readoutBox = new DOMRect();
  let paramsCrowd = false;
  let traceCrowd = false;
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
    for (const dimension of dimensions) dimension.width = dimension.height = 0;
  }

  /**
   * A short screen has no room for every copy block above the readout. The readout steps aside
   * while any copy, params.json, or the trace card that reaches into it is showing. Read with no
   * lift on the copy and every trace line in. The next frame puts them back.
   */
  function measureCrowding() {
    for (const { element } of blocks) element.style.transform = "";
    for (const line of trace.lines) line.style.removeProperty("--in");
    readoutBox = readout.box.getBoundingClientRect();
    const crowds = (box: DOMRect) =>
      box.bottom + 16 > readoutBox.top && box.top < readoutBox.bottom && box.left < readoutBox.right && box.right > readoutBox.left;
    for (const block of blocks) {
      block.box = block.element.getBoundingClientRect();
      block.crowds = crowds(block.box);
    }
    paramsCrowd = crowds(params.getBoundingClientRect());
    traceCrowd = crowds(traceBox.getBoundingClientRect());
  }

  function measure(force: boolean) {
    vh = track.offsetHeight / trackLength(motion);
    top = root.getBoundingClientRect().top + window.scrollY;
    measureCrowding();
    const w = window.innerWidth;
    const h = window.innerHeight;
    // A phone's toolbar sliding in and out changes only the height a little. Keep the frame steady then.
    if (!force && phone && w === width && Math.abs(h - height) < 120) return;
    width = w;
    height = h;
    phone = w < PHONE && h >= w;
    scene?.resize(width, height, phone);
    forgetSizes();
  }

  /** Lays out the teardown labels. A column that would run into the readout, `avoid`, stops above it. */
  function placeLabels(scene: StoryScene, avoid: DOMRect | null) {
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
      const [from, to] = side === "right" ? [right, right + widest.right] : [left - widest.left, left];
      const floor = height - (phone ? 16 : 24);
      stack(column, gap, phone ? 64 : 84, avoid && from < avoid.right && to > avoid.left ? Math.min(floor, avoid.top - 16) : floor);
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

  /** Places the drawing's sizes. On a small screen a size that would cover `text` on screen steps aside. */
  function placeDimensions(scene: StoryScene, alpha: number, text: readonly DOMRect[]) {
    for (const dimension of dimensions) {
      if (alpha <= 0.004) {
        fade(dimension.element, 0);
        continue;
      }
      if (!dimension.width) {
        dimension.width = dimension.element.offsetWidth;
        dimension.height = dimension.element.offsetHeight;
      }
      const at = scene.dimensionAnchor(dimension.point, { x: 0, y: 0 });
      const x = clamp(dimension.vertical ? at.x + 10 : at.x - dimension.width / 2, 6, width - dimension.width - 6);
      const y = dimension.vertical ? at.y - 7 : at.y + (dimension.point.y > 0 ? -21 : 7);
      dimension.element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      const covers = text.some((box) => x < box.right && x + dimension.width > box.left && y < box.bottom && y + dimension.height > box.top);
      fade(dimension.element, covers ? 0 : alpha);
    }
  }

  function frame() {
    const scrolled = window.scrollY - top;
    // The end section slides up over the last stage. The readout and rail leave as it comes.
    const over = clamp((scrolled - (trackLength(motion) - 100) * vh) / (60 * vh));
    const hud = 1 - smoothstep(0, 0.5, over);
    const stage = stageAt(P);
    const overlays = overlaysAt(P);
    const traceView = traceAt(P);

    // Write the trace first: the sizes below read where the card ends.
    fade(traceBox, traceView.alpha * hud);
    text(trace.kick, traceView.kick);
    text(trace.head, traceView.head);
    text(trace.count, traceView.count);
    trace.card.toggleAttribute("data-done", traceView.done);
    for (const [i, line] of trace.lines.entries()) lineIn(line, traceView.lines[i] ?? 0);

    // The copy, the trace, and the readout on screen, which the labels and sizes keep clear of, and
    // how much of what the readout must not cover is showing.
    const shown: DOMRect[] = [];
    let cover = Math.max(paramsCrowd ? overlays.params : 0, traceCrowd ? traceView.alpha : 0);
    for (const block of blocks) {
      const { alpha, y } = copyAt(block.stage, P, motion);
      fade(block.element, alpha * hud, y);
      block.element.style.pointerEvents = alpha * hud > 0.5 ? "auto" : "none";
      if (alpha * hud > 0.004) shown.push(block.box);
      if (block.crowds) cover = Math.max(cover, alpha);
    }
    // The card shrinks as lines leave, so its box is read only while the sizes need it.
    if (traceView.alpha > 0.004 && overlays.dimensions > 0.004) shown.push(traceBox.getBoundingClientRect());
    // The readout is gone before what it steps aside for is a third of the way in.
    const readoutAlpha = hud * (1 - smoothstep(0, 0.35, cover));
    const readoutShown = readoutAlpha > 0.004 && readoutBox.height > 0;
    if (readoutShown) shown.push(readoutBox);

    if (scene) {
      scene.pose(P);
      scene.render();
      placeLabels(scene, readoutShown ? readoutBox : null);
      placeDimensions(scene, overlays.dimensions, shown);
    }

    const view = readoutAt(P, PRINT);
    for (const key of ["kick", "kickNote", "value", "of", "unit", "line", "note"] as const) text(readout[key], view[key]);
    fade(readout.box, readoutAlpha);
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
    measureCrowding();
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
        height: 0,
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
