import { ViewTransition } from "react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { notFound } from "next/navigation";
import { RecordedExampleViewer } from "@/components/recorded-example-viewer";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "@/lib/recorded-examples";

export const dynamicParams = false;

export function generateStaticParams() {
  return RECORDED_EXAMPLES.map((example) => ({ slug: example.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const example = RECORDED_EXAMPLES.find((item) => item.slug === slug);
  return {
    title: example ? `${example.title} · 需求梳理示例 · 方案擂台` : "未找到示例 · 方案擂台",
    description:
      "真实模型运行的模拟案例，回看需求、问题、选项、模拟回答和确认后的交付。回放新增模型用量为 0。",
  };
}

export default async function RecordedExamplePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const example = RECORDED_EXAMPLES.find((item) => item.slug === slug);
  if (!example) notFound();
  const source = await readFile(
    path.join(process.cwd(), "public", "recorded-examples", `${example.slug}.json`),
    "utf8",
  );
  const payload = JSON.parse(source) as RecordedExamplePayload;
  return (
    <ViewTransition
      name="paper-page"
      default="none"
      share="paper-page"
      enter="paper-page-enter"
      exit="paper-page-exit"
    >
      <RecordedExampleViewer payload={payload} />
    </ViewTransition>
  );
}
