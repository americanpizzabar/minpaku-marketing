"use client";

import dynamic from "next/dynamic";
import type { MapPoint } from "@/lib/types";

// Leaflet は window に依存するためサーバーサイドでは読み込まない
const MapPanel = dynamic(() => import("./MapPanel"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[70vh] items-center justify-center rounded-xl border border-slate-200 bg-white text-sm text-slate-500">
      地図を読み込み中...
    </div>
  ),
});

export default function MapView({ points }: { points: MapPoint[] }) {
  return <MapPanel points={points} />;
}
