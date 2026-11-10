import { NextRequest, NextResponse } from "next/server";
import { hasCronBearer } from "@/lib/cron-auth";

/**
 * BASIC_AUTH_USER / BASIC_AUTH_PASSWORD を両方設定した場合のみ
 * ダッシュボード全体にBasic認証をかける (Cronルートは除外)。
 */
export function middleware(request: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!user || !password) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/cron")) return NextResponse.next();

  const auth = request.headers.get("authorization");
  // /api/pricing のリモート操作用: CRON_SECRET と一致する Bearer のみ通す (Basic 認証の代わり。ルート側でも検証する)
  if (request.nextUrl.pathname === "/api/pricing" && hasCronBearer(auth)) return NextResponse.next();

  if (auth?.startsWith("Basic ")) {
    const [u, p] = atob(auth.slice(6)).split(":");
    if (u === user && p === password) return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Lumina Fuji Dashboard"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
