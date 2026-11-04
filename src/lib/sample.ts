import type { Challenge } from "./contracts";

/** Synthetic input for the visible sample and live integration checks; never an AI result. */
export const videoChallenge: Challenge = {
  domain: "creation",
  goal: "七天内用已有的十二张照片制作一支九十秒、1080p、有字幕且无水印的视频。比较模板、本地剪辑和 AI 镜头三条路线。",
  constraints: "只有八小时，包含等待、重试、学习和返工。七天内交付。必须 1080p、有字幕且无水印。",
  preferences: "优先保证按时交付，再考虑画面丰富。",
  options: ["模板制作", "本地剪辑", "AI 生成镜头"],
  budget: 300,
  timeHours: 8,
  materials:
    "【TEST MATERIALS · 开发测试材料，非用户实测，非 AI 结果】\n三个合格 AI 镜头分别经历了 2、3、4 次尝试。每次尝试八分钟。\n后期处理估计需要 120 分钟；此数字不是实际测量。\n原始照片 12 张，都有合法使用权。目标是 90 秒成片。\n当前软件的无水印导出权限、1080p 导出条件、模板订阅价格尚未核实。\n样本只有三个，不代表未来成功率；不得把均值当作必然结果。",
};
