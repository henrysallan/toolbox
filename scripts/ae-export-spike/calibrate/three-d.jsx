// Calibration job for the 3D lane (M4 lane 5, specdocs/ae-m4/3d.md).
//
// cfg: { project, renders, w, h, cases: [case…] }
// case: { name, model?: path, renderer?: match name, camera?: {...}, lights?: [...],
//         modelTransform?: {...}, dump?: true, frames?: [n…] }
//   camera: { position, poi, zoom, orientation?, xRotation?, yRotation?, zRotation? }
//   light:  { type: "PARALLEL"|"POINT"|"SPOT"|"AMBIENT"|"ENVIRONMENT", position?, poi?,
//             color?, intensity?, coneAngle?, coneFeather?, falloff?, radius?, falloffDistance? }
//   modelTransform: { position?, scale?, orientation?, xRotation?, yRotation?, zRotation?, anchor? }
// Each case is one comp; frame 0 (or `frames`) is queued as 16-bit
// straight PNG, the project saved. With `dump`, every property of the model,
// camera and light layers is written out (match names, value types, values).

/* eslint-disable @typescript-eslint/no-unused-vars -- ES3 has no optional catch binding */

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  // A new project inherits AE's sticky "Last Project Settings", which may be
  // OCIO-managed; that refuses bitsPerChannel = 16. Switch to Adobe's.
  C.attempt("colorManagementSystem", function () {
    var cms = {};
    var k;
    if (typeof ColorManagementSystem !== "undefined") for (k in ColorManagementSystem) cms[k] = ColorManagementSystem[k];
    C.out.colorManagement = { before: app.project.colorManagementSystem, members: cms };
    C.out.colorManagement.hasEnum = typeof ColorManagementSystem !== "undefined";
    // 1 = OCIO in the sticky pref's JSON ("colorManagementSystem":1).
    if (app.project.colorManagementSystem === 1) app.project.colorManagementSystem = 0;
    C.out.colorManagement.after = app.project.colorManagementSystem;
  });
  app.project.bitsPerChannel = 16;
  C.attempt("workingSpace", function () { app.project.workingSpace = ""; });
  C.attempt("linearizeWorkingSpace", function () { app.project.linearizeWorkingSpace = false; });
  C.out.cases = [];
  C.out.hasThreeDModelLayer = typeof ThreeDModelLayer !== "undefined";
  C.out.lightTypes = {};
  var LT = ["PARALLEL", "SPOT", "POINT", "AMBIENT", "ENVIRONMENT"];
  var j;
  for (j = 0; j < LT.length; j++) C.out.lightTypes[LT[j]] = typeof LightType !== "undefined" && LightType[LT[j]] !== undefined;

  function typeOf(o) {
    if (o === null || o === undefined) return String(o);
    var names = ["ThreeDModelLayer", "AVLayer", "CameraLayer", "LightLayer", "ShapeLayer", "TextLayer", "FootageItem", "CompItem", "FolderItem"];
    var k;
    for (k = 0; k < names.length; k++) {
      try {
        if ($.global[names[k]] && o instanceof $.global[names[k]]) return names[k];
      } catch (e) {}
    }
    return String(o);
  }

  function setTrs(layer, T) {
    var tg = layer.property("ADBE Transform Group");
    if (T.anchor) tg.property("ADBE Anchor Point").setValue(T.anchor);
    if (T.position) tg.property("ADBE Position").setValue(T.position);
    if (T.poi) tg.property("ADBE Anchor Point").setValue(T.poi);
    if (T.scale) tg.property("ADBE Scale").setValue(T.scale);
    if (T.orientation) tg.property("ADBE Orientation").setValue(T.orientation);
    if (T.xRotation !== undefined) tg.property("ADBE Rotate X").setValue(T.xRotation);
    if (T.yRotation !== undefined) tg.property("ADBE Rotate Y").setValue(T.yRotation);
    if (T.zRotation !== undefined) tg.property("ADBE Rotate Z").setValue(T.zRotation);
  }

  // Each option is its own step: AE hides (and refuses) options the light
  // type or falloff does not use; the refusals are recorded.
  function addLight(comp, L, n, rec) {
    var layer = comp.layers.addLight("Light " + n, [comp.width / 2, comp.height / 2]);
    layer.lightType = LightType[L.type];
    setTrs(layer, L);
    var lo = function () { return layer.property("ADBE Light Options Group"); };
    var opts = [["color", "ADBE Light Color"], ["intensity", "ADBE Light Intensity"], ["coneAngle", "ADBE Light Cone Angle"],
      ["coneFeather", "ADBE Light Cone Feather 2"], ["falloff", "ADBE Light Falloff Type"], ["radius", "ADBE Light Falloff Start"],
      ["falloffDistance", "ADBE Light Falloff Distance"], ["castsShadows", "ADBE Casts Shadows"]];
    var k;
    for (k = 0; k < opts.length; k++) {
      if (L[opts[k][0]] === undefined) continue;
      try {
        lo().property(opts[k][1]).setValue(L[opts[k][0]]);
      } catch (e) {
        rec.errors.push("light " + n + " " + opts[k][0] + ": " + e.toString());
      }
    }
    return layer;
  }

  for (j = 0; j < cfg.cases.length; j++) {
    (function (K) {
      var rec = { name: K.name, errors: [] };
      C.out.cases.push(rec);
      function attempt(label, fn) {
        try {
          return fn();
        } catch (e) {
          rec.errors.push(label + ": " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
          return null;
        }
      }
      var comp = C.comp(K.name, K.w || cfg.w, K.h || cfg.h, 30, 1);
      attempt("renderers", function () { rec.renderers = comp.renderers; rec.rendererBefore = comp.renderer; });
      if (K.renderer) attempt("set renderer", function () { comp.renderer = K.renderer; });
      attempt("renderer after", function () { rec.renderer = comp.renderer; });
      var item = null, layer = null;
      if (K.model) {
        attempt("import", function () {
          var f = new File(K.model);
          rec.modelExists = f.exists;
          var io = new ImportOptions(f);
          rec.canImportFootage = io.canImportAs(ImportAsType.FOOTAGE);
          var t0 = new Date().getTime();
          item = app.project.importFile(io);
          rec.importSeconds = (new Date().getTime() - t0) / 1000;
          rec.itemType = typeOf(item);
          if (item) {
            rec.item = { name: item.name, typeName: item.typeName, width: item.width, height: item.height, duration: item.duration, hasVideo: item.hasVideo };
            attempt("mainSource", function () { rec.item.mainSource = String(item.mainSource); rec.item.isStill = item.mainSource.isStill; });
          }
        });
        if (item) {
          attempt("add layer", function () {
            layer = comp.layers.add(item);
            rec.layerType = typeOf(layer);
            rec.layerMatch = layer.matchName;
            rec.threeD = layer.threeDLayer;
            attempt("layer source dims", function () { rec.layerSize = [layer.width, layer.height]; });
          });
        }
        if (layer && K.modelTransform) attempt("model transform", function () { setTrs(layer, K.modelTransform); });
        if (layer && K.modelProps) {
          attempt("model props", function () {
            var key, path, p, q;
            for (key in K.modelProps) {
              if (!Object.prototype.hasOwnProperty.call(K.modelProps, key)) continue;
              path = key.split("/");
              p = layer;
              for (q = 0; q < path.length; q++) p = p.property(path[q]);
              p.setValue(K.modelProps[key]);
            }
          });
        }
        if (layer && K.dump) attempt("dump model", function () { rec.modelProps = C.dumpProps(layer, 4); });
      }
      var cam = null;
      if (K.camera) {
        attempt("camera", function () {
          cam = comp.layers.addCamera("Camera", [comp.width / 2, comp.height / 2]);
          var co = cam.property("ADBE Camera Options Group");
          if (K.camera.zoom !== undefined) co.property("ADBE Camera Zoom").setValue(K.camera.zoom);
          setTrs(cam, K.camera);
          if (K.dump) rec.cameraProps = C.dumpProps(cam, 3);
        });
      }
      var n;
      if (K.lights) {
        for (n = 0; n < K.lights.length; n++) {
          (function (L, n) {
            attempt("light " + n, function () {
              var lay = addLight(comp, L, n + 1, rec);
              if (K.dump && n === 0) rec.lightProps = C.dumpProps(lay, 3);
            });
          }(K.lights[n], n));
        }
      }
      var frames = K.frames || [0];
      for (n = 0; n < frames.length; n++) {
        (function (f) {
          attempt("queue " + f, function () { C.queue(comp, f, cfg.renders + "/" + K.name + "_f" + f + "_[#####].tif", 16); });
        }(frames[n]));
      }
    }(cfg.cases[j]));
  }
  C.attempt("om", function () { C.out.om = C.omSettings(); });
  // What a model item / layer reports right after import vs. later.
  function snap() {
    var r = [], k, it, L, j2;
    for (k = 1; k <= app.project.numItems; k++) {
      it = app.project.item(k);
      if (!(it instanceof CompItem)) continue;
      for (j2 = 1; j2 <= it.numLayers; j2++) {
        L = it.layer(j2);
        if (!(typeof ThreeDModelLayer !== "undefined" && L instanceof ThreeDModelLayer)) continue;
        var e = { comp: it.name, t: new Date().getTime() };
        try { e.rect = L.sourceRectAtTime(0, false); } catch (x) { e.rect = String(x); }
        try { e.dur = L.source.duration; e.w = L.source.width; e.fr = L.source.frameRate; } catch (x2) {}
        r.push(e);
      }
    }
    return r;
  }
  C.out.snapBefore = snap();
  if (cfg.settleMs) $.sleep(cfg.settleMs);
  C.out.snapAfter = snap();
  C.save(cfg.project);
}());
