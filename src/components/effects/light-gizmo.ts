// =====================================================================
// Light gizmo — Blender-style viewport representation of a selected light
// =====================================================================
//
// Lives in Scene3DViewport's HELPERS scene (second render pass — never
// leaks into the rendered image, same as the transform gizmo). Synced
// every frame from the live three.Light the selection resolves to, so
// param edits and gizmo drags update it with zero plumbing.
//
// The Blender conventions mirrored here:
//   point       — center dot + two concentric dashed circles, billboarded
//                 to the camera and screen-constant sized.
//   directional — the icon + a dashed aim line to the target (our lights
//                 aim at the world origin) ending in a small yellow dot.
//   spot        — icon + aim line + the cone outline: four side lines and
//                 the base rim, apex at the light, opening = the cone
//                 angle, length = `distance` (or the aim distance when
//                 distance = 0 / ∞) so the rim lands where the light does.
//   ambient     — nothing (no position to represent).
//
// All materials are depth-test-off: an editor affordance should read over
// the scene (the helpers pass draws after the geometry).

import * as THREE from "three";

const ICON_COLOR = 0xffa733; // Blender's active-light orange
const TARGET_COLOR = 0xffe14d; // interest-point yellow
const ICON_SCREEN_K = 0.035; // icon world-size per unit camera distance

function dashedMat(): THREE.LineDashedMaterial {
  return new THREE.LineDashedMaterial({
    color: ICON_COLOR,
    dashSize: 0.12,
    gapSize: 0.08,
    depthTest: false,
    transparent: true,
  });
}
function solidMat(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: ICON_COLOR,
    depthTest: false,
    transparent: true,
  });
}

function circleLoop(radius: number, segments: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

export interface LightGizmo {
  group: THREE.Group;
  /** Sync to the selected object (pass null/non-light to hide). */
  sync(obj: THREE.Object3D | null, cam: THREE.Camera): void;
  dispose(): void;
}

export function createLightGizmo(): LightGizmo {
  const group = new THREE.Group();
  group.visible = false;
  // Above the grid/axes, below TransformControls' handles.
  group.renderOrder = 1;

  // -- screen-constant, camera-facing icon --------------------------------
  const icon = new THREE.Group();
  group.add(icon);
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.09, 16),
    new THREE.MeshBasicMaterial({
      color: ICON_COLOR,
      depthTest: false,
      transparent: true,
      side: THREE.DoubleSide,
    })
  );
  icon.add(dot);
  const ring1 = new THREE.LineLoop(circleLoop(0.35, 32), dashedMat());
  const ring2 = new THREE.LineLoop(circleLoop(0.62, 40), dashedMat());
  ring1.computeLineDistances();
  ring2.computeLineDistances();
  icon.add(ring1, ring2);

  // -- aim line + target dot (directional/spot) ---------------------------
  // Unit line along −Z, scaled to the aim distance each sync.
  const aim = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]),
    dashedMat()
  );
  aim.computeLineDistances();
  group.add(aim);
  const targetDot = new THREE.Mesh(
    new THREE.CircleGeometry(0.05, 12),
    new THREE.MeshBasicMaterial({
      color: TARGET_COLOR,
      depthTest: false,
      transparent: true,
      side: THREE.DoubleSide,
    })
  );
  group.add(targetDot);

  // -- spot cone (unit: apex at 0, base rim radius 1 at z = −1) -----------
  const cone = new THREE.Group();
  group.add(cone);
  const rimGeo = circleLoop(1, 40);
  rimGeo.translate(0, 0, -1);
  const rim = new THREE.LineLoop(rimGeo, solidMat());
  cone.add(rim);
  const sideGeo = new THREE.BufferGeometry().setFromPoints(
    [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].flatMap((a) => [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(Math.cos(a), Math.sin(a), -1),
    ])
  );
  const sides = new THREE.LineSegments(sideGeo, solidMat());
  cone.add(sides);

  const aimQuat = new THREE.Quaternion();
  const NEG_Z = new THREE.Vector3(0, 0, -1);
  const worldPos = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const sync = (obj: THREE.Object3D | null, cam: THREE.Camera): void => {
    const light = obj as THREE.Light | null;
    const isLight = !!light && (light as unknown as { isLight?: boolean }).isLight;
    const isAmbient =
      isLight && (light as unknown as { isAmbientLight?: boolean }).isAmbientLight;
    if (!isLight || isAmbient) {
      group.visible = false;
      return;
    }
    group.visible = true;
    light.getWorldPosition(worldPos);
    group.position.copy(worldPos);

    // Screen-constant icon, billboarded.
    cam.getWorldPosition(camPos);
    const dist = camPos.distanceTo(worldPos);
    icon.scale.setScalar(Math.max(1e-4, dist * ICON_SCREEN_K));
    icon.quaternion.copy(cam.quaternion);

    const spot = light as THREE.SpotLight;
    const isSpot = (spot as unknown as { isSpotLight?: boolean }).isSpotLight;
    const isDirectional = (
      light as unknown as { isDirectionalLight?: boolean }
    ).isDirectionalLight;

    // Aim: from the light toward its target (both our directional and spot
    // aim at the target object, default world origin).
    const hasAim = !!isSpot || !!isDirectional;
    aim.visible = hasAim;
    targetDot.visible = hasAim;
    cone.visible = !!isSpot;
    if (!hasAim) return;

    const target =
      (light as THREE.DirectionalLight | THREE.SpotLight).target?.position ??
      new THREE.Vector3();
    dir.copy(target).sub(worldPos);
    const aimLen = Math.max(1e-4, dir.length());
    dir.divideScalar(aimLen);
    aimQuat.setFromUnitVectors(NEG_Z, dir);

    aim.quaternion.copy(aimQuat);
    aim.scale.setScalar(aimLen);
    targetDot.position.copy(dir).multiplyScalar(aimLen);
    targetDot.quaternion.copy(cam.quaternion);
    targetDot.scale.setScalar(Math.max(1e-4, dist * ICON_SCREEN_K));

    if (isSpot) {
      cone.quaternion.copy(aimQuat);
      const len =
        spot.distance > 0 ? spot.distance : aimLen; // ∞ ⇒ land on the aim
      const radius = Math.tan(spot.angle) * len;
      cone.scale.set(radius, radius, len);
    }
  };

  const dispose = (): void => {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as { material?: THREE.Material | THREE.Material[] })
        .material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  };

  return { group, sync, dispose };
}
