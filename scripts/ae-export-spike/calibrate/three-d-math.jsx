// Calibration job for the 3D lane (M4 lane 5): AE's own transform math, read
// back exactly through expressions instead of renders. For each case a 3-D
// null (or camera) gets the given transform; a 3D Point Control on a helper
// layer evaluates thisComp.layer(<it>).toWorld(v) for the basis vectors, and
// its post-expression value is read with valueAtTime(t, false).
//
// cfg: { cases: [{ name, kind: "null"|"camera", orientation?, xRotation?,
//        yRotation?, zRotation?, position?, poi?, scale?, parent?: {…same…} }] }
// out.cases[i]: { name, origin, x, y, z } — comp coordinates of the layer's
// local origin and unit axes (x/y/z minus origin).

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  C.out.cases = [];

  function setTrs(layer, T) {
    var tg = layer.property("ADBE Transform Group");
    if (T.position) tg.property("ADBE Position").setValue(T.position);
    if (T.poi) tg.property("ADBE Anchor Point").setValue(T.poi);
    if (T.scale) tg.property("ADBE Scale").setValue(T.scale);
    if (T.orientation) tg.property("ADBE Orientation").setValue(T.orientation);
    if (T.xRotation !== undefined) tg.property("ADBE Rotate X").setValue(T.xRotation);
    if (T.yRotation !== undefined) tg.property("ADBE Rotate Y").setValue(T.yRotation);
    if (T.zRotation !== undefined) tg.property("ADBE Rotate Z").setValue(T.zRotation);
  }

  var comp = C.comp("math", 1000, 1000, 30, 1);
  var helper = comp.layers.addNull(1);
  helper.name = "helper";
  var j;
  for (j = 0; j < cfg.cases.length; j++) {
    (function (K, n) {
      var rec = { name: K.name };
      C.out.cases.push(rec);
      C.attempt(K.name, function () {
        var it;
        if (K.kind === "camera") it = comp.layers.addCamera("it" + n, [500, 500]);
        else {
          it = comp.layers.addNull(1);
          it.threeDLayer = true;
          it.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0, 0]);
          it.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0, 0]);
        }
        it.name = "it" + n;
        setTrs(it, K);
        if (K.parent) {
          var par = comp.layers.addNull(1);
          par.threeDLayer = true;
          par.name = "par" + n;
          par.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0, 0]);
          par.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0, 0]);
          setTrs(par, K.parent);
          it.parent = par;
          // parenting may have changed the child's values (jump); re-set them
          setTrs(it, K);
        }
        var vecs = { origin: "[0,0,0]", x: "[1,0,0]", y: "[0,1,0]", z: "[0,0,1]" };
        var key;
        for (key in vecs) {
          if (!Object.prototype.hasOwnProperty.call(vecs, key)) continue;
          var fx = helper.property("ADBE Effect Parade").addProperty("ADBE Point3D Control");
          var p = fx.property("ADBE Point3D Control-0001");
          p.expression = "thisComp.layer(\"it" + n + "\").toWorld(" + vecs[key] + ")";
          rec[key] = p.valueAtTime(0, false);
          if (p.expressionError) rec[key + "Error"] = p.expressionError;
        }
        var k;
        for (k = 0; k < 3; k++) {
          rec.x[k] -= rec.origin[k];
          rec.y[k] -= rec.origin[k];
          rec.z[k] -= rec.origin[k];
        }
      });
    }(cfg.cases[j], j + 1));
  }
}());
