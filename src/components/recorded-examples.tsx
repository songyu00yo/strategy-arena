"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  BriefcaseBusiness,
  Clapperboard,
  ChevronDown,
  Code2,
  Coffee,
  LoaderCircle,
} from "lucide-react";
import {
  RECORDED_EXAMPLES,
  type RecordedExample,
  type RecordedExamplePayload,
} from "@/lib/recorded-examples";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { Modal } from "./modal";
import { DisclosureMotion } from "./disclosure-motion";
import "./recorded-examples.css";

const ICONS: Record<string, typeof BookOpen> = {
  learning: BookOpen,
  consumption: Coffee,
  career: BriefcaseBusiness,
  creation: Clapperboard,
  "course-site": Code2,
};

function ExamplePreview({ example }: { example: RecordedExample }) {
  const [payload, setPayload] = useState<RecordedExamplePayload | null>(null);
  const [error, setError] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/recorded-examples/${example.slug}.json`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("暂时无法读取这份记录，请稍后再试。");
        return response.json() as Promise<RecordedExamplePayload>;
      })
      .then((value) => {
        if (!controller.signal.aborted) setPayload(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "记录暂时无法打开。");
      });
    return () => controller.abort();
  }, [example.slug]);
  const version = payload?.arena.versions.at(-1);
  return (
    <div className="recorded-preview">
      <p className="recorded-label">真实生成记录 · 回看不调用模型</p>
      <p className="recorded-preview-question">{example.question}</p>
      <p>{example.summary}</p>
      <div className="recorded-preview-result" aria-live="polite">
        {error ? (
          <p role="alert">{error}</p>
        ) : !payload ? (
          <p role="status">
            <LoaderCircle className="spin" size={15} /> 正在打开已保存的记录…
          </p>
        ) : version?.verdict ? (
          <>
            <small>当时的结论 · V{version.number}</small>
            <h3>{version.verdict.headline}</h3>
            <p>{version.verdict.rationale}</p>
          </>
        ) : (
          <p>这份记录保留了当时的步骤，可进入回看。</p>
        )}
      </div>
      <div className="recorded-preview-note">
        <button
          type="button"
          className="text-button recorded-source-toggle"
          aria-expanded={sourceOpen}
          aria-controls={`recorded-source-${example.slug}`}
          onClick={() => setSourceOpen((open) => !open)}
        >
          来源与适用范围 <ChevronDown size={14} />
        </button>
        <DisclosureMotion open={sourceOpen} id={`recorded-source-${example.slug}`}>
          <p>示例问题为预设，方案来自真实模型。</p>
          <p>
            {example.modelId} ·{" "}
            {new Date(example.generatedAt).toLocaleDateString("zh-CN", {
              timeZone: "Asia/Shanghai",
            })}
          </p>
          <p>
            来源提交：<code>{example.sourceCommit}</code>
          </p>
          <p>{example.qualityNote}</p>
        </DisclosureMotion>
      </div>
      <Link className="primary-button recorded-preview-link" href={`/examples/${example.slug}`}>
        回看完整推演 <ArrowRight size={16} />
      </Link>
    </div>
  );
}

export function RecordedExamples() {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = section.current;
    if (!element || !("IntersectionObserver" in window)) return;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;
    let animations: Animation[] = [];
    element.classList.add("is-waiting");
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        element.classList.remove("is-waiting");
        if (preference.matches) return;
        animations = [...element.querySelectorAll(".recorded-example-card")].map((card, index) => {
          const animation = card.animate(
            [
              { opacity: 0, transform: "translateY(18px)" },
              { opacity: 1, transform: "translateY(0)" },
            ],
            {
              duration: 700,
              delay: index * 65,
              easing: "cubic-bezier(.16,1,.3,1)",
              fill: "backwards",
            },
          );
          animation.onfinish = () => animation.cancel();
          return animation;
        });
      },
      { threshold: 0.12 },
    );
    observer.observe(element);
    const reduce = () => {
      if (!preference.matches) return;
      observer.disconnect();
      element.classList.remove("is-waiting");
      animations.forEach((animation) => animation.cancel());
    };
    preference.addEventListener("change", reduce);
    return () => {
      observer.disconnect();
      preference.removeEventListener("change", reduce);
      element.classList.remove("is-waiting");
      animations.forEach((animation) => animation.cancel());
    };
  }, []);
  const [opened, setOpened] = useState<{
    example: RecordedExample;
    trigger: HTMLButtonElement;
  } | null>(null);
  return (
    <section ref={section} className="recorded-examples" aria-labelledby="recorded-examples-title">
      <header className="recorded-examples-heading">
        <div>
          <span className="recorded-label">先看一场</span>
          <h2 id="recorded-examples-title">这些问题，已经推演过了。</h2>
        </div>
        <p>
          真实生成记录 · 回看不调用模型
          <br />
          <span>示例问题为预设，方案来自真实模型。</span>
        </p>
      </header>
      <div className="recorded-examples-grid">
        {RECORDED_EXAMPLES.map((example) => {
          const Icon = ICONS[example.slug] ?? BookOpen;
          return (
            <button
              key={example.slug}
              type="button"
              className="recorded-example-card"
              onClick={(event) => setOpened({ example, trigger: event.currentTarget })}
              aria-label={`预览${example.direction}示例：${example.title}`}
            >
              <div className="recorded-card-top">
                <span>{example.direction}</span>
                <Icon size={18} aria-hidden="true" />
              </div>
              <h3>{example.title}</h3>
              <p>{example.summary}</p>
              <div className="recorded-card-bottom">
                <span>
                  {MODEL_CATALOG.find((model) => model.id === example.modelId)?.label ??
                    example.modelId}
                </span>
                <span>
                  看一眼 <ArrowUpRight size={14} />
                </span>
              </div>
            </button>
          );
        })}
      </div>
      {opened && (
        <Modal
          title={opened.example.title}
          trigger={opened.trigger}
          onClose={() => setOpened(null)}
        >
          <ExamplePreview key={opened.example.slug} example={opened.example} />
        </Modal>
      )}
    </section>
  );
}
