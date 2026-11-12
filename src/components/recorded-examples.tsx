"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, BookOpen, BriefcaseBusiness, Code2 } from "lucide-react";
import { RECORDED_EXAMPLES } from "@/lib/recorded-examples";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { examplePickerRequested } from "@/lib/example-navigation";
import { Modal } from "./modal";
import "./recorded-examples.css";

const ICONS: Record<string, typeof BookOpen> = {
  "personal-website": Code2,
  presentation: BriefcaseBusiness,
  "user-guide": BookOpen,
};

function ExampleGallery() {
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
              { opacity: 0, transform: "translateY(24px) scale(.97)" },
              { opacity: 1, transform: "translateY(0) scale(1)" },
            ],
            {
              duration: 760,
              delay: 120 + index * 85,
              easing: "cubic-bezier(0.19, 1, 0.22, 1)",
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
  return (
    <section ref={section} className="recorded-examples in-dialog" aria-label="选择需求梳理示例">
      <header className="recorded-examples-heading">
        <div>
          <p>从模糊目标开始，看提问、模拟回答、查漏和需求交接。</p>
        </div>
        <p>真实模型运行的模拟案例 · 回看新增调用为 0</p>
      </header>
      <div className="recorded-examples-grid">
        {RECORDED_EXAMPLES.map((example) => {
          const Icon = ICONS[example.slug] ?? BookOpen;
          return (
            <Link
              key={example.slug}
              href={`/examples/${example.slug}`}
              className="recorded-example-card"
              aria-label={`回看${example.direction}需求梳理示例：${example.title}`}
            >
              <div className="recorded-card-top">
                <span>{example.direction}</span>
                <Icon size={18} aria-hidden="true" />
              </div>
              <h3>{example.title}</h3>
              <p>{example.question}</p>
              <div className="recorded-card-bottom">
                <span>
                  {MODEL_CATALOG.find((model) => model.id === example.modelId)?.label ??
                    example.modelId}
                </span>
                <span>
                  从头看 <ArrowUpRight size={14} />
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function RecordedExamples() {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!examplePickerRequested()) return;
    const frame = requestAnimationFrame(() => setTrigger(button.current));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="text-button h-examples-link"
        aria-haspopup="dialog"
        aria-expanded={!!trigger}
        onClick={(event) => setTrigger(event.currentTarget)}
      >
        先看需求梳理示例 <ArrowRight size={14} />
      </button>
      {trigger && (
        <Modal title="先看需求梳理示例" trigger={trigger} onClose={() => setTrigger(null)} wide>
          <ExampleGallery />
        </Modal>
      )}
    </>
  );
}
