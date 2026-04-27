import { useEffect, useState } from "react";
import LiveViewer from "@/lib/live-viewer/LiveViewer";
import "@/lib/live-viewer/styles.css";
import { loadData, type ExportData } from "./load-data";

export default function App() {
  const [data, setData] = useState<ExportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadData()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error("Export load failed", err);
        if (!cancelled) setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="live-root">
        <div className="fatal">
          Export failed to load:{"\n"}
          {error}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="live-root">
        <div className="fatal">Loading…</div>
      </div>
    );
  }

  return (
    <div className="live-root">
      <LiveViewer graph={data.graph} manifest={data.manifest} />
    </div>
  );
}
