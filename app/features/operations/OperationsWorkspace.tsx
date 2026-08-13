"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { OperationsSection, PipelineTask, SourceRecord } from "./types";
import styles from "./operations.module.css";

const initialSources: SourceRecord[] = [
  {
    id: "SRC-001",
    name: "Meta Ads Library · 北美",
    kind: "广告情报",
    platform: "Meta",
    markets: "美国 / 加拿大",
    frequency: "每 2 小时",
    status: "运行中",
    lastSync: "2 分钟前",
    volume: 1284,
  },
  {
    id: "SRC-002",
    name: "TikTok Creative Center",
    kind: "广告情报",
    platform: "TikTok",
    markets: "英国 / 德国 / 巴西",
    frequency: "每 4 小时",
    status: "运行中",
    lastSync: "38 分钟前",
    volume: 836,
  },
  {
    id: "SRC-003",
    name: "内部投放日报",
    kind: "内部投放",
    platform: "CSV / API",
    markets: "全部市场",
    frequency: "每日 09:00",
    status: "待配置",
    lastSync: "尚未同步",
    volume: 0,
  },
  {
    id: "SRC-004",
    name: "Lumina 正片资产库",
    kind: "正片资产",
    platform: "对象存储",
    markets: "自有版权",
    frequency: "实时",
    status: "运行中",
    lastSync: "6 分钟前",
    volume: 2842,
  },
];

export const initialTasks: PipelineTask[] = [];

const members = [
  {
    name: "Julia Chen",
    email: "julia@lumina.ai",
    role: "管理员",
    scope: "全部工作区",
    status: "在线",
    initials: "JC",
  },
  {
    name: "Mia Wang",
    email: "mia@lumina.ai",
    role: "内容运营",
    scope: "灵感大屏 / 剧库",
    status: "12 分钟前",
    initials: "MW",
  },
  {
    name: "Leo Zhang",
    email: "leo@lumina.ai",
    role: "编导",
    scope: "内容工厂 / 我的创作",
    status: "1 小时前",
    initials: "LZ",
  },
  {
    name: "Eric Lin",
    email: "eric@lumina.ai",
    role: "投放",
    scope: "只读 / 数据导出",
    status: "昨天",
    initials: "EL",
  },
];

export type OperationsWorkspaceProps = {
  section: OperationsSection;
  onNotify?: (message: string) => void;
  tasks?: PipelineTask[];
  onTasksChange?: Dispatch<SetStateAction<PipelineTask[]>>;
};

type OperationDetail = {
  kind: "source" | "task" | "member" | "audit";
  title: string;
  subtitle: string;
};

export function OperationsWorkspace({
  section,
  onNotify,
  tasks: sharedTasks,
  onTasksChange,
}: OperationsWorkspaceProps) {
  const [sources, setSources] = useState(initialSources);
  const [localTasks, setLocalTasks] = useState(initialTasks);
  const tasks = sharedTasks ?? localTasks;
  const setTasks = onTasksChange ?? setLocalTasks;
  const [sourceModal, setSourceModal] = useState(false);
  const [taskModal, setTaskModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState<PipelineTask | undefined>(tasks[0]);
  const [taskFilter, setTaskFilter] = useState("全部任务");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const notify = (message: string) => onNotify?.(message);
  useEffect(() => {
    if (!tasks.length) { setSelectedTask(undefined); return; }
    setSelectedTask((current) => tasks.find((task) => task.id === current?.id) ?? tasks[0]);
  }, [tasks]);

  if (section === "sources")
    return (
      <section className={styles.workspace} aria-label="数据源管理">
        <PageHeader
          eyebrow="DATA CONNECTIONS"
          title="数据源管理"
          description="管理外部素材、内部投放与自有正片资产的采集范围、频率和字段可用性。"
          action="＋ 添加数据源"
          onAction={() => setSourceModal(true)}
        />
        <div className={styles.metricGrid}>
          <Metric label="运行中数据源" value="3" hint="1 个待配置" />
          <Metric
            label="今日新增实例"
            value="1,284"
            hint="保留 163 个重复实例"
          />
          <Metric label="最近同步成功率" value="98.7%" hint="过去 24 小时" />
          <Metric label="存储使用" value="4.82 TB" hint="热存 30 天" />
        </div>
        <div className={styles.toolbar}>
          <label className={styles.search}>
            ⌕
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索数据源"
            />
          </label>
          <select>
            <option>全部类型</option>
            <option>广告情报</option>
            <option>内部投放</option>
            <option>正片资产</option>
          </select>
          <button onClick={() => notify("已刷新全部数据源状态")}>
            刷新状态 ↻
          </button>
        </div>
        <div className={styles.sourceGrid}>
          {sources
            .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
            .map((source) => (
              <article className={styles.card} key={source.id}>
                <header>
                  <span className={styles.sourceIcon}>
                    {source.platform.slice(0, 1)}
                  </span>
                  <div>
                    <small>
                      {source.id} · {source.kind}
                    </small>
                    <h2>{source.name}</h2>
                  </div>
                  <em className={styles[statusClass(source.status)]}>
                    {source.status}
                  </em>
                </header>
                <dl>
                  <div>
                    <dt>平台 / 接入方式</dt>
                    <dd>{source.platform}</dd>
                  </div>
                  <div>
                    <dt>市场范围</dt>
                    <dd>{source.markets}</dd>
                  </div>
                  <div>
                    <dt>同步频率</dt>
                    <dd>{source.frequency}</dd>
                  </div>
                  <div>
                    <dt>最近同步</dt>
                    <dd>{source.lastSync}</dd>
                  </div>
                </dl>
                <div className={styles.volume}>
                  <span>
                    本周期入库 <b>{source.volume.toLocaleString()}</b>
                  </span>
                  <i>
                    <em
                      style={{ width: `${Math.min(100, source.volume / 13)}%` }}
                    />
                  </i>
                </div>
                <footer>
                  <button
                    onClick={() =>
                      setDetail({
                        kind: "source",
                        title: source.name,
                        subtitle: `${source.id} · ${source.platform}`,
                      })
                    }
                  >
                    配置
                  </button>
                  <button
                    onClick={() => {
                      setSources((current) =>
                        current.map((item) =>
                          item.id === source.id
                            ? {
                                ...item,
                                status:
                                  item.status === "运行中"
                                    ? "已暂停"
                                    : "运行中",
                              }
                            : item,
                        ),
                      );
                      notify(
                        source.status === "运行中"
                          ? "数据源已暂停"
                          : "数据源已启动",
                      );
                    }}
                  >
                    {source.status === "运行中" ? "暂停" : "启动"}
                  </button>
                  <button
                    className={styles.primary}
                    onClick={() => notify("同步任务已进入队列")}
                  >
                    立即同步
                  </button>
                </footer>
              </article>
            ))}
        </div>
        <section className={styles.panel}>
          <PanelTitle
            title="字段与接口可用性"
            subtitle="只展示真实可获得字段；缺失指标不会以模拟数据占位"
          />
          <div className={styles.fieldTable}>
            <div>
              <b>数据源</b>
              <b>曝光</b>
              <b>消耗</b>
              <b>CTR</b>
              <b>ROI</b>
              <b>完整视频</b>
              <b>授权状态</b>
            </div>
            {[
              ["Meta Ads Library", "可用", "—", "—", "—", "可抓取", "研究用途"],
              [
                "内部投放日报",
                "可用",
                "可用",
                "可用",
                "可用",
                "已关联",
                "内部授权",
              ],
              ["正片资产库", "—", "—", "—", "—", "原片", "自有版权"],
            ].map((row) => (
              <div key={row[0]}>
                {row.map((cell, i) => (
                  <span key={i} className={cell === "—" ? styles.muted : ""}>
                    {cell}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </section>
        {sourceModal && (
          <Modal title="添加数据源" onClose={() => setSourceModal(false)}>
            <div className={styles.formGrid}>
              <label>
                数据源类型
                <select>
                  <option>广告情报平台</option>
                  <option>内部投放数据</option>
                  <option>正片资产</option>
                </select>
              </label>
              <label>
                平台
                <select>
                  <option>Meta Ads Library</option>
                  <option>TikTok Creative Center</option>
                  <option>YouTube</option>
                  <option>CSV 定期导入</option>
                </select>
              </label>
              <label>
                数据源名称
                <input defaultValue="新建市场监测源" />
              </label>
              <label>
                国家 / 市场
                <input defaultValue="美国, 英国" />
              </label>
              <label>
                抓取频率
                <select>
                  <option>每 2 小时</option>
                  <option>每 4 小时</option>
                  <option>每天</option>
                  <option>手动</option>
                </select>
              </label>
              <label>
                历史范围
                <select>
                  <option>最近 30 天</option>
                  <option>最近 90 天</option>
                  <option>仅新增</option>
                </select>
              </label>
              <label className={styles.full}>
                关键词 / 榜单范围
                <textarea defaultValue="short drama, billionaire, revenge" />
              </label>
            </div>
            <div className={styles.notice}>
              连接凭据将在后端接入阶段加密保存；当前仅保存前端配置草案。
            </div>
            <ModalActions
              onCancel={() => setSourceModal(false)}
              onConfirm={() => {
                setSources((current) => [
                  {
                    id: `SRC-00${current.length + 1}`,
                    name: "新建市场监测源",
                    kind: "广告情报",
                    platform: "Meta",
                    markets: "美国 / 英国",
                    frequency: "每 2 小时",
                    status: "待配置",
                    lastSync: "尚未同步",
                    volume: 0,
                  },
                  ...current,
                ]);
                setSourceModal(false);
                notify("数据源配置草案已保存");
              }}
              confirm="保存并测试连接"
            />
          </Modal>
        )}
        {detail?.kind === "source" && (
          <OperationDetailPanel
            detail={detail}
            onClose={() => setDetail(null)}
          />
        )}
      </section>
    );

  if (section === "tasks") {
    const processingCount = tasks.filter((task) => task.status === "处理中").length;
    const queuedCount = tasks.filter((task) => task.status === "排队中").length;
    const reviewCount = tasks.filter((task) => task.status === "需处理").length;
    const visible = tasks.filter(
      (task) =>
        (taskFilter === "全部任务" || task.status === taskFilter) &&
        `${task.title}${task.id}`.toLowerCase().includes(query.toLowerCase()),
    );
    return (
      <section className={`${styles.workspace} ${styles.taskWorkspace}`} aria-label="任务中心">
        <PageHeader
          eyebrow="处理流水线"
          title="任务中心"
          description="统一查看抓取、分析、剧集解析和视频生成任务的状态、成本与异常。"
          action="上传片源后自动创建"
          onAction={() => notify("解析任务由剧库上传成功后自动创建，避免产生无片源空任务")}
        />
        <div className={styles.metricGrid}>
          <Metric label="处理中" value={String(processingCount)} hint={`并发 ${processingCount} / 12`} />
          <Metric label="排队中" value={String(queuedCount)} hint="预计 18 分钟" />
          <Metric label="需要人工处理" value={String(reviewCount)} hint="复核 SLA 4 小时" />
          <Metric label="今日模型成本" value="$68.42" hint="预算使用 54%" />
        </div>
        <div className={styles.toolbar}>
          <label className={styles.search}>
            ⌕
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索任务 ID 或名称"
            />
          </label>
          {["全部任务", "处理中", "排队中", "需处理", "失败", "已完成"].map(
            (x) => (
              <button
                className={taskFilter === x ? styles.selected : ""}
                onClick={() => setTaskFilter(x)}
                key={x}
              >
                {x}
              </button>
            ),
          )}
        </div>
        <div className={styles.taskLayout}>
          <div className={styles.taskList}>
            {visible.map((task) => (
              <button
                className={selectedTask?.id === task.id ? styles.activeTask : ""}
                key={task.id}
                onClick={() => setSelectedTask(task)}
              >
                <i className={styles.taskIcon}>◫</i>
                <span>
                  <small>
                    任务 #{String(tasks.findIndex((item) => item.id === task.id) + 1).padStart(3, "0")} · {task.category}
                  </small>
                  <b>{task.title}</b>
                  <em>
                    {task.owner} · {task.createdAt}
                  </em>
                </span>
                <span className={styles.taskProgress}>
                  <b>{task.progress}%</b>
                  <i>
                    <em style={{ width: `${task.progress}%` }} />
                  </i>
                  <small className={styles[statusClass(task.status)]}>
                    {task.status}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {selectedTask ? <aside className={styles.taskDetail}>
            <small>{selectedTask.id} · EXECUTION TRACE</small>
            <h2>{selectedTask.title}</h2>
            <p>任务状态、处理证据和异常均会保留；失败节点可从当前阶段重试。</p>
            <div className={styles.pipeline}>
              {[
                "已抓取",
                "转码",
                "文本提取",
                "来源匹配",
                "基础分析",
                "深度分析",
              ].map((stage, i) => (
                <div
                  className={
                    i < Math.ceil(selectedTask.progress / 18)
                      ? styles.finished
                      : i === Math.ceil(selectedTask.progress / 18)
                        ? styles.running
                        : ""
                  }
                  key={stage}
                >
                  <i>
                    {i < Math.ceil(selectedTask.progress / 18) ? "✓" : i + 1}
                  </i>
                  <span>
                    <b>{stage}</b>
                    <small>
                      {i < Math.ceil(selectedTask.progress / 18)
                        ? "已完成"
                        : i === Math.ceil(selectedTask.progress / 18)
                          ? "处理中"
                          : "等待前序任务"}
                    </small>
                  </span>
                </div>
              ))}
            </div>
            <dl className={styles.taskFacts}>
              <div>
                <dt>负责人</dt>
                <dd>{selectedTask.owner}</dd>
              </div>
              <div>
                <dt>资源 / 成本</dt>
                <dd>{selectedTask.cost}</dd>
              </div>
              <div>
                <dt>优先级</dt>
                <dd>P1 · 标准</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd>分析结果 + 证据帧</dd>
              </div>
            </dl>
            <footer>
              <button
                onClick={() =>
                  setDetail({
                    kind: "task",
                    title: `${selectedTask.id} · 任务日志`,
                    subtitle: selectedTask.title,
                  })
                }
              >
                查看日志
              </button>
              <button
                disabled={Boolean(selectedTask.backendId)}
                title={selectedTask.backendId ? "真实任务重试由服务端 Worker 鉴权接口执行" : undefined}
                onClick={() => {
                  setTasks((current) =>
                    current.map((t) =>
                      t.id === selectedTask.id
                        ? { ...t, status: "排队中", progress: 0 }
                        : t,
                    ),
                  );
                  notify("任务已重新进入队列");
                }}
              >
                从失败点重试
              </button>
              <button
                className={styles.danger}
                disabled={Boolean(selectedTask.backendId)}
                title={selectedTask.backendId ? "当前服务端未开放暂停接口" : undefined}
                onClick={() => {
                  setTasks((current) =>
                    current.map((t) =>
                      t.id === selectedTask.id ? { ...t, status: "需处理" } : t,
                    ),
                  );
                  notify("任务已暂停");
                }}
              >
                暂停任务
              </button>
            </footer>
          </aside> : <aside className={styles.taskDetail}><h2>暂无真实任务</h2><p>上传片源并创建解析任务后，这里会显示 PocketBase 队列的实时状态。</p></aside>}
        </div>
        {taskModal && (
          <Modal title="新建处理任务" onClose={() => setTaskModal(false)}>
            <div className={styles.formGrid}>
              <label>
                任务类型
                <select id="new-task-category">
                  <option>基础分析</option>
                  <option>深度分析</option>
                  <option>素材抓取</option>
                  <option>剧集解析</option>
                  <option>视频生成</option>
                </select>
              </label>
              <label>
                优先级
                <select>
                  <option>P1 · 标准</option>
                  <option>P0 · 紧急</option>
                  <option>P2 · 低优先</option>
                </select>
              </label>
              <label className={styles.full}>
                任务名称
                <input id="new-task-title" defaultValue="新建素材分析任务" />
              </label>
              <label>
                输入范围
                <select>
                  <option>已选素材</option>
                  <option>今日新增素材</option>
                  <option>指定剧集</option>
                </select>
              </label>
              <label>
                分析深度
                <select>
                  <option>基础分析</option>
                  <option>完整钩子深度分析</option>
                </select>
              </label>
            </div>
            <div className={styles.notice}>
              解析任务只会在剧库片源上传成功后由 PocketBase 自动创建；这里不再生成前端模拟任务。
            </div>
            <ModalActions
              onCancel={() => setTaskModal(false)}
              onConfirm={() => {
                setTaskModal(false);
                notify("请前往剧库上传真实片源，系统会自动创建解析任务");
              }}
              confirm="前往剧库上传"
            />
          </Modal>
        )}
        {detail?.kind === "task" && (
          <OperationDetailPanel
            detail={detail}
            onClose={() => setDetail(null)}
          />
        )}
      </section>
    );
  }

  return (
    <section className={styles.workspace} aria-label="团队与权限">
      <PageHeader
        eyebrow="工作区治理"
        title="团队与权限"
        description="管理成员、角色、复核责任和高风险操作权限，所有关键修改保留审计记录。"
        action="＋ 邀请成员"
        onAction={() => setInviteModal(true)}
      />
      <div className={styles.metricGrid}>
        <Metric label="团队成员" value="12" hint="8 人本周活跃" />
        <Metric label="待处理邀请" value="2" hint="7 天后过期" />
        <Metric label="复核 SLA" value="3.2h" hint="目标 ≤ 4h" />
        <Metric label="高风险覆盖" value="2" hint="本月质检人工覆盖" />
      </div>
      <section className={styles.panel}>
        <PanelTitle
          title="成员与角色"
          subtitle="成员仅能访问角色授权的工作区和操作"
        />
        <div className={styles.memberTable}>
          <div>
            <b>成员</b>
            <b>角色</b>
            <b>访问范围</b>
            <b>最近活跃</b>
            <b>操作</b>
          </div>
          {members.map((member) => (
            <div key={member.email}>
              <span className={styles.person}>
                <i>{member.initials}</i>
                <span>
                  <b>{member.name}</b>
                  <small>{member.email}</small>
                </span>
              </span>
              <span>
                <select
                  defaultValue={member.role}
                  onChange={() => notify("角色权限已更新")}
                >
                  <option>管理员</option>
                  <option>内容运营</option>
                  <option>编导</option>
                  <option>投放</option>
                  <option>只读</option>
                </select>
              </span>
              <span>{member.scope}</span>
              <span>{member.status}</span>
              <span>
                <button
                  onClick={() =>
                    setDetail({
                      kind: "member",
                      title: `管理 · ${member.name}`,
                      subtitle: `${member.email} · ${member.role}`,
                    })
                  }
                >
                  管理
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>
      <div className={styles.twoPanels}>
        <section className={styles.panel}>
          <PanelTitle title="角色权限矩阵" subtitle="高风险动作需单独授权" />
          <div className={styles.permissionGrid}>
            {[
              "查看市场素材",
              "人工修正 T1 / T2",
              "管理钩子原型",
              "生成与导出视频",
              "覆盖禁止批量生成",
              "管理团队权限",
            ].map((permission, i) => (
              <div key={permission}>
                <b>{permission}</b>
                {["管理员", "运营", "编导", "投放"].map((role, j) => (
                  <span
                    key={role}
                    className={
                      j === 0 ||
                      (i < 3 && j === 1) ||
                      (i === 3 && j === 2) ||
                      (i === 3 && j === 3)
                        ? styles.allowed
                        : ""
                    }
                  >
                    {j === 0 ||
                    (i < 3 && j === 1) ||
                    (i === 3 && j === 2) ||
                    (i === 3 && j === 3)
                      ? "✓"
                      : "—"}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </section>
        <section className={styles.panel}>
          <PanelTitle
            title="复核规则与审计"
            subtitle="异常分类、责任人和处理时限"
          />
          <div className={styles.rules}>
            {[
              ["T1 / T2 边界冲突", "内容运营组", "4 小时"],
              ["人物关系低置信度", "剧情分析组", "8 小时"],
              ["货不对板覆盖申请", "管理员", "2 小时"],
            ].map((row) => (
              <div key={row[0]}>
                <span>
                  <b>{row[0]}</b>
                  <small>{row[1]}</small>
                </span>
                <em>{row[2]}</em>
              </div>
            ))}
          </div>
          <button
            className={styles.auditButton}
            onClick={() =>
              setDetail({
                kind: "audit",
                title: "全部审计日志",
                subtitle: "最近 30 天 · 关键操作完整留痕",
              })
            }
          >
            查看全部审计日志 →
          </button>
        </section>
      </div>
      {inviteModal && (
        <Modal title="邀请团队成员" onClose={() => setInviteModal(false)}>
          <div className={styles.formGrid}>
            <label className={styles.full}>
              邮箱地址
              <textarea placeholder="每行一个邮箱地址" />
            </label>
            <label>
              初始角色
              <select>
                <option>内容运营</option>
                <option>编导</option>
                <option>投放</option>
                <option>只读</option>
              </select>
            </label>
            <label>
              加入复核队列
              <select>
                <option>暂不加入</option>
                <option>T1 / T2 复核</option>
                <option>人物关系复核</option>
              </select>
            </label>
          </div>
          <ModalActions
            onCancel={() => setInviteModal(false)}
            onConfirm={() => {
              setInviteModal(false);
              notify("邀请已发送");
            }}
            confirm="发送邀请"
          />
        </Modal>
      )}
      {(detail?.kind === "member" || detail?.kind === "audit") && (
        <OperationDetailPanel detail={detail} onClose={() => setDetail(null)} />
      )}
    </section>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
  onAction,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <header className={styles.pageHeader}>
      <div>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <button className={styles.primary} onClick={onAction}>
        {action}
      </button>
    </header>
  );
}
function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <article className={styles.metric}>
      <span>{label}</span>
      <b>{value}</b>
      <small>{hint}</small>
    </article>
  );
}
function PanelTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className={styles.panelTitle}>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </header>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={styles.modalBackdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className={styles.modal}>
        <header>
          <div>
            <small>工作区设置</small>
            <h2>{title}</h2>
          </div>
          <button aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function ModalActions({
  onCancel,
  onConfirm,
  confirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirm: string;
}) {
  return (
    <footer className={styles.modalActions}>
      <button onClick={onCancel}>取消</button>
      <button className={styles.primary} onClick={onConfirm}>
        {confirm}
      </button>
    </footer>
  );
}
function OperationDetailPanel({
  detail,
  onClose,
}: {
  detail: OperationDetail;
  onClose: () => void;
}) {
  const copy = {
    source: {
      eyebrow: "DATA SOURCE CONFIG",
      rows: [
        ["接入状态", "接口连通 · 186ms"],
        ["字段映射", "12 / 12 项可用"],
        ["授权有效期", "2026-12-31"],
      ],
    },
    task: {
      eyebrow: "EXECUTION LOG",
      rows: [
        ["10:24:02 · INFO", "任务创建，输入清单校验通过"],
        ["10:26:41 · INFO", "转码完成 · H.264 · 1080×1920"],
        ["10:31:16 · INFO", "ASR / OCR 提取完成 · 286 条文本"],
        ["10:36:52 · RUNNING", "正在执行钩子结构与人物关系分析"],
      ],
    },
    member: {
      eyebrow: "MEMBER ACCESS",
      rows: [
        ["灵感大屏与素材分析", "允许查看与编辑"],
        ["剧库与剧集详情", "允许查看与编辑"],
        ["内容工厂与视频导出", "允许生成与导出"],
        ["高风险权限", "禁止覆盖质检结论"],
      ],
    },
    audit: {
      eyebrow: "AUDIT TRAIL",
      rows: [
        ["今天 10:32 · Julia", "覆盖质检结论 · AD-240812-018"],
        ["今天 09:18 · Mia", "修正 T1 / T2 · 00:08.2 → 00:06.8"],
        ["昨天 18:46 · Leo", "导出视频 · 身份反转 V12"],
        ["昨天 16:03 · Julia", "修改 Eric Lin 角色为只读"],
      ],
    },
  }[detail.kind];
  return (
    <div
      className={styles.drawerBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className={styles.detailDrawer}
        role="dialog"
        aria-modal="true"
        aria-label={detail.title}
      >
        <header>
          <div>
            <small>{copy.eyebrow}</small>
            <h2>{detail.title}</h2>
            <p>{detail.subtitle}</p>
          </div>
          <button aria-label="关闭详情" onClick={onClose}>
            ×
          </button>
        </header>
        {detail.kind === "source" && (
          <div className={styles.detailForm}>
            <label>
              同步频率
              <select defaultValue="每 2 小时">
                <option>实时</option>
                <option>每 2 小时</option>
                <option>每 4 小时</option>
                <option>每日</option>
              </select>
            </label>
            <label>
              市场范围
              <input defaultValue="美国 / 加拿大" />
            </label>
            <label className={styles.detailFull}>
              关键词
              <textarea defaultValue="short drama, billionaire, revenge" />
            </label>
          </div>
        )}
        {detail.kind === "member" && (
          <div className={styles.detailForm}>
            <label>
              成员角色
              <select defaultValue="内容运营">
                <option>管理员</option>
                <option>内容运营</option>
                <option>编导</option>
                <option>投放</option>
                <option>只读</option>
              </select>
            </label>
            <label>
              复核队列
              <select defaultValue="T1 / T2 复核">
                <option>暂不加入</option>
                <option>T1 / T2 复核</option>
                <option>人物关系复核</option>
              </select>
            </label>
          </div>
        )}
        <div
          className={`${styles.detailRows} ${detail.kind === "task" ? styles.logRows : ""}`}
        >
          {copy.rows.map((row) => (
            <div key={row[0]}>
              <b>{row[0]}</b>
              <span>{row[1]}</span>
            </div>
          ))}
        </div>
        <footer className={styles.detailActions}>
          <button onClick={onClose}>关闭</button>
          {detail.kind !== "task" && (
            <button className={styles.primary} onClick={onClose}>
              {detail.kind === "audit" ? "导出审计日志" : "保存更改"}
            </button>
          )}
          {detail.kind === "task" && (
            <button className={styles.primary} onClick={onClose}>
              导出完整日志
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}
function statusClass(status: string) {
  return status === "运行中" || status === "已完成"
    ? "success"
    : status === "失败"
      ? "error"
      : status === "需处理" || status === "待配置"
        ? "warning"
        : "neutral";
}

export default OperationsWorkspace;
