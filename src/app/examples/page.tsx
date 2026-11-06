import { redirect } from "next/navigation";

export const metadata = {
  title: "真实推演示例 · 方案擂台",
  description: "回看已保存的真实生成记录，浏览和播放都不调用模型。",
};

export default function ExamplesPage() {
  redirect("/?examples=open");
}
