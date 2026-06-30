import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LidarReading, Point3D } from "../types/liveMessages";
import type { TelemetryState, Vector3 } from "../types/telemetry";
import { isMeaningfulDisplayPoint, pointToDisplayThree, scanReadingsToPoints } from "../utils/lidarProcessing";
import { createPointSpriteTexture, setTurboColor } from "../utils/dashboardHelpers";

export type LidarColorMode = "intensity" | "height" | "distance";

type LidarDebugStats = {
  pointsCount: number;
  sourcePointsCount: number;
  min: Required<Vector3>;
  max: Required<Vector3>;
  threeMin: Required<Vector3>;
  threeMax: Required<Vector3>;
  firstPoints: Point3D[];
};

const LIDAR_RENDER_FPS = 40;
// Default camera: behind-and-above the ego, slightly looking down.
// In Three.js coords, vehicle is at origin and forward = -Z, so we sit at +Z (behind), +Y (above).
const DEFAULT_LIDAR_CAMERA_POSITION = new THREE.Vector3(0, 18, 28);
// Height-color range tuned for a roof-mounted sensor on a road: the ground sits
// ~1.6 m below the sensor (cool blue), curbs/people read green, walls/canopy
// warm. A tighter range than before makes low structure stand out from ground.
const HEIGHT_COLOR_MIN = -2;
const HEIGHT_COLOR_MAX = 4;

function Lidar3D({
  readings,
  points,
  activeTopic,
  frameId,
  resolvedFrame,
  vehiclePose,
  pointSize,
  colorMode,
  autoFit,
  showDebug,
}: {
  readings: LidarReading[];
  points: Point3D[];
  activeTopic?: string;
  frameId?: string;
  resolvedFrame?: string;
  vehiclePose?: TelemetryState["pose"];
  pointSize: number;
  colorMode: LidarColorMode;
  autoFit: boolean;
  showDebug: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const cloudRef = useRef<THREE.Points | null>(null);
  const vehicleRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pointTextureRef = useRef<THREE.Texture | undefined>(undefined);
  const renderRequestRef = useRef<(() => void) | null>(null);
  const rawDisplayPoints = useMemo(() => points.length > 0 ? points : scanReadingsToPoints(readings), [points, readings]);
  const hasPoints = points.length > 0;
  // Worker already filters + downsamples; we only need the meaningful-display
  // filter here. Skipping denoisePointCloud removes a 60k×27 voxel-lookup pass
  // that was killing the main thread (was ~30-50 ms per flush at capacity).
  const scenePoints = useMemo(() => {
    return rawDisplayPoints.filter((point) => isMeaningfulDisplayPoint(point, frameId, resolvedFrame, vehiclePose));
  }, [frameId, rawDisplayPoints, resolvedFrame, vehiclePose]);
  const displayPoints = scenePoints; // worker already capped to render budget
  const debugStats = useMemo<LidarDebugStats>(() => {
    // Lazy: only compute when debug overlay is visible (saves 60k×trig per frame).
    if (!showDebug) {
      return {
        pointsCount: displayPoints.length,
        sourcePointsCount: rawDisplayPoints.length,
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 },
        threeMin: { x: 0, y: 0, z: 0 },
        threeMax: { x: 0, y: 0, z: 0 },
        firstPoints: [],
      };
    }
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let threeMinX = Infinity, threeMaxX = -Infinity;
    let threeMinY = Infinity, threeMaxY = -Infinity;
    let threeMinZ = Infinity, threeMaxZ = -Infinity;

    for (const point of displayPoints) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
      const threePoint = pointToDisplayThree(point, frameId, resolvedFrame, vehiclePose);
      threeMinX = Math.min(threeMinX, threePoint.x); threeMaxX = Math.max(threeMaxX, threePoint.x);
      threeMinY = Math.min(threeMinY, threePoint.y); threeMaxY = Math.max(threeMaxY, threePoint.y);
      threeMinZ = Math.min(threeMinZ, threePoint.z); threeMaxZ = Math.max(threeMaxZ, threePoint.z);
    }

    if (displayPoints.length === 0) {
      minX = 0; maxX = 0; minY = 0; maxY = 0; minZ = 0; maxZ = 0;
      threeMinX = 0; threeMaxX = 0; threeMinY = 0; threeMaxY = 0; threeMinZ = 0; threeMaxZ = 0;
    }

    return {
      pointsCount: displayPoints.length,
      sourcePointsCount: rawDisplayPoints.length,
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
      threeMin: { x: threeMinX, y: threeMinY, z: threeMinZ },
      threeMax: { x: threeMaxX, y: threeMaxY, z: threeMaxZ },
      firstPoints: displayPoints.slice(0, 5),
    };
  }, [displayPoints, frameId, rawDisplayPoints.length, resolvedFrame, vehiclePose, showDebug]);

  const setView = useCallback((position: THREE.Vector3, target = new THREE.Vector3(0, 0, 0), up = new THREE.Vector3(0, 1, 0)) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) {
      return;
    }

    camera.up.copy(up);
    camera.position.copy(position);
    controls.target.copy(target);
    controls.update();
  }, []);

  function zoomView(multiplier: number) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) {
      return;
    }

    const offset = camera.position.clone().sub(controls.target).multiplyScalar(multiplier);
    const distance = Math.max(controls.minDistance, Math.min(controls.maxDistance, offset.length()));
    offset.setLength(distance);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }

  /**
   * fitToCloud: zoom so the cloud is visible but keep the EGO (origin) in frame.
   * Foxglove behavior — the camera target stays at (0,0,0) so the vehicle marker
   * remains anchored at the center. We only adjust camera distance.
   */
  const fitToCloud = useCallback(() => {
    const debugStats = cloudRef.current?.userData?.debugStats;
    const controls = controlsRef.current;
    if (!debugStats || !controls) return;

    const target = new THREE.Vector3(0, 0, 0);
    const span = Math.max(
      Math.abs(debugStats.threeMax.x), Math.abs(debugStats.threeMin.x),
      Math.abs(debugStats.threeMax.z), Math.abs(debugStats.threeMin.z),
      18,
    );
    // Stay behind-and-above, looking at the ego.
    setView(new THREE.Vector3(0, span * 0.55, span * 0.95), target);
  }, [setView]);

  /** True top-down view, north (forward) at the top of the screen. */
  function setTopView() {
    const target = new THREE.Vector3(0, 0, 0);
    const debugStats = cloudRef.current?.userData?.debugStats;
    let height = 60;
    if (debugStats) {
      height = Math.max(
        Math.abs(debugStats.threeMax.x), Math.abs(debugStats.threeMin.x),
        Math.abs(debugStats.threeMax.z), Math.abs(debugStats.threeMin.z),
        35,
      ) * 1.3;
    }
    // up = -Z so forward (ROS x = Three -Z) points to the top of the screen.
    setView(new THREE.Vector3(0, height, 0.001), target, new THREE.Vector3(0, 0, -1));
  }

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#070a0c");

    const camera = new THREE.PerspectiveCamera(54, mount.clientWidth / mount.clientHeight, 0.1, 260);
    camera.position.copy(DEFAULT_LIDAR_CAMERA_POSITION);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    // Cap pixel ratio at 1.5: on a 2× HiDPI display, rendering at full 2× means 4×
    // the fragments, and a fill-heavy point cloud is exactly what that punishes.
    // 1.5 cuts ~44% of the pixel work with no visible loss on sprite points.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);
    pointTextureRef.current = createPointSpriteTexture();

    // WebGL context loss (GPU OOM / driver reset under a heavy cloud) otherwise
    // leaves a permanently black canvas. Prevent the default so the browser will
    // restore the context, and re-render once it's back.
    const canvas = renderer.domElement;
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      console.warn("LiDAR WebGL context lost — waiting for restore");
    };
    const handleContextRestored = () => {
      console.warn("LiDAR WebGL context restored");
      renderRequestRef.current?.();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost, false);
    canvas.addEventListener("webglcontextrestored", handleContextRestored, false);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.panSpeed = 0.9;
    controls.rotateSpeed = 0.65;
    controls.zoomSpeed = 1.05;
    controls.maxDistance = 200;
    controls.minDistance = 4;
    controls.target.set(0, 0, 0);
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controlsRef.current = controls;

    const grid = new THREE.GridHelper(160, 32, "#0e5e9c", "#10314a");
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    grid.position.y = -1.5; // sit at typical road level relative to roof-mounted sensor
    scene.add(grid);
    // (No AxesHelper at the origin — its X/Y/Z lines punched straight through the
    // ego car. Orientation is conveyed by the forward arrow + FRONT/BACK labels.)

    const ringMaterial = new THREE.LineBasicMaterial({
      color: "#0f4e75",
      transparent: true,
      opacity: 0.45,
    });
    const ringDistances = [1, 2, 5, 10, 20, 30, 50, 80];
    const makeLabelSprite = (text: string, color = "#7dd3fc") => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = color;
        ctx.font = "bold 36px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 64, 32);
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(4, 2, 1);
      return sprite;
    };
    ringDistances.forEach((radius) => {
      const ringPoints = Array.from({ length: 128 }, (_, index) => {
        const angle = (index / 128) * Math.PI * 2;
        // In Three.js: ring on the XZ plane (y=0). ROS x (forward) maps to -Z.
        return new THREE.Vector3(Math.cos(angle) * radius, 0.01, Math.sin(angle) * radius);
      });
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPoints), ringMaterial);
      scene.add(ring);
      // Label the ring along the +x (right) axis in Three.js space.
      const label = makeLabelSprite(`${radius}m`);
      label.position.set(radius, 0.6, 0);
      scene.add(label);
    });

    // Direction labels — FRONT/BACK/LEFT/RIGHT, aligned with ROS axes.
    // ROS x forward → Three.js -Z; ROS y left → Three.js -X.
    const frontLabel = makeLabelSprite("FRONT", "#fbbf24");
    frontLabel.position.set(0, 1.2, -6);
    scene.add(frontLabel);
    const backLabel = makeLabelSprite("BACK", "#64748b");
    backLabel.position.set(0, 1.2, 6);
    scene.add(backLabel);
    const leftLabel = makeLabelSprite("LEFT", "#94a3b8");
    leftLabel.position.set(-5, 1.2, 0);
    scene.add(leftLabel);
    const rightLabel = makeLabelSprite("RIGHT", "#94a3b8");
    rightLabel.position.set(5, 1.2, 0);
    scene.add(rightLabel);

    // Bright forward-direction arrow on the ground.
    const arrowMat = new THREE.LineBasicMaterial({ color: "#fbbf24", transparent: true, opacity: 0.9 });
    const arrowGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.05, 0),
      new THREE.Vector3(0, 0.05, -6),
      new THREE.Vector3(-0.4, 0.05, -5.2),
      new THREE.Vector3(0, 0.05, -6),
      new THREE.Vector3(0.4, 0.05, -5.2),
    ]);
    scene.add(new THREE.Line(arrowGeom, arrowMat));

    const vehicle = new THREE.Group();
    // Forward is −Z. The body is built as a smooth top-view silhouette in the
    // shape's (x=width, y=length) plane, extruded for height, then laid flat with
    // rotateX(−90°) so the shape's +y maps to world −z (forward).
    const HALF_W = 1.0;
    const FRONT_Y = 2.2;
    const REAR_Y = -2.0;

    const silhouette = new THREE.Shape();
    silhouette.moveTo(0, FRONT_Y); // pointed front
    silhouette.bezierCurveTo(0.55, FRONT_Y - 0.05, HALF_W, 1.15, HALF_W, 0.4);
    silhouette.lineTo(HALF_W, -1.0);
    silhouette.bezierCurveTo(HALF_W, REAR_Y + 0.35, 0.6, REAR_Y, 0, REAR_Y); // rounded rear
    silhouette.bezierCurveTo(-0.6, REAR_Y, -HALF_W, REAR_Y + 0.35, -HALF_W, -1.0);
    silhouette.lineTo(-HALF_W, 0.4);
    silhouette.bezierCurveTo(-HALF_W, 1.15, -0.55, FRONT_Y - 0.05, 0, FRONT_Y);

    const bodyGeom = new THREE.ExtrudeGeometry(silhouette, {
      depth: 0.5,
      bevelEnabled: true,
      bevelThickness: 0.16,
      bevelSize: 0.16,
      bevelSegments: 4,
      steps: 1,
    });
    bodyGeom.rotateX(-Math.PI / 2); // lay flat: extrude height -> world +y
    const body = new THREE.Mesh(bodyGeom, new THREE.MeshBasicMaterial({ color: "#22304a" }));
    body.position.y = 0.3;
    // Only keep the sharp silhouette edges (not every bevel facet) as a cyan glow.
    body.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(bodyGeom, 32),
      new THREE.LineBasicMaterial({ color: "#38bdf8", transparent: true, opacity: 0.7 }),
    ));
    vehicle.add(body);

    // Glass canopy — a stretched translucent dome for the cabin.
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(0.92, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#7dd3fc", transparent: true, opacity: 0.5 }),
    );
    canopy.scale.set(0.92, 0.62, 1.45);
    canopy.position.set(0, 0.74, -0.15);
    vehicle.add(canopy);

    // Forward direction arrow (−Z is forward).
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.32, 0.85, 4),
      new THREE.MeshBasicMaterial({ color: "#22d3ee" }),
    );
    nose.position.set(0, 0.55, -2.55);
    nose.rotation.x = -Math.PI / 2;
    nose.rotation.y = Math.PI / 4;
    vehicle.add(nose);

    // Headlights (front, white) and tail lights (rear, red).
    const lampGeom = new THREE.BoxGeometry(0.34, 0.16, 0.12);
    [-0.62, 0.62].forEach((x) => {
      const head = new THREE.Mesh(lampGeom, new THREE.MeshBasicMaterial({ color: "#f8fafc" }));
      head.position.set(x, 0.42, -2.0);
      vehicle.add(head);
      const tail = new THREE.Mesh(lampGeom, new THREE.MeshBasicMaterial({ color: "#ef4444" }));
      tail.position.set(x, 0.42, 1.95);
      vehicle.add(tail);
    });

    const wheelMaterial = new THREE.MeshBasicMaterial({ color: "#0b1220" });
    const wheelGeom = new THREE.CylinderGeometry(0.32, 0.32, 0.26, 20);
    [
      [-1.02, 0.3, -1.25],
      [1.02, 0.3, -1.25],
      [-1.02, 0.3, 1.25],
      [1.02, 0.3, 1.25],
    ].forEach(([x, y, z]) => {
      const wheel = new THREE.Mesh(wheelGeom, wheelMaterial);
      wheel.position.set(x, y, z);
      wheel.rotation.z = Math.PI / 2;
      wheel.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(wheelGeom),
        new THREE.LineBasicMaterial({ color: "#64748b", transparent: true, opacity: 0.7 }),
      ));
      vehicle.add(wheel);
    });

    vehicle.scale.setScalar(1.1);
    // Opaque car parts already occlude the cloud via depthTest. Bump every part's
    // renderOrder above the cloud (10) so the car's *transparent* bits (glass
    // canopy, edge glow) also draw after the points instead of under them.
    vehicle.traverse((obj) => { obj.renderOrder = 20; });
    scene.add(vehicle);
    vehicleRef.current = vehicle;

    sceneRef.current = scene;
    rendererRef.current = renderer;

    // On-demand rendering: render only when data or camera changed, throttled to
    // LIDAR_RENDER_FPS. Saves ~10% CPU when idle vs continuous rAF.
    let frame = 0;
    let lastRenderMs = 0;
    let needsRender = true;
    const minRenderIntervalMs = 1000 / LIDAR_RENDER_FPS;
    const markDirty = () => { needsRender = true; };
    renderRequestRef.current = markDirty;

    // Adaptive resolution: if rendered frames keep coming in slow, step the pixel
    // ratio down (1.5 → 1.0 → 0.75) to recover smoothness; if they're comfortably
    // fast, step back up. Hysteresis (separate slow/fast thresholds + a frame
    // counter) keeps it from oscillating.
    const PIXEL_RATIO_STEPS = [Math.min(window.devicePixelRatio, 1.5), 1.0, 0.75];
    let prStep = 0;
    let slowStreak = 0;
    let fastStreak = 0;
    const SLOW_MS = 1000 / 24; // a rendered frame slower than ~24 fps is "slow"
    const FAST_MS = 1000 / 50;

    const render = (now = 0) => {
      frame = requestAnimationFrame(render);
      if (!needsRender && now - lastRenderMs < minRenderIntervalMs * 4) {
        return;
      }
      if (now - lastRenderMs < minRenderIntervalMs) return;
      const sinceLast = now - lastRenderMs;
      needsRender = false;
      lastRenderMs = now;
      controls.update();
      renderer.render(scene, camera);

      // Tune resolution based on how long real render frames are taking.
      if (sinceLast > SLOW_MS) { slowStreak++; fastStreak = 0; }
      else if (sinceLast < FAST_MS) { fastStreak++; slowStreak = 0; }
      if (slowStreak >= 8 && prStep < PIXEL_RATIO_STEPS.length - 1) {
        prStep++; slowStreak = 0;
        renderer.setPixelRatio(PIXEL_RATIO_STEPS[prStep]);
      } else if (fastStreak >= 90 && prStep > 0) {
        prStep--; fastStreak = 0;
        renderer.setPixelRatio(PIXEL_RATIO_STEPS[prStep]);
      }
    };
    controls.addEventListener("change", markDirty);
    render();

    const handleResize = () => {
      if (!mount || !rendererRef.current) {
        return;
      }
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      rendererRef.current.setSize(mount.clientWidth, mount.clientHeight);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      controls.dispose();
      pointTextureRef.current?.dispose();
      // Dispose the point cloud and clear its ref so the cloud-creation effect
      // re-runs on remount (React 19 StrictMode mounts twice). Without this the
      // cloud stays attached to the disposed scene and never re-renders.
      if (cloudRef.current) {
        cloudRef.current.geometry.dispose();
        (cloudRef.current.material as THREE.Material).dispose();
        cloudRef.current = null;
      }
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      vehicleRef.current = null;
      controlsRef.current = null;
    };
  }, []);

  useEffect(() => {
    const vehicle = vehicleRef.current;
    if (!vehicle) {
      return;
    }

    vehicle.position.set(0, 0, 0);
  }, [frameId, resolvedFrame, vehiclePose]);

  // Pre-allocated typed-array pool — same buffer is reused across frames so we
  // avoid GC pressure (was ~21 MB/s of churn at 30 Hz with 60k points).
  const MAX_RENDER_POINTS = 65_536;
  const positionsRef = useRef<Float32Array>(new Float32Array(MAX_RENDER_POINTS * 3));
  const colorsRef = useRef<Float32Array>(new Float32Array(MAX_RENDER_POINTS * 3));

  // Create geometry + material ONCE on first render and reuse forever.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || cloudRef.current) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positionsRef.current, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colorsRef.current, 3));
    geometry.setDrawRange(0, 0);
    // Bounding sphere doesn't auto-update with in-place writes — give a large
    // sphere so frustum-culling never hides the cloud.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000);

    const material = new THREE.PointsMaterial({
      size: Math.max(pointSize, 0.25),
      // Soft round sprite (built in createPointSpriteTexture) instead of hard
      // squares — alphaTest drops the transparent rim so points stay crisp.
      map: pointTextureRef.current,
      opacity: 1,
      transparent: true,
      alphaTest: 0.35,
      vertexColors: true,
      blending: THREE.NormalBlending,
      // depthTest ON so the opaque ego car occludes points behind/inside it (the
      // car is the only opaque object, so nothing else is affected). depthWrite
      // stays OFF so points don't occlude each other and blending is preserved.
      depthTest: true,
      depthWrite: false,
      sizeAttenuation: true,
    });

    const cloud = new THREE.Points(geometry, material);
    cloud.renderOrder = 10;
    cloud.frustumCulled = false;
    cloudRef.current = cloud;
    scene.add(cloud);
  }, []);

  // Keep material.size in sync with the pointSize slider without recreating cloud.
  useEffect(() => {
    const cloud = cloudRef.current;
    if (!cloud) return;
    (cloud.material as THREE.PointsMaterial).size = Math.max(pointSize, 0.25);
  }, [pointSize]);

  // Per-cloud update: write into the existing typed-array slots and flag dirty.
  useEffect(() => {
    const cloud = cloudRef.current;
    if (!cloud) return;

    const positions = positionsRef.current;
    const colors = colorsRef.current;
    const color = new THREE.Color();
    const count = Math.min(displayPoints.length, MAX_RENDER_POINTS);

    for (let i = 0; i < count; i++) {
      const point = displayPoints[i];
      const threePoint = pointToDisplayThree(point, frameId, resolvedFrame, vehiclePose);
      const o = i * 3;
      positions[o]     = threePoint.x;
      positions[o + 1] = threePoint.y;
      positions[o + 2] = threePoint.z;

      if (colorMode === "intensity" && typeof point.intensity === "number" && point.intensity > 0) {
        const normalizedInt = Math.max(0, Math.min(1, point.intensity > 255 ? point.intensity / 4096 : point.intensity / 255));
        setTurboColor(color, normalizedInt);
      } else if (colorMode === "height") {
        const height = (threePoint.y - HEIGHT_COLOR_MIN) / (HEIGHT_COLOR_MAX - HEIGHT_COLOR_MIN);
        setTurboColor(color, height);
      } else {
        // Math.sqrt(x*x + y*y + z*z) is ~3× faster than Math.hypot in V8.
        const distance = Math.sqrt(threePoint.x * threePoint.x + threePoint.y * threePoint.y + threePoint.z * threePoint.z);
        const normalized = Math.max(0, Math.min(1, distance / 45));
        setTurboColor(color, 1 - normalized);
      }

      colors[o]     = color.r;
      colors[o + 1] = color.g;
      colors[o + 2] = color.b;
    }

    cloud.geometry.setDrawRange(0, count);
    (cloud.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (cloud.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    cloud.userData = { debugStats };
    renderRequestRef.current?.();
  }, [colorMode, debugStats, displayPoints, frameId, resolvedFrame, vehiclePose]);

  useEffect(() => {
    if (!autoFit || !hasPoints) {
      return;
    }

    const timer = window.setTimeout(fitToCloud, 120);
    return () => window.clearTimeout(timer);
  }, [activeTopic, autoFit, fitToCloud, hasPoints, displayPoints.length]);

  return (
    <div className="lidar-3d-stage" ref={mountRef}>
      {showDebug && debugStats && (
        <div className="lidar-debug-card">
          <strong>Lidar Debug</strong><br />
          Topic: <span style={{ color: "#fbbf24" }}>{activeTopic || "None"}</span><br />
          Sensor Frame: {frameId || "unknown"}<br />
          Render Frame: {resolvedFrame || frameId || "raw sensor frame (no TF applied)"}<br />
          Valid Points: {debugStats.pointsCount.toLocaleString()} / {debugStats.sourcePointsCount.toLocaleString()}<br />
          Min XYZ: {debugStats.min.x.toFixed(2)}, {debugStats.min.y.toFixed(2)}, {debugStats.min.z.toFixed(2)}<br />
          Max XYZ: {debugStats.max.x.toFixed(2)}, {debugStats.max.y.toFixed(2)}, {debugStats.max.z.toFixed(2)}<br />
          First 5 Points:<br />
          {debugStats.firstPoints.map((point, index) => `[${index}] x:${point.x.toFixed(2)} y:${point.y.toFixed(2)} z:${point.z.toFixed(2)} int:${point.intensity?.toFixed(1) ?? 0}`).join("\n")}
        </div>
      )}
      <div className="lidar-view-controls" aria-label="LiDAR viewport controls">
        <button type="button" onClick={() => zoomView(0.75)} title="Zoom in">+</button>
        <button type="button" onClick={() => zoomView(1.35)} title="Zoom out">-</button>
        <button type="button" onClick={fitToCloud} title="Fit to point cloud bounds">Fit</button>
        <button type="button" onClick={setTopView} title="Top view">Top</button>
        <button type="button" onClick={() => setView(DEFAULT_LIDAR_CAMERA_POSITION.clone())} title="Reset view">Reset</button>
      </div>
      <div className="lidar-hud">
        <span>{resolvedFrame || frameId || "raw frame"}</span>
        <span>left orbit / right pan / wheel zoom</span>
        <span>{points.length.toLocaleString()} pts</span>
      </div>
    </div>
  );
}

export { Lidar3D };
