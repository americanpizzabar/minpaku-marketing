/**
 * プライシング設定の DB 保存・読込 (sync_state の key "config:pricing" に JSON で保存)。
 *
 * 【担当: data-ops】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { Client } from "@libsql/client";
import type { PricingConfig } from "./types";

export const PRICING_CONFIG_KEY = "config:pricing";

/** 保存値を normalizePricingConfig で既定値とマージして返す (未保存/壊れた JSON は既定値) */
export async function getPricingConfig(db: Client): Promise<PricingConfig> {
  void db;
  throw new Error("not implemented");
}

/** 正規化済みの完全な設定を保存する (INSERT … ON CONFLICT(key) DO UPDATE) */
export async function savePricingConfig(db: Client, cfg: PricingConfig): Promise<void> {
  void db;
  void cfg;
  throw new Error("not implemented");
}
