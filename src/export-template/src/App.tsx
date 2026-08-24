import { useEffect, useState } from "react";
import LiveViewer from "@/lib/live-viewer/LiveViewer";
import { LiveRoot } from "@/lib/live-viewer/live-root";
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
      <LiveRoot>
        <div className="fatal">
          Export failed to load:{"\n"}
          {error}
        </div>
      </LiveRoot>
    );
  }
  if (!data) {
    return (
      <LiveRoot>
        <div className="fatal">Loading…</div>
      </LiveRoot>
    );
  }

  return (
    <LiveRoot design={data.manifest.design}>
      <LiveViewer graph={data.graph} manifest={data.manifest} />
    </LiveRoot>
  );
}
