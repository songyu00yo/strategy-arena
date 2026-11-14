/** A schematic of how a game runs. It holds no content, so nothing here can pass for a result. */
const THREADS = [
  { d: "M140,92 C166,92 154,58 180,58", label: "质疑", delay: "0s" },
  { d: "M360,120 C334,120 346,92 320,92", label: "质疑", delay: "1.3s" },
  { d: "M140,210 C166,210 154,222 180,222", label: "查证", delay: "2.6s" },
  { d: "M360,210 C334,210 346,222 320,222", label: "查证", delay: "3.9s" },
];

export function HomeFlow() {
  return (
    <aside className="h-flow" aria-label="一场推演怎么进行">
      <div className="h-diagram" aria-hidden="true">
        {(["A", "B", "C"] as const).map((id) => (
          <div key={id} className={`h-board h-board-${id}`}>
            <b>{id}</b>
            <i />
            <i />
            <i />
            <i />
          </div>
        ))}
        <div className="h-verdict">带条件的建议</div>
        <svg viewBox="0 0 500 280">
          {THREADS.map((t) => (
            <path key={t.d} d={t.d} />
          ))}
        </svg>
        {THREADS.map((t) => (
          <span
            key={t.d}
            className="h-packet"
            style={{ offsetPath: `path("${t.d}")`, animationDelay: t.delay }}
          >
            {t.label}
          </span>
        ))}
      </div>
      <ol>
        <li>
          <b>1 各自提案</b>
          <span>三条路线分别提案，互相看不到。</span>
        </li>
        <li>
          <b>2 互相质疑，查证修正</b>
          <span>盯着具体原话追问，用你的材料和算式核对。</span>
        </li>
        <li>
          <b>3 给出有条件的建议</b>
          <span>说清建议何时成立、还缺什么，以及第一步该做什么。</span>
        </li>
      </ol>
      <small>上图仅展示流程。未知的部分会如实保留，估算也会注明。</small>
    </aside>
  );
}
