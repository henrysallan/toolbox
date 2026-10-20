// Toolbox AE calibration: ExtendScript helpers for the job scripts
// (scripts/ae-export-spike/calibrate/ae.mts evaluates this, then one job).
//
// Runs inside aerender's render core at startup (spec §13): no newProject()
// (it blocks), no renderQueue.render() (it does nothing) — jobs build into the
// untouched startup project, queue frames and save it; ae.mts renders the
// saved queue with a second, plain `aerender -project`.

/* eslint-disable @typescript-eslint/no-unused-vars -- ES3 has no optional catch binding */

$.global.CAL = (function () {
  var C = {};
  C.cfg = $.global.TBX_CAL || {};
  C.out = { ae: app.version, errors: [] };

  function quote(s) {
    return '"' + String(s).replace(/[\\"\u0000-\u001f\u2028\u2029]/g, function (ch) {
      if (ch === '"') return '\\"';
      if (ch === "\\") return "\\\\";
      if (ch === "\n") return "\\n";
      if (ch === "\r") return "\\r";
      return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
    }) + '"';
  }
  C.toJSON = function toJSON(v) {
    var parts = [], i, k;
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return isFinite(v) ? String(v) : "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return quote(v);
    if (v instanceof Array) {
      for (i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
      return "[" + parts.join(",") + "]";
    }
    for (k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k) && typeof v[k] !== "function") parts.push(quote(k) + ":" + toJSON(v[k]));
    }
    return "{" + parts.join(",") + "}";
  };
  C.writeJSON = function (path, v) {
    var f = new File(path);
    f.encoding = "UTF-8";
    f.lineFeed = "Unix";
    if (!f.open("w")) throw new Error("cannot write " + path);
    f.write(C.toJSON(v));
    f.close();
  };
  C.attempt = function (label, fn) {
    try {
      return fn();
    } catch (e) {
      C.out.errors.push(label + ": " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
      return null;
    }
  };
  C.finish = function () {
    C.writeJSON(C.cfg.out, C.out);
  };

  var PVT = ["NO_VALUE", "ThreeD_SPATIAL", "ThreeD", "TwoD_SPATIAL", "TwoD", "OneD", "COLOR", "CUSTOM_VALUE", "MARKER", "LAYER_INDEX", "MASK_INDEX", "SHAPE", "TEXT_DOCUMENT"];
  C.pvtName = function (t) {
    var i;
    for (i = 0; i < PVT.length; i++) if (PropertyValueType[PVT[i]] === t) return PVT[i];
    return String(t);
  };

  // Every leaf property of a group: match name, display name, value type,
  // value and range where AE exposes them.
  C.dumpProps = function (group, depth) {
    var r = [], i, p, e;
    for (i = 1; i <= group.numProperties; i++) {
      p = group.property(i);
      e = { i: i, mn: p.matchName, name: p.name };
      if (p.propertyType === PropertyType.PROPERTY) {
        e.type = C.pvtName(p.propertyValueType);
        try { if (p.propertyValueType !== PropertyValueType.NO_VALUE && p.propertyValueType !== PropertyValueType.CUSTOM_VALUE) e.value = p.value; } catch (x) {}
        try { if (p.hasMin) e.min = p.minValue; } catch (x) {}
        try { if (p.hasMax) e.max = p.maxValue; } catch (x) {}
        try { e.canVary = p.canVaryOverTime; } catch (x) {}
        try { if (p.isDropdownEffect) e.dropdown = true; } catch (x) {}
      } else if (depth > 0) {
        e.props = C.dumpProps(p, depth - 1);
      }
      r.push(e);
    }
    return r;
  };

  C.comp = function (name, w, h, fps, dur) {
    return app.project.items.addComp(name, w, h, 1, dur || 1, fps || 30);
  };
  C.importStill = function (path) {
    var io = new ImportOptions(new File(path));
    io.sequence = false;
    var it = app.project.importFile(io);
    if (it && it.mainSource && it.mainSource.alphaMode !== undefined) {
      // Test images are written straight (unmatted) alpha.
      try { it.mainSource.alphaMode = AlphaMode.STRAIGHT; } catch (x) {}
    }
    return it;
  };
  // Effect by match name; params set by "<match>-<4-digit position>" or by
  // the full match name.
  C.addEffect = function (layer, match, props) {
    var fx = layer.property("ADBE Effect Parade").addProperty(match);
    if (!fx) throw new Error("addProperty(" + match + ") returned null");
    var k, p;
    for (k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      p = fx.property(k.indexOf("ADBE") === 0 || k.indexOf("VISINF") === 0 || k.indexOf("-") > 0 ? k : match + "-" + k);
      if (!p) throw new Error(match + ": no property " + k);
      p.setValue(props[k]);
    }
    return fx;
  };
  // One queued frame, its own output name (AE skips a duplicate name).
  // 8 bpc: "TIFF Sequence with Alpha" (premultiplied, spec §13). 16 bpc: the
  // hidden "_HIDDEN X-Factor 16" template — PNG Sequence, Trillions of
  // Colors+, straight alpha — because an output module's Depth is read-only
  // to scripts (setSettings refuses every value).
  C.queue = function (comp, frame, path, depth) {
    var rq = app.project.renderQueue.items.add(comp);
    rq.applyTemplate("Best Settings");
    rq.timeSpanStart = frame * comp.frameDuration;
    rq.timeSpanDuration = comp.frameDuration;
    var om = rq.outputModule(1);
    om.applyTemplate(depth === 16 ? "_HIDDEN X-Factor 16" : "TIFF Sequence with Alpha");
    om.file = new File(path.replace(/\.tif$/, depth === 16 ? ".png" : ".tif"));
    return rq;
  };
  C.omSettings = function () {
    if (!app.project.renderQueue.numItems) return null;
    return app.project.renderQueue.item(1).outputModule(1).getSettings(GetSettingsFormat.STRING);
  };
  C.save = function (path) {
    app.project.save(new File(path));
  };
  return C;
}());
