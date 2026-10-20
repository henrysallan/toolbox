// Calibration job: shape layers built from a small content list, one comp
// per item, frame 0 queued (16-bit straight PNG), project saved. Used for the
// geometry questions (Round Corners, Polystar) that scripting cannot read
// back: render AE's own result next to candidate plain paths.
//
// cfg: { project, renders, w, h, items: [{ name, layers: [[content…]…] }] }
// content: { kind: "path", path } | { kind: "polystar", type: "star"|"polygon",
//   points, position, rotation, outer, inner? } | { kind: "rc", radius } |
//   { kind: "trim", start, end, offset } | { kind: "fill", color } |
//   { kind: "stroke", color, width }

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  app.project.bitsPerChannel = 16;
  C.attempt("workingSpace", function () { app.project.workingSpace = ""; });

  function shape(p) {
    var s = new Shape();
    s.vertices = p.vertices;
    s.inTangents = p.inTangents;
    s.outTangents = p.outTangents;
    s.closed = p.closed;
    return s;
  }
  function add(vectors, it) {
    var p;
    if (it.kind === "path") {
      p = vectors.addProperty("ADBE Vector Shape - Group");
      p.property("ADBE Vector Shape").setValue(shape(it.path));
    } else if (it.kind === "polystar") {
      p = vectors.addProperty("ADBE Vector Shape - Star");
      p.property("ADBE Vector Star Type").setValue(it.type === "star" ? 1 : 2);
      p.property("ADBE Vector Star Points").setValue(it.points);
      p.property("ADBE Vector Star Position").setValue(it.position);
      p.property("ADBE Vector Star Rotation").setValue(it.rotation);
      p.property("ADBE Vector Star Outer Radius").setValue(it.outer);
      if (it.type === "star") p.property("ADBE Vector Star Inner Radius").setValue(it.inner);
    } else if (it.kind === "rc") {
      p = vectors.addProperty("ADBE Vector Filter - RC");
      p.property("ADBE Vector RoundCorner Radius").setValue(it.radius);
    } else if (it.kind === "trim") {
      p = vectors.addProperty("ADBE Vector Filter - Trim");
      p.property("ADBE Vector Trim Start").setValue(it.start);
      p.property("ADBE Vector Trim End").setValue(it.end);
      p.property("ADBE Vector Trim Offset").setValue(it.offset || 0);
    } else if (it.kind === "fill") {
      p = vectors.addProperty("ADBE Vector Graphic - Fill");
      p.property("ADBE Vector Fill Color").setValue(it.color);
    } else if (it.kind === "stroke") {
      p = vectors.addProperty("ADBE Vector Graphic - Stroke");
      p.property("ADBE Vector Stroke Color").setValue(it.color);
      p.property("ADBE Vector Stroke Width").setValue(it.width);
      p.property("ADBE Vector Stroke Line Cap").setValue(1);
      p.property("ADBE Vector Stroke Line Join").setValue(2);
    }
    if (!p) throw new Error("cannot add " + it.kind);
  }

  var i, j, k;
  C.out.built = [];
  for (i = 0; i < cfg.items.length; i++) {
    (function (I) {
      C.attempt("item " + I.name, function () {
        var comp = C.comp(I.name, cfg.w, cfg.h, 30, 1);
        for (j = 0; j < I.layers.length; j++) {
          var layer = comp.layers.addShape();
          // A shape layer's own transform starts at the comp centre with
          // anchor 0: put its origin at the comp's top-left.
          layer.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]);
          var vectors = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").property("ADBE Vectors Group");
          for (k = 0; k < I.layers[j].length; k++) add(vectors, I.layers[j][k]);
        }
        C.queue(comp, 0, cfg.renders + "/" + I.name + "_f0_[#####].tif", 16);
        C.out.built.push(I.name);
      });
    }(cfg.items[i]));
  }
  C.save(cfg.project);
}());
