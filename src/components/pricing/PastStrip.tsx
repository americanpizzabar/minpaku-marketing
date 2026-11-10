"use client";

import type { PastDay } from "@/lib/pricing/types";
import {
  Card,
  OWN_STATUS_LABEL,
  dowClass,
  heatStyle,
  heatTextClass,
  mdw,
  pct,
  signedPt,
  yenK,
} from "./shared";

/** 7. 直近14日の実績 (横スクロールの小さな帯) */
export default function PastStrip({ past }: { past: PastDay[] }) {
  return (
    <Card title="直近14日の実績" right="実績占有率はブロック補正後">
      {past.length === 0 ? (
        <p className="text-xs text-slate-400">直近の実績データがありません</p>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <div className="flex w-max gap-1">
            {past.map((p) => {
              const occ = p.occ;
              const quality = p.units === 0 || occ === null ? "none" : "ok";
              return (
                <div key={p.date} className="w-[72px] shrink-0 overflow-hidden rounded-lg border border-slate-200 text-center">
                  <div className="bg-slate-50 px-1 py-0.5">
                    <p className={`text-[10px] font-semibold ${dowClass(p.night)}`}>{mdw(p.date)}</p>
                    <p className="text-[9px] text-slate-500">
                      {p.night.type === "weekend" ? "週末" : "平日"}
                      {p.night.tag ? `・${p.night.tag}` : ""}
                    </p>
                  </div>
                  <div className="py-1" style={heatStyle({ occ, dataQuality: quality })}>
                    <p className={`text-xs font-bold ${quality === "none" ? "text-slate-300" : heatTextClass(occ)}`}>
                      {quality === "none" ? "—" : pct(Math.round(occ ?? 0))}
                    </p>
                    <p className={`text-[10px] ${quality === "none" ? "text-slate-400" : heatTextClass(occ)}`}>
                      {yenK(p.compAdr)}
                    </p>
                  </div>
                  <div className="space-y-0.5 px-1 py-0.5 text-[9px] leading-tight text-slate-500">
                    <p>
                      自社{" "}
                      <span
                        className={
                          p.own.status === "booked"
                            ? "font-semibold text-emerald-700"
                            : p.own.status === "blocked"
                              ? "text-slate-500"
                              : "text-slate-700"
                        }
                      >
                        {OWN_STATUS_LABEL[p.own.status]}
                      </span>
                    </p>
                    <p>直前7日 {p.pickup7 === null ? "—" : `${signedPt(p.pickup7)}pt`}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
