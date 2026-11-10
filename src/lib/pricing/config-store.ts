/**
 * プライシング設定の DB 保存・読込 (sync_state の key "config:pricing" に JSON で保存)。
 */
import type { Client } from "@libsql/client";
import { normalizePricingConfig } from "./config";
import type { PricingConfig } from "./types";

export const PRICING_CONFIG_KEY = "config:pricing";

/** 保存値を normalizePricingConfig で既定値とマージして返す (未保存/壊れた JSON は既定値) */
export async function getPricingConfig(db: Client): Promise<PricingConfig> {
  const res = await db.execute({
    sql: "SELECT value FROM sync_state WHERE key = ?",
    args: [PRICING_CONFIG_KEY],
  });
  const raw = res.rows[0]?.value;
  let parsed: unknown = null;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  return normalizePricingConfig(parsed);
}

/** 正規化済みの完全な設定を保存する (INSERT … ON CONFLICT(key) DO UPDATE) */
export async function savePricingConfig(db: Client, cfg: PricingConfig): Promise<void> {
  await db.execute({
    sql: `INSERT INTO sync_state (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    args: [PRICING_CONFIG_KEY, JSON.stringify(cfg)],
  });
}
