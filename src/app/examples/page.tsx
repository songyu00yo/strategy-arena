import { redirect } from "next/navigation";

export const metadata = {
  title: "需求梳理示例 · 方案擂台",
  description: "真实模型运行的模拟案例，逐轮回看问题、选项、回答和最终需求。回放新增模型用量为 0。",
};

export default function ExamplesPage() {
  redirect("/?examples=open");
}
