/**
 * CRON_SECRET による認証の判定 (cron ルート・/api/pricing・/api/sync 等・middleware で共通)。
 * Vercel Cron は環境変数の値をそのまま `Authorization: Bearer <CRON_SECRET>` で送るため生の値と比較し、
 * 手動呼び出し・同期のチェーン継続用に、前後の空白・引用符を除いた値も受け付ける。
 * 除去後に空になる値 (`""` `' '` など) は「未設定」と同じ扱いで、秘密として一致させない。
 */
export function cleanSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** value が CRON_SECRET (生の値 / 整形後の値) と一致するか。CRON_SECRET が未設定・空なら常に false */
export function matchesCronSecret(value: string | null | undefined): boolean {
  const raw = process.env.CRON_SECRET;
  const cleaned = cleanSecret(raw);
  if (!raw || !cleaned || !value) return false;
  return value === raw || value === cleaned;
}

/** Authorization ヘッダが CRON_SECRET の Bearer と一致するか (CRON_SECRET 未設定・空なら false) */
export function hasCronBearer(authorization: string | null): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  return matchesCronSecret(authorization.slice("Bearer ".length));
}

/**
 * cron ルート用: CRON_SECRET が設定されていれば一致を必須にする (未設定・空なら従来どおり許可。
 * 本番では Vercel の環境変数で CRON_SECRET を設定することを推奨)。
 */
export function isCronAuthorized(authorization: string | null): boolean {
  if (!cleanSecret(process.env.CRON_SECRET)) return true;
  return hasCronBearer(authorization);
}
