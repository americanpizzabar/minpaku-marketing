/**
 * サーバー側エントリポイント: 画面・API から呼ぶ。
 */
import { computePricingDashboard } from "./compute";
import { loadPricingInputs } from "./load";
import type { PricingDashboard } from "./types";

/** loadPricingInputs() → computePricingDashboard() */
export async function getPricingDashboard(): Promise<PricingDashboard> {
  return computePricingDashboard(await loadPricingInputs());
}
