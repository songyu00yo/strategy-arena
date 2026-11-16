import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "方案擂台",
  description: "把想法整理成项目分析与制作指引。",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
