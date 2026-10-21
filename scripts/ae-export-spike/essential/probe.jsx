// Essential Properties lane (M4 lane 6): what After Effects' headless render
// core does with Expression Controls, Essential Graphics and Essential
// Properties overrides. Run by probe.mts through calibrate/ae.mts (runAeJob),
// so it builds into aerender's startup project and never touches the AE GUI.
//
//   1. each Expression Control by match name: its params (match name, type)
//   2. Dropdown Menu Control: setPropertyParameters(items) headless
//   3. an expression that names a control which does not exist yet, then the
//      control: is the expression still enabled, and does it read the value?
//   4. Property.addToMotionGraphicsTemplateAs(comp, name) on each control and
//      on a shape property; the comp's controller list
//   5. two precomp layers of the comp: AVLayer.essentialProperty, an
//      override set by script on one, values read back
//   6. a cross-comp expression (comp("…").layer("Controls")) set before that
//      comp exists
//   7. frame 0 of the main comp queued, so the second launch renders what
//      the SAVED project holds (overrides included)
//
// cfg: { project, renders }

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  var out = C.out;
  app.project.bitsPerChannel = 8;

  var W = 200;
  var H = 200;
  var CONTROLS = [
    ["slider", "ADBE Slider Control", "Radius"],
    ["angle", "ADBE Angle Control", "Spin"],
    ["point", "ADBE Point Control", "Where"],
    ["color", "ADBE Color Control", "Tint"],
    ["checkbox", "ADBE Checkbox Control", "Show"],
    ["dropdown", "ADBE Dropdown Control", "Pick"]
  ];

  function exprState(p) {
    var r = {};
    C.attempt("exprState", function () {
      r.enabled = p.expressionEnabled;
      r.error = p.expressionError;
      r.value = p.valueAtTime(0, false);
      r.preExpression = p.valueAtTime(0, true);
    });
    return r;
  }

  // ---- the inner comp: a dot whose size and color read a Controls null -----
  var inner = C.comp("EP Inner", W, H, 30, 1);
  var dot = inner.layers.addShape();
  dot.name = "Dot";
  dot.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]);
  var vg = function () {
    return dot.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
  };
  dot.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  vg().addProperty("ADBE Vector Shape - Ellipse");
  vg().addProperty("ADBE Vector Graphic - Fill");
  var size = function () { return vg().property(1).property("ADBE Vector Ellipse Size"); };
  var epos = function () { return vg().property(1).property("ADBE Vector Ellipse Position"); };
  var fill = function () { return vg().property(2).property("ADBE Vector Fill Color"); };
  epos().setValue([W / 2, H / 2]);
  size().setValue([40, 40]);
  fill().setValue([0, 0, 1, 1]);

  // 3. expressions before the controls exist.
  C.attempt("early expressions", function () {
    size().expression = 'var r = thisComp.layer("Controls").effect("Radius")(1); [2 * r, 2 * r]';
    fill().expression = 'thisComp.layer("Controls").effect("Tint")(1)';
    out.earlySize = exprState(size());
    out.earlyFill = exprState(fill());
  });
  // 6. a cross-comp reference to a comp that does not exist yet.
  C.attempt("cross-comp expression", function () {
    epos().expression = 'var o = comp("EP Main").layer("Controls").effect("Shift")(1); [' + (W / 2) + ' + o, ' + (H / 2) + ']';
    out.earlyCross = exprState(epos());
  });

  // 1 + 2. the controls null and one control of each kind.
  var ctl = inner.layers.addNull();
  ctl.name = "Controls";
  out.nullTransform = {
    anchor: ctl.property("ADBE Transform Group").property("ADBE Anchor Point").value,
    position: ctl.property("ADBE Transform Group").property("ADBE Position").value
  };
  var parade = function () { return ctl.property("ADBE Effect Parade"); };
  out.controls = {};
  var j;
  for (j = 0; j < CONTROLS.length; j++) {
    (function (c) {
      C.attempt("add " + c[1], function () {
        var fx = parade().addProperty(c[1]);
        fx.name = c[2];
        out.controls[c[0]] = { match: fx.matchName, name: fx.name, props: C.dumpProps(fx, 0) };
      });
    }(CONTROLS[j]));
  }
  var fx = function (name) { return parade().property(name); };
  C.attempt("dropdown items", function () {
    var p = fx("Pick").property(1);
    var r = p.setPropertyParameters(["Alpha", "Beta", "Gamma"]);
    out.dropdown = { returned: r ? r.matchName : null, isDropdown: fx("Pick").property(1).isDropdownEffect };
    fx("Pick").property(1).setValue(2);
    out.dropdown.value = fx("Pick").property(1).value;
    out.dropdown.after = C.dumpProps(fx("Pick"), 0);
  });
  C.attempt("set control values", function () {
    fx("Radius").property(1).setValue(30);
    fx("Tint").property(1).setValue([0, 1, 0, 1]);
    fx("Spin").property(1).setValue(45);
    fx("Where").property(1).setValue([10, 20]);
    fx("Show").property(1).setValue(1);
  });
  out.lateSize = exprState(size());
  out.lateFill = exprState(fill());
  out.lateCross = exprState(epos());
  // Re-assigning the same text: does it re-enable a disabled expression?
  C.attempt("reassign", function () {
    var s = size().expression;
    size().expression = s;
    out.reassignSize = exprState(size());
  });

  // 4. Essential Graphics.
  out.mgt = { before: { name: null, count: null } };
  C.attempt("mgt before", function () {
    out.mgt.before.name = inner.motionGraphicsTemplateName;
    out.mgt.before.count = inner.motionGraphicsTemplateControllerCount;
  });
  out.mgt.add = {};
  for (j = 0; j < CONTROLS.length; j++) {
    (function (c) {
      C.attempt("mgt " + c[2], function () {
        var p = fx(c[2]).property(1);
        var can = p.canAddToMotionGraphicsTemplate(inner);
        var ok = p.addToMotionGraphicsTemplateAs(inner, "EP " + c[2]);
        out.mgt.add[c[2]] = { can: can, ok: ok };
      });
    }(CONTROLS[j]));
  }
  C.attempt("mgt shape prop", function () {
    var p = vg().property(2).property("ADBE Vector Fill Opacity");
    out.mgt.add.fillOpacity = { can: p.canAddToMotionGraphicsTemplate(inner), ok: p.addToMotionGraphicsTemplateAs(inner, "EP Opacity") };
  });
  C.attempt("mgt after", function () {
    out.mgt.after = { name: inner.motionGraphicsTemplateName, count: inner.motionGraphicsTemplateControllerCount, names: [] };
    for (j = 1; j <= inner.motionGraphicsTemplateControllerCount; j++) out.mgt.after.names.push(inner.getMotionGraphicsTemplateControllerName(j));
  });

  // 5. the main comp: two instances, one overridden.
  var main = C.comp("EP Main", W * 2, H, 30, 1);
  main.bgColor = [0, 0, 0];
  var mctl = main.layers.addNull();
  mctl.name = "Controls";
  mctl.property("ADBE Effect Parade").addProperty("ADBE Slider Control").name = "Shift";
  mctl.property("ADBE Effect Parade").property("Shift").property(1).setValue(0);
  out.afterMainCross = exprState(epos());
  var A = main.layers.add(inner);
  A.name = "A";
  A.property("ADBE Transform Group").property("ADBE Position").setValue([W / 2, H / 2]);
  var B = main.layers.add(inner);
  B.name = "B";
  B.property("ADBE Transform Group").property("ADBE Position").setValue([W * 1.5, H / 2]);
  C.attempt("essentialProperty", function () {
    var ep = B.essentialProperty;
    out.essential = { match: ep ? ep.matchName : null, n: ep ? ep.numProperties : null, props: ep ? C.dumpProps(ep, 0) : null };
    out.essential.layerOverrides = B.property("ADBE Layer Overrides") ? B.property("ADBE Layer Overrides").numProperties : null;
  });
  C.attempt("override B", function () {
    var ep = B.essentialProperty;
    ep.property("EP Radius").setValue(70);
    ep.property("EP Tint").setValue([1, 0, 0, 1]);
    ep.property("EP Pick").setValue(3);
    out.overrideB = C.dumpProps(B.essentialProperty, 0);
    out.overrideA = C.dumpProps(A.essentialProperty, 0);
  });
  C.attempt("override keys", function () {
    var p = B.essentialProperty.property("EP Spin");
    p.setValueAtTime(0, 10);
    p.setValueAtTime(0.5, 90);
    out.overrideKeys = { numKeys: p.numKeys, at25: p.valueAtTime(0.25, false), canVary: p.canVaryOverTime };
  });
  C.attempt("override expression", function () {
    var p = B.essentialProperty.property("EP Show");
    out.overrideExpr = { canSet: p.canSetExpression };
  });
  C.attempt("inner read back", function () {
    out.innerAfter = { size: size().valueAtTime(0, false), fill: fill().valueAtTime(0, false), radius: fx("Radius").property(1).value };
  });
  C.attempt("an outside expression reads B's essential property", function () {
    mctl.property("ADBE Effect Parade").addProperty("ADBE Slider Control").name = "Read";
    var p = mctl.property("ADBE Effect Parade").property("Read").property(1);
    p.expression = 'thisComp.layer("B").essentialProperty("EP Radius")';
    out.outsideRead = exprState(p);
  });

  // 7. render what the saved project holds.
  C.queue(main, 0, cfg.renders + "/main_f0_[#####].tif", 8);
  C.save(cfg.project);
}());
