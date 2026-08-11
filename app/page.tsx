"use client";

import { useMemo, useState } from "react";

type NavKey = "overview" | "shows" | "autoedit" | "creative" | "distribution" | "experiments";

const navItems: { key: NavKey; label: string; icon: string; badge?: string }[] = [
  { key: "overview", label: "增长总览", icon: "⌂" },
  { key: "shows", label: "剧集管理", icon: "▣", badge: "8" },
  { key: "autoedit", label: "自动剪辑", icon: "▶", badge: "12" },
  { key: "creative", label: "素材工厂", icon: "✦", badge: "24" },
  { key: "distribution", label: "发布中心", icon: "↗", badge: "6" },
  { key: "experiments", label: "广告实验", icon: "◎" },
];

const campaigns = [
  { title: "身份揭露 · 先果后因", market: "美国 · 女性 25–34", spend: "$8,240", roas: "1.62", change: "+18.4%", status: "扩量中", tone: "good" },
  { title: "背叛复仇 · 激烈对白", market: "美国 · 女性 35–44", spend: "$3,180", roas: "1.21", change: "+4.1%", status: "观察", tone: "watch" },
  { title: "婚礼逃跑 · 倒叙钩子", market: "加拿大 · 女性 25–44", spend: "$2,420", roas: "0.86", change: "−12.2%", status: "待处理", tone: "risk" },
];

const shows = [
  { title: "Goodbye, My Billionaire Husband", meta: "都市情感 · 82 集", stage: "投放中", market: "美国 / 加拿大", assets: 48, roas: "1.32", color: "rose" },
  { title: "The Alpha's Forbidden Bride", meta: "狼人奇幻 · 76 集", stage: "素材测试", market: "美国 / 德国", assets: 32, roas: "1.18", color: "violet" },
  { title: "Revenge Wears Red", meta: "女性复仇 · 68 集", stage: "本地化", market: "巴西 / 墨西哥", assets: 16, roas: "—", color: "amber" },
  { title: "Contracted to the CEO", meta: "契约爱情 · 91 集", stage: "内容解析", market: "英语市场", assets: 0, roas: "—", color: "blue" },
];

const queue = [
  { name: "身份揭露_V12", format: "30s · 9:16", language: "英语", score: 92, status: "可发布" },
  { name: "婚礼冲突_V08", format: "25s · 9:16", language: "英语", score: 87, status: "待审核" },
  { name: "复仇回归_V03", format: "30s · 9:16", language: "葡萄牙语", score: 84, status: "生成中" },
  { name: "危险关系_V16", format: "15s · 9:16", language: "德语", score: 79, status: "待优化" },
];

function Sparkline({ points, color = "#5f55e7" }: { points: number[]; color?: string }) {
  const path = useMemo(() => {
    const max = Math.max(...points); const min = Math.min(...points);
    return points.map((v, i) => `${i ? "L" : "M"}${(i / (points.length - 1)) * 220},${56 - ((v - min) / (max - min || 1)) * 48}`).join(" ");
  }, [points]);
  return <svg className="spark" viewBox="0 0 220 64" preserveAspectRatio="none" aria-hidden="true"><path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function Header({ title, subtitle, action, onAction }: { title: string; subtitle: string; action: string; onAction?: () => void }) {
  return <header className="page-header"><div><div className="eyebrow">LUMINA GROWTH OS</div><h1>{title}</h1><p>{subtitle}</p></div><div className="header-actions"><button className="icon-button" aria-label="搜索">⌕</button><button className="icon-button notification" aria-label="通知">♢<i /></button><button className="primary" onClick={onAction}><span>＋</span>{action}</button></div></header>;
}

function Overview({ notify }: { notify: (s: string) => void }) {
  return <>
    <Header title="增长总览" subtitle="Goodbye, My Billionaire Husband · 上线第 6 天" action="创建增长任务" onAction={() => notify("已创建新的增长任务草稿")} />
    <section className="metrics-grid">
      <article className="metric-card"><div className="metric-top"><span>总消耗</span><b className="positive">↑ 12.8%</b></div><strong>$48,260</strong><small>较前 7 天</small><Sparkline points={[12,18,15,25,29,28,39,35,42,48]} /></article>
      <article className="metric-card"><div className="metric-top"><span>新增付费</span><b className="positive">↑ 16.2%</b></div><strong>$57,912</strong><small>1,284 位付费用户</small><Sparkline points={[8,12,18,16,26,31,28,40,44,52]} color="#21a67a" /></article>
      <article className="metric-card"><div className="metric-top"><span>综合 ROAS</span><b className="positive">↑ 0.09</b></div><strong>1.20</strong><small>目标 1.15</small><div className="goal-line"><i style={{width:"78%"}} /></div></article>
      <article className="metric-card"><div className="metric-top"><span>素材胜率</span><b>12 / 48</b></div><strong>25.0%</strong><small>高于品类基准 6.4%</small><Sparkline points={[22,20,24,21,25,28,24,27,29,32]} color="#dd8b36" /></article>
    </section>

    <section className="main-grid">
      <article className="panel performance"><div className="panel-head"><div><h2>增长表现</h2><p>过去 7 天投放回报与预算趋势</p></div><select aria-label="时间范围"><option>过去 7 天</option><option>过去 30 天</option></select></div><div className="chart-wrap"><div className="chart-axis"><span>2.0</span><span>1.5</span><span>1.0</span><span>0.5</span><span>0</span></div><div className="chart"><div className="target"><span>目标 1.15</span></div><div className="bars">{[44,53,49,62,68,72,81].map((n,i)=><i key={i} style={{height:`${n}%`}}><em>{["周一","周二","周三","周四","周五","周六","今天"][i]}</em></i>)}</div><svg viewBox="0 0 700 210" preserveAspectRatio="none"><path d="M0 168 C80 140, 110 151, 180 126 S290 109,350 91 S470 99,525 62 S635 69,700 30" fill="none" stroke="#5f55e7" strokeWidth="4" strokeLinecap="round" /></svg></div></div><div className="legend"><span><i className="legend-line" />ROAS</span><span><i className="legend-bar" />预算消耗</span><b>今日 ROAS <strong>1.42</strong></b></div></article>

      <article className="panel ai-panel"><div className="panel-head"><div><h2><span className="ai-mark">✦</span> 今日 AI 建议</h2><p>基于实时数据生成 · 3 条待处理</p></div><button className="text-button">全部查看</button></div>
        <div className="recommendation"><div className="rec-icon up">↗</div><div><b>扩大高表现素材预算</b><p>“身份揭露”在美国 25–34 岁女性中 ROAS 达 1.64，建议日预算提升至 $2,000。</p><small>预计新增收入 +$1,280 / 日</small><div><button onClick={() => notify("扩量方案已批准，将于下一投放周期生效")}>批准执行</button><button className="ghost">查看详情</button></div></div></div>
        <div className="recommendation"><div className="rec-icon down">↘</div><div><b>暂停 4 个衰减广告组</b><p>“婚礼逃跑”素材连续两日 CTR 下降 32%，继续投放可能损失约 $420。</p><div><button onClick={() => notify("已暂停 4 个衰减广告组")}>批准暂停</button><button className="ghost">稍后处理</button></div></div></div>
        <div className="recommendation"><div className="rec-icon idea">✦</div><div><b>测试巴西葡语市场</b><p>自然流量互动率高于均值 2.1 倍，建议生成 8 个葡语版本。</p><div><button onClick={() => notify("葡语素材生成任务已加入队列")}>生成素材</button><button className="ghost">忽略</button></div></div></div>
      </article>
    </section>

    <section className="panel campaigns"><div className="panel-head"><div><h2>最佳素材组合</h2><p>按内容 × 受众 × 市场综合表现排序</p></div><button className="outlined">查看素材洞察 →</button></div><div className="table"><div className="tr th"><span>素材方向</span><span>目标市场</span><span>消耗</span><span>ROAS</span><span>趋势</span><span>状态</span></div>{campaigns.map((c,i)=><div className="tr" key={c.title}><span><i className={`thumb t${i+1}`}>{i===0?"01":"0"+(i+1)}</i><b>{c.title}</b></span><span>{c.market}</span><span>{c.spend}</span><span><strong>{c.roas}</strong></span><span className={c.change.startsWith("+")?"positive":"negative"}>{c.change}</span><span><em className={`status ${c.tone}`}>{c.status}</em></span></div>)}</div></section>
  </>;
}

function Shows({ notify }: { notify: (s: string) => void }) {
  return <><Header title="剧集管理" subtitle="管理内容资产、发行状态与增长表现" action="导入新剧" onAction={()=>notify("上传窗口已准备好，可导入正片与剧本")} /><div className="filter-row"><div className="search">⌕ <input aria-label="搜索剧集" placeholder="搜索剧集名称、题材或市场…" /></div><button className="filter active">全部剧集 <b>8</b></button><button className="filter">投放中 <b>3</b></button><button className="filter">准备中 <b>4</b></button></div><section className="show-grid">{shows.map((s,i)=><article className="show-card" key={s.title}><div className={`poster ${s.color}`}><span>0{i+1}</span><em>{s.meta.split(" · ")[0]}</em></div><div className="show-body"><div className="show-title"><div><h2>{s.title}</h2><p>{s.meta}</p></div><button aria-label="更多">•••</button></div><div className="show-stage"><span>{s.stage}</span><i /></div><dl><div><dt>目标市场</dt><dd>{s.market}</dd></div><div><dt>素材资产</dt><dd>{s.assets} 条</dd></div><div><dt>综合 ROAS</dt><dd className={s.roas!=="—"?"positive":""}>{s.roas}</dd></div></dl><button className="card-action" onClick={()=>notify(`已打开《${s.title}》增长工作台`)}>进入增长工作台 <span>→</span></button></div></article>)}</section></>;
}

function AutoEdit({ notify }: { notify: (s: string) => void }) {
  const [mode, setMode] = useState<"paid" | "social">("paid");
  const [started, setStarted] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [freeEpisodes, setFreeEpisodes] = useState(10);
  const tasks = [
    { name: "Goodbye, My Billionaire Husband", episodes: "82 集 · 3h 26m", progress: 100, step: "已完成", output: "24 条素材", state: "done" },
    { name: "The Alpha's Forbidden Bride", episodes: "76 集 · 3h 08m", progress: 74, step: "识别高能情节", output: "分析中", state: "active" },
    { name: "Revenge Wears Red", episodes: "68 集 · 2h 42m", progress: 31, step: "语音与人物识别", output: "分析中", state: "active" },
    { name: "Contracted to the CEO", episodes: "91 集 · 3h 51m", progress: 0, step: "等待处理", output: "—", state: "wait" },
  ];
  return <>
    <Header title="自动剪辑" subtitle="批量读取完整剧集，自动理解剧情并生成买量与社媒混剪" action="新建批量任务" onAction={()=>notify("新的批量剪辑任务已创建")} />
    <section className="workflow-strip">
      {[['01','导入本地剧集','整剧或分集批量导入'],['02','AI 读取分析','人物、剧情与高能点'],['03','自动混剪','买量与社媒双版本'],['04','审核导出','批量审片与交付']].map((s,i)=><div className={i===0?"active":""} key={s[0]}><i>{s[0]}</i><span><b>{s[1]}</b><small>{s[2]}</small></span>{i<3&&<em>→</em>}</div>)}
    </section>
    <section className="engine-status"><div><i>SV2</i><span><b>ElevenLabs Scribe v2</b><small>批量对白理解引擎</small></span></div><span><b>词级时间码</b><small>精确到每个对白词</small></span><span><b>多人分离</b><small>最多识别 32 位说话人</small></span><span><b>智能缓存</b><small>源文件不变则不重复计费</small></span><em>等待 API Key</em></section>
    <section className="auto-grid">
      <article className="panel import-panel">
        <div className="panel-head"><div><h2>1. 导入剧集</h2><p>支持 MP4、MOV、MKV；可一次选择多部剧或整季分集</p></div><span className="secure">只读取，不修改源文件</span></div>
        <label className="dropzone">
          <input type="file" multiple accept="video/*" onChange={e=>{setFileCount(e.target.files?.length||0);notify(`已选择 ${e.target.files?.length||0} 个视频文件`)}} />
          <i>⇧</i><b>{fileCount ? `已选择 ${fileCount} 个视频文件` : "拖入剧集文件，或点击从电脑选择"}</b>
          <p>{fileCount ? "文件仅保留在本次任务中，点击下方按钮开始读取" : "建议按「剧名 / 集数」整理文件名，AI 会自动归组"}</p>
          <span>{fileCount ? "重新选择" : "选择本地文件"}</span>
        </label>
        <div className="scope-banner"><i>✓</i><div><b>仅分析免费章节</b><p>Scribe 转写、画面理解和自动剪辑均止于免费章节，付费内容不会上传模型。</p></div><label>每部剧前 <input type="number" min="1" max="50" value={freeEpisodes} onChange={e=>setFreeEpisodes(Math.max(1,Number(e.target.value)||1))} /> 集</label></div>
        <div className="import-options"><label><span>自动识别语言</span><select><option>自动检测</option><option>英语</option><option>中文</option><option>葡萄牙语</option></select></label><label><span>剧集归组规则</span><select><option>按文件夹与文件名</option><option>仅按文件夹</option></select></label></div>
      </article>
      <article className="panel strategy-panel">
        <div className="panel-head"><div><h2>2. 选择剪辑目标</h2><p>同一部剧可并行生成两套增长素材</p></div></div>
        <div className="mode-tabs"><button className={mode==='paid'?"active":""} onClick={()=>setMode('paid')}><i>↗</i><span><b>买量广告</b><small>强钩子 · 高转化 · 付费卡点</small></span></button><button className={mode==='social'?"active":""} onClick={()=>setMode('social')}><i>♢</i><span><b>社媒混剪</b><small>可追更 · 强互动 · 连续叙事</small></span></button></div>
        <div className="strategy-form"><label><span>输出时长</span><div className="choice"><button>15s</button><button className="active">30s</button><button>60s</button></div></label><label><span>每部剧生成</span><select><option>24 个版本</option><option>12 个版本</option><option>48 个版本</option></select></label><label><span>画面比例</span><select><option>9:16 竖屏</option><option>1:1 方形</option><option>16:9 横屏</option></select></label><label><span>默认语言</span><select><option>英语字幕 + 英语配音</option><option>仅英语字幕</option></select></label></div>
        <div className="auto-features"><span>✓ 人物连续性</span><span>✓ 自动字幕</span><span>✓ 敏感内容检查</span><span>✓ 平台安全区</span></div>
        <button className="start-button" onClick={()=>{setStarted(true);notify(`AI 已开始分析每部剧前 ${freeEpisodes} 个免费章节`)}}><span>✦</span>{started?"任务运行中…":"开始分析并自动剪辑"}<small>仅前 {freeEpisodes} 集 · 预计生成 {(fileCount||36)*24} 条素材</small></button>
      </article>
    </section>
    <section className="panel task-panel">
      <div className="panel-head"><div><h2>批量任务进度</h2><p>全局队列 · 36 部剧 · 预计剩余 2 小时 18 分</p></div><div className="task-actions"><button>暂停队列</button><button>任务设置</button></div></div>
      <div className="task-table"><div className="task-row task-head"><span>剧集</span><span>AI 处理阶段</span><span>进度</span><span>产出</span><span>操作</span></div>{tasks.map((t,i)=><div className="task-row" key={t.name}><span className="task-name"><i className={`mini-cover c${i}`}>0{i+1}</i><span><b>{t.name}</b><small>{t.episodes}</small></span></span><span><em className={`task-dot ${t.state}`} />{t.step}</span><span className="task-progress"><i><em style={{width:`${t.progress}%`}} /></i><b>{t.progress}%</b></span><span><b>{t.output}</b></span><span><button onClick={()=>notify(t.state==='done'?`已打开 ${t.output} 审核页`:`已打开《${t.name}》处理详情`)}>{t.state==='done'?"审核素材":"查看详情"} →</button></span></div>)}</div>
    </section>
    <section className="output-preview"><div><span className="eyebrow">AI OUTPUT BLUEPRINT</span><h2>一部剧，自动产出完整素材矩阵</h2><p>系统不会随机拼接片段，而是围绕剧情假设生成可追踪、可复用的剪辑版本。</p></div><div className="output-cards">{[['买量钩子','8 个','冲突前置 · 3 秒抓人'],['剧情混剪','6 个','连续叙事 · 付费卡点'],['角色向','4 个','主角关系 · 人设强化'],['本地化变体','6 个','字幕 · 配音 · CTA']].map((o,i)=><article key={o[0]}><i>0{i+1}</i><b>{o[0]}</b><strong>{o[1]}</strong><small>{o[2]}</small></article>)}</div></section>
  </>;
}

function Creative({ notify }: { notify: (s: string) => void }) {
  return <><Header title="素材工厂" subtitle="从剧情洞察到多语言增长素材，一站式批量生产" action="创建素材任务" onAction={()=>notify("新的素材任务已创建")} /><section className="creative-hero"><div><span className="ai-mark big">✦</span><div><div className="eyebrow">AI CREATIVE COPILOT</div><h2>今天想测试什么增长假设？</h2><p>描述目标市场、受众或剧情方向，AI 将生成完整素材矩阵。</p></div></div><div className="prompt"><textarea defaultValue="为《Goodbye, My Billionaire Husband》生成一组面向美国 25–34 岁女性的身份反转素材，突出女主被羞辱后的身份揭露。" aria-label="素材任务描述" /><button onClick={()=>notify("AI 已开始分析任务，将生成 12 个素材版本")}>开始生成 <span>→</span></button></div><div className="chips"><span>推荐：</span><button>高能片段变体</button><button>多语言本地化</button><button>衰减素材翻新</button></div></section><section className="panel"><div className="panel-head"><div><h2>生产队列</h2><p>24 个素材正在处理 · 今日已完成 38 个</p></div><div className="segmented"><button className="active">全部</button><button>待审核</button><button>已完成</button></div></div><div className="asset-grid">{queue.map((q,i)=><article className="asset" key={q.name}><div className={`asset-preview p${i+1}`}><span>00:{["30","25","30","15"][i]}</span><button aria-label="预览">▶</button></div><div className="asset-body"><div><b>{q.name}</b><span className={`asset-status s${i}`}>{q.status}</span></div><p>{q.format} · {q.language}</p><div className="score"><span>AI 预测分</span><i><em style={{width:`${q.score}%`}} /></i><b>{q.score}</b></div></div></article>)}</div></section></>;
}

function Distribution({ notify }: { notify: (s: string) => void }) {
  const channels=[{n:"TikTok",a:"@lumina_drama",s:"已连接",c:"12 条待发布"},{n:"Instagram",a:"@luminashorts",s:"已连接",c:"8 条待发布"},{n:"YouTube",a:"Lumina Drama",s:"已连接",c:"5 条待发布"},{n:"Meta Ads",a:"Lumina Growth US",s:"已连接",c:"6 个广告组"}];
  return <><Header title="发布中心" subtitle="统一管理社媒内容与广告素材的跨平台发布" action="安排发布" onAction={()=>notify("已打开跨平台发布排期")} /><section className="publish-layout"><article className="panel calendar"><div className="panel-head"><div><h2>发布日历</h2><p>2026 年 8 月 9–15 日</p></div><div className="week-controls"><button>‹</button><button>本周</button><button>›</button></div></div><div className="calendar-grid">{["周一 10","周二 11","周三 12","周四 13","周五 14","周六 15","周日 16"].map((d,i)=><div className={i===2?"today":""} key={d}><b>{d}</b>{Array.from({length:[2,3,4,2,3,1,1][i]}).map((_,j)=><span className={["tk","ig","yt"][j%3]} key={j}>{["TikTok","Instagram","YouTube"][j%3]} · {10+j*3}:00</span>)}</div>)}</div></article><aside className="panel channels"><div className="panel-head"><div><h2>渠道状态</h2><p>4 个渠道运行正常</p></div></div>{channels.map(c=><div className="channel" key={c.n}><i>{c.n.slice(0,2)}</i><div><b>{c.n}</b><p>{c.a}</p></div><span><em>● {c.s}</em>{c.c}</span></div>)}<button className="card-action">管理渠道连接 <span>→</span></button></aside></section></>;
}

function Experiments({ notify }: { notify: (s: string) => void }) {
  const experiments=[{n:"US｜身份揭露｜女性 25–34",goal:"D1 ROAS ≥ 1.15",budget:"$12,000",spent:"$8,240",result:"1.62",state:"扩量中"},{n:"CA｜婚礼逃跑｜女性 25–44",goal:"D1 ROAS ≥ 1.10",budget:"$5,000",spent:"$2,420",result:"0.86",state:"待决策"},{n:"DE｜狼人禁恋｜女性 18–24",goal:"付费率 ≥ 3.2%",budget:"$3,500",spent:"$1,180",result:"3.8%",state:"测试中"}];
  return <><Header title="广告实验" subtitle="用小预算快速验证素材、市场与受众组合" action="新建实验" onAction={()=>notify("新的广告实验草稿已创建")} /><section className="experiment-summary"><div><span>活跃实验</span><strong>12</strong><small>3 个接近决策点</small></div><div><span>本周测试预算</span><strong>$24,500</strong><small>已消耗 68%</small></div><div><span>胜出组合</span><strong>4</strong><small>平均 ROAS 1.48</small></div><div><span>预计节省</span><strong>$6,820</strong><small>来自自动止损</small></div></section><section className="panel experiment-list"><div className="panel-head"><div><h2>实验矩阵</h2><p>按决策优先级排序</p></div><button className="outlined">实验规则</button></div>{experiments.map((e,i)=><article key={e.n}><div className="exp-index">0{i+1}</div><div className="exp-name"><b>{e.n}</b><p>成功条件：{e.goal}</p></div><div><span>预算进度</span><b>{e.spent} / {e.budget}</b><i><em style={{width:[68,48,34][i]+"%"}} /></i></div><div><span>当前结果</span><strong>{e.result}</strong></div><em className={`status ${i===0?"good":i===1?"risk":"watch"}`}>{e.state}</em><button className="more" onClick={()=>notify(`已打开实验：${e.n}`)}>→</button></article>)}</section></>;
}

export default function Home() {
  const [active, setActive] = useState<NavKey>("overview");
  const [toast, setToast] = useState("");
  const notify=(message:string)=>{setToast(message); window.setTimeout(()=>setToast(""),2600)};
  const pages={overview:<Overview notify={notify}/>,shows:<Shows notify={notify}/>,autoedit:<AutoEdit notify={notify}/>,creative:<Creative notify={notify}/>,distribution:<Distribution notify={notify}/>,experiments:<Experiments notify={notify}/>};
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div>LU</div><span><b>Lumina</b><small>Growth OS</small></span></div><nav aria-label="主导航"><p>增长工作台</p>{navItems.map(n=><button key={n.key} className={active===n.key?"active":""} onClick={()=>setActive(n.key)}><i>{n.icon}</i><span>{n.label}</span>{n.badge&&<em>{n.badge}</em>}</button>)}</nav><div className="sidebar-bottom"><button><i>◇</i><span>素材洞察</span></button><button><i>⚙</i><span>账号与权限</span></button><div className="usage"><div><span>本月 AI 用量</span><b>68%</b></div><i><em /></i><p>6,820 / 10,000 credits</p></div><div className="profile"><div>JC</div><span><b>Julia Chen</b><small>Growth Lead</small></span><button>⌄</button></div></div></aside><main>{pages[active]}</main>{toast&&<div className="toast"><i>✓</i>{toast}</div>}</div>;
}
