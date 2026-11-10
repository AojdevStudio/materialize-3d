/**
 * The 3D side of the story: the printer that comes apart, the plate the right shelf
 * prints on, and the dock mount the rewind takes apart. `pose(P)` sets every object
 * and the camera for one story position, and `render()` draws it. The scene draws
 * only when asked, so nothing repaints while the reader is still.
 */
import {
  BackSide,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  RepeatWrapping,
  Scene,
  ShadowMaterial,
  Vector3,
  Vector4,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Models } from "./assets";
import { DIMENSIONS, DOCK_BOX, EXPLODE, PRINT_MATRIX, PRINT_SIZE, type Dimension } from "./facts";
import type { Part } from "./parts";
import { CAMERA, at, clamp, ease, lerp, liftAt, mountAlpha, printedAt, progress, ramp, smoothstep, type CameraKey } from "./timeline";

export type Palette = { paper: string; ink: string; accent: string; dark: boolean };
export type Point = { x: number; y: number };
export type Rect = { left: number; right: number; top: number; bottom: number };

/** Brand oxblood for lines, and the same plastic under the key light, so it lands on oxblood and not on red. */
const OXBLOOD = 0x89272c;
const OXBLOOD_LIT = 0x6e1f27;
const HIGHLIGHT = new Color(0x8a2a31);
/** Light gray that lands near brand concrete once lit. */
const CONCRETE = 0xb4b5b4;

/** A material's own fade values, so the teardown can fade a part and restore it. */
type Fade = { material: Material; opacity: number; transparent: boolean; depthWrite: boolean };

/** A printer part as the scene moves it. The page lays out one leader label per part. */
export type PrinterPart = { part: Part; object: Object3D; base: Vector3; offset: Vector3; fades: Fade[]; exploded: Box3; alpha: number };

const DOCK_PARTS = ["back_plate", "rail_left", "rail_right", "shelf_left", "shelf_right", "adapter"] as const;
type DockPartName = (typeof DOCK_PARTS)[number];
type DockPiece = { mesh: Mesh; material: MeshStandardMaterial; base: Color; edges: LineSegments; offset: Vector3 };

type Key = CameraKey & { at: number; point: Vector3 };
type Segment = { from: Key; to: Key };

/** A soft speckle for the textured PEI plate, drawn once into a tiling texture. */
function grainTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("No 2D canvas for the plate texture");
  g.fillStyle = "#808080";
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 5200; i++) {
    const x = random() * 256;
    const y = random() * 256;
    const r = 0.8 + random() * 2.2;
    const v = Math.floor(70 + random() * 150);
    g.fillStyle = `rgba(${v},${v},${v},0.55)`;
    for (const [ox, oy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]] as const) {
      g.beginPath();
      g.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function meshNamed(root: Object3D, name: string, file: string): Mesh {
  const object = root.getObjectByName(name);
  if (!(object instanceof Mesh)) throw new Error(`${file} has no mesh named ${name}`);
  return object;
}

export class StoryScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(28, 1, 0.02, 60);
  private readonly key = new DirectionalLight(0xffffff, 2.3);
  private readonly ground = new Mesh(new PlaneGeometry(6, 6), new ShadowMaterial({ opacity: 0.2, transparent: true, depthWrite: false }));
  readonly parts: readonly PrinterPart[];
  /** Each drawing dimension with the point its label sits at, in the mount's own space. */
  readonly dimensions: readonly { dimension: Dimension; point: Vector3 }[];
  private readonly segments: readonly Segment[];
  private readonly firstSegment: Segment;
  private readonly plate: Vector3;
  private readonly palette = { paper: new Color(), ink: new Color(), accent: new Color(), dark: false };
  private width = 1;
  private height = 1;
  private phone = false;

  // The print and the dock mount.
  private readonly mount = new Group();
  private readonly inner = new Group();
  private readonly pieces: Record<DockPartName, DockPiece>;
  private readonly shelf: Mesh;
  private readonly cut: Mesh;
  private readonly hot: Mesh;
  private readonly clipTop = new Plane(new Vector3(0, -1, 0), 10);
  private readonly clipHotBelow = new Plane(new Vector3(0, 1, 0), 0);
  private readonly printPose = { position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3() };
  private readonly printOrigin = new Vector3();
  private readonly slices: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly nozzle = new Group();
  private readonly nozzleMetal: MeshStandardMaterial[];
  private readonly nozzleAxis: LineBasicMaterial;
  private readonly ghost: LineSegments<EdgesGeometry, LineDashedMaterial>;
  private readonly dimensionLines: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly edgeMaterial = new LineBasicMaterial({ color: 0x1e1e1e, transparent: true, opacity: 0 });
  private readonly models: Models;

  // Scratch values, reused every frame.
  private readonly v = new Vector3();
  private readonly w = new Vector3();
  private readonly q = new Quaternion();
  private readonly m = new Matrix4();
  private readonly color = new Color();

  constructor(canvas: HTMLCanvasElement, models: Models) {
    this.models = models;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    const { renderer, scene, key } = this;
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.localClippingEnabled = true;

    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    pmrem.dispose();
    scene.environmentIntensity = 0.85;

    key.castShadow = true;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.002;
    key.shadow.radius = 5;
    scene.add(key, key.target);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    scene.add(this.ground);

    this.plate = models.plateTop.clone();
    this.parts = this.setupPrinter();

    // The mount's station sits below the plate, where the camera goes for the rewind.
    const station = new Vector3(this.plate.x, this.plate.y - 0.62, this.plate.z);
    const targets = { printer: new Vector3(), plate: this.plate, station };
    const keys: Key[] = CAMERA.map((camera) => ({
      ...camera,
      at: at(camera.stage, camera.t),
      point: targets[camera.target].clone().add(new Vector3(0, camera.lift, 0)),
    }));
    this.segments = keys.flatMap((from, i) => {
      const to = keys[i + 1];
      return to ? [{ from, to }] : [];
    });
    const first = this.segments[0];
    if (!first) throw new Error("The camera needs at least two keys");
    this.firstSegment = first;

    this.mount.position.copy(station);
    this.mount.rotation.y = Math.PI;
    this.inner.position.set(0, 0, 0.043);
    this.mount.add(this.inner);
    scene.add(this.mount);
    this.mount.updateMatrixWorld(true);

    const piece = (name: DockPartName): DockPiece => {
      const geometry = meshNamed(models.dock, name, "dock.glb").geometry;
      const printed = name === "shelf_right";
      const material = new MeshStandardMaterial({ color: printed ? OXBLOOD_LIT : CONCRETE, roughness: 0.62, metalness: 0, transparent: true });
      material.polygonOffset = true;
      material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 1;
      const mesh = new Mesh(geometry, material);
      mesh.castShadow = printed;
      const edges = new LineSegments(new EdgesGeometry(geometry, 28), this.edgeMaterial);
      mesh.add(edges);
      // The printed shelf travels from the plate to the mount, so it lives in the scene, not the mount.
      (printed ? scene : this.inner).add(mesh);
      return { mesh, material, base: material.color.clone(), edges, offset: new Vector3() };
    };
    this.pieces = {
      back_plate: piece("back_plate"),
      rail_left: piece("rail_left"),
      rail_right: piece("rail_right"),
      shelf_left: piece("shelf_left"),
      shelf_right: piece("shelf_right"),
      adapter: piece("adapter"),
    };
    this.shelf = this.pieces.shelf_right.mesh;

    // The print pose on the plate, with the part's footprint centred.
    const [sizeX, sizeY] = PRINT_SIZE;
    this.printOrigin.set(this.plate.x - sizeX / 2000, this.plate.y, this.plate.z + sizeY / 2000);
    const pose = new Matrix4().fromArray(PRINT_MATRIX);
    new Matrix4()
      .makeTranslation(this.printOrigin.x, this.printOrigin.y, this.printOrigin.z)
      .multiply(pose)
      .decompose(this.printPose.position, this.printPose.quaternion, this.printPose.scale);

    // Layer lines in the plastic, in print space, so they stay with the part when it moves.
    const row = new Vector4(pose.elements[1], pose.elements[5], pose.elements[9], pose.elements[13]);
    const shelfMaterial = this.pieces.shelf_right.material;
    shelfMaterial.clippingPlanes = [this.clipTop];
    shelfMaterial.clipShadows = true;
    shelfMaterial.roughness = 0.58;
    shelfMaterial.envMapIntensity = 0.8;
    shelfMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uRow = { value: row };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform vec4 uRow;\nvarying float vPy;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPy = dot(uRow, vec4(position, 1.0));");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vPy;")
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          { float ly = vPy / 0.0002; float fw = fwidth(ly); float band = 0.5 + 0.5 * cos(6.2831853 * ly);
            float k = clamp(1.0 - fw * 1.3, 0.0, 1.0);
            float mm = vPy / 0.001; float fm = fwidth(mm); float coarse = smoothstep(0.0, fm * 1.5 + 0.06, abs(fract(mm) - 0.5) * 2.0);
            diffuseColor.rgb *= mix(0.94, 0.8 + 0.2 * band, k) * mix(1.0, 0.9 + 0.1 * coarse, clamp(1.0 - fm * 2.0, 0.0, 1.0)); }`,
        );
    };
    // While it prints, back faces in a flat darker shade read as the solid cut face, and a thin band as the hot layer.
    this.cut = new Mesh(this.shelf.geometry, new MeshBasicMaterial({ color: 0x661b20, side: BackSide, clippingPlanes: [this.clipTop] }));
    this.hot = new Mesh(
      this.shelf.geometry,
      new MeshBasicMaterial({
        color: 0xc4565b,
        clippingPlanes: [this.clipTop, this.clipHotBelow],
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.shelf.add(this.cut, this.hot);

    // The printed part's real slice outlines.
    const outline: number[] = [];
    for (const slice of models.slices) {
      const y = slice.z / 1000;
      for (const loop of slice.loops) {
        for (const { a, b } of loop) outline.push(a.x / 1000, y, -a.y / 1000, b.x / 1000, y, -b.y / 1000);
      }
    }
    const sliceGeometry = new BufferGeometry();
    sliceGeometry.setAttribute("position", new Float32BufferAttribute(outline, 3));
    this.slices = new LineSegments(sliceGeometry, new LineBasicMaterial({ color: OXBLOOD, transparent: true, opacity: 0 }));
    this.slices.position.copy(this.printOrigin);
    this.slices.visible = false;
    scene.add(this.slices);

    // The nozzle, drawn small over the layer it lays down.
    const steel = new MeshStandardMaterial({ color: 0x9a9da1, metalness: 1, roughness: 0.3, transparent: true });
    const dark = new MeshStandardMaterial({ color: 0x2b2c2f, metalness: 0.8, roughness: 0.45, transparent: true });
    const tip = new Mesh(new ConeGeometry(0.0021, 0.0036, 20), steel);
    tip.rotation.x = Math.PI;
    tip.position.y = 0.0018;
    const hex = new Mesh(new CylinderGeometry(0.0028, 0.0028, 0.002, 6), steel);
    hex.position.y = 0.0046;
    const block = new Mesh(new BoxGeometry(0.0085, 0.0058, 0.0072), dark);
    block.position.y = 0.0085;
    const stem = new Mesh(new CylinderGeometry(0.0013, 0.0013, 0.012, 12), steel);
    stem.position.y = 0.0174;
    this.nozzleAxis = new LineBasicMaterial({ color: 0x1e1e1e, transparent: true, opacity: 0.4 });
    const axis = new Line(new BufferGeometry().setFromPoints([new Vector3(0, 0.0234, 0), new Vector3(0, 0.085, 0)]), this.nozzleAxis);
    tip.castShadow = block.castShadow = true;
    this.nozzle.add(tip, hex, block, stem, axis);
    this.nozzleMetal = [steel, dark];
    this.nozzle.visible = false;
    scene.add(this.nozzle);

    // The dock itself, as a dashed reference box. It is not printed.
    const [x0, x1] = DOCK_BOX.x;
    const [y0, y1] = DOCK_BOX.y;
    const [z0, z1] = DOCK_BOX.z;
    // Dock axes in mm (x right, y away, z up) to three.js axes in metres.
    const box = new BoxGeometry((x1 - x0) / 1000, (z1 - z0) / 1000, (y1 - y0) / 1000);
    box.translate((x0 + x1) / 2000, (z0 + z1) / 2000, -(y0 + y1) / 2000);
    this.ghost = new LineSegments(new EdgesGeometry(box), new LineDashedMaterial({ color: 0x1e1e1e, dashSize: 0.006, gapSize: 0.004, transparent: true, opacity: 0 }));
    this.ghost.computeLineDistances();
    this.inner.add(this.ghost);

    // The drawing's dimension lines on the front elevation: extension lines, the dimension line, slash ticks.
    const depth = -0.09;
    const tick = 0.006;
    const lines: number[] = [];
    this.dimensions = DIMENSIONS.map((dimension) => {
      const { from, to, offset } = dimension;
      const [ax, ay] = from;
      const [bx, by] = to;
      const [ex, ey] = offset;
      lines.push(ax, ay, depth, ax + ex * 1.25, ay + ey * 1.25, depth, bx, by, depth, bx + ex * 1.25, by + ey * 1.25, depth);
      const p1 = [ax + ex, ay + ey] as const;
      const p2 = [bx + ex, by + ey] as const;
      lines.push(p1[0], p1[1], depth, p2[0], p2[1], depth);
      for (const [px, py] of [p1, p2]) lines.push(px - tick / 2, py - tick / 2, depth, px + tick / 2, py + tick / 2, depth);
      return { dimension, point: new Vector3((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, depth) };
    });
    const dimensionGeometry = new BufferGeometry();
    dimensionGeometry.setAttribute("position", new Float32BufferAttribute(lines, 3));
    this.dimensionLines = new LineSegments(dimensionGeometry, new LineBasicMaterial({ color: OXBLOOD, transparent: true, opacity: 0 }));
    this.inner.add(this.dimensionLines);
  }

  private setupPrinter(): PrinterPart[] {
    const { printer, parts } = this.models;
    this.scene.add(printer);
    printer.updateMatrixWorld(true);
    const glass = new MeshPhysicalMaterial({
      color: 0x0b0c0e,
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.46,
      depthWrite: false,
      envMapIntensity: 1.5,
      side: DoubleSide,
    });
    const grain = grainTexture();
    return parts.map(({ part, offset }) => {
      const object = printer.getObjectByName(part.name);
      if (!object) throw new Error(`printer.glb has no part named ${part.name}`);
      const fades: Fade[] = [];
      object.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        const source: unknown = node.material;
        if (!(source instanceof MeshStandardMaterial)) throw new Error(`printer.glb: ${node.name} has no standard material`);
        node.castShadow = true;
        node.receiveShadow = true;
        let material: MeshStandardMaterial;
        if (source.name === "glass") {
          material = glass.clone();
          node.castShadow = false;
          node.renderOrder = 3;
        } else {
          material = source.clone();
          if (source.name === "pei_plate") {
            // Planar UVs from x and z, so the speckle tiles every 2 cm across the plate.
            const position = node.geometry.getAttribute("position");
            const uv = new Float32Array(position.count * 2);
            for (let v = 0; v < position.count; v++) {
              uv[v * 2] = position.getX(v) / 0.02;
              uv[v * 2 + 1] = position.getZ(v) / 0.02;
            }
            node.geometry.setAttribute("uv", new BufferAttribute(uv, 2));
            material.bumpMap = grain;
            material.bumpScale = 1.6;
            material.roughnessMap = grain;
            material.roughness = 1;
            material.metalness = 0.3;
            material.color.set(0x34322e);
          }
        }
        node.material = material;
        fades.push({ material, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
      });
      const exploded = new Box3().setFromObject(object).translate(offset);
      return { part, object, base: object.position.clone(), offset, fades, exploded, alpha: -1 };
    });
  }

  private fadePart(part: PrinterPart, value: number) {
    const alpha = clamp(value);
    if (Math.abs(alpha - part.alpha) < 0.002) return;
    part.alpha = alpha;
    part.object.visible = alpha > 0.004;
    for (const fade of part.fades) {
      fade.material.opacity = fade.opacity * alpha;
      fade.material.transparent = fade.transparent || alpha < 0.999;
      fade.material.depthWrite = fade.depthWrite && alpha > 0.5;
    }
  }

  resize(width: number, height: number, phone: boolean) {
    this.width = width;
    this.height = height;
    this.phone = phone;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, phone ? 2 : 1.75));
    this.renderer.setSize(width, height, false);
    const size = phone ? 1024 : 2048;
    if (this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
  }

  setPalette(palette: Palette) {
    this.palette.paper.set(palette.paper);
    this.palette.ink.set(palette.ink);
    this.palette.accent.set(palette.accent);
    this.palette.dark = palette.dark;
  }

  private poseCamera(P: number) {
    let segment = this.firstSegment;
    for (const candidate of this.segments) if (P >= candidate.from.at) segment = candidate;
    const { from: a, to: b } = segment;
    const u = ease((P - a.at) / Math.max(1e-6, b.at - a.at));
    const [aw, ah, ax, ay] = this.phone ? a.frame.phone : a.frame.desktop;
    const [bw, bh, bx, by] = this.phone ? b.frame.phone : b.frame.desktop;
    const fw = lerp(aw, bw, u);
    const fh = lerp(ah, bh, u);
    const sx = lerp(ax, bx, u);
    const sy = lerp(ay, by, u);
    const fov = lerp(a.fov, b.fov, u);
    const yaw = MathUtils.degToRad(lerp(a.yaw, b.yaw, u));
    const pitch = MathUtils.degToRad(lerp(a.pitch, b.pitch, u));
    const fitW = lerp(a.fit[0], b.fit[0], u);
    const fitH = lerp(a.fit[1], b.fit[1], u);
    const target = this.v.lerpVectors(a.point, b.point, u);
    const aspect = this.width / this.height;
    const tan = Math.tan(MathUtils.degToRad(fov) / 2);
    const distance = Math.max(fitH / 2 / (tan * fh), fitW / 2 / (tan * aspect * fw));
    const { camera } = this;
    camera.fov = fov;
    camera.aspect = aspect;
    camera.position.set(
      target.x + distance * Math.sin(yaw) * Math.cos(pitch),
      target.y + distance * Math.sin(pitch),
      target.z + distance * Math.cos(yaw) * Math.cos(pitch),
    );
    camera.lookAt(target);
    camera.near = Math.max(0.01, distance * 0.05);
    camera.far = distance * 4 + 10;
    camera.setViewOffset(this.width, this.height, -sx * this.width, -sy * this.height, this.width, this.height);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // The key light and its shadow box follow what is in view.
    const extent = Math.max(0.12, Math.max(fitW, fitH) * 0.85);
    this.key.position.set(target.x + 2.2 * extent, target.y + 4.4 * extent, target.z + 3 * extent);
    this.key.target.position.copy(target);
    const shadow = this.key.shadow.camera;
    shadow.left = shadow.bottom = -extent;
    shadow.right = shadow.top = extent;
    shadow.near = 0.01;
    shadow.far = extent * 12;
    shadow.updateProjectionMatrix();
  }

  /** Sets every object and the camera for story position P. */
  pose(P: number) {
    this.poseCamera(P);
    const { palette } = this;
    const dive = ease(progress("dive", P));

    // The printer comes apart top down, drifts a little further on the dive, and fades as the camera reaches the plate.
    const printerAlpha = 1 - ramp("dive", 0.08, 0.7, P);
    for (const part of this.parts) {
      if (part.part.lift === null) {
        this.fadePart(part, 1 - ramp("guide", 0.02, 0.3, P));
        continue;
      }
      part.object.position.copy(part.base).addScaledVector(part.offset, ease(liftAt(part.part, P)) * (1 + 0.22 * dive));
      this.fadePart(part, printerAlpha);
    }
    this.ground.material.opacity = palette.dark ? 0 : 0.2 * (1 - ramp("explode", 0, 0.18, P));
    this.ground.visible = this.ground.material.opacity > 0.003;

    // The print rises layer by layer under a clipping plane.
    const sizeMm = PRINT_SIZE[2];
    const grow = printedAt(P);
    const heightMm = sizeMm * grow;
    const done = heightMm >= sizeMm - 1e-6;
    const top = this.plate.y + heightMm / 1000;
    this.clipTop.constant = done ? 10 : top + 1e-5;
    this.clipHotBelow.constant = -(top - 0.00045);
    this.cut.visible = this.hot.visible = !done && heightMm > 0;
    const story = mountAlpha(P);
    this.shelf.visible = heightMm > 0 && story > 0.004;

    const printing = P >= at("dive", 0.75) && P < at("slices", 0.02);
    const nozzleAlpha = ramp("print", 0.03, 0.09, P) * (1 - smoothstep(0.96, 1, grow));
    this.nozzle.visible = nozzleAlpha > 0.004 && printing;
    if (this.nozzle.visible) {
      this.nozzleAt(Math.max(heightMm, 0.25), grow * 46, this.w);
      this.nozzle.position.set(this.w.x, top + 0.0002, this.w.z);
      for (const material of this.nozzleMetal) material.opacity = nozzleAlpha;
      this.nozzleAxis.opacity = 0.4 * nozzleAlpha;
      this.nozzleAxis.color.copy(palette.ink);
    }

    // Rewind to the slices: the outlines spread apart and the plastic thins.
    const sliceBell = ramp("slices", 0.08, 0.42, P) * (1 - ramp("slices", 0.66, 0.96, P));
    this.slices.visible = sliceBell > 0.004;
    this.slices.material.opacity = sliceBell;
    this.slices.material.color.copy(palette.accent);
    this.slices.scale.y = 1 + 1.9 * sliceBell;

    // The mount gathers around the printed shelf, shows the adapter, comes apart, then flattens into the drawing.
    const kPose = ease(ramp("guide", 0.02, 0.6, P));
    const explodeK = ease(ramp("parts", 0.05, 0.5, P)) * (1 - ease(ramp("drawing", 0, 0.34, P)));
    const others = ramp("guide", 0.34, 0.72, P);
    const gather = 1 - ease(ramp("guide", 0.3, 0.8, P));
    const flat = ramp("drawing", 0.16, 0.56, P);
    const adapterLit = ramp("adapter", 0.1, 0.4, P);
    const adapterGone = ease(ramp("adapter", 0.58, 0.96, P));
    const railY = EXPLODE.railY / 1000;
    const shelfX = EXPLODE.shelfX / 1000;
    const { pieces } = this;
    pieces.rail_left.offset.set(-0.03 * gather, 0, -railY * explodeK - 0.04 * gather);
    pieces.rail_right.offset.set(0.03 * gather, 0, -railY * explodeK - 0.04 * gather);
    pieces.shelf_left.offset.set(-shelfX * explodeK - 0.05 * gather, 0.02 * gather, 0);
    pieces.shelf_right.offset.set(shelfX * explodeK, 0, 0);
    pieces.back_plate.offset.set(0, 0, 0.03 * gather);
    pieces.adapter.offset.set(0, -0.03 * gather, 0.05 * gather + 0.09 * adapterGone);
    for (const name of DOCK_PARTS) {
      const piece = pieces[name];
      const printed = name === "shelf_right";
      let alpha = (printed ? 1 - 0.88 * sliceBell : others) * story;
      if (name === "adapter") alpha *= 1 - adapterGone;
      if (!printed) {
        piece.mesh.position.copy(piece.offset);
        piece.mesh.visible = alpha > 0.004;
      }
      // Shaded plastic flattens to paper for the drawing.
      this.color.copy(piece.base);
      if (name === "adapter") this.color.lerp(HIGHLIGHT, adapterLit * (1 - flat));
      piece.material.color.copy(this.color).multiplyScalar(1 - flat);
      piece.material.emissive.copy(palette.paper).multiplyScalar(flat);
      piece.material.envMapIntensity = 1 - flat;
      piece.material.opacity = alpha;
      piece.material.depthWrite = alpha > 0.5;
    }
    this.edgeMaterial.opacity = Math.max(flat, 0.22 * others) * story;
    this.edgeMaterial.color.copy(palette.ink);
    for (const name of DOCK_PARTS) {
      pieces[name].edges.visible = this.edgeMaterial.opacity > 0.004 && (name !== "shelf_right" || kPose > 0.98);
    }

    // The printed shelf travels from the plate into its place on the mount, with a small hop.
    this.inner.updateMatrixWorld(true);
    const place = this.w;
    this.m
      .makeTranslation(pieces.shelf_right.offset.x, pieces.shelf_right.offset.y, pieces.shelf_right.offset.z)
      .premultiply(this.inner.matrixWorld)
      .decompose(place, this.q, this.v.set(1, 1, 1));
    this.shelf.position.lerpVectors(this.printPose.position, place, kPose);
    this.shelf.position.y += 0.05 * Math.sin(Math.PI * kPose);
    this.shelf.quaternion.slerpQuaternions(this.printPose.quaternion, this.q, kPose);

    const ghostAlpha = (ramp("guide", 0.62, 0.9, P) * (1 - ramp("adapter", 0, 0.25, P)) + ramp("drawing", 0.3, 0.6, P)) * story;
    this.ghost.material.opacity = 0.75 * ghostAlpha;
    this.ghost.material.color.copy(palette.ink);
    this.ghost.visible = ghostAlpha > 0.004;
    const dimensions = ramp("drawing", 0.5, 0.78, P) * story;
    this.dimensionLines.material.opacity = dimensions;
    this.dimensionLines.material.color.copy(palette.accent);
    this.dimensionLines.visible = dimensions > 0.004;
    this.mount.visible = (others > 0.004 || ghostAlpha > 0.004) && story > 0.004;
  }

  /** Where the nozzle is over the outline nearest a height, a fraction u of the way round it. */
  private nozzleAt(heightMm: number, u: number, out: Vector3) {
    // loadModels checks there is at least one slice.
    const nearest = this.models.slices.reduce((best, slice) => (Math.abs(slice.z - heightMm) < Math.abs(best.z - heightMm) ? slice : best));
    let distance = (u % 1) * nearest.path.length;
    for (const edge of nearest.path.edges) {
      if (distance <= edge.length) {
        const t = edge.length ? clamp(distance / edge.length) : 0;
        return out.set(this.printOrigin.x + lerp(edge.a.x, edge.b.x, t) / 1000, 0, this.printOrigin.z - lerp(edge.a.y, edge.b.y, t) / 1000);
      }
      distance -= edge.length;
    }
    return out;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** A world point on screen, in CSS pixels. */
  project(point: Vector3, out: Point): Point {
    this.v.copy(point).project(this.camera);
    out.x = (this.v.x * 0.5 + 0.5) * this.width;
    out.y = (-this.v.y * 0.5 + 0.5) * this.height;
    return out;
  }

  /** Where a part's leader line starts on screen, as the part sits now. */
  partAnchor(part: PrinterPart, out: Point): Point {
    const [x, y, z] = part.part.anchor;
    return this.project(this.w.set(x, y, z).add(part.object.position).sub(part.base), out);
  }

  /** The fully exploded printer's outline on screen. The labels stand in columns either side of it. */
  explodedBounds(): Rect {
    const rect = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    const point = { x: 0, y: 0 };
    for (const { exploded } of this.parts) {
      for (let corner = 0; corner < 8; corner++) {
        this.w.set(corner & 1 ? exploded.max.x : exploded.min.x, corner & 2 ? exploded.max.y : exploded.min.y, corner & 4 ? exploded.max.z : exploded.min.z);
        this.project(this.w, point);
        rect.left = Math.min(rect.left, point.x);
        rect.right = Math.max(rect.right, point.x);
        rect.top = Math.min(rect.top, point.y);
        rect.bottom = Math.max(rect.bottom, point.y);
      }
    }
    return rect;
  }

  /** Where a dimension's label sits on screen. */
  dimensionAnchor(point: Vector3, out: Point): Point {
    return this.project(this.w.copy(point).applyMatrix4(this.inner.matrixWorld), out);
  }

  dispose() {
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
