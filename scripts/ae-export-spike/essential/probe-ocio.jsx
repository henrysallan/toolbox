// Essential Properties lane: a new project inherits "AE Last Project
// Settings" (here OCIO color management, which refuses bitsPerChannel 16).
// What scripting can read and set about it (probe.mts --ocio).
(function () {
  var C = $.global.CAL;
  var out = C.out;
  var p = app.project;
  out.before = {};
  C.attempt("read", function () {
    out.before.cms = p.colorManagementSystem;
    out.before.bpc = p.bitsPerChannel;
    out.before.workingSpace = p.workingSpace;
    out.enumType = typeof ColorManagementSystem;
    if (typeof ColorManagementSystem !== "undefined") {
      out.enumKeys = [];
      var k;
      for (k in ColorManagementSystem) out.enumKeys.push(k + "=" + ColorManagementSystem[k]);
    }
  });
  C.attempt("set adobe (0)", function () { p.colorManagementSystem = 0; });
  C.attempt("bpc 16", function () { p.bitsPerChannel = 16; });
  C.attempt("working space", function () { p.workingSpace = "sRGB IEC61966-2.1"; });
  out.after = {};
  C.attempt("read after", function () {
    out.after.cms = p.colorManagementSystem;
    out.after.bpc = p.bitsPerChannel;
    out.after.workingSpace = p.workingSpace;
  });
}());
