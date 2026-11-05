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

const EXAMPLE_NOTE = "【示例材料 · 虚构情境，仅用于演示，非真实数据】";

/** Synthetic questions offered on the home page. They only fill the form; every result still comes from a real run. */
export const samples: { id: string; label: string; challenge: Challenge }[] = [
  { id: "video", label: "试填一个视频任务", challenge: videoChallenge },
  {
    id: "study",
    label: "考研还是就业",
    challenge: {
      domain: "learning",
      goal: "大三下学期，要在全力考研、直接就业、先工作两年再读研三条路里选一条。希望判断哪条更适合现在的我，以及第一步该做什么。",
      constraints: "家里能支持一年生活费，不能再多。九月前必须定方向。不考虑出国。",
      preferences: "更看重五年后的选择空间，其次才是起薪。",
      options: ["全力考研", "直接就业", "先工作两年再读研"],
      budget: 20000,
      timeHours: 1500,
      materials: `${EXAMPLE_NOTE}\n专业排名前 30%，有一段三个月的实习经历。\n目标院校去年复试线和报录比尚未核实。\n秋招开放时间与备考冲刺期重叠。`,
    },
  },
  {
    id: "city",
    label: "要不要换城市",
    challenge: {
      domain: "life",
      goal: "收到外地一份薪资高 30% 的工作邀约，但伴侣和父母都在现在的城市。要在接受、拒绝、争取远程三种做法中决定，并想清楚各自的代价。",
      constraints: "两周内必须答复。不能影响父母的日常照护。",
      preferences: "优先家庭稳定，其次才是收入增长。",
      options: ["接受并搬家", "拒绝邀约", "争取远程或混合办公"],
      budget: 50000,
      timeHours: 40,
      materials: `${EXAMPLE_NOTE}\n新城市房租约为现在的 1.4 倍，生活成本未详细核算。\n对方尚未书面确认能否远程。\n现公司今年的调薪幅度未知。`,
    },
  },
  {
    id: "ops",
    label: "工单系统选型",
    challenge: {
      domain: "work",
      goal: "五人小团队要在六周内上线内部工单系统。比较自研、采购 SaaS、改造开源项目三条路线，给出可执行的决定和第一周要做的事。",
      constraints: "六周内上线。只有两名开发，还要兼顾现有业务。客户数据不能出境。",
      preferences: "优先降低长期维护成本，其次才是功能完整。",
      options: ["自研", "采购 SaaS", "改造开源项目"],
      budget: 80000,
      timeHours: 480,
      materials: `${EXAMPLE_NOTE}\n目前每周约 300 张工单，高峰期翻倍。\n候选 SaaS 的数据存储地点和年费报价尚未核实。\n开源项目最近一次发布时间未确认。`,
    },
  },
  {
    id: "channel",
    label: "内容账号起步",
    challenge: {
      domain: "creation",
      goal: "想下班后做一个讲个人理财入门的内容账号，三个月内验证有没有人看。比较图文、短视频、播客三种形式，决定先做哪一种。",
      constraints: "每周最多八小时。不露脸。不推荐具体理财产品。",
      preferences: "优先能长期坚持，其次才是增长速度。",
      options: ["图文", "短视频", "播客"],
      budget: 1000,
      timeHours: 96,
      materials: `${EXAMPLE_NOTE}\n有写作习惯，没有剪辑经验。\n各平台对理财内容的审核规则尚未核实。\n三个月后才能看出是否有持续读者。`,
    },
  },
];
