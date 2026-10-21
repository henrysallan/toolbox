// Toolbox -> After Effects: the package builder (spec 091926_after-effects-handoff.md sec. 5).
//
// A static ExtendScript (ES3) interpreter of scene.json. It never contains
// project data: everything it builds comes from the scene.json next to it, and
// it maps one JSON node to one ExtendScript call. All conversion math (pixels,
// seconds, speed/influence, colors) already happened in TypeScript
// (src/lib/ae-export/convert); this file only moves values into AE.
//
// Trust boundary (sec. 8): scene.json is DATA. It is parsed by the hand-written
// JSON reader below, never eval'd, so a crafted project cannot run
// ExtendScript. Match names from the scene reach addProperty() as plain
// strings - AE rejects unknown ones.
//
// Run it: File -> Scripts -> Run Script File... and pick this file. It starts a
// new project (AE asks to save the current one first if it has changes),
// builds every comp in one undo group, opens the main comp, saves
// <package name>.aep inside the package (next to scene.json, so footage and
// shaders/ resolve relative to it) and shows one summary. A scene with a
// Toolbox Shader effect saves there once more first, before the effect's
// Bundle ID is set (the host's rules, at @tbx-begin below).
//
// Hosts that drive it (the desktop app, the M0 spike) can set, before
// evaluating this file:
//   $.global.TBX_AE_QUIET = true       no alert at the end (headless runs)
//   $.global.TBX_AE_PACKAGE = "/path"  the package folder, when $.fileName
//                                       is not this file (e.g. $.evalFile)
//   $.global.TBX_AE_OVERWRITE = true   replace an existing <name>.aep
// The outcome lands in $.global.TBX_AE_RESULT and, when AE may write files,
// in build-log.json inside the package.
//
// ES3 only: no JSON object, no Array.indexOf/forEach/map, no String.trim, no
// trailing commas, no reserved words as property names (report["native"]).

/* eslint-disable @typescript-eslint/no-unused-vars -- ES3 has no optional catch binding */

(function () {
  var BUILDER_VERSION = "1.1.0";
  var SCHEMA_VERSION = 1;

  /* @json-begin - gated in scripts/ae-export/check-runtime.mts under Node */
  var TbxJson = (function () {
    var MAX_DEPTH = 256;

    function parse(text) {
      var s = String(text);
      var n = s.length;
      var i = 0;
      var depth = 0;
      var nextBackslash = -2;
      if (n > 0 && s.charCodeAt(0) === 0xfeff) i = 1;

      function fail(msg) {
        throw new Error("scene.json: " + msg + " at character " + i);
      }

      function skipSpace() {
        var c;
        while (i < n) {
          c = s.charCodeAt(i);
          if (c === 32 || c === 9 || c === 10 || c === 13) i++;
          else break;
        }
      }

      function hasControl(chunk) {
        var k, c;
        for (k = 0; k < chunk.length; k++) {
          c = chunk.charCodeAt(k);
          if (c < 32) return true;
        }
        return false;
      }

      function readString() {
        var out = "";
        var quote, chunk, esc, hex;
        i++;
        for (;;) {
          quote = s.indexOf('"', i);
          if (quote < 0) fail("unterminated string");
          if (nextBackslash !== -1 && nextBackslash < i) nextBackslash = s.indexOf("\\", i);
          if (nextBackslash >= 0 && nextBackslash < quote) {
            chunk = s.substring(i, nextBackslash);
            if (hasControl(chunk)) fail("control character in string");
            out += chunk;
            i = nextBackslash + 1;
            esc = s.charAt(i);
            if (esc === '"') out += '"';
            else if (esc === "\\") out += "\\";
            else if (esc === "/") out += "/";
            else if (esc === "b") out += "\b";
            else if (esc === "f") out += "\f";
            else if (esc === "n") out += "\n";
            else if (esc === "r") out += "\r";
            else if (esc === "t") out += "\t";
            else if (esc === "u") {
              hex = s.substr(i + 1, 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
              out += String.fromCharCode(parseInt(hex, 16));
              i += 4;
            } else fail("bad escape");
            i++;
            continue;
          }
          chunk = s.substring(i, quote);
          if (hasControl(chunk)) fail("control character in string");
          out += chunk;
          i = quote + 1;
          return out;
        }
      }

      function digits() {
        var start = i, c;
        while (i < n) {
          c = s.charCodeAt(i);
          if (c >= 48 && c <= 57) i++;
          else break;
        }
        return i - start;
      }

      function readNumber() {
        var start = i, c;
        if (s.charCodeAt(i) === 45) i++;
        c = s.charCodeAt(i);
        if (c === 48) i++;
        else if (c >= 49 && c <= 57) digits();
        else fail("bad number");
        if (s.charCodeAt(i) === 46) {
          i++;
          if (!digits()) fail("bad number");
        }
        c = s.charCodeAt(i);
        if (c === 101 || c === 69) {
          i++;
          c = s.charCodeAt(i);
          if (c === 43 || c === 45) i++;
          if (!digits()) fail("bad number");
        }
        return parseFloat(s.substring(start, i));
      }

      function readValue() {
        var c, v;
        skipSpace();
        if (i >= n) fail("unexpected end");
        c = s.charCodeAt(i);
        if (c === 123 || c === 91) {
          if (++depth > MAX_DEPTH) fail("nesting deeper than " + MAX_DEPTH);
          v = c === 123 ? readObject() : readArray();
          depth--;
          return v;
        }
        if (c === 34) return readString();
        if (c === 45 || (c >= 48 && c <= 57)) return readNumber();
        if (s.substr(i, 4) === "true") {
          i += 4;
          return true;
        }
        if (s.substr(i, 5) === "false") {
          i += 5;
          return false;
        }
        if (s.substr(i, 4) === "null") {
          i += 4;
          return null;
        }
        fail("unexpected character");
      }

      function readObject() {
        var o = {};
        var key, c;
        i++;
        skipSpace();
        if (s.charCodeAt(i) === 125) {
          i++;
          return o;
        }
        for (;;) {
          skipSpace();
          if (s.charCodeAt(i) !== 34) fail("expected a key");
          key = readString();
          // The one key that would rewire an object's prototype instead of
          // storing data. scene.json never needs it.
          if (key === "__proto__") fail("forbidden key __proto__");
          skipSpace();
          if (s.charCodeAt(i) !== 58) fail("expected ':'");
          i++;
          o[key] = readValue();
          skipSpace();
          c = s.charCodeAt(i);
          if (c === 44) {
            i++;
            continue;
          }
          if (c === 125) {
            i++;
            return o;
          }
          fail("expected ',' or '}'");
        }
      }

      function readArray() {
        var a = [];
        var c;
        i++;
        skipSpace();
        if (s.charCodeAt(i) === 93) {
          i++;
          return a;
        }
        for (;;) {
          a.push(readValue());
          skipSpace();
          c = s.charCodeAt(i);
          if (c === 44) {
            i++;
            continue;
          }
          if (c === 93) {
            i++;
            return a;
          }
          fail("expected ',' or ']'");
        }
      }

      var result = readValue();
      skipSpace();
      if (i < n) fail("unexpected text after the value");
      return result;
    }

    function quote(str) {
      return '"' + String(str).replace(/[\\"\u0000-\u001f\u2028\u2029]/g, function (ch) {
        if (ch === '"') return '\\"';
        if (ch === "\\") return "\\\\";
        if (ch === "\n") return "\\n";
        if (ch === "\r") return "\\r";
        if (ch === "\t") return "\\t";
        return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
      }) + '"';
    }

    function stringify(v) {
      var parts = [];
      var k, j;
      if (v === null || v === undefined) return "null";
      if (typeof v === "number") return isFinite(v) ? String(v) : "null";
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "string") return quote(v);
      if (v instanceof Array) {
        for (j = 0; j < v.length; j++) parts.push(stringify(v[j]));
        return "[" + parts.join(",") + "]";
      }
      for (k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k) && typeof v[k] !== "function") parts.push(quote(k) + ":" + stringify(v[k]));
      }
      return "{" + parts.join(",") + "}";
    }

    return { parse: parse, stringify: stringify };
  }());
  /* @json-end */

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  var G = $.global;
  var problems = [];
  var warnings = [];
  var counts = { comps: 0, layers: 0, keys: 0, effects: 0, masks: 0, presets: 0, expressions: 0 };

  function has(o, k) {
    return o !== null && o !== undefined && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  }

  function problem(where, e) {
    var msg = e && e.message ? e.message : String(e);
    problems.push(where + ": " + msg + (e && e.line ? " (build.jsx line " + e.line + ")" : ""));
  }

  // Run one step; a failure is recorded and the build carries on.
  function step(where, fn) {
    try {
      fn();
      return true;
    } catch (e) {
      problem(where, e);
      return false;
    }
  }

  function enumValue(table, key, where) {
    if (!has(table, key)) throw new Error("unknown " + where + " \"" + key + "\"");
    return table[key];
  }

  // AE enum members by name, resolved when used so a member this AE lacks
  // fails one step instead of the whole script.
  function aeEnum(enumObj, names, label) {
    var j;
    for (j = 0; j < names.length; j++) {
      if (enumObj && enumObj[names[j]] !== undefined) return enumObj[names[j]];
    }
    throw new Error("this After Effects has no " + label);
  }

  var BLEND = {
    "normal": ["NORMAL"], "dissolve": ["DISSOLVE"], "darken": ["DARKEN"], "multiply": ["MULTIPLY"],
    "color-burn": ["COLOR_BURN"], "classic-color-burn": ["CLASSIC_COLOR_BURN"], "linear-burn": ["LINEAR_BURN"],
    "darker-color": ["DARKER_COLOR"], "add": ["ADD"], "lighten": ["LIGHTEN"], "screen": ["SCREEN"],
    "color-dodge": ["COLOR_DODGE"], "classic-color-dodge": ["CLASSIC_COLOR_DODGE"], "linear-dodge": ["LINEAR_DODGE", "ADD"],
    "lighter-color": ["LIGHTER_COLOR"], "overlay": ["OVERLAY"], "soft-light": ["SOFT_LIGHT"], "hard-light": ["HARD_LIGHT"],
    "linear-light": ["LINEAR_LIGHT"], "vivid-light": ["VIVID_LIGHT"], "pin-light": ["PIN_LIGHT"], "hard-mix": ["HARD_MIX"],
    "difference": ["DIFFERENCE"], "classic-difference": ["CLASSIC_DIFFERENCE"], "exclusion": ["EXCLUSION"],
    "subtract": ["SUBTRACT"], "divide": ["DIVIDE"], "hue": ["HUE"], "saturation": ["SATURATION"], "color": ["COLOR"],
    "luminosity": ["LUMINOSITY"], "stencil-alpha": ["STENCIL_ALPHA"], "stencil-luma": ["STENCIL_LUMA"],
    "silhouette-alpha": ["SILHOUETTE_ALPHA", "SILHOUETE_ALPHA"], "silhouette-luma": ["SILHOUETTE_LUMA", "SILHOUETE_LUMA"],
    "alpha-add": ["ALPHA_ADD"], "luminescent-premul": ["LUMINESCENT_PREMUL"]
  };

  // "ADBE Vector Blend Mode" popup (shape groups, fills, strokes): its menu
  // order, 1-based. AE has no stencil/silhouette/dissolve modes here.
  var SHAPE_BLEND = {
    "normal": 1, "darken": 2, "multiply": 3, "color-burn": 4, "linear-burn": 5, "darker-color": 6, "lighten": 7,
    "screen": 8, "color-dodge": 9, "add": 10, "linear-dodge": 10, "lighter-color": 11, "overlay": 12, "soft-light": 13,
    "hard-light": 14, "linear-light": 15, "vivid-light": 16, "pin-light": 17, "hard-mix": 18, "difference": 19,
    "exclusion": 20, "subtract": 21, "divide": 22, "hue": 23, "saturation": 24, "color": 25, "luminosity": 26
  };

  var CAP = { "butt": 1, "round": 2, "square": 3 };
  var JOIN = { "miter": 1, "round": 2, "bevel": 3 };
  var FILL_RULE = { "nonzero": 1, "evenodd": 2 };
  var GRAD_TYPE = { "linear": 1, "radial": 2 };
  var TRIM_MODE = { "simultaneous": 1, "individual": 2 };
  var MERGE_MODE = { "merge": 1, "add": 2, "subtract": 3, "intersect": 4, "exclude": 5 };
  var REPEATER_COMPOSITE = { "above": 1, "below": 2 };
  var STAR_TYPE = { "star": 1, "polygon": 2 };
  var TEXT_BASED_ON = { "characters": 1, "characters-excluding-spaces": 2, "words": 3, "lines": 4 };
  var TEXT_UNITS = { "percentage": 1, "index": 2 };
  var TEXT_SHAPE = { "square": 1, "ramp-up": 2, "ramp-down": 3, "triangle": 4, "round": 5, "smooth": 6 };
  var TEXT_MODE = { "add": 1, "subtract": 2, "intersect": 3, "min": 4, "max": 5, "difference": 6 };
  var TEXT_GROUPING = { "character": 1, "word": 2, "line": 3, "all": 4 };
  var MASK_MODE = {
    "none": "NONE", "add": "ADD", "subtract": "SUBTRACT", "intersect": "INTERSECT",
    "lighten": "LIGHTEN", "darken": "DARKEN", "difference": "DIFFERENCE"
  };
  var JUSTIFY = {
    "left": "LEFT_JUSTIFY", "center": "CENTER_JUSTIFY", "right": "RIGHT_JUSTIFY",
    "full-left": "FULL_JUSTIFY_LASTLINE_LEFT", "full-center": "FULL_JUSTIFY_LASTLINE_CENTER",
    "full-right": "FULL_JUSTIFY_LASTLINE_RIGHT", "full": "FULL_JUSTIFY_LASTLINE_FULL"
  };
  var MATTE = {
    "LUMA": "LUMA", "LUMA_INVERTED": "LUMA_INVERTED", "ALPHA": "ALPHA", "ALPHA_INVERTED": "ALPHA_INVERTED"
  };

  // ---------------------------------------------------------------------------
  // Property values and keyframes
  // ---------------------------------------------------------------------------

  function interpType(name) {
    if (name === "linear") return KeyframeInterpolationType.LINEAR;
    if (name === "bezier") return KeyframeInterpolationType.BEZIER;
    if (name === "hold") return KeyframeInterpolationType.HOLD;
    throw new Error("unknown interpolation \"" + name + "\"");
  }

  function toShape(p) {
    var sh = new Shape();
    sh.vertices = p.vertices;
    sh.inTangents = p.inTangents;
    sh.outTangents = p.outTangents;
    sh.closed = p.closed === true;
    return sh;
  }

  // A color property takes [r, g, b, a]; scene colors are [r, g, b].
  function asValue(prop, v) {
    if (prop.propertyValueType === PropertyValueType.COLOR && v instanceof Array && v.length === 3) return [v[0], v[1], v[2], 1];
    if (prop.propertyValueType === PropertyValueType.SHAPE) return toShape(v);
    return v;
  }

  // AE wants 1 ease for spatial, 1-D and color properties, else one per
  // dimension of the property's value type. A 2-D layer's Scale is ThreeD in
  // AE, so a 2-entry scene array is completed with its last entry (the z
  // ease of a 2-D layer has no effect).
  // Spatial by value type: Property.isSpatial is also true for paths, which
  // the spatial-tangent calls reject.
  function spatial(prop) {
    var t = prop.propertyValueType;
    return t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL;
  }

  function easeCount(prop) {
    var t = prop.propertyValueType;
    if (spatial(prop)) return 1;
    if (t === PropertyValueType.ThreeD) return 3;
    if (t === PropertyValueType.TwoD) return 2;
    return 1;
  }

  function easeArray(prop, list) {
    if (!(list instanceof Array) || !list.length) throw new Error("an empty ease list");
    var want = easeCount(prop);
    var out = [];
    var j, e;
    for (j = 0; j < want; j++) {
      e = list[j < list.length ? j : list.length - 1];
      out.push(new KeyframeEase(e.speed, e.influence));
    }
    return out;
  }

  // A tangent at the property's own length: a 2-D layer's Position is
  // ThreeD_SPATIAL, so [x, y] from the scene gets z = 0; omitted = zero.
  function tangent(prop, k, v) {
    var n = prop.keyInSpatialTangent(k).length;
    var out = [];
    var j;
    for (j = 0; j < n; j++) out.push(v && j < v.length ? v[j] : 0);
    return out;
  }

  function sceneTime(times, t) {
    var j;
    for (j = 0; j < times.length; j++) if (Math.abs(times[j] - t) < 1e-7) return true;
    return false;
  }

  // AeProp -> the property: a static value, or keys with interpolation, ease
  // and spatial tangents, then the expression. `convert` maps a scene value
  // to what setValue takes (TextDocument, Shape...); asValue covers the rest.
  function applyProp(prop, ap, where, convert) {
    if (!prop) throw new Error(where + " is missing on this layer");
    if (!ap || typeof ap !== "object") return;
    try {
      writeProp(prop, ap, where, convert);
    } catch (e) {
      throw new Error(where + ": " + (e && e.message ? e.message : e) + (e && e.line ? " (build.jsx line " + e.line + ")" : ""));
    }
  }

  function writeProp(prop, ap, where, convert) {
    var conv = convert || function (v) { return asValue(prop, v); };
    var keys, times, values, j, k, key, inE, outE;
    if (has(ap, "keys")) {
      keys = ap.keys;
      times = [];
      values = [];
      for (j = 0; j < keys.length; j++) {
        if (j > 0 && !(keys[j].t > keys[j - 1].t)) throw new Error("key times must increase");
        times.push(keys[j].t);
        values.push(conv(keys[j].v));
      }
      // Write over what is there, then drop keys at other times: Time
      // Remapping starts with two, and removing them all switches it off.
      if (keys.length) prop.setValuesAtTimes(times, values);
      for (k = prop.numKeys; k >= 1; k--) if (!sceneTime(times, prop.keyTime(k))) prop.removeKey(k);
      if (prop.numKeys !== keys.length) throw new Error("AE kept " + prop.numKeys + " of " + keys.length + " keys");
      for (j = 0; j < keys.length; j++) {
        key = keys[j];
        k = j + 1;
        prop.setInterpolationTypeAtKey(k, interpType(key.inInterp), interpType(key.outInterp));
        if (has(key, "easeIn") || has(key, "easeOut")) {
          inE = has(key, "easeIn") ? easeArray(prop, key.easeIn) : prop.keyInTemporalEase(k);
          outE = has(key, "easeOut") ? easeArray(prop, key.easeOut) : prop.keyOutTemporalEase(k);
          prop.setTemporalEaseAtKey(k, inE, outE);
          // Setting an ease turns a LINEAR side into BEZIER; put it back.
          prop.setInterpolationTypeAtKey(k, interpType(key.inInterp), interpType(key.outInterp));
        }
        if (spatial(prop)) {
          // Omitted tangents mean a straight motion path (toolbox has no
          // spatial curves); AE would otherwise auto-bezier through the keys.
          prop.setSpatialContinuousAtKey(k, false);
          prop.setSpatialAutoBezierAtKey(k, false);
          prop.setSpatialTangentsAtKey(k, tangent(prop, k, has(key, "spatialIn") ? key.spatialIn : null),
            tangent(prop, k, has(key, "spatialOut") ? key.spatialOut : null));
        }
        counts.keys++;
      }
    } else if (has(ap, "v")) {
      if (prop.numKeys > 0) {
        while (prop.numKeys > 0) prop.removeKey(prop.numKeys);
      }
      prop.setValue(conv(ap.v));
    }
    if (has(ap, "expression") && ap.expression) {
      prop.expression = ap.expression;
      counts.expressions++;
    }
  }

  function setEnum(prop, value, where) {
    if (!prop) throw new Error(where + " is missing");
    prop.setValue(value);
  }

  // ---------------------------------------------------------------------------
  // Project, footage, comps
  // ---------------------------------------------------------------------------

  function applyProject(p) {
    var proj = app.project;
    // An OCIO-managed project (colorManagementSystem 1, the startup project
    // in aerender 26.5 on 2026-10-21) refuses 16 bpc, and the scene's working
    // space is an ICC profile: switch to Adobe color management (0; 26.5 has
    // no enum object for it).
    step("project color management", function () {
      if (proj.colorManagementSystem !== undefined && proj.colorManagementSystem !== 0) {
        proj.colorManagementSystem = 0;
        warnings.push("project: switched color management from OCIO to Adobe (the scene's working space is an ICC profile)");
      }
    });
    step("project bitsPerChannel", function () { proj.bitsPerChannel = p.bitsPerChannel; });
    if (has(p, "workingSpace")) step("project workingSpace", function () { proj.workingSpace = p.workingSpace; });
    step("project linearBlending", function () { proj.linearBlending = p.linearBlending === true; });
    if (has(p, "linearizeWorkingSpace")) {
      step("project linearizeWorkingSpace", function () { proj.linearizeWorkingSpace = p.linearizeWorkingSpace === true; });
    }
    if (has(p, "expressionEngine")) step("project expressionEngine", function () { proj.expressionEngine = p.expressionEngine; });
  }

  function packageFile(root, rel) {
    // Package paths are relative and use forward slashes; refuse ones that
    // climb out of the package.
    if (/(^|\/)\.\.(\/|$)/.test(rel) || rel.charAt(0) === "/" || /^[A-Za-z]:/.test(rel)) {
      throw new Error("path \"" + rel + "\" leaves the package");
    }
    return new File(root.fsName + "/" + rel);
  }

  function importFootage(root, f, folder) {
    var file = packageFile(root, f.path);
    if (!file.exists) throw new Error("missing file " + f.path);
    var io = new ImportOptions(file);
    var item;
    if (f.kind === "svg") {
      if (io.canImportAs(ImportAsType.COMP_CROPPED_LAYERS)) io.importAs = ImportAsType.COMP_CROPPED_LAYERS;
      else if (io.canImportAs(ImportAsType.COMP)) io.importAs = ImportAsType.COMP;
      else warnings.push(f.id + ": this After Effects imports the SVG as footage, not shape layers");
    } else {
      if (io.canImportAs(ImportAsType.FOOTAGE)) io.importAs = ImportAsType.FOOTAGE;
      if (f.kind === "sequence") io.sequence = true;
    }
    var before = {};
    var j;
    for (j = 1; j <= app.project.numItems; j++) before[app.project.item(j).id] = true;
    item = app.project.importFile(io);
    if (!item && f.kind === "svg") {
      // An SVG imported as cropped-layer shapes returns null (26.5) although
      // the comp is created: take the new comp.
      for (j = 1; j <= app.project.numItems; j++) {
        if (!before[app.project.item(j).id] && app.project.item(j) instanceof CompItem) item = app.project.item(j);
      }
    }
    if (!item) throw new Error("After Effects did not import " + f.path);
    if (has(f, "name") && f.name) item.name = f.name;
    if (item.mainSource) {
      if (f.alpha === "straight") item.mainSource.alphaMode = AlphaMode.STRAIGHT;
      else if (f.alpha === "premultiplied") {
        item.mainSource.alphaMode = AlphaMode.PREMULTIPLIED;
        item.mainSource.premulColor = [0, 0, 0];
      } else if (f.alpha === "ignore") item.mainSource.alphaMode = AlphaMode.IGNORE;
      if (has(f, "fps") && f.fps > 0) item.mainSource.conformFrameRate = f.fps;
    }
    if (folder) item.parentFolder = folder;
    return item;
  }

  // ---------------------------------------------------------------------------
  // Shape contents
  // ---------------------------------------------------------------------------

  // Every structural change to a shape layer's contents invalidates earlier
  // property references, so items are reached through getters that walk
  // from the layer each time.
  function childGetter(parentGet, index) {
    return function () { return parentGet().property(index); };
  }

  function groupTransform(get, t, where) {
    if (!t) return;
    var tg = function () { return get().property("ADBE Vector Transform Group"); };
    if (has(t, "anchor")) applyProp(tg().property("ADBE Vector Anchor"), t.anchor, where + " anchor");
    if (has(t, "position")) applyProp(tg().property("ADBE Vector Position"), t.position, where + " position");
    if (has(t, "scale")) applyProp(tg().property("ADBE Vector Scale"), t.scale, where + " scale");
    if (has(t, "skew")) applyProp(tg().property("ADBE Vector Skew"), t.skew, where + " skew");
    if (has(t, "skewAxis")) applyProp(tg().property("ADBE Vector Skew Axis"), t.skewAxis, where + " skew axis");
    if (has(t, "rotation")) applyProp(tg().property("ADBE Vector Rotation"), t.rotation, where + " rotation");
    if (has(t, "opacity")) applyProp(tg().property("ADBE Vector Group Opacity"), t.opacity, where + " opacity");
  }

  function strokeCommon(get, it, where) {
    if (has(it, "width")) applyProp(get().property("ADBE Vector Stroke Width"), it.width, where + " width");
    // Miter limit first: AE hides it (and refuses values) once the join is
    // not Miter.
    if (has(it, "miterLimit")) get().property("ADBE Vector Stroke Miter Limit").setValue(it.miterLimit);
    if (has(it, "cap")) setEnum(get().property("ADBE Vector Stroke Line Cap"), enumValue(CAP, it.cap, "cap"), where + " cap");
    if (has(it, "join")) setEnum(get().property("ADBE Vector Stroke Line Join"), enumValue(JOIN, it.join, "join"), where + " join");
    var j, pairs;
    if (has(it, "dashes") && it.dashes.length) {
      pairs = it.dashes.length > 3 ? 3 : it.dashes.length;
      if (it.dashes.length > 3) warnings.push(where + ": AE takes 3 dash pairs; the rest were dropped");
      for (j = 1; j <= pairs; j++) {
        get().property("ADBE Vector Stroke Dashes").addProperty("ADBE Vector Stroke Dash " + j);
        get().property("ADBE Vector Stroke Dashes").addProperty("ADBE Vector Stroke Gap " + j);
      }
      for (j = 1; j <= pairs; j++) {
        applyProp(get().property("ADBE Vector Stroke Dashes").property("ADBE Vector Stroke Dash " + j), it.dashes[j - 1].dash, where + " dash " + j);
        applyProp(get().property("ADBE Vector Stroke Dashes").property("ADBE Vector Stroke Gap " + j), it.dashes[j - 1].gap, where + " gap " + j);
      }
      if (has(it, "dashOffset")) {
        get().property("ADBE Vector Stroke Dashes").addProperty("ADBE Vector Stroke Offset");
        applyProp(get().property("ADBE Vector Stroke Dashes").property("ADBE Vector Stroke Offset"), it.dashOffset, where + " dash offset");
      }
    }
    if (has(it, "taper")) {
      var tp = function () { return get().property("ADBE Vector Stroke Taper"); };
      applyProp(tp().property("ADBE Vector Taper Start Length"), it.taper.startLength, where + " taper start length");
      applyProp(tp().property("ADBE Vector Taper End Length"), it.taper.endLength, where + " taper end length");
      applyProp(tp().property("ADBE Vector Taper Start Width"), it.taper.startWidth, where + " taper start width");
      applyProp(tp().property("ADBE Vector Taper End Width"), it.taper.endWidth, where + " taper end width");
      applyProp(tp().property("ADBE Vector Taper Start Ease"), it.taper.startEase, where + " taper start ease");
      applyProp(tp().property("ADBE Vector Taper End Ease"), it.taper.endEase, where + " taper end ease");
    }
  }

  // Applies a synthesized .ffx (presets/) to one property: AE applies a
  // preset to the selected layers, landing it on the selected property.
  function applyPresetTo(layer, propGet, presetId, ctx, where) {
    if (!has(ctx.presets, presetId)) throw new Error(where + ": unknown preset \"" + presetId + "\"");
    if (ctx.headless) {
      // layer.applyPreset() hangs or crashes aerender's render core (26.5,
      // any preset, Adobe's own included), so headless builds leave AE's
      // default instead. Run build.jsx in the After Effects app for these.
      warnings.push(where + ": preset " + presetId + " not applied (no UI: run build.jsx in the After Effects app)");
      return;
    }
    var file = packageFile(ctx.root, ctx.presets[presetId]);
    if (!file.exists) throw new Error(where + ": missing preset " + ctx.presets[presetId]);
    var comp = layer.containingComp;
    var j, sel;
    if (ctx.viewer !== comp) {
      // A preset lands on the selection of the comp the viewer shows.
      try { comp.openInViewer(); } catch (eV) {}
      ctx.viewer = comp;
    }
    sel = comp.selectedLayers;
    for (j = 0; j < sel.length; j++) sel[j].selected = false;
    sel = comp.selectedProperties;
    for (j = 0; j < sel.length; j++) {
      try { sel[j].selected = false; } catch (e) {}
    }
    layer.selected = true;
    propGet().selected = true;
    try {
      layer.applyPreset(file);
    } finally {
      try { propGet().selected = false; } catch (e2) {}
      layer.selected = false;
    }
    counts.presets++;
  }

  function addShapeItems(layer, contentsGet, items, ctx, where) {
    var j;
    for (j = 0; j < items.length; j++) {
      (function (it, n) {
        step(where + " item " + n + " (" + it.kind + ")", function () { addShapeItem(layer, contentsGet, it, ctx, where + "/" + (it.name || it.kind)); });
      }(items[j], j + 1));
    }
  }

  var SHAPE_MATCH = {
    "group": "ADBE Vector Group", "path": "ADBE Vector Shape - Group", "rect": "ADBE Vector Shape - Rect",
    "ellipse": "ADBE Vector Shape - Ellipse", "polystar": "ADBE Vector Shape - Star", "fill": "ADBE Vector Graphic - Fill",
    "stroke": "ADBE Vector Graphic - Stroke", "gradient-fill": "ADBE Vector Graphic - G-Fill",
    "gradient-stroke": "ADBE Vector Graphic - G-Stroke", "trim": "ADBE Vector Filter - Trim",
    "offset": "ADBE Vector Filter - Offset", "round-corners": "ADBE Vector Filter - RC",
    "repeater": "ADBE Vector Filter - Repeater", "merge": "ADBE Vector Filter - Merge"
  };

  function addShapeItem(layer, contentsGet, it, ctx, where) {
    var match = enumValue(SHAPE_MATCH, it.kind, "shape item");
    if (!contentsGet().canAddProperty(match)) throw new Error("cannot add " + match + " here");
    contentsGet().addProperty(match);
    // New items append, so this one is the last; an item that failed earlier
    // leaves no hole.
    var index = contentsGet().numProperties;
    var get = childGetter(contentsGet, index);
    if (has(it, "name") && it.name) get().name = it.name;
    var k = it.kind;
    if (k === "group") {
      if (has(it, "blendMode")) setEnum(get().property("ADBE Vector Blend Mode"), enumValue(SHAPE_BLEND, it.blendMode, "shape blend mode"), where);
      groupTransform(get, it.transform, where);
      addShapeItems(layer, function () { return get().property("ADBE Vectors Group"); }, it.contents || [], ctx, where);
    } else if (k === "path") {
      applyProp(get().property("ADBE Vector Shape"), it.path, where + " path");
    } else if (k === "rect") {
      applyProp(get().property("ADBE Vector Rect Size"), it.size, where + " size");
      applyProp(get().property("ADBE Vector Rect Position"), it.position, where + " position");
      applyProp(get().property("ADBE Vector Rect Roundness"), it.roundness, where + " roundness");
    } else if (k === "ellipse") {
      applyProp(get().property("ADBE Vector Ellipse Size"), it.size, where + " size");
      applyProp(get().property("ADBE Vector Ellipse Position"), it.position, where + " position");
    } else if (k === "polystar") {
      setEnum(get().property("ADBE Vector Star Type"), enumValue(STAR_TYPE, it.type, "polystar type"), where + " type");
      applyProp(get().property("ADBE Vector Star Points"), it.points, where + " points");
      applyProp(get().property("ADBE Vector Star Position"), it.position, where + " position");
      applyProp(get().property("ADBE Vector Star Rotation"), it.rotation, where + " rotation");
      applyProp(get().property("ADBE Vector Star Outer Radius"), it.outerRadius, where + " outer radius");
      // AE's match names really are spelled "Roundess".
      applyProp(get().property("ADBE Vector Star Outer Roundess"), it.outerRoundness, where + " outer roundness");
      if (has(it, "innerRadius")) applyProp(get().property("ADBE Vector Star Inner Radius"), it.innerRadius, where + " inner radius");
      if (has(it, "innerRoundness")) applyProp(get().property("ADBE Vector Star Inner Roundess"), it.innerRoundness, where + " inner roundness");
    } else if (k === "fill") {
      applyProp(get().property("ADBE Vector Fill Color"), it.color, where + " color");
      applyProp(get().property("ADBE Vector Fill Opacity"), it.opacity, where + " opacity");
      setEnum(get().property("ADBE Vector Fill Rule"), enumValue(FILL_RULE, it.rule, "fill rule"), where + " rule");
      if (has(it, "blendMode")) setEnum(get().property("ADBE Vector Blend Mode"), enumValue(SHAPE_BLEND, it.blendMode, "shape blend mode"), where);
    } else if (k === "stroke") {
      applyProp(get().property("ADBE Vector Stroke Color"), it.color, where + " color");
      applyProp(get().property("ADBE Vector Stroke Opacity"), it.opacity, where + " opacity");
      strokeCommon(get, it, where);
      if (has(it, "blendMode")) setEnum(get().property("ADBE Vector Blend Mode"), enumValue(SHAPE_BLEND, it.blendMode, "shape blend mode"), where);
    } else if (k === "gradient-fill" || k === "gradient-stroke") {
      setEnum(get().property("ADBE Vector Grad Type"), enumValue(GRAD_TYPE, it.type, "gradient type"), where + " type");
      applyProp(get().property("ADBE Vector Grad Start Pt"), it.start, where + " start");
      applyProp(get().property("ADBE Vector Grad End Pt"), it.end, where + " end");
      if (has(it, "highlightLength")) applyProp(get().property("ADBE Vector Grad HiLite Length"), it.highlightLength, where + " highlight length");
      if (has(it, "highlightAngle")) applyProp(get().property("ADBE Vector Grad HiLite Angle"), it.highlightAngle, where + " highlight angle");
      if (k === "gradient-fill") {
        applyProp(get().property("ADBE Vector Fill Opacity"), it.opacity, where + " opacity");
        if (has(it, "rule")) setEnum(get().property("ADBE Vector Fill Rule"), enumValue(FILL_RULE, it.rule, "fill rule"), where + " rule");
      } else {
        applyProp(get().property("ADBE Vector Stroke Opacity"), it.opacity, where + " opacity");
        strokeCommon(get, it, where);
      }
      if (has(it, "preset") && it.preset) {
        applyPresetTo(layer, function () { return get().property("ADBE Vector Grad Colors"); }, it.preset, ctx, where + " colors");
      } else {
        warnings.push(where + ": no preset for the gradient colors; AE's default gradient stays");
      }
    } else if (k === "trim") {
      applyProp(get().property("ADBE Vector Trim Start"), it.start, where + " start");
      applyProp(get().property("ADBE Vector Trim End"), it.end, where + " end");
      applyProp(get().property("ADBE Vector Trim Offset"), it.offset, where + " offset");
      setEnum(get().property("ADBE Vector Trim Type"), enumValue(TRIM_MODE, it.mode, "trim mode"), where + " mode");
    } else if (k === "offset") {
      applyProp(get().property("ADBE Vector Offset Amount"), it.amount, where + " amount");
      get().property("ADBE Vector Offset Miter Limit").setValue(it.miterLimit);
      setEnum(get().property("ADBE Vector Offset Line Join"), enumValue(JOIN, it.join, "join"), where + " join");
      if (has(it, "copies")) applyProp(get().property("ADBE Vector Offset Copies"), it.copies, where + " copies");
      if (has(it, "copyOffset")) applyProp(get().property("ADBE Vector Offset Copy Offset"), it.copyOffset, where + " copy offset");
    } else if (k === "round-corners") {
      applyProp(get().property("ADBE Vector RoundCorner Radius"), it.radius, where + " radius");
    } else if (k === "repeater") {
      applyProp(get().property("ADBE Vector Repeater Copies"), it.copies, where + " copies");
      applyProp(get().property("ADBE Vector Repeater Offset"), it.offset, where + " offset");
      setEnum(get().property("ADBE Vector Repeater Order"), enumValue(REPEATER_COMPOSITE, it.composite, "repeater composite"), where + " composite");
      var t = it.transform || {};
      var rt = function () { return get().property("ADBE Vector Repeater Transform"); };
      if (has(t, "anchor")) applyProp(rt().property("ADBE Vector Repeater Anchor"), t.anchor, where + " anchor");
      if (has(t, "position")) applyProp(rt().property("ADBE Vector Repeater Position"), t.position, where + " position");
      if (has(t, "scale")) applyProp(rt().property("ADBE Vector Repeater Scale"), t.scale, where + " scale");
      if (has(t, "rotation")) applyProp(rt().property("ADBE Vector Repeater Rotation"), t.rotation, where + " rotation");
      if (has(t, "startOpacity")) applyProp(rt().property("ADBE Vector Repeater Opacity 1"), t.startOpacity, where + " start opacity");
      if (has(t, "endOpacity")) applyProp(rt().property("ADBE Vector Repeater Opacity 2"), t.endOpacity, where + " end opacity");
    } else if (k === "merge") {
      setEnum(get().property("ADBE Vector Merge Type"), enumValue(MERGE_MODE, it.mode, "merge mode"), where + " mode");
    }
  }

  // ---------------------------------------------------------------------------
  // Layers
  // ---------------------------------------------------------------------------

  function createLayer(comp, L, ctx) {
    var layer, src, box, doc;
    var k = L.kind;
    if (k === "shape" && has(L, "source") && L.source) {
      // Contents seeded from an imported SVG (the static-gradient route that
      // needs no preset): copy its shape layer in. Scene contents are added
      // after the SVG's, i.e. below them in AE's stack, where modifiers
      // (trim, repeater...) apply to the SVG's paths.
      src = has(ctx.items, L.source) ? ctx.items[L.source] : null;
      if (!(src instanceof CompItem) || src.numLayers < 1 || !(src.layer(1) instanceof ShapeLayer)) {
        throw new Error("source \"" + L.source + "\" is not an SVG imported as shapes");
      }
      src.layer(1).copyToComp(comp);
      layer = comp.layer(1);
    } else if (k === "shape") layer = comp.layers.addShape();
    else if (k === "solid" || k === "adjustment") {
      var sc = has(L, "solid") ? L.solid : { color: [1, 1, 1], width: comp.width, height: comp.height };
      layer = comp.layers.addSolid(asColor3(sc.color), L.name, sc.width, sc.height, 1, comp.duration);
      if (k === "adjustment") layer.adjustmentLayer = true;
    } else if (k === "null") layer = comp.layers.addNull(comp.duration);
    else if (k === "text") {
      doc = firstDocument(L);
      box = doc && has(doc, "box") ? doc.box : null;
      layer = box ? comp.layers.addBoxText(box.size, doc.text) : comp.layers.addText(doc ? doc.text : "");
    } else if (k === "footage" || k === "precomp") {
      if (!has(L, "source") || !has(ctx.items, L.source)) throw new Error("unknown source \"" + L.source + "\"");
      src = ctx.items[L.source];
      layer = comp.layers.add(src);
    } else if (k === "camera") layer = comp.layers.addCamera(L.name, [0, 0]);
    else if (k === "light") layer = comp.layers.addLight(L.name, [0, 0]);
    else throw new Error("unknown layer kind \"" + k + "\"");
    layer.name = L.name;
    if (L.threeD === true && k !== "camera" && k !== "light") layer.threeDLayer = true;
    counts.layers++;
    return layer;
  }

  function asColor3(c) {
    return c && c.length >= 3 ? [c[0], c[1], c[2]] : [1, 1, 1];
  }

  function firstDocument(L) {
    if (!has(L, "text") || !has(L.text, "document")) return null;
    var d = L.text.document;
    if (has(d, "v")) return d.v;
    if (has(d, "keys") && d.keys.length) return d.keys[0].v;
    return null;
  }

  function applyTimes(layer, L) {
    layer.startTime = L.startTime;
    layer.inPoint = L.inPoint;
    layer.outPoint = L.outPoint;
  }

  var LAYER_PROPS = {
    "rotation": "ADBE Rotate Z", "opacity": "ADBE Opacity", "orientation": "ADBE Orientation",
    "xRotation": "ADBE Rotate X", "yRotation": "ADBE Rotate Y"
  };

  function applyTransform(layer, T, where, kind) {
    var tg = function () { return layer.property("ADBE Transform Group"); };
    var key;
    // Cameras and lights carry Scale and Opacity in their transform group,
    // hidden; AE refuses values there.
    var noScaleOpacity = kind === "camera" || kind === "light";
    if (has(T, "anchor") && tg().property("ADBE Anchor Point")) applyProp(tg().property("ADBE Anchor Point"), T.anchor, where + " anchor");
    if (has(T, "separated")) {
      tg().property("ADBE Position").dimensionsSeparated = true;
      applyProp(tg().property("ADBE Position_0"), T.separated.x, where + " x position");
      applyProp(tg().property("ADBE Position_1"), T.separated.y, where + " y position");
      if (has(T.separated, "z")) applyProp(tg().property("ADBE Position_2"), T.separated.z, where + " z position");
    } else if (has(T, "position")) {
      applyProp(tg().property("ADBE Position"), T.position, where + " position");
    }
    if (has(T, "scale") && !noScaleOpacity) applyProp(tg().property("ADBE Scale"), T.scale, where + " scale");
    for (key in LAYER_PROPS) {
      if (Object.prototype.hasOwnProperty.call(LAYER_PROPS, key) && has(T, key)) {
        if (key === "opacity" && noScaleOpacity) continue;
        // Cameras and lights have no Opacity; a missing property for a
        // value the scene leaves at its default is not an error.
        if (!tg().property(LAYER_PROPS[key])) {
          warnings.push(where + ": no " + key + " on a " + layer.matchName);
          continue;
        }
        applyProp(tg().property(LAYER_PROPS[key]), T[key], where + " " + key);
      }
    }
  }

  function applyMasks(layer, masks, where) {
    var j;
    for (j = 0; j < masks.length; j++) {
      (function (m, n) {
        step(where + " mask " + n, function () {
          layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
          var index = layer.property("ADBE Mask Parade").numProperties;
          var get = function () { return layer.property("ADBE Mask Parade").property(index); };
          if (has(m, "name") && m.name) get().name = m.name;
          get().maskMode = MaskMode[enumValue(MASK_MODE, m.mode, "mask mode")];
          get().inverted = m.inverted === true;
          applyProp(get().property("ADBE Mask Shape"), m.path, where + " mask path");
          applyProp(get().property("ADBE Mask Feather"), m.feather, where + " mask feather");
          applyProp(get().property("ADBE Mask Offset"), m.expansion, where + " mask expansion");
          applyProp(get().property("ADBE Mask Opacity"), m.opacity, where + " mask opacity");
          counts.masks++;
        });
      }(masks[j], j + 1));
    }
  }

  /* @tbx-begin - the planner is gated in scripts/ae-export/check-runtime.mts under Node */
  // The Toolbox Shader host ("TBX Shader", ../AE_Plugins/toolbox-shader
  // README "For scripts") has three rules, all measured in aerender:
  //   1. save the project before setting Bundle ID - the host looks for
  //      shaders/<id>.tbxfx next to the saved project (a headless build also
  //      gets TBX_SHADER_BUNDLES from its launcher);
  //   2. set Bundle ID first - it loads the bundle and resets every un-keyed
  //      control to the bundle's defaults;
  //   3. only the bundle's own controls are visible, and AE refuses setValue
  //      on a hidden one - so set just those.
  var TBX_MATCH = "TBX Shader";
  var TBX_BUNDLE_PARAM = "TBX Shader-0001";
  var TBX_STATUS_PARAM = "TBX Shader-0090";

  function tbxMatch(diskId) {
    var s = String(diskId);
    while (s.length < 4) s = "0" + s;
    return TBX_MATCH + "-" + s;
  }

  // Match names of the controls bundle `b` shows (disk ids in types.ts
  // tbxShaderDiskId), or null when the bundle is unknown - the host then
  // leaves every control visible.
  function tbxControls(b) {
    if (!b || typeof b !== "object") return null;
    var out = {};
    var j, p;
    var inputs = { a: 10, b: 11, c: 12, d: 13 };
    var base = { slider: 20, color: 60, point: 70, checkbox: 80 };
    if (b.readsTime === true) {
      out[tbxMatch(2)] = true;
      out[tbxMatch(3)] = true;
      out[tbxMatch(4)] = true;
    }
    if (b.inputs instanceof Array) {
      for (j = 0; j < b.inputs.length; j++) if (has(inputs, b.inputs[j])) out[tbxMatch(inputs[b.inputs[j]])] = true;
    }
    if (b.params instanceof Array) {
      for (j = 0; j < b.params.length; j++) {
        p = b.params[j];
        if (p && has(base, p.kind) && typeof p.slot === "number") out[tbxMatch(base[p.kind] + p.slot - 1)] = true;
      }
    }
    return out;
  }

  // The bundle id an effect names: `bundle`, or a static Bundle ID prop.
  function tbxBundleId(fx) {
    var fromField = has(fx, "bundle") && fx.bundle !== null && fx.bundle !== "" ? Number(fx.bundle) : null;
    var prop = has(fx.props, TBX_BUNDLE_PARAM) ? fx.props[TBX_BUNDLE_PARAM] : null;
    if (prop && has(prop, "keys")) throw new Error("Bundle ID (" + TBX_BUNDLE_PARAM + ") cannot be keyed");
    var fromProp = prop && has(prop, "v") ? Number(prop.v) : null;
    if (fromField !== null && fromProp !== null && fromField !== fromProp) {
      throw new Error("bundle " + fx.bundle + " and Bundle ID " + prop.v + " disagree");
    }
    var id = fromField !== null ? fromField : fromProp;
    if (id === null || isNaN(id) || id < 1 || id >= 16777216 || Math.floor(id) !== id) {
      throw new Error("a TBX Shader effect needs a bundle id (a whole number 1 to 2^24 - 1)");
    }
    return id;
  }

  // What to set, in order: Bundle ID first, then the scene's other props
  // that are this bundle's own controls (all of them when the bundle is
  // unknown). `skipped` names the rest, which AE would refuse.
  function tbxPlan(fx, bundle) {
    var id = tbxBundleId(fx);
    var allowed = tbxControls(bundle);
    var sets = [TBX_BUNDLE_PARAM];
    var skipped = [];
    var key;
    for (key in fx.props) {
      if (!Object.prototype.hasOwnProperty.call(fx.props, key)) continue;
      if (key === TBX_BUNDLE_PARAM) continue;
      if (key === TBX_STATUS_PARAM || (allowed !== null && !has(allowed, key))) skipped.push(key);
      else sets.push(key);
    }
    return { id: id, sets: sets, skipped: skipped };
  }
  /* @tbx-end */

  function tbxReadBundle(ctx, id) {
    if (has(ctx.tbx, String(id))) return ctx.tbx[String(id)];
    var b = null;
    var f = packageFile(ctx.root, "shaders/" + id + ".tbxfx");
    if (f.exists) {
      f.encoding = "UTF-8";
      if (f.open("r")) {
        var text = f.read();
        f.close();
        b = TbxJson.parse(text);
      }
    }
    ctx.tbx[String(id)] = b;
    return b;
  }

  // Rule 1: the project gets its package path before the first Bundle ID.
  function tbxEnsureSaved(ctx) {
    if (ctx.tbxSaved) return;
    app.project.save(ctx.saveTo);
    ctx.tbxSaved = true;
  }

  function setEffectProp(get, fx, key, ctx, where) {
    // Params by match name ("<effect>-<4-digit disk id>") or "#<index>",
    // never by display name: the Toolbox Shader renames its params.
    var p = key.charAt(0) === "#" ? get().property(parseInt(key.substring(1), 10)) : get().property(key);
    var ref = layerRefOf(fx.props[key]);
    if (ref !== null) {
      // A layer param takes the layer's index; AE then follows the layer
      // itself if the stack is reordered.
      if (!p) throw new Error(fx.match + " has no param " + key);
      if (!has(ctx.layerById, ref)) throw new Error(key + ": no layer \"" + ref + "\" in this comp");
      p.setValue(ctx.layerById[ref].index);
    } else applyProp(p, fx.props[key], where + " " + fx.match + " " + key);
  }

  function applyEffects(layer, effects, ctx, where) {
    var j;
    for (j = 0; j < effects.length; j++) {
      (function (fx, n) {
        step(where + " effect " + n + " (" + fx.match + ")", function () {
          var parade = function () { return layer.property("ADBE Effect Parade"); };
          if (!parade().canAddProperty(fx.match)) throw new Error("this After Effects has no effect " + fx.match + " (is the plug-in installed?)");
          var tbx = fx.match === TBX_MATCH ? tbxPlan(fx, null) : null;
          var bundle = null;
          if (tbx) {
            bundle = tbxReadBundle(ctx, tbx.id);
            tbx = tbxPlan(fx, bundle);
            if (!bundle) warnings.push(where + ": shaders/" + tbx.id + ".tbxfx is missing or unreadable - every TBX Shader control was set; the .aep needs that file until it is opened once");
            tbxEnsureSaved(ctx);
          }
          parade().addProperty(fx.match);
          var index = parade().numProperties;
          var get = function () { return parade().property(index); };
          if (has(fx, "name") && fx.name) get().name = fx.name;
          var k, key;
          if (tbx) {
            get().property(TBX_BUNDLE_PARAM).setValue(tbx.id);
            for (k = 1; k < tbx.sets.length; k++) setEffectProp(get, fx, tbx.sets[k], ctx, where);
            for (k = 0; k < tbx.skipped.length; k++) {
              warnings.push(where + ": skipped " + tbx.skipped[k] + " - not a control of shader bundle " + (bundle && bundle.name ? bundle.name : tbx.id) + " (After Effects refuses hidden controls)");
            }
          } else {
            for (key in fx.props) {
              if (Object.prototype.hasOwnProperty.call(fx.props, key)) setEffectProp(get, fx, key, ctx, where);
            }
          }
          if (has(fx, "compositingMask")) {
            var cm = fx.compositingMask;
            get().property("ADBE Effect Built In Params").property("ADBE Effect Mask Parade").addProperty("ADBE Effect Mask");
            get().property("ADBE Effect Built In Params").property("ADBE Effect Mask Parade").property(1)
              .property("ADBE Effect Path Stream Ref").setValue(cm.mask);
            if (has(cm, "opacity")) {
              applyProp(get().property("ADBE Effect Built In Params").property("ADBE Effect Mask Opacity"), cm.opacity, where + " effect opacity");
            }
          }
          if (has(fx, "preset") && fx.preset) applyPresetTo(layer, get, fx.preset, ctx, where + " " + fx.match);
          if (has(fx, "enabled")) get().enabled = fx.enabled === true;
          counts.effects++;
        });
      }(effects[j], j + 1));
    }
  }

  // Character attributes the scene does not carry, at AE's neutral values.
  // A new text layer starts from the Character panel's last-used settings
  // (the designer's, e.g. All Caps), so each one is set explicitly. Some are
  // read-only before AE 24; those keep the panel's value. The scales are
  // fractions (1 = 100%).
  var TEXT_NEUTRAL = {
    fauxBold: false, fauxItalic: false, smallCaps: false, horizontalScale: 1, verticalScale: 1,
    baselineShift: 0, tsume: 0, superscript: false, subscript: false
  };

  // AeLayerRef, bare ({ layerRef }) or as a static value ({ v: { layerRef } }).
  function layerRefOf(val) {
    if (has(val, "layerRef")) return String(val.layerRef);
    if (has(val, "v") && has(val.v, "layerRef")) return String(val.v.layerRef);
    return null;
  }

  function toTextDocument(prop, d, problemsOut) {
    var td = prop.value;
    var key;
    td.text = d.text;
    td.font = d.font;
    td.fontSize = d.fontSize;
    if (has(d, "fillColor")) {
      td.applyFill = true;
      td.fillColor = d.fillColor;
    } else td.applyFill = false;
    if (has(d, "strokeColor")) {
      td.applyStroke = true;
      td.strokeColor = d.strokeColor;
      if (has(d, "strokeWidth")) td.strokeWidth = d.strokeWidth;
      if (has(d, "strokeOverFill")) td.strokeOverFill = d.strokeOverFill === true;
    } else td.applyStroke = false;
    td.tracking = d.tracking;
    if (has(d, "leading")) {
      td.autoLeading = false;
      td.leading = d.leading;
    } else td.autoLeading = true;
    td.justification = ParagraphJustification[enumValue(JUSTIFY, d.justification, "justification")];
    try {
      td.allCaps = d.allCaps === true;
    } catch (e) {
      try {
        td.fontCapsOption = d.allCaps === true ? FontCapsOption.FONT_ALL_CAPS : FontCapsOption.FONT_NORMAL_CAPS;
      } catch (e2) {
        problemsOut.push("all caps cannot be set in this After Effects");
      }
    }
    for (key in TEXT_NEUTRAL) {
      if (Object.prototype.hasOwnProperty.call(TEXT_NEUTRAL, key)) {
        try {
          if (td[key] !== TEXT_NEUTRAL[key]) td[key] = TEXT_NEUTRAL[key];
        } catch (e3) {
          problemsOut.push(key + " is read-only here");
        }
      }
    }
    // The panel's kerning mode too: it came in as Optical (measured 26.5),
    // which narrowed Arial "II" pairs by up to 2 px at 72 px; toolbox's
    // canvas kerns by the font's metrics.
    try {
      if (typeof AutoKernType !== "undefined" && td.autoKernType !== AutoKernType.METRIC_KERN) td.autoKernType = AutoKernType.METRIC_KERN;
    } catch (e4) {
      problemsOut.push("kerning (Metrics) cannot be set in this After Effects");
    }
    if (has(d, "baselineShift")) td.baselineShift = d.baselineShift;
    if (has(d, "box")) {
      td.boxTextSize = d.box.size;
      td.boxTextPos = d.box.position;
    }
    return td;
  }

  function applyTextAnimator(layer, A, where) {
    var animators = function () { return layer.property("ADBE Text Properties").property("ADBE Text Animators"); };
    animators().addProperty("ADBE Text Animator");
    var index = animators().numProperties;
    var get = function () { return animators().property(index); };
    get().name = A.name;
    var key;
    for (key in A.properties) {
      if (Object.prototype.hasOwnProperty.call(A.properties, key)) get().property("ADBE Text Animator Properties").addProperty(key);
    }
    for (key in A.properties) {
      if (Object.prototype.hasOwnProperty.call(A.properties, key)) {
        applyProp(get().property("ADBE Text Animator Properties").property(key), A.properties[key], where + " " + key);
      }
    }
    if (has(A, "selector")) applyRangeSelector(get, A.selector, where);
    var j;
    if (has(A, "selectors")) {
      for (j = 0; j < A.selectors.length; j++) {
        if (A.selectors[j].kind === "expression") applyExpressionSelector(get, A.selectors[j], where + " selector " + (j + 1));
        else applyRangeSelector(get, A.selectors[j], where + " selector " + (j + 1));
      }
    }
  }

  function applyRangeSelector(get, S, where) {
    get().property("ADBE Text Selectors").addProperty("ADBE Text Selector");
    var n = get().property("ADBE Text Selectors").numProperties;
    var sel = function () { return get().property("ADBE Text Selectors").property(n); };
    var adv = function () { return sel().property("ADBE Text Range Advanced"); };
    setEnum(adv().property("ADBE Text Range Units"), enumValue(TEXT_UNITS, S.units, "selector units"), where + " units");
    setEnum(adv().property("ADBE Text Range Type2"), enumValue(TEXT_BASED_ON, S.basedOn, "selector based-on"), where + " based on");
    if (has(S, "mode")) setEnum(adv().property("ADBE Text Selector Mode"), enumValue(TEXT_MODE, S.mode, "selector mode"), where + " mode");
    var byIndex = S.units === "index";
    applyProp(sel().property(byIndex ? "ADBE Text Index Start" : "ADBE Text Percent Start"), S.start, where + " start");
    applyProp(sel().property(byIndex ? "ADBE Text Index End" : "ADBE Text Percent End"), S.end, where + " end");
    applyProp(sel().property(byIndex ? "ADBE Text Index Offset" : "ADBE Text Percent Offset"), S.offset, where + " offset");
    setEnum(adv().property("ADBE Text Range Shape"), enumValue(TEXT_SHAPE, S.shape, "selector shape"), where + " shape");
    if (has(S, "amount")) applyProp(adv().property("ADBE Text Selector Max Amount"), S.amount, where + " amount");
    applyProp(adv().property("ADBE Text Levels Max Ease"), S.easeHigh, where + " ease high");
    applyProp(adv().property("ADBE Text Levels Min Ease"), S.easeLow, where + " ease low");
    if (has(S, "randomize")) adv().property("ADBE Text Randomize Order").setValue(S.randomize === true ? 1 : 0);
    if (has(S, "seed")) adv().property("ADBE Text Random Seed").setValue(S.seed);
  }

  // The Expression Selector's Amount is three equal dimensions (the scene
  // gives one); its expression reads value[0] and returns the selection %.
  function applyExpressionSelector(get, S, where) {
    get().property("ADBE Text Selectors").addProperty("ADBE Text Expressible Selector");
    var n = get().property("ADBE Text Selectors").numProperties;
    var sel = function () { return get().property("ADBE Text Selectors").property(n); };
    setEnum(sel().property("ADBE Text Range Type2"), enumValue(TEXT_BASED_ON, S.basedOn, "selector based-on"), where + " based on");
    if (has(S, "mode")) setEnum(sel().property("ADBE Text Selector Mode"), enumValue(TEXT_MODE, S.mode, "selector mode"), where + " mode");
    var amount = function () { return sel().property("ADBE Text Expressible Amount"); };
    applyProp(amount(), S.amount, where + " amount", function (v) { return [v, v, v]; });
    amount().expression = S.expression;
    counts.expressions++;
  }

  function applyText(layer, T, where) {
    var docProp = function () { return layer.property("ADBE Text Properties").property("ADBE Text Document"); };
    var notes = [];
    applyProp(docProp(), T.document, where + " text", function (d) { return toTextDocument(docProp(), d, notes); });
    if (notes.length) warnings.push(where + ": " + notes[0] + (notes.length > 1 ? " (+" + (notes.length - 1) + " more)" : ""));
    if (has(T, "pathMask")) {
      layer.property("ADBE Text Properties").property("ADBE Text Path Options").property("ADBE Text Path").setValue(T.pathMask);
    }
    if (has(T, "pathOptions")) {
      var po = function () { return layer.property("ADBE Text Properties").property("ADBE Text Path Options"); };
      var O = T.pathOptions;
      if (has(O, "reverse")) po().property("ADBE Text Reverse Path").setValue(O.reverse === true ? 1 : 0);
      if (has(O, "perpendicular")) po().property("ADBE Text Perpendicular To Path").setValue(O.perpendicular === true ? 1 : 0);
      if (has(O, "forceAlignment")) po().property("ADBE Text Force Align Path").setValue(O.forceAlignment === true ? 1 : 0);
      if (has(O, "firstMargin")) applyProp(po().property("ADBE Text First Margin"), O.firstMargin, where + " first margin");
      if (has(O, "lastMargin")) applyProp(po().property("ADBE Text Last Margin"), O.lastMargin, where + " last margin");
    }
    if (has(T, "anchorGrouping")) {
      setEnum(layer.property("ADBE Text Properties").property("ADBE Text More Options").property("ADBE Text Anchor Point Option"),
        enumValue(TEXT_GROUPING, T.anchorGrouping, "anchor point grouping"), where + " anchor point grouping");
    }
    var j;
    if (has(T, "animators")) {
      for (j = 0; j < T.animators.length; j++) {
        (function (A, n) {
          step(where + " animator " + n, function () { applyTextAnimator(layer, A, where + " animator " + A.name); });
        }(T.animators[j], j + 1));
      }
    }
    var d = firstDocument({ text: T });
    if (d && app.fonts && app.fonts.getFontsByPostScriptName) {
      var found = app.fonts.getFontsByPostScriptName(d.font);
      if (!found || !found.length) warnings.push(where + ": font " + d.font + " is not installed; AE substitutes another");
    }
  }

  function fillLayer(layer, L, ctx, where) {
    // Time remapping first: a remapped layer may outlast its source, which
    // AE only allows once remapping is on.
    if (has(L, "timeRemap")) {
      step(where + " time remap", function () {
        if (!layer.canSetTimeRemapEnabled) throw new Error("this layer cannot be time-remapped");
        layer.timeRemapEnabled = true;
      });
    }
    step(where + " times", function () { applyTimes(layer, L); });
    step(where + " transform", function () { applyTransform(layer, L.transform, where, L.kind); });
    if (has(L, "masks")) applyMasks(layer, L.masks, where);
    if (has(L, "contents")) {
      if (L.kind !== "shape") problem(where, "contents on a " + L.kind + " layer");
      else addShapeItems(layer, function () { return layer.property("ADBE Root Vectors Group"); }, L.contents, ctx, where);
    }
    if (has(L, "text")) step(where + " text", function () { applyText(layer, L.text, where); });
    if (has(L, "effects")) applyEffects(layer, L.effects, ctx, where);
    if (has(L, "timeRemap") && layer.timeRemapEnabled) {
      step(where + " time remap keys", function () { applyProp(layer.property("ADBE Time Remapping"), L.timeRemap, where + " time remap"); });
    }
    step(where + " blending mode", function () { layer.blendingMode = aeEnum(BlendingMode, enumValue(BLEND, L.blendingMode, "blend mode"), L.blendingMode + " blending"); });
    if (has(L, "origin") && L.origin.length) {
      step(where + " comment", function () { layer.comment = "toolbox: " + L.origin.join(", "); });
    }
  }

  function buildComp(comp, C, ctx) {
    var j, L, layer;
    var byId = {};
    var made = [];
    // Pass 1: create, bottom-up, so layers[0] ends at index 1.
    for (j = C.layers.length - 1; j >= 0; j--) {
      L = C.layers[j];
      (function (L) {
        step(C.name + "/" + L.name + " create", function () {
          layer = createLayer(comp, L, ctx);
          byId[L.id] = layer;
          made.push({ L: L, layer: layer });
        });
      }(L));
    }
    // Pass 2: parenting (without moving the child - its values are already
    // in parent space) and track mattes by reference.
    for (j = 0; j < made.length; j++) {
      (function (m) {
        var where = C.name + "/" + m.L.name;
        if (has(m.L, "parent") && m.L.parent) {
          step(where + " parent", function () {
            if (!has(byId, m.L.parent)) throw new Error("unknown parent \"" + m.L.parent + "\"");
            if (m.layer.setParentWithJump) m.layer.setParentWithJump(byId[m.L.parent]);
            else m.layer.parent = byId[m.L.parent];
          });
        }
        if (has(m.L, "matte")) {
          step(where + " track matte", function () {
            if (!has(byId, m.L.matte.layer)) throw new Error("unknown matte layer \"" + m.L.matte.layer + "\"");
            if (!m.layer.setTrackMatte) throw new Error("track mattes by reference need After Effects 23.0 or later");
            m.layer.setTrackMatte(byId[m.L.matte.layer], TrackMatteType[enumValue(MATTE, m.L.matte.type, "matte type")]);
          });
        }
      }(made[j]));
    }
    // Pass 3: properties. Every layer exists now, so layer refs resolve.
    ctx.layerById = byId;
    for (j = 0; j < made.length; j++) fillLayer(made[j].layer, made[j].L, ctx, C.name + "/" + made[j].L.name);
    // Visibility last: AE switches a matte source off when it becomes one.
    for (j = 0; j < made.length; j++) {
      if (has(made[j].L, "enabled")) {
        (function (m) {
          step(C.name + "/" + m.L.name + " enabled", function () { m.layer.enabled = m.L.enabled === true; });
        }(made[j]));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------

  function readScene(root) {
    var f = new File(root.fsName + "/scene.json");
    if (!f.exists) throw new Error("No scene.json next to build.jsx (" + root.fsName + ").");
    f.encoding = "UTF-8";
    if (!f.open("r")) throw new Error("Cannot read " + f.fsName);
    var text = f.read();
    f.close();
    var scene = TbxJson.parse(text);
    if (!scene || typeof scene !== "object") throw new Error("scene.json is not an object");
    if (scene.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("scene.json schema " + scene.schemaVersion + " needs a different builder (this one reads " + SCHEMA_VERSION + ")");
    }
    if (!(scene.comps instanceof Array) || !scene.comps.length) throw new Error("scene.json has no comps");
    return scene;
  }

  function packageRoot() {
    if (typeof G.TBX_AE_PACKAGE === "string" && G.TBX_AE_PACKAGE) return new Folder(G.TBX_AE_PACKAGE);
    return new File($.fileName).parent;
  }

  // <package>.aepkg/<package>.aep - inside the package, so the host plug-in
  // finds shaders/<bundle id>.tbxfx and AE footage paths relative to it.
  function saveTarget(root) {
    var base = decodeURI(root.name).replace(/\.aepkg$/i, "");
    var f = new File(root.fsName + "/" + base + ".aep");
    var n = 2;
    if (G.TBX_AE_OVERWRITE !== true) {
      while (f.exists) {
        f = new File(root.fsName + "/" + base + " " + n + ".aep");
        n++;
      }
    }
    return f;
  }

  function writeLog(root, result) {
    try {
      var f = new File(root.fsName + "/build-log.json");
      f.encoding = "UTF-8";
      f.lineFeed = "Unix";
      if (f.open("w")) {
        f.write(TbxJson.stringify(result));
        f.close();
      }
    } catch (e) {
      // Writing needs "Allow Scripts to Write Files and Access Network";
      // without it the saved .aep is the only signal.
    }
  }

  function summary(scene, result) {
    var r = scene.report || {};
    var lines = [];
    lines.push(result.ok ? "Built from Toolbox" : "Toolbox build stopped");
    if (result.saved) lines.push("Saved " + result.saved);
    lines.push(counts.comps + " comps, " + counts.layers + " layers, " + counts.keys + " keys");
    function count(list) { return list && list.length ? list.length : 0; }
    if (r.route) {
      lines.push("Route: " + r.route + " - native " + count(r["native"]) + ", approximate " + count(r.approx) +
        ", shader " + count(r.shader) + ", baked " + count(r.baked));
    }
    var j;
    if (r.approx && r.approx.length) {
      lines.push("Approximated:");
      for (j = 0; j < r.approx.length && j < 8; j++) lines.push("  " + (r.approx[j].name || r.approx[j].type) + (r.approx[j].note ? " - " + r.approx[j].note : ""));
    }
    if (r.requires && r.requires.fonts && r.requires.fonts.length) lines.push("Fonts: " + r.requires.fonts.join(", "));
    if (r.requires && r.requires.shaderHost) lines.push("Needs the Toolbox Shader plug-in " + r.requires.shaderHost);
    for (j = 0; j < warnings.length && j < 6; j++) lines.push("Note: " + warnings[j]);
    if (problems.length) {
      lines.push(problems.length + " problem(s):");
      for (j = 0; j < problems.length && j < 8; j++) lines.push("  " + problems[j]);
      if (problems.length > 8) lines.push("  ... see build-log.json");
    }
    return lines.join("\n");
  }

  function main() {
    var started = new Date().getTime();
    var root = packageRoot();
    var result = { ok: false, builder: BUILDER_VERSION, ae: app.version, saved: null, problems: problems, warnings: warnings, counts: counts };
    var scene = null;
    var suppressed = false;
    var undo = false;
    // Read before beginSuppressDialogs: true in aerender's render core.
    var headless = app.isUISuppressed === true;
    result.headless = headless;
    try {
      scene = readScene(root);
      // Build into a fresh project. An untouched one (no items, never saved)
      // is used as is; otherwise it is closed first, before dialogs are
      // suppressed, so AE can ask to save the designer's work. (Not
      // app.newProject(): it blocks in aerender's render core.)
      if (app.project.numItems > 0 || app.project.file !== null) {
        if (!app.project.close(CloseOptions.PROMPT_TO_SAVE_CHANGES)) throw new Error("Closing the current project was cancelled; nothing was built.");
      }
      app.beginSuppressDialogs();
      suppressed = true;
      app.beginUndoGroup("Build from Toolbox");
      undo = true;

      applyProject(scene.project || {});

      // One save target for the whole build: a TBX Shader effect saves the
      // project there early (tbxEnsureSaved), the end saves it again.
      var ctx = { root: root, items: {}, presets: {}, viewer: null, headless: headless, layerById: {}, saveTo: saveTarget(root), tbxSaved: false, tbx: {} };
      var j, f, folder = null;
      if (scene.presets) {
        for (j = 0; j < scene.presets.length; j++) ctx.presets[scene.presets[j].id] = scene.presets[j].path;
      }
      if (scene.footage && scene.footage.length) {
        folder = app.project.items.addFolder("Footage");
        for (j = 0; j < scene.footage.length; j++) {
          f = scene.footage[j];
          (function (f) {
            step("footage " + f.id, function () { ctx.items[f.id] = importFootage(root, f, folder); });
          }(f));
        }
      }
      // Every comp exists before any is filled, so precomp layers can point
      // at any comp id.
      var comps = [];
      for (j = 0; j < scene.comps.length; j++) {
        var C = scene.comps[j];
        var comp = app.project.items.addComp(C.name, C.width, C.height, 1, C.duration, C.fps);
        if (has(C, "bgColor")) comp.bgColor = C.bgColor;
        if (has(ctx.items, C.id)) throw new Error("comp id \"" + C.id + "\" is also a footage id");
        ctx.items[C.id] = comp;
        comps.push({ C: C, comp: comp });
        counts.comps++;
      }
      for (j = 0; j < comps.length; j++) buildComp(comps[j].comp, comps[j].C, ctx);

      if (!has(ctx.items, scene.main)) throw new Error("main comp \"" + scene.main + "\" is not in scene.json");
      var main = ctx.items[scene.main];
      step("open main comp", function () { main.openInViewer(); });

      app.endUndoGroup();
      undo = false;
      var target = ctx.saveTo;
      app.project.save(target);
      result.saved = target.fsName;
      result.ok = true;
    } catch (e) {
      problem("build", e);
    } finally {
      if (undo) app.endUndoGroup();
      if (suppressed) app.endSuppressDialogs(false);
    }
    result.seconds = (new Date().getTime() - started) / 1000;
    G.TBX_AE_RESULT = result;
    writeLog(root, result);
    if (G.TBX_AE_QUIET !== true) alert(summary(scene || {}, result), "Toolbox -> After Effects");
    return result;
  }

  main();
}());
