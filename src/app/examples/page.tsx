import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { RecordedExamples } from "@/components/recorded-examples";
import { ClickFx } from "@/components/console/effects";
import "@/components/console/console.css";

export const metadata = {
  title: "真实推演示例 · 方案擂台",
  description: "回看已保存的真实生成记录，浏览和播放都不调用模型。",
};

export default function ExamplesPage() {
  return (
    <div className="console-shell home recorded-gallery">
      <ClickFx />
      <header className="site-header">
        <Link className="text-button" href="/">
          <ArrowLeft size={15} /> 返回首页
        </Link>
        <span>方案擂台</span>
      </header>
      <main>
        <RecordedExamples />
      </main>
    </div>
  );
}
