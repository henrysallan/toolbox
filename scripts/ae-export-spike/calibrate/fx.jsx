// Calibration job: one comp per item — image (or image-sequence) layers with
// effects — every requested frame queued as TIFF with alpha, project saved.
//
// cfg: { project, bpc, workingSpace?, linearize?, renders, items: [{ name,
//   w, h, fps?, dur?, frames: [n…], layers: [{ name, image?, sequence?,
//   hidden?, effects?: [{ match, props: { "<match>-NNNN": value | { layer: k } } }] }] }] }
// Layers are listed top → bottom; { layer: k } is a 1-based layer index.

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  var proj = app.project;
  proj.bitsPerChannel = cfg.bpc || 8;
  C.attempt("workingSpace", function () { proj.workingSpace = cfg.workingSpace || ""; });
  C.attempt("linearizeWorkingSpace", function () { proj.linearizeWorkingSpace = cfg.linearize === true; });
  C.attempt("linearBlending", function () { proj.linearBlending = false; });
  C.out.gpuBefore = C.attempt("gpu read", function () { return String(proj.gpuAccelType); });
  if (cfg.gpu) C.attempt("gpuAccelType", function () { proj.gpuAccelType = GpuAccelType[cfg.gpu]; });
  C.out.gpu = C.attempt("gpu read", function () { return String(proj.gpuAccelType); });
  C.out.gpuTypes = C.attempt("gpu enum", function () { var r = {}, k; for (k in GpuAccelType) { try { r[k] = String(GpuAccelType[k]); } catch (x) {} } return r; });
  C.out.project = { bpc: proj.bitsPerChannel, workingSpace: proj.workingSpace, linearize: proj.linearizeWorkingSpace, linearBlending: proj.linearBlending };

  var footage = {};
  function item(path, sequence) {
    var key = (sequence ? "seq:" : "") + path;
    if (footage[key]) return footage[key];
    var io = new ImportOptions(new File(path));
    io.sequence = sequence === true;
    var it = proj.importFile(io);
    try { it.mainSource.alphaMode = AlphaMode.STRAIGHT; } catch (x) {}
    if (sequence) { try { it.mainSource.conformFrameRate = cfg.fps || 30; } catch (x) {} }
    footage[key] = it;
    return it;
  }

  var built = [];
  var i, j, k;
  for (i = 0; i < cfg.items.length; i++) {
    (function (I) {
      C.attempt("item " + I.name, function () {
        var comp = C.comp(I.name, I.w, I.h, I.fps || 30, I.dur || 1);
        var layers = [];
        // Add bottom-first so index 1 ends up being I.layers[0].
        for (j = I.layers.length - 1; j >= 0; j--) {
          var L = I.layers[j], layer;
          if (L.image) layer = comp.layers.add(item(L.image, false));
          else if (L.sequence) layer = comp.layers.add(item(L.sequence, true));
          else layer = comp.layers.addSolid(L.solid || [0, 0, 0], L.name, I.w, I.h, 1);
          layer.name = L.name;
          layers[j] = layer;
        }
        for (j = 0; j < I.layers.length; j++) {
          var LL = I.layers[j];
          for (k = 0; LL.effects && k < LL.effects.length; k++) {
            var E = LL.effects[k];
            var fx = layers[j].property("ADBE Effect Parade").addProperty(E.match);
            if (!fx) throw new Error("addProperty(" + E.match + ") returned null");
            var keys = [], key;
            for (key in E.props) if (Object.prototype.hasOwnProperty.call(E.props, key)) keys.push(key);
            // Layer refs and popups first: some params hide others.
            keys.sort(function (a, b) {
              if (a < b) return -1;
              return a > b ? 1 : 0;
            });
            for (var m = 0; m < keys.length; m++) {
              var p = fx.property(keys[m]);
              if (!p) throw new Error(E.match + ": no property " + keys[m]);
              var v = E.props[keys[m]];
              if (v && typeof v === "object" && !(v instanceof Array) && v.layer) p.setValue(v.layer);
              else if (v && typeof v === "object" && !(v instanceof Array) && v.keys) {
                for (var q = 0; q < v.keys.length; q++) p.setValueAtTime(v.keys[q][0], v.keys[q][1]);
              } else p.setValue(v);
            }
          }
          if (LL.quality) layers[j].quality = LL.quality === "draft" ? LayerQuality.DRAFT : LayerQuality.BEST;
          if (LL.hidden) layers[j].enabled = false;
        }
        for (j = 0; j < I.frames.length; j++) C.queue(comp, I.frames[j], cfg.renders + "/" + I.name + "_f" + I.frames[j] + "_[#####].tif", cfg.bpc);
        built.push(I.name);
        if (I.readBack) {
          var rb = {}, fxs = layers[0].property("ADBE Effect Parade"), e1, n1;
          for (e1 = 1; e1 <= fxs.numProperties; e1++) {
            for (n1 = 1; n1 <= fxs.property(e1).numProperties; n1++) {
              try { rb[fxs.property(e1).property(n1).matchName] = fxs.property(e1).property(n1).value; } catch (x) {}
            }
          }
          rb.quality = String(layers[0].quality);
          C.out.readBack = C.out.readBack || {};
          C.out.readBack[I.name] = rb;
        }
      });
    }(cfg.items[i]));
  }
  C.out.built = built;
  C.out.om = C.attempt("om settings", C.omSettings);
  C.save(cfg.project);
  C.out.saved = cfg.project;
}());
