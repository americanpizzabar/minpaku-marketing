import { addDays, isHoliday, toDateStr, todayJst } from "./dates";
import type { DailyMetric, LuminaMetric, Property, PropertyType } from "./types";
import { AREAS } from "./types";

// 決定的な擬似乱数 (mulberry32) — 表示のたびにデータが変わらないようにする
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPE_CONFIG: Record<PropertyType, { basePrice: number; label: string; weight: number }> = {
  villa: { basePrice: 62000, label: "ヴィラ", weight: 0.35 },
  house: { basePrice: 38000, label: "貸切", weight: 0.35 },
  hotel: { basePrice: 28000, label: "ホテル", weight: 0.15 },
  pension: { basePrice: 22000, label: "ペンション", weight: 0.15 },
};

const NAME_PARTS_A = ["富士", "湖畔", "森の", "Mt.Fuji", "レイクビュー", "星空", "薪火", "サウナ付き", "絶景", "隠れ家"];
const NAME_PARTS_B = ["ヴィラ", "ロッジ", "リトリート", "ハウス", "コテージ", "ステイ", "テラス", "ベース", "キャビン", "荘"];

const AREA_COORDS: Record<string, [number, number]> = {
  山中湖村: [35.4167, 138.8667],
  富士吉田市: [35.4874, 138.8077],
  富士河口湖町: [35.4972, 138.755],
  鳴沢村: [35.4763, 138.7047],
  忍野村: [35.46, 138.845],
};

function pickType(r: number): PropertyType {
  let acc = 0;
  for (const [type, cfg] of Object.entries(TYPE_CONFIG)) {
    acc += cfg.weight;
    if (r < acc) return type as PropertyType;
  }
  return "house";
}

export function generateDemoProperties(count = 72): Property[] {
  const rand = mulberry32(20260727);
  const props: Property[] = [];
  for (let i = 0; i < count; i++) {
    const area = AREAS[Math.floor(rand() * AREAS.length)];
    const type = pickType(rand());
    const bedrooms = type === "hotel" ? 1 : 1 + Math.floor(rand() * 5);
    const maxGuests =
      type === "hotel"
        ? 2 + Math.floor(rand() * 3)
        : Math.min(2 + bedrooms * 2 + Math.floor(rand() * 3), 14);
    const [lat, lng] = AREA_COORDS[area];
    const airroiId = String(10000000 + i);
    props.push({
      id: `airroi_${airroiId}`,
      airroiId,
      airbnbId: String(50000000 + i * 7),
      title: `${NAME_PARTS_A[Math.floor(rand() * NAME_PARTS_A.length)]}${NAME_PARTS_B[Math.floor(rand() * NAME_PARTS_B.length)]} ${area.replace(/村|市|町/, "")} #${i + 1}`,
      area,
      latitude: lat + (rand() - 0.5) * 0.04,
      longitude: lng + (rand() - 0.5) * 0.04,
      propertyType: type,
      maxGuests,
      bedrooms,
      bathrooms: 1 + Math.floor(rand() * 2),
      areaSqm: Math.round(25 + maxGuests * 10 + rand() * 40),
      rating: Math.round((4.2 + rand() * 0.75) * 100) / 100,
      reviewsCount: Math.floor(rand() * 280),
      url: `https://www.airbnb.jp/rooms/${50000000 + i * 7}`,
      cleaningFee: Math.round((5000 + rand() * 12000) / 500) * 500,
      superhost: rand() < 0.3,
      instantBook: rand() < 0.5,
      guestFavorite: rand() < 0.2,
      beds: bedrooms + Math.floor(rand() * 3),
      hostName: `ホスト${i + 1}`,
      l90dOccupancy: Math.round((35 + rand() * 50) * 10) / 10,
      l90dAvgRate: Math.round(TYPE_CONFIG[type].basePrice * (0.85 + rand() * 0.3)),
      l90dRevpar: null,
      ttmOccupancy: Math.round((30 + rand() * 50) * 10) / 10,
      ttmAvgRate: Math.round(TYPE_CONFIG[type].basePrice * (0.8 + rand() * 0.3)),
      ttmRevpar: null,
      ttmAvgLos: Math.round((1.2 + rand() * 1.6) * 10) / 10,
    });
  }
  return props;
}

/**
 * 物件ごとに -90日〜+90日の日次価格・空室データを生成する。
 * 季節性 (8月ピーク)・曜日 (金土・祝前の跳ね上がり)・リードタイムに応じた
 * 予約進行 (Pacing) を織り込んだ現実的なダミーデータ。
 */
export function generateDemoMetrics(properties: Property[]): DailyMetric[] {
  const rand = mulberry32(87650321);
  const today = todayJst();
  const metrics: DailyMetric[] = [];

  for (const p of properties) {
    const base = TYPE_CONFIG[p.propertyType].basePrice * (0.6 + (p.maxGuests / 8) * 0.7);
    const quality = 0.75 + ((p.rating ?? 4.5) - 4.2) * 0.6 + rand() * 0.2; // 物件ごとの人気度

    for (let offset = -90; offset < 90; offset++) {
      const date = addDays(today, offset);
      const dateStr = toDateStr(date);
      const dow = date.getUTCDay();
      const month = date.getUTCMonth() + 1;

      // 価格係数
      let mult = 1.0;
      if (dow === 5 || dow === 6) mult *= 1.35; // 金土
      if (isHoliday(dateStr)) mult *= 1.25;
      if (month === 8) mult *= 1.45; // 夏休みピーク
      else if (month === 7 || month === 9 || month === 11) mult *= 1.15; // 花火・紅葉
      mult *= 0.92 + rand() * 0.16;

      const price = Math.round((base * mult) / 100) * 100;

      // 予約確率: 過去は確定実績、未来はリードタイムが近いほど埋まる (Pacing)
      let bookProb =
        0.35 * quality +
        (dow === 5 || dow === 6 ? 0.25 : 0) +
        (isHoliday(dateStr) ? 0.15 : 0) +
        (month === 8 ? 0.2 : 0);
      if (offset >= 0) {
        const leadFactor = Math.max(0.15, 1 - offset / 75);
        bookProb *= leadFactor;
      }
      const isBooked = rand() < Math.min(bookProb, 0.96);

      metrics.push({
        propertyId: p.id,
        targetDate: dateStr,
        priceJpy: price,
        isAvailable: !isBooked,
        minNights: p.propertyType === "villa" ? 2 : 1,
      });
    }
  }
  return metrics;
}

/** Lumina Fuji 自社物件の設定価格・稼働実績 (デモ) */
export function generateDemoLuminaMetrics(): LuminaMetric[] {
  const rand = mulberry32(11223344);
  const today = todayJst();
  const rows: LuminaMetric[] = [];
  for (let offset = -90; offset < 90; offset++) {
    const date = addDays(today, offset);
    const dateStr = toDateStr(date);
    const dow = date.getUTCDay();
    const month = date.getUTCMonth() + 1;

    let price = 78000;
    if (dow === 5 || dow === 6) price *= 1.3;
    if (isHoliday(dateStr)) price *= 1.2;
    if (month === 8) price *= 1.4;
    price = Math.round(price / 1000) * 1000;

    let bookProb = 0.52 + (dow === 5 || dow === 6 ? 0.3 : 0) + (month === 8 ? 0.15 : 0);
    if (offset >= 0) bookProb *= Math.max(0.15, 1 - offset / 70);
    const isBooked = rand() < Math.min(bookProb, 0.95);

    rows.push({
      targetDate: dateStr,
      configuredPrice: price,
      isBooked,
      actualRevenue: isBooked && offset < 0 ? price : 0,
    });
  }
  return rows;
}

export const LUMINA_PROFILE = {
  title: "Lumina Fuji Residence Yamanakako",
  area: "山中湖村",
  maxGuests: 10,
  bedrooms: 4,
};
