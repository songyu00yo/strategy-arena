import { readFile } from "node:fs/promises";
import path from "node:path";
import { notFound } from "next/navigation";
import { RecordedExampleViewer } from "@/components/recorded-example-viewer";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "@/lib/recorded-examples";

export function generateStaticParams() {
  return RECORDED_EXAMPLES.map((example) => ({ slug: example.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const example = RECORDED_EXAMPLES.find((item) => item.slug === slug);
  return {
    title: example ? `${example.title} · 真实推演回看 · 方案擂台` : "未找到示例 · 方案擂台",
    description: "真实生成记录，回看不调用模型。示例问题为预设，方案来自真实模型。",
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
  return <RecordedExampleViewer payload={payload} />;
}
