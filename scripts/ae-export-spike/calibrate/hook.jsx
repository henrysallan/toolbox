// Toolbox AE calibration: startup hook (scripts/ae-export-spike/calibrate/ae.mts).
//
// Same mechanism as ../hook.jsx (spec 091926_after-effects-handoff.md §13):
// ae.mts copies this file into the user Scripts/Startup folder for ONE
// aerender launch and deletes it afterwards. It has its own file name and
// environment variable so a calibration run and a spike run never remove or
// trigger each other's hook. It does nothing unless TBX_AE_CALIBRATE_DRIVER is
// set, which only ae.mts sets in aerender's environment.

(function () {
  var driver = $.getenv("TBX_AE_CALIBRATE_DRIVER");
  if (!driver) return;
  var f = new File(driver);
  if (!f.exists) return;
  try {
    $.evalFile(f);
  } catch (e) {
    var out = new File(f.parent.fsName + "/hook-error.txt");
    out.encoding = "UTF-8";
    out.lineFeed = "Unix";
    if (out.open("w")) {
      out.write(String(e) + (e && e.line ? " (line " + e.line + ")" : "") + "\n");
      out.close();
    }
  }
}());
