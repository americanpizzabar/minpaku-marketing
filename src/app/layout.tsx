import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lumina Fuji | 競合分析・価格戦略ダッシュボード",
  description:
    "山中湖・富士吉田・河口湖エリアの民泊・ヴィラの価格・稼働データを分析し、Lumina Fuji Residence Yamanakako のダイナミックプライシングを支援するダッシュボード",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased">{children}</body>
    </html>
  );
}
