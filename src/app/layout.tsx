import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "方案擂台 · 让好策略经得起挑战",
  description: "独立策略、关键质疑、证据核验。带着你的条件，找到值得行动的路线。",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
