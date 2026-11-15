import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanningReportContent } from "../src/components/planning-report-content";

describe("planning report presentation", () => {
  it("prints headings, lists and source status without dropping adjacent content", () => {
    const html = renderToStaticMarkup(
      createElement(PlanningReportContent, {
        content:
          "# 项目规划\n**已确认**的目标\n## 实施计划\n- 第一项\n- 第二项\n\n1. 核对材料\n2. 开始执行\n\n工时未知\n预算未知",
      }),
    );
    expect(html).toContain("<h2>项目规划</h2>");
    expect(html).toContain("<h3>实施计划</h3>");
    expect(html).toContain("<strong>已确认</strong>的目标");
    expect(html).toContain("<ul><li>第一项</li><li>第二项</li></ul>");
    expect(html).toContain(
      '<ol start="1"><li value="1">核对材料</li><li value="2">开始执行</li></ol>',
    );
    expect(html).toContain("工时未知\n预算未知");
  });

  it("keeps user and model HTML as text", () => {
    const html = renderToStaticMarkup(
      createElement(PlanningReportContent, {
        content: '# 材料\n<script>alert("source")</script>\n- **<img src=x onerror=alert(1)>**',
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });
  it("preserves source step numbers and unmatched emphasis marks", () => {
    const html = renderToStaticMarkup(
      createElement(PlanningReportContent, {
        content: "7. 已有第七步\n9. 跳转至第九步\n\n****",
      }),
    );
    expect(html).toContain('<ol start="7">');
    expect(html).toContain('<li value="9">跳转至第九步</li>');
    expect(html).toContain("<p>****</p>");
  });
});
