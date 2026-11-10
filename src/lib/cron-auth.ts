/**
 * CRON_SECRET による Bearer 認証の判定 (cron ルート・/api/pricing・middleware で共通)。
 * Vercel Cron は環境変数の値をそのまま `Authorization: Bearer <CRON_SECRET>` で送るため生の値と比較し、
 * 手動呼び出し用に前後の空白・引用符を除いた値も受け付ける。
 */
export function cleanSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Authorization ヘッダが CRON_SECRET の Bearer と一致するか (CRON_SECRET 未設定なら false) */
export function hasCronBearer(authorization: string | null): boolean {
  const raw = process.env.CRON_SECRET;
  if (!raw || !authorization) return false;
  const cleaned = cleanSecret(raw);
  return authorization === `Bearer ${raw}` || (cleaned !== undefined && authorization === `Bearer ${cleaned}`);
}

/**
 * cron ルート用: CRON_SECRET が設定されていれば一致を必須にする (未設定なら従来どおり許可。
 * 本番では Vercel の環境変数で CRON_SECRET を設定することを推奨)。
 */
export function isCronAuthorized(authorization: string | null): boolean {
  if (!process.env.CRON_SECRET) return true;
  return hasCronBearer(authorization);
}
