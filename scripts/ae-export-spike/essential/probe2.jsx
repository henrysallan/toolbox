// Essential Properties lane, second probe (probe.mts --second): what the
// first one left open.
//
//   1. Dropdown Menu Control by index: setPropertyParameters, value range,
//      an expression reading effect("<name>")(1), Essential Graphics, override
//   2. a cross-comp expression with a non-zero control, set before the comp
//      exists — does it read the value once it does?
//   3. Essential Graphics order: add order vs controller order
//   4. motionGraphicsTemplateName by script
//   5. a stale expressionError re-checked by re-assigning through a property
//      path recorded when the expression was set
//
// cfg: { project, renders }

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  var out = C.out;
  app.project.bitsPerChannel = 8;

  function exprState(p) {
    var r = {};
    C.attempt("exprState", function () {
      r.enabled = p.expressionEnabled;
      r.error = p.expressionError;
      r.value = p.valueAtTime(0, false);
    });
    return r;
  }
  function pathOf(p) {
    var r = [];
    var q = p;
    while (q && q.parentProperty) {
      r.unshift(q.propertyIndex);
      q = q.parentProperty;
    }
    return r;
  }
  function byPath(layer, path) {
    var p = layer;
    var j;
    for (j = 0; j < path.length; j++) p = p.property(path[j]);
    return p;
  }

  var inner = C.comp("EP2 Inner", 100, 100, 30, 1);
  var probeNull = inner.layers.addNull();
  probeNull.name = "Probe";
  var pp = function () { return probeNull.property("ADBE Effect Parade"); };
  pp().addProperty("ADBE Slider Control").name = "Cross";
  pp().addProperty("ADBE Slider Control").name = "Pick read";
  var cross = function () { return pp().property(1).property(1); };
  var pick = function () { return pp().property(2).property(1); };
  C.attempt("cross expression", function () {
    cross().expression = 'comp("EP2 Main").layer("Controls").effect("Shift")(1)';
    out.crossEarly = exprState(cross());
    out.crossPath = pathOf(cross());
  });
  C.attempt("pick expression", function () {
    pick().expression = 'thisComp.layer("Controls").effect("Pick")(1)';
    out.pickPath = pathOf(pick());
  });

  var ctl = inner.layers.addNull();
  ctl.name = "Controls";
  var parade = function () { return ctl.property("ADBE Effect Parade"); };
  C.attempt("dropdown", function () {
    var fx = parade().addProperty("ADBE Dropdown Control");
    fx.name = "Pick";
    var n = parade().numProperties;
    out.dropdown = { index: n, match: parade().property(n).matchName, byName: parade().property("Pick") ? "found" : "null" };
    var menu = parade().property(n).property(1);
    var r = menu.setPropertyParameters(["Alpha", "Beta", "Gamma", "Delta"]);
    out.dropdown.returned = r ? r.matchName : null;
    menu = parade().property(n).property(1);
    out.dropdown.max = menu.maxValue;
    out.dropdown.matchAfter = parade().property(n).matchName;
    out.dropdown.nameAfter = parade().property(n).name;
    menu.setValue(3);
    out.dropdown.value = parade().property(n).property(1).value;
    out.dropdown.paramName = parade().property(n).property(1).name;
  });
  out.pickLate = exprState(pick());
  C.attempt("slider order", function () {
    var names = ["First", "Second", "Third"];
    var j;
    for (j = 0; j < names.length; j++) parade().addProperty("ADBE Slider Control").name = names[j];
  });
  C.attempt("mgt", function () {
    var n = parade().numProperties;
    var j;
    out.mgtAdds = [];
    // Pick first, then First / Second / Third.
    parade().property(1).property(1).addToMotionGraphicsTemplateAs(inner, "Pick");
    out.mgtAdds.push("Pick");
    for (j = 2; j <= n; j++) {
      parade().property(j).property(1).addToMotionGraphicsTemplateAs(inner, parade().property(j).name);
      out.mgtAdds.push(parade().property(j).name);
    }
    out.mgtNames = [];
    for (j = 1; j <= inner.motionGraphicsTemplateControllerCount; j++) out.mgtNames.push(inner.getMotionGraphicsTemplateControllerName(j));
  });
  C.attempt("mgt name", function () {
    inner.motionGraphicsTemplateName = "EP2 Inner";
    out.mgtName = inner.motionGraphicsTemplateName;
  });

  var main = C.comp("EP2 Main", 200, 100, 30, 1);
  var mctl = main.layers.addNull();
  mctl.name = "Controls";
  mctl.property("ADBE Effect Parade").addProperty("ADBE Slider Control").name = "Shift";
  mctl.property("ADBE Effect Parade").property(1).property(1).setValue(17);
  out.crossLate = exprState(cross());
  var A = main.layers.add(inner);
  A.name = "A";
  C.attempt("override dropdown", function () {
    var ep = A.essentialProperty;
    out.epNames = [];
    var j;
    for (j = 1; j <= ep.numProperties; j++) out.epNames.push(ep.property(j).name + " = " + ep.property(j).matchName);
    ep.property("Pick").setValue(4);
    out.overridePick = ep.property("Pick").value;
  });
  C.attempt("re-assign by path", function () {
    var p = byPath(probeNull, out.crossPath);
    var before = p.expressionError;
    p.expression = p.expression;
    out.reassign = { before: before, after: p.expressionError, value: p.valueAtTime(0, false) };
  });
  C.save(cfg.project);
}());
