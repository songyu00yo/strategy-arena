import type { Metadata } from "next";
import { PAPER_NAVIGATION_SCRIPT } from "@/lib/paper-navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: "方案擂台 · 让好策略经得起挑战",
  description: "比较三条路线，查看质疑和证据，再决定下一步怎么做。",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" style={{ viewTransitionName: "none" }}>
      <head>
        <script
          id="paper-navigation"
          dangerouslySetInnerHTML={{ __html: PAPER_NAVIGATION_SCRIPT }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
