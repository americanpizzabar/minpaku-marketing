/**
 * API・画面に返すエラー文の扱い。
 * 自前で投げる日本語のエラー (iCal の取得失敗など) は利用者に見せ、DB・ライブラリの英語の内部エラー
 * (SQL 文やホスト名を含みうる) はサーバーログにだけ残して一般的な文に置き換える。
 */
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;

export function isUserFacingMessage(message: string): boolean {
  return JAPANESE.test(message);
}

/** 利用者に見せてよいエラー文。内部エラーなら fallback (例: "内部エラー（詳細はサーバーログ）") */
export function publicErrorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return isUserFacingMessage(message) ? message : fallback;
}
