"use client";

import { useEffect, useState } from "react";

interface Props {
  propertyId: string;
  title: string;
  onClose: () => void;
}

type Json = Record<string, unknown>;

/** ネストされたグループ (listing_info等) を1階層フラット化 */
function flatten(obj: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      Object.assign(out, v as Json);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const yen = (v: unknown) =>
  v == null || !Number.isFinite(Number(v)) ? "—" : `¥${Math.round(Number(v)).toLocaleString("ja-JP")}`;
const pct = (v: unknown) => {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return `${(n <= 1 ? n * 100 : n).toFixed(1)}%`;
};
const numOrDash = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? "—" : String(v));
const boolLabel = (v: unknown) => (v == null ? "—" : v ? "はい" : "いいえ");

const RATING_LABELS: [string, string][] = [
  ["rating_overall", "総合"],
  ["rating_cleanliness", "清潔さ"],
  ["rating_accuracy", "正確さ"],
  ["rating_checkin", "チェックイン"],
  ["rating_communication", "コミュニケーション"],
  ["rating_location", "立地"],
  ["rating_value", "コスパ"],
];

// 既に専用セクションで表示しているキー (「その他」一覧から除外)
const SHOWN_KEYS = new Set([
  "listing_id", "listing_name", "description", "listing_type", "room_type",
  "cover_photo_url", "photo_urls", "photos_count", "guests", "bedrooms", "beds", "baths",
  "amenities", "host_id", "host_name", "superhost", "professional_management",
  "cohost_ids", "cohost_names", "guest_favorite", "instant_book", "min_nights",
  "cancellation_policy", "checkin_time", "checkout_time", "currency", "cleaning_fee",
  "extra_guest_fee", "single_fee_structure", "num_reviews", "registration", "registration_details",
  "latitude", "longitude", "country_code", "country", "region", "locality", "district", "exact_location",
  ...RATING_LABELS.map(([k]) => k),
  ...["ttm", "l90d"].flatMap((p) =>
    ["revenue", "avg_rate", "occupancy", "adjusted_occupancy", "revpar", "adjusted_revpar",
     "total_days", "available_days", "blocked_days", "days_reserved", "avg_min_nights",
     "avg_length_of_stay"].map((s) => `${p}_${s}`),
  ),
]);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-bold text-slate-500">{title}</h4>
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-100 py-1 text-xs">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-800">{value}</span>
    </div>
  );
}

export default function PropertyDetailModal({ propertyId, title, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flat, setFlat] = useState<Json | null>(null);
  const [columns, setColumns] = useState<Json | null>(null);

  useEffect(() => {
    fetch(`/api/property/${encodeURIComponent(propertyId)}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) {
          setError(json.error);
          return;
        }
        setColumns(json.property ?? null);
        setFlat(json.details ? flatten(json.details as Json) : null);
      })
      .catch(() => setError("詳細の取得に失敗しました"))
      .finally(() => setLoading(false));
  }, [propertyId]);

  const amenities = Array.isArray(flat?.amenities) ? (flat!.amenities as unknown[]).map(String) : [];
  const cover = (flat?.cover_photo_url ?? columns?.cover_photo_url) as string | undefined;
  const otherEntries = flat
    ? Object.entries(flat).filter(
        ([k, v]) =>
          !SHOWN_KEYS.has(k) &&
          (typeof v === "string" || typeof v === "number" || typeof v === "boolean") &&
          String(v).length <= 120,
      )
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-slate-200 bg-white p-4">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900">{title}</h3>
            {flat?.host_name != null && (
              <p className="text-xs text-slate-500">
                ホスト: {String(flat.host_name)}
                {flat.superhost ? " ⭐スーパーホスト" : ""}
                {flat.professional_management ? " / プロ運営" : ""}
                {flat.guest_favorite ? " / ゲスト人気" : ""}
              </p>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4">
          {loading && <p className="text-sm text-slate-500">読み込み中...</p>}
          {error && <p className="text-sm text-amber-600">{error}</p>}

          {cover && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cover} alt={title} className="max-h-56 w-full rounded-lg object-cover" />
          )}

          {flat && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Section title="基本情報">
                  <KV label="施設タイプ" value={String(flat.listing_type ?? "—")} />
                  <KV label="定員" value={`${numOrDash(flat.guests)}名`} />
                  <KV label="寝室 / ベッド / バス" value={`${numOrDash(flat.bedrooms)} / ${numOrDash(flat.beds)} / ${numOrDash(flat.baths)}`} />
                  <KV label="民泊届出" value={String(flat.registration ?? "—")} />
                  <KV label="写真数" value={numOrDash(flat.photos_count)} />
                </Section>

                <Section title="料金設定">
                  <KV label="清掃料" value={yen(flat.cleaning_fee)} />
                  <KV label="追加ゲスト料金" value={yen(flat.extra_guest_fee)} />
                  <KV label="通貨" value={String(flat.currency ?? "—")} />
                </Section>

                <Section title="予約設定">
                  <KV label="即時予約" value={boolLabel(flat.instant_book)} />
                  <KV label="最低泊数" value={`${numOrDash(flat.min_nights)}泊`} />
                  <KV label="キャンセルポリシー" value={String(flat.cancellation_policy ?? "—")} />
                  <KV label="チェックイン/アウト" value={`${flat.checkin_time ?? "—"} / ${flat.checkout_time ?? "—"}`} />
                </Section>

                <Section title="評価の内訳">
                  {RATING_LABELS.map(([key, label]) => (
                    <KV key={key} label={label} value={flat[key] != null ? `★${Number(flat[key]).toFixed(2)}` : "—"} />
                  ))}
                  <KV label="レビュー数" value={numOrDash(flat.num_reviews)} />
                </Section>
              </div>

              <Section title="過去実績 (AirROI集計)">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500">
                        <th className="py-1 pr-3 font-semibold">期間</th>
                        <th className="py-1 pr-3 text-right font-semibold">稼働率</th>
                        <th className="py-1 pr-3 text-right font-semibold">平均単価</th>
                        <th className="py-1 pr-3 text-right font-semibold">RevPAR</th>
                        <th className="py-1 pr-3 text-right font-semibold">売上</th>
                        <th className="py-1 text-right font-semibold">平均泊数</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-800">
                      {(["l90d", "ttm"] as const).map((p) => (
                        <tr key={p} className="border-t border-slate-100">
                          <td className="py-1 pr-3 font-medium">{p === "l90d" ? "過去90日" : "過去12ヶ月"}</td>
                          <td className="py-1 pr-3 text-right">{pct(flat[`${p}_occupancy`])}</td>
                          <td className="py-1 pr-3 text-right">{yen(flat[`${p}_avg_rate`])}</td>
                          <td className="py-1 pr-3 text-right">{yen(flat[`${p}_revpar`])}</td>
                          <td className="py-1 pr-3 text-right">{yen(flat[`${p}_revenue`])}</td>
                          <td className="py-1 text-right">{numOrDash(flat[`${p}_avg_length_of_stay`])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              {amenities.length > 0 && (
                <Section title={`アメニティ (${amenities.length})`}>
                  <div className="flex flex-wrap gap-1">
                    {amenities.map((a) => (
                      <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                        {a}
                      </span>
                    ))}
                  </div>
                </Section>
              )}

              {typeof flat.description === "string" && flat.description && (
                <Section title="物件説明">
                  <p className="text-xs leading-relaxed whitespace-pre-wrap text-slate-600">
                    {flat.description.slice(0, 1200)}
                    {flat.description.length > 1200 ? "…" : ""}
                  </p>
                </Section>
              )}

              {otherEntries.length > 0 && (
                <Section title="その他の取得フィールド">
                  {otherEntries.map(([k, v]) => (
                    <KV key={k} label={k} value={String(v)} />
                  ))}
                </Section>
              )}
            </>
          )}

          {!loading && !error && !flat && (
            <p className="text-sm text-slate-500">
              詳細データは未取得です。「物件情報を今すぐ更新」(データ取得設定) を実行すると取得されます。
            </p>
          )}

          {columns?.url != null && (
            <a
              href={String(columns.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-indigo-600 px-3 py-2 text-center text-sm font-semibold text-white transition hover:bg-indigo-700"
            >
              Airbnbで開く ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
