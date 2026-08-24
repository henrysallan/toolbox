"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { createLightGizmo } from "./light-gizmo";
import { claimPointerGesture } from "@/lib/pointer-claim";
import { getSceneRender } from "@/engine/three-viewport-registry";
import { applyInstanceBillboards } from "@/engine/three-geometry";

type GizmoMode = "translate" | "rotate" | "scale";

// =====================================================================
// Scene3DViewport (M1b) — live orbit viewport over the preview canvas
// =====================================================================
//
// Mounts when a 3D node is selected. Renders the bound Scene Render's live
// three.Scene with its OWN renderer + an ephemeral editor camera. Grid +
// axes draw in a separate depth-sharing pass so they never leak into the
// scene's graph image.
//
// Two camera modes (spec §7):
//   • Free orbit — an editor camera, navigation-only (no graph effect).
//   • Camera view — looks through the wired Camera node AND drives it:
//     orbit/pan/zoom write the camera node's pos/target params (Blender's
//     "lock camera to view"). All param writes for one gesture share an
//     undo-coalesce key, so a drag is a single history entry.
//
// Input uses native listeners (pointerdown on the canvas, move/up on
// window) for reliable capture during drags.

type ParamChange = (
  nodeId: string,
  paramName: string,
  value: unknown,
  coalesceKey?: string
) => void;

interface Props {
  canvas: HTMLCanvasElement | null;
  sceneRenderId: string;
  // The camera-3d node feeding the Scene Render, drivable in look-through
  // mode. Null ⇒ look-through is view-only.
  cameraNodeId: string | null;
  // The selected 3D object node the transform gizmo edits (writes pos/rot
  // params). Null ⇒ no gizmo. canRotate gates the rotate mode (lights have
  // position only).
  gizmoNodeId: string | null;
  gizmoCanRotate: boolean;
  gizmoCanScale: boolean;
  // 3D Spline editing (M10, unified M10.6): when the selected node is the
  // curve node, its id + anchors (`splinePoints` → the `points` param) and,
  // in bezier mode, the EFFECTIVE handles ([in0, out0, …] flat, 2× anchors
  // — `splineHandles`, written back to the `handles` param; null in smooth
  // mode). Anchors render as large dots, handles as smaller tethered dots;
  // dragging an anchor carries its handles; `splineMirrored` makes a
  // handle drag mirror its partner across the anchor. All writes share the
  // per-gesture coalesce key (one undo per drag).
  splineNodeId: string | null;
  splinePoints: [number, number, number][] | null;
  splineHandles: [number, number, number][] | null;
  splineMirrored: boolean;
  // The app's overlays toggle. False hides every VISUAL (grid/axes, light
  // gizmo, transform gizmo, spline rig, toolbars, viewport border) but the
  // component stays mounted with its input layer live — turning overlays
  // off must never take orbit/pan/zoom or camera drive away.
  showOverlays: boolean;
  onParamChange: ParamChange;
}

interface OrbitState {
  azimuth: number; // radians around Y
  polar: number; // radians from +Y, in (0, PI)
  radius: number;
  target: THREE.Vector3;
}

// pos = target + (r·sinP·sinA, r·cosP, r·sinP·cosA). Shared by the editor
// orbit and the camera-drive path so seeding/inversion stay consistent.
function orbitToPosition(o: {
  azimuth: number;
  polar: number;
  radius: number;
  target: THREE.Vector3;
}): THREE.Vector3 {
  const sinP = Math.sin(o.polar);
  return new THREE.Vector3(
    o.target.x + o.radius * sinP * Math.sin(o.azimuth),
    o.target.y + o.radius * Math.cos(o.polar),
    o.target.z + o.radius * sinP * Math.cos(o.azimuth)
  );
}

// Remembered across viewport remounts (so the camera/orbit choice survives
// selecting a different 3D node). Defaults to camera view — the viewport
// opens looking through the scene camera, not the editor orbit camera.
let lastLookThrough = true;
// When locked, trackpad 2-finger gestures over the viewport control the 3D
// camera (orbit / shift-pan / cmd-zoom) instead of panning/zooming the 2D
// canvas. Default unlocked.
let lastLocked = false;

export default function Scene3DViewport({
  canvas,
  sceneRenderId,
  cameraNodeId,
  gizmoNodeId,
  gizmoCanRotate,
  gizmoCanScale,
  splineNodeId,
  splinePoints,
  splineHandles,
  splineMirrored,
  showOverlays,
  onParamChange,
}: Props) {
  // `rect` = the letterboxed preview canvas (where the 3D view renders).
  // `hostRect` = the parent viewport module (where the toolbars dock — its
  // corners, not the canvas's, so they sit in the panel margins).
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [hostRect, setHostRect] = useState<DOMRect | null>(null);
  const viewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Editor (free-orbit) camera state.
  const orbitRef = useRef<OrbitState>({
    azimuth: 0.7,
    polar: 1.05,
    radius: 6,
    target: new THREE.Vector3(0, 0, 0),
  });
  // Look-through drive state (seeded from the wired camera at gesture start).
  // While `active`, the render loop uses this for zero-lag feedback rather
  // than the registry's (one-eval-behind) camera descriptor.
  const driveRef = useRef<OrbitState & { active: boolean; fov: number }>({
    azimuth: 0,
    polar: 1,
    radius: 6,
    target: new THREE.Vector3(0, 0, 0),
    active: false,
    fov: 45,
  });

  const [lookThrough, setLookThrough] = useState(lastLookThrough);
  const lookThroughRef = useRef(lookThrough);
  lookThroughRef.current = lookThrough;
  // Persist the choice so it survives remounts (selecting another 3D node).
  useEffect(() => {
    lastLookThrough = lookThrough;
  }, [lookThrough]);

  const [locked, setLocked] = useState(lastLocked);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    lastLocked = locked;
  }, [locked]);

  // Latest props for the native handlers (which close over mount values).
  const sceneRenderIdRef = useRef(sceneRenderId);
  sceneRenderIdRef.current = sceneRenderId;
  const cameraNodeIdRef = useRef(cameraNodeId);
  cameraNodeIdRef.current = cameraNodeId;
  const onParamChangeRef = useRef(onParamChange);
  onParamChangeRef.current = onParamChange;
  const gizmoNodeIdRef = useRef(gizmoNodeId);
  gizmoNodeIdRef.current = gizmoNodeId;
  const gizmoCanRotateRef = useRef(gizmoCanRotate);
  gizmoCanRotateRef.current = gizmoCanRotate;
  const gizmoCanScaleRef = useRef(gizmoCanScale);
  gizmoCanScaleRef.current = gizmoCanScale;
  const controlsRef = useRef<TransformControls | null>(null);
  // True while a gizmo handle is being dragged — suppresses camera orbit.
  const gizmoDraggingRef = useRef(false);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>("translate");
  const gizmoModeRef = useRef(gizmoMode);

  // -- 3D Spline editing state ------------------------------------------
  const splineNodeIdRef = useRef(splineNodeId);
  const splinePointsRef = useRef(splinePoints);
  const splineHandlesRef = useRef(splineHandles);
  const splineMirroredRef = useRef(splineMirrored);
  // Hovered dot index (rAF-rendered; no React state needed).
  const splineHoverRef = useRef<number | null>(null);
  // Selection keyed to the node id — a different node derives to "none"
  // with no reset effect needed.
  const [splineSelRaw, setSplineSelRaw] = useState<{
    id: string | null;
    index: number | null;
  }>({ id: null, index: null });
  const splineSel = splineSelRaw.id === splineNodeId ? splineSelRaw.index : null;
  const splineSelRef = useRef<number | null>(null);
  const showOverlaysRef = useRef(true);
  // Ref mirrors for the rAF loop (written in an effect — not render — to
  // satisfy the hooks rules; one-frame staleness is irrelevant at rAF).
  useEffect(() => {
    gizmoModeRef.current = gizmoMode;
    splineNodeIdRef.current = splineNodeId;
    splinePointsRef.current = splinePoints;
    splineHandlesRef.current = splineHandles;
    splineMirroredRef.current = splineMirrored;
    splineSelRef.current = splineSel;
    showOverlaysRef.current = showOverlays;
  });
  const selectSplinePoint = (index: number | null) =>
    setSplineSelRaw({ id: splineNodeIdRef.current, index });
  // Set of pickable dot meshes, rebuilt when the point count changes.
  const splineDotsRef = useRef<THREE.Mesh[]>([]);
  // Picking bridge from the input effect into the renderer effect's camera.
  const pickSplineDotRef = useRef<
    ((clientX: number, clientY: number) => number | null) | null
  >(null);
  // Structural edits from the HUD (+/−). Anchors are dot indices < n;
  // handle dots (bezier mode) live at n + 2·anchor (+1 for out). Insert
  // adds an anchor after the selected one's (segment midpoint with
  // tangent handles, or extended past the end); remove deletes the anchor
  // (with its handles), keeping ≥ 2. A selected HANDLE resolves to its
  // anchor for both operations.
  const splineAnchorOfSel = (): number | null => {
    const pts = splinePointsRef.current;
    const i = splineSelRef.current;
    if (!pts || i == null) return null;
    return i < pts.length ? i : Math.floor((i - pts.length) / 2);
  };
  const splineAddPoint = () => {
    const id = splineNodeIdRef.current;
    const pts = splinePointsRef.current;
    if (!id || !pts || pts.length < 2) return;
    const handles = splineHandlesRef.current;
    const g = Math.min(pts.length - 1, splineAnchorOfSel() ?? pts.length - 1);
    const a = pts[g];
    const next = g + 1 < pts.length ? pts[g + 1] : null;
    let anchor: [number, number, number];
    let dir: [number, number, number];
    if (next) {
      anchor = [(a[0] + next[0]) / 2, (a[1] + next[1]) / 2, (a[2] + next[2]) / 2];
      dir = [next[0] - a[0], next[1] - a[1], next[2] - a[2]];
    } else {
      const prev = pts[g - 1] ?? [a[0] - 1, a[1], a[2]];
      dir = [a[0] - prev[0], a[1] - prev[1], a[2] - prev[2]];
      anchor = [a[0] + dir[0] * 0.8, a[1] + dir[1] * 0.8, a[2] + dir[2] * 0.8];
    }
    const outPts = [...pts.slice(0, g + 1), anchor, ...pts.slice(g + 1)];
    onParamChangeRef.current(id, "points", outPts);
    if (handles) {
      const len = Math.max(1e-4, Math.hypot(dir[0], dir[1], dir[2]));
      const h: [number, number, number] = [
        (dir[0] / len) * 0.3,
        (dir[1] / len) * 0.3,
        (dir[2] / len) * 0.3,
      ];
      const pair: [number, number, number][] = [
        [anchor[0] - h[0], anchor[1] - h[1], anchor[2] - h[2]], // in
        [anchor[0] + h[0], anchor[1] + h[1], anchor[2] + h[2]], // out
      ];
      const at = (g + 1) * 2;
      onParamChangeRef.current(id, "handles", [
        ...handles.slice(0, at),
        ...pair,
        ...handles.slice(at),
      ]);
    }
    selectSplinePoint(g + 1);
  };
  const splineRemovePoint = () => {
    const id = splineNodeIdRef.current;
    const pts = splinePointsRef.current;
    if (!id || !pts || pts.length <= 2) return;
    const g = splineAnchorOfSel();
    if (g == null) return;
    const handles = splineHandlesRef.current;
    onParamChangeRef.current(
      id,
      "points",
      pts.filter((_, k) => k !== g)
    );
    if (handles) {
      onParamChangeRef.current(
        id,
        "handles",
        handles.filter((_, k) => Math.floor(k / 2) !== g)
      );
    }
    selectSplinePoint(Math.max(0, g - 1));
  };

  // Rotate/scale aren't available for every object (lights are position-
  // only) — fall back to Move when the current mode isn't supported.
  useEffect(() => {
    if (
      (gizmoMode === "rotate" && !gizmoCanRotate) ||
      (gizmoMode === "scale" && !gizmoCanScale)
    )
      setGizmoMode("translate");
  }, [gizmoCanRotate, gizmoCanScale, gizmoMode]);

  // Track the canvas rect AND its parent module rect (the spline-overlay
  // approach) — observe both, since the panel can resize without the
  // letterboxed canvas changing size.
  useEffect(() => {
    if (!canvas) {
      setRect(null);
      setHostRect(null);
      return;
    }
    // The framed module is the canvas's GRANDPARENT (the padded panel); its
    // immediate parent is just a centering box inset by the panel padding.
    const host = canvas.parentElement?.parentElement ?? canvas.parentElement;
    const update = () => {
      setRect(canvas.getBoundingClientRect());
      setHostRect((host ?? canvas).getBoundingClientRect());
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    if (host) ro.observe(host);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [canvas]);

  // Renderer + render loop.
  useEffect(() => {
    const viewCanvas = viewCanvasRef.current;
    if (!viewCanvas) return;

    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: viewCanvas,
        antialias: true,
        alpha: true, // allow a transparent clear (used in look-through mode)
      });
    } catch {
      renderer = null;
    }

    const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 2000);
    const helpers = new THREE.Scene();
    const grid = new THREE.GridHelper(20, 20, 0x4b5563, 0x27272f);
    helpers.add(grid);
    helpers.add(new THREE.AxesHelper(1.5));
    // Blender-style representation of the selected light (icon rings, aim
    // line, spot cone) — synced from the live light object each frame.
    const lightGizmo = createLightGizmo();
    helpers.add(lightGizmo.group);

    // 3D Spline editing rig (M10): pickable control-point dots + a dashed
    // control polyline, in the helpers scene (never in the render).
    const splineGroup = new THREE.Group();
    splineGroup.visible = false;
    helpers.add(splineGroup);
    const splinePolyMat = new THREE.LineDashedMaterial({
      color: 0x9ca3af,
      dashSize: 0.06,
      gapSize: 0.05,
      depthTest: false,
      transparent: true,
    });
    const splinePoly = new THREE.Line(new THREE.BufferGeometry(), splinePolyMat);
    splineGroup.add(splinePoly);
    // Bezier handle tethers (anchor→in, anchor→out), rebuilt per frame.
    const splineHandleMat = new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      depthTest: false,
      transparent: true,
      opacity: 0.8,
    });
    const splineHandleLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      splineHandleMat
    );
    splineGroup.add(splineHandleLines);
    let splineDotsBezier = false;
    const disposeSplineDots = () => {
      for (const d of splineDotsRef.current) {
        // Each pickable dot is an invisible hit disc with the visible dot
        // as its child.
        const child = d.children[0] as THREE.Mesh | undefined;
        child?.geometry.dispose();
        (child?.material as THREE.Material | undefined)?.dispose();
        d.geometry.dispose();
        (d.material as THREE.Material).dispose();
        splineGroup.remove(d);
      }
      splineDotsRef.current = [];
    };
    // Depth-only material for the overlay pass: writes depth (so the grid is
    // occluded by objects) but no color (so the geometry isn't drawn over the
    // composite behind us).
    const depthOnlyMat = new THREE.MeshBasicMaterial({ colorWrite: false });

    // Transform gizmo. The helper goes in the HELPERS scene (not the shared
    // graph scene) so it never leaks into the rendered image. Its handles
    // are depth-test-off, so they draw on top in the second pass.
    let controls: TransformControls | null = null;
    let gizmoGesture = 0;
    let gizmoKey = "";
    const onDraggingChanged = (e: { value: unknown }) => {
      gizmoDraggingRef.current = !!e.value;
      if (e.value)
        gizmoKey = `gizmo:${
          gizmoNodeIdRef.current ?? `spline:${splineNodeIdRef.current}`
        }:${++gizmoGesture}`;
    };
    const onObjectChange = () => {
      const obj = controls?.object;
      // Spline control-point drag: write the whole points array (one
      // vec3_list param) with the dragged index replaced.
      if (obj?.userData.__splineDot) {
        const sid = splineNodeIdRef.current;
        const pts = splinePointsRef.current;
        if (!sid || !pts) return;
        const handles = splineHandlesRef.current;
        const idx = obj.userData.index as number;
        const px = obj.position.x;
        const py = obj.position.y;
        const pz = obj.position.z;
        if (idx < pts.length) {
          // Anchor drag — carry its two handles by the same delta
          // (computed against one snapshot, so repeated objectChange
          // events stay self-consistent).
          const base = pts[idx] ?? [0, 0, 0];
          const dx = px - base[0];
          const dy = py - base[1];
          const dz = pz - base[2];
          onParamChangeRef.current(
            sid,
            "points",
            pts.map((p, k) =>
              k === idx ? [px, py, pz] : p
            ),
            gizmoKey
          );
          if (handles) {
            onParamChangeRef.current(
              sid,
              "handles",
              handles.map((h, k) =>
                Math.floor(k / 2) === idx
                  ? ([h[0] + dx, h[1] + dy, h[2] + dz] as [
                      number,
                      number,
                      number,
                    ])
                  : h
              ),
              gizmoKey
            );
          }
          return;
        }
        // Handle drag — write it, and in mirrored mode reflect the
        // partner across the anchor (full point mirror).
        if (!handles) return;
        const k = idx - pts.length;
        const anchor = pts[Math.floor(k / 2)] ?? [0, 0, 0];
        const partner = k % 2 === 0 ? k + 1 : k - 1;
        const mirrored = splineMirroredRef.current;
        onParamChangeRef.current(
          sid,
          "handles",
          handles.map((h, j) => {
            if (j === k) return [px, py, pz] as [number, number, number];
            if (mirrored && j === partner)
              return [
                2 * anchor[0] - px,
                2 * anchor[1] - py,
                2 * anchor[2] - pz,
              ] as [number, number, number];
            return h;
          }),
          gizmoKey
        );
        return;
      }
      const id = gizmoNodeIdRef.current;
      if (!id || !obj) return;
      const opc = onParamChangeRef.current;
      opc(id, "pos_x", obj.position.x, gizmoKey);
      opc(id, "pos_y", obj.position.y, gizmoKey);
      opc(id, "pos_z", obj.position.z, gizmoKey);
      if (gizmoCanRotateRef.current && controls?.mode === "rotate") {
        opc(id, "rot_x", THREE.MathUtils.radToDeg(obj.rotation.x), gizmoKey);
        opc(id, "rot_y", THREE.MathUtils.radToDeg(obj.rotation.y), gizmoKey);
        opc(id, "rot_z", THREE.MathUtils.radToDeg(obj.rotation.z), gizmoKey);
      }
      if (gizmoCanScaleRef.current && controls?.mode === "scale") {
        opc(id, "scale_x", obj.scale.x, gizmoKey);
        opc(id, "scale_y", obj.scale.y, gizmoKey);
        opc(id, "scale_z", obj.scale.z, gizmoKey);
      }
    };
    if (renderer) {
      try {
        controls = new TransformControls(cam, viewCanvas);
        controls.setSpace("world");
        helpers.add(controls.getHelper());
        controls.addEventListener("dragging-changed", onDraggingChanged);
        controls.addEventListener("objectChange", onObjectChange);
        controlsRef.current = controls;
      } catch {
        controls = null;
      }
    }

    let raf = 0;
    let lastW = 0;
    let lastH = 0;
    const tmp = new THREE.Vector3();
    const camWorld = new THREE.Vector3();

    // Spline-dot picking for the input effect (which has no camera access):
    // client coords → NDC → raycast against the dot meshes.
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    pickSplineDotRef.current = (clientX: number, clientY: number) => {
      if (!splineDotsRef.current.length) return null;
      const rect = viewCanvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, cam);
      const hits = raycaster.intersectObjects(splineDotsRef.current, false);
      return hits.length
        ? (hits[0].object.userData.index as number)
        : null;
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const r = renderer;
      if (!r) return;
      const handle = getSceneRender(sceneRenderId);
      const w = viewCanvas.clientWidth;
      const h = viewCanvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (w !== lastW || h !== lastH) {
        r.setPixelRatio(window.devicePixelRatio || 1);
        r.setSize(w, h, false);
        lastW = w;
        lastH = h;
      }
      cam.aspect = w / h;

      const showOv = showOverlaysRef.current;

      // Attach/detach the gizmo to the selected object (found by nodeId in
      // the shared scene). Suppressed while looking through the camera.
      // Overlays off ⇒ keep it detached: an invisible gizmo would still
      // set `.axis` under the pointer and swallow orbit drags.
      if (controls && !showOv) {
        if (controls.object) controls.detach();
      } else if (controls) {
        // Keep the gizmo attached in look-through too — handle drags move
        // the object, empty-space drags still drive the camera (onDown bails
        // to TransformControls when a handle is under the pointer).
        const wantId = gizmoNodeIdRef.current;
        const cur = controls.object;
        if (!wantId) {
          // Spline dots own the controls while a point is selected —
          // don't let the node-gizmo path detach them.
          if (cur && !cur.userData.__splineDot) controls.detach();
        } else if (!cur || cur.userData.nodeId !== wantId) {
          let found: THREE.Object3D | undefined;
          handle?.scene.traverse((o) => {
            if (o.userData.nodeId === wantId) found = o;
          });
          if (found) {
            controls.attach(found);
            // Restore the toolbar's mode (spline editing forces translate).
            controls.setMode(gizmoModeRef.current);
          } else if (cur) controls.detach();
        }
      }
      // Light gizmo follows whatever the selection resolved to (hides for
      // non-lights / ambient / nothing).
      lightGizmo.sync(showOv ? (controls?.object ?? null) : null, cam);

      // -- 3D Spline editing rig sync -----------------------------------
      const spts = splinePointsRef.current;
      const editingSpline =
        showOv && !!splineNodeIdRef.current && !!spts && spts.length >= 2;
      splineGroup.visible = editingSpline;
      if (editingSpline) {
        const shandles = splineHandlesRef.current;
        const bezier = !!shandles;
        const nAnchors = spts.length;
        const totalDots = nAnchors + (bezier ? nAnchors * 2 : 0);
        const dots = splineDotsRef.current;
        if (dots.length !== totalDots || splineDotsBezier !== bezier) {
          disposeSplineDots();
          splineDotsBezier = bezier;
          for (let i = 0; i < totalDots; i++) {
            const isHandle = i >= nAnchors;
            // Invisible hit disc (~2.3× the visible dot) = the click
            // target; the visible dot rides as a child.
            const hit = new THREE.Mesh(
              new THREE.CircleGeometry(isHandle ? 0.13 : 0.16, 12),
              new THREE.MeshBasicMaterial({
                depthTest: false,
                depthWrite: false,
                transparent: true,
                opacity: 0,
                side: THREE.DoubleSide,
              })
            );
            hit.userData.__splineDot = true;
            hit.userData.index = i;
            const vis = new THREE.Mesh(
              new THREE.CircleGeometry(isHandle ? 0.05 : 0.07, 16),
              new THREE.MeshBasicMaterial({
                color: isHandle ? 0x7dd3fc : 0xd9d9e0,
                depthTest: false,
                transparent: true,
                side: THREE.DoubleSide,
              })
            );
            hit.add(vis);
            splineGroup.add(hit);
            splineDotsRef.current.push(hit);
          }
        }
        const selIdx = splineSelRef.current;
        const hovIdx = splineHoverRef.current;
        camWorld.setFromMatrixPosition(cam.matrixWorld);
        for (let i = 0; i < splineDotsRef.current.length; i++) {
          const dot = splineDotsRef.current[i];
          const isHandle = i >= nAnchors;
          // The dragged dot is the source of truth mid-gesture (its
          // mirrored partner follows through the prop echo).
          if (!(gizmoDraggingRef.current && i === selIdx)) {
            const src = isHandle ? shandles![i - nAnchors] : spts[i];
            if (src) dot.position.set(src[0], src[1], src[2]);
          }
          dot.quaternion.copy(cam.quaternion);
          const hovered = i === hovIdx && i !== selIdx;
          dot.scale.setScalar(
            Math.max(1e-4, camWorld.distanceTo(dot.position) * 0.03) *
              (hovered ? 1.3 : 1)
          );
          const vis = dot.children[0] as THREE.Mesh;
          (vis.material as THREE.MeshBasicMaterial).color.set(
            i === selIdx
              ? 0xffa733
              : hovered
                ? 0xffffff
                : isHandle
                  ? 0x7dd3fc
                  : 0xd9d9e0
          );
        }
        // Smooth mode: dashed polyline through the anchors. Bezier mode:
        // handle tethers (anchor→in, anchor→out) instead.
        splinePoly.visible = !bezier;
        splineHandleLines.visible = bezier;
        if (!bezier) {
          splinePoly.geometry.dispose();
          splinePoly.geometry = new THREE.BufferGeometry().setFromPoints(
            splineDotsRef.current.map((d) => d.position)
          );
          splinePoly.computeLineDistances();
        } else {
          const segs: THREE.Vector3[] = [];
          for (let g = 0; g < nAnchors; g++) {
            const a = splineDotsRef.current[g].position;
            segs.push(a, splineDotsRef.current[nAnchors + g * 2].position);
            segs.push(a, splineDotsRef.current[nAnchors + g * 2 + 1].position);
          }
          splineHandleLines.geometry.dispose();
          splineHandleLines.geometry = new THREE.BufferGeometry().setFromPoints(
            segs
          );
        }
        // Selected dot takes the transform controls (translate only —
        // a point has no meaningful rotation/scale).
        if (controls) {
          const want =
            selIdx != null ? (splineDotsRef.current[selIdx] ?? null) : null;
          const cur = controls.object;
          if (want) {
            if (cur !== want) {
              controls.detach();
              controls.attach(want);
              controls.setMode("translate");
            }
          } else if (cur && cur.userData.__splineDot) {
            controls.detach();
          }
        }
      } else {
        if (splineDotsRef.current.length) disposeSplineDots();
        const cur = controls?.object;
        if (cur && cur.userData.__splineDot) controls?.detach();
      }

      if (lookThroughRef.current && driveRef.current.active) {
        // Mid-gesture: render from the drive state directly (no eval lag).
        // Keep the camera's own FOV — don't snap to the editor default.
        const o = driveRef.current;
        cam.fov = o.fov;
        cam.position.copy(orbitToPosition(o));
        cam.lookAt(o.target);
      } else if (lookThroughRef.current && handle) {
        const d = handle.cameraDesc;
        cam.fov = d.projection === "orthographic" ? 45 : d.fov;
        cam.position.set(d.position[0], d.position[1], d.position[2]);
        tmp.set(d.target[0], d.target[1], d.target[2]);
        cam.lookAt(tmp);
      } else {
        const o = orbitRef.current;
        cam.fov = 45;
        cam.position.copy(orbitToPosition(o));
        cam.lookAt(o.target);
      }
      cam.updateProjectionMatrix();

      // Render-time billboarding (M12): marked instance streams face THIS
      // viewport's camera every frame — orbiting tracks live. (Markers
      // pinned to a wired Camera keep their own position instead.)
      if (handle) applyInstanceBillboards(handle.scene, cam.position);

      // Look-through = overlay mode: transparent clear (the composite shows
      // behind), and the geometry is rendered DEPTH-ONLY so it occludes the
      // grid without drawing color that would double the composite. Free
      // orbit = opaque dark clear with the geometry drawn normally.
      const overlay = lookThroughRef.current;
      r.setClearColor(overlay ? 0x000000 : 0x14141a, overlay ? 0 : 1);
      r.autoClear = false;
      r.clear();
      if (handle) {
        if (overlay) {
          handle.scene.overrideMaterial = depthOnlyMat;
          r.render(handle.scene, cam);
          handle.scene.overrideMaterial = null;
        } else {
          r.render(handle.scene, cam);
        }
      }
      if (showOv) r.render(helpers, cam);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      if (controls) {
        controls.removeEventListener("dragging-changed", onDraggingChanged);
        controls.removeEventListener("objectChange", onObjectChange);
        controls.detach();
        controls.dispose();
      }
      controlsRef.current = null;
      pickSplineDotRef.current = null;
      disposeSplineDots();
      splinePoly.geometry.dispose();
      splinePolyMat.dispose();
      splineHandleLines.geometry.dispose();
      splineHandleMat.dispose();
      lightGizmo.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      depthOnlyMat.dispose();
      renderer?.dispose();
      renderer = null;
    };
  }, [sceneRenderId]);

  // Keep the gizmo's mode in sync with the toolbar selection.
  useEffect(() => {
    controlsRef.current?.setMode(gizmoMode);
  }, [gizmoMode]);

  // Native input listeners.
  useEffect(() => {
    const el = viewCanvasRef.current;
    if (!el) return;

    let mode: "orbit" | "pan" | null = null;
    let lastX = 0;
    let lastY = 0;
    // Per-gesture undo key: every param write within one drag/zoom shares
    // it (one history entry per gesture), and it changes between gestures.
    let gesture = 0;
    let gestureKey = "";
    // Debounce that ends a trackpad-scroll camera gesture (keeps the drive
    // state "active" — and thus rendered with zero lag — while wheeling).
    let wheelTimer = 0;

    // Seed the drive state from the wired camera's current descriptor.
    const seedDrive = (): boolean => {
      const handle = getSceneRender(sceneRenderIdRef.current);
      if (!handle) return false;
      const d = handle.cameraDesc;
      const o = driveRef.current;
      o.target.set(d.target[0], d.target[1], d.target[2]);
      const ox = d.position[0] - d.target[0];
      const oy = d.position[1] - d.target[1];
      const oz = d.position[2] - d.target[2];
      o.radius = Math.max(0.01, Math.hypot(ox, oy, oz));
      o.azimuth = Math.atan2(ox, oz);
      o.polar = Math.acos(Math.max(-1, Math.min(1, oy / o.radius)));
      o.fov = d.projection === "orthographic" ? 45 : d.fov;
      return true;
    };

    // Write the drive state back to the camera node's params. All params in
    // one gesture share a coalesce key ⇒ a single undo entry.
    const writeCamera = (includeTarget: boolean) => {
      const camId = cameraNodeIdRef.current;
      const opc = onParamChangeRef.current;
      if (!camId) return;
      const o = driveRef.current;
      const pos = orbitToPosition(o);
      opc(camId, "pos_x", pos.x, gestureKey);
      opc(camId, "pos_y", pos.y, gestureKey);
      opc(camId, "pos_z", pos.z, gestureKey);
      if (includeTarget) {
        opc(camId, "target_x", o.target.x, gestureKey);
        opc(camId, "target_y", o.target.y, gestureKey);
        opc(camId, "target_z", o.target.z, gestureKey);
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!mode) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      const driving = lookThroughRef.current && driveRef.current.active;
      const o = driving ? driveRef.current : orbitRef.current;

      if (mode === "orbit") {
        o.azimuth -= dx * 0.01;
        o.polar = Math.max(0.02, Math.min(Math.PI - 0.02, o.polar - dy * 0.01));
        if (driving) writeCamera(false);
      } else {
        const k = o.radius * 0.0015;
        o.target.x -= dx * Math.cos(o.azimuth) * k;
        o.target.z += dx * Math.sin(o.azimuth) * k;
        o.target.y += dy * k;
        if (driving) writeCamera(true);
      }
    };

    const onUp = () => {
      mode = null;
      driveRef.current.active = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    const onDown = (e: PointerEvent) => {
      // Every press on the 3D viewport is 3D interaction (gizmo drag,
      // dot pick, orbit/pan) — keep it out of the graph's cursor press
      // facts. Claim before the TransformControls early-return so axis
      // drags are covered too.
      if (e.button === 0) claimPointerGesture(e.pointerId);
      // A gizmo handle is under the pointer → let TransformControls own this
      // drag; don't orbit/pan/drive.
      if (controlsRef.current?.axis) return;
      // A spline control point under the pointer → select it (the gizmo
      // attaches next frame); no orbit on this press.
      if (e.button === 0) {
        const hit = pickSplineDotRef.current?.(e.clientX, e.clientY);
        if (hit != null) {
          e.preventDefault();
          selectSplinePoint(hit);
          return;
        }
      }
      e.preventDefault();
      mode = e.button === 1 || e.button === 2 || e.shiftKey ? "pan" : "orbit";
      lastX = e.clientX;
      lastY = e.clientY;
      gestureKey = `cam-drive:${cameraNodeIdRef.current}:${++gesture}`;
      // In look-through mode, drive the wired camera (if any).
      driveRef.current.active =
        lookThroughRef.current && !!cameraNodeIdRef.current && seedDrive();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };

    // Apply a trackpad-scroll delta to an orbit state. zoom = cmd/pinch,
    // pan = shift, otherwise orbit (plain 2-finger scroll).
    const applyScrollDelta = (
      o: OrbitState,
      e: WheelEvent,
      kind: "orbit" | "pan" | "zoom"
    ) => {
      if (kind === "zoom") {
        o.radius = Math.max(0.2, Math.min(500, o.radius * (1 + e.deltaY * 0.003)));
      } else if (kind === "pan") {
        const k = o.radius * 0.0016;
        o.target.x += e.deltaX * Math.cos(o.azimuth) * k;
        o.target.z -= e.deltaX * Math.sin(o.azimuth) * k;
        o.target.y -= e.deltaY * k;
      } else {
        o.azimuth += e.deltaX * 0.006;
        o.polar = Math.max(0.02, Math.min(Math.PI - 0.02, o.polar + e.deltaY * 0.006));
      }
    };

    const onWheel = (e: WheelEvent) => {
      // Unlocked: let the wheel bubble to window so the canvas pans/zooms.
      if (!lockedRef.current) return;
      // Locked: the gesture controls the 3D camera — consume it so the
      // canvas doesn't also move (the canvas handler lives on window).
      e.preventDefault();
      e.stopPropagation();
      const kind = e.metaKey || e.ctrlKey ? "zoom" : e.shiftKey ? "pan" : "orbit";

      if (lookThroughRef.current && cameraNodeIdRef.current) {
        // Drive the wired scene camera. Seed once per gesture; the debounce
        // keeps `active` true (zero-lag render) until scrolling stops.
        if (!driveRef.current.active) {
          if (!seedDrive()) return;
          gestureKey = `cam-drive:${cameraNodeIdRef.current}:${++gesture}`;
          driveRef.current.active = true;
        }
        applyScrollDelta(driveRef.current, e, kind);
        writeCamera(kind === "pan");
        clearTimeout(wheelTimer);
        wheelTimer = window.setTimeout(() => {
          driveRef.current.active = false;
        }, 150);
      } else {
        applyScrollDelta(orbitRef.current, e, kind);
      }
    };

    const onContext = (e: Event) => e.preventDefault();

    // Hover feedback for spline control points: highlight + pointer cursor
    // (idle only — never mid-orbit/mid-gizmo-drag).
    const onHover = (e: PointerEvent) => {
      if (mode || gizmoDraggingRef.current) {
        splineHoverRef.current = null;
        return;
      }
      const hit = pickSplineDotRef.current?.(e.clientX, e.clientY) ?? null;
      splineHoverRef.current = hit;
      el.style.cursor = hit != null ? "pointer" : "grab";
    };
    const onLeave = () => {
      splineHoverRef.current = null;
      el.style.cursor = "grab";
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onHover);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", onContext);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onHover);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onContext);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      clearTimeout(wheelTimer);
    };
  }, []);

  const canDrive = lookThrough && !!cameraNodeId;

  // Dock the toolbars to the outer viewport module (not the letterboxed
  // canvas), so they sit in the panel's corners.
  const base = hostRect ?? rect;

  // NOTE: always render the canvas (don't early-return on a null rect) so
  // the ref exists when the renderer/listener effects run on mount.
  return (
    <>
      {/* The 3D render — covers the letterboxed preview canvas area. */}
      <div
        style={{
          position: "fixed",
          left: rect ? `${rect.left}px` : "-99999px",
          top: rect ? `${rect.top}px` : "0px",
          width: rect ? `${rect.width}px` : "1px",
          height: rect ? `${rect.height}px` : "1px",
          zIndex: 3,
          touchAction: "none",
          pointerEvents: rect ? "auto" : "none",
          // Overlays off ⇒ frameless (the input layer is invisible chrome).
          border: showOverlays ? "1px solid #2dd4bf55" : "none",
        }}
      >
        <canvas
          ref={viewCanvasRef}
          style={{ width: "100%", height: "100%", display: "block", cursor: "grab" }}
        />
      </div>

      {/* Toolbars dock to the parent module's corners. This layer spans the
          whole panel but is click-through — only the pills capture events,
          so orbiting over the canvas still works underneath. */}
      {showOverlays && base && (
        <div
          style={{
            position: "fixed",
            left: base.left,
            top: base.top,
            width: base.width,
            height: base.height,
            zIndex: 4,
            pointerEvents: "none",
          }}
        >
          {splineNodeId && (
            <div style={toolbarStyle("left")}>
              <IconBtn
                label="Add point (after selected)"
                accent={GIZMO_ACCENT}
                onClick={splineAddPoint}
              >
                <span style={{ fontSize: 13, fontWeight: 700 }}>+</span>
              </IconBtn>
              <IconBtn
                label={splineHandles ? "Remove selected anchor" : "Remove selected point"}
                accent={GIZMO_ACCENT}
                disabled={
                  splineSel == null || (splinePoints?.length ?? 0) <= 2
                }
                onClick={splineRemovePoint}
              >
                <span style={{ fontSize: 13, fontWeight: 700 }}>−</span>
              </IconBtn>
            </div>
          )}
          {gizmoNodeId && (
            <div style={toolbarStyle("left")}>
              <IconBtn
                label="Move"
                active={gizmoMode === "translate"}
                accent={GIZMO_ACCENT}
                onClick={() => setGizmoMode("translate")}
              >
                <MoveIcon />
              </IconBtn>
              <IconBtn
                label={gizmoCanRotate ? "Rotate" : "Rotate (unavailable)"}
                active={gizmoMode === "rotate"}
                accent={GIZMO_ACCENT}
                disabled={!gizmoCanRotate}
                onClick={() => setGizmoMode("rotate")}
              >
                <RotateIcon />
              </IconBtn>
              <IconBtn
                label={gizmoCanScale ? "Scale" : "Scale (unavailable)"}
                active={gizmoMode === "scale"}
                accent={GIZMO_ACCENT}
                disabled={!gizmoCanScale}
                onClick={() => setGizmoMode("scale")}
              >
                <ScaleIcon />
              </IconBtn>
            </div>
          )}
          <div style={toolbarStyle("right")}>
            <IconBtn
              label={
                locked
                  ? "Trackpad controls the camera — click to unlock (canvas pan/zoom)"
                  : "Trackpad pans/zooms the canvas — click to lock (camera orbit / shift-pan / cmd-zoom)"
              }
              active={locked}
              accent={CAMERA_ACCENT}
              onClick={() => setLocked((v) => !v)}
            >
              <LockIcon locked={locked} />
            </IconBtn>
            <IconBtn
              label={
                lookThrough
                  ? canDrive
                    ? "Looking through the wired camera — drag/zoom moves it"
                    : "Looking through the default view (no camera wired to drive)"
                  : "Free editor orbit (does not affect the scene camera)"
              }
              active={lookThrough}
              accent={CAMERA_ACCENT}
              onClick={() => setLookThrough((v) => !v)}
            >
              <CameraIcon />
            </IconBtn>
          </div>
        </div>
      )}
    </>
  );
}

// ---- Corner toolbar (matches SplineEditorOverlay styling) -------------

const GIZMO_ACCENT = "var(--tb-a-amber-500)";
const CAMERA_ACCENT = "var(--tb-t-cyan-l-2)";
const TB_BTN = 26;

function toolbarStyle(side: "left" | "right"): React.CSSProperties {
  return {
    position: "absolute",
    top: 10,
    left: side === "left" ? 10 : undefined,
    right: side === "right" ? 10 : undefined,
    zIndex: 4,
    display: "flex",
    gap: 2,
    padding: 1,
    background: "color-mix(in srgb, var(--tb-n-0) 90%, transparent)",
    border: "1px solid var(--tb-n-7)",
    borderRadius: 6,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.35)",
    pointerEvents: "auto",
  };
}

function IconBtn({
  active,
  disabled,
  label,
  accent,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  accent: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      disabled={disabled}
      onClick={onClick}
      // Don't let a button click start a viewport orbit/drag.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: TB_BTN,
        height: TB_BTN,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active
          ? `${accent}2e`
          : hover && !disabled
            ? "color-mix(in srgb, var(--tb-lift) 8%, transparent)"
            : "transparent",
        color: active ? accent : disabled ? "var(--tb-n-10)" : hover ? "var(--tb-n-16)" : "var(--tb-n-13)",
        border: `1px solid ${active ? accent : "transparent"}`,
        borderRadius: 4,
        boxSizing: "border-box",
        padding: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        transition:
          "background 0.12s ease, color 0.12s ease, border-color 0.12s ease",
      }}
    >
      {children}
    </button>
  );
}

// Inline icons (currentColor) so we don't add an icon dependency.
function MoveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M8 2 6.4 3.6M8 2l1.6 1.6M8 14l-1.6-1.6M8 14l1.6-1.6M2 8l1.6-1.6M2 8l1.6 1.6M14 8l-1.6-1.6M14 8l-1.6 1.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RotateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.4 8a4.6 4.6 0 1 1 1.4 3.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M2.6 4.8l.8 3 3-.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ScaleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 9v4h4M13 7V3H9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 13l4-4M13 3L9 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="6.5" y="6.5" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="3.5" y="7" width="9" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.3" />
      {locked ? (
        <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      ) : (
        <path d="M5.5 7V5.2a2.5 2.5 0 0 1 4.7-1.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      )}
      <circle cx="8" cy="9.7" r="1" fill="currentColor" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="5" width="12" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 5l1-1.6h2L10 5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="9" r="2.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
