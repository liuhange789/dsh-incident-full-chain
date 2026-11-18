/**
 * Built-in fault tree. Pure data plus pure functions: no I/O, no model calls.
 * The tree is intentionally shallow — it ranks what to look at first and what
 * to do after a failed attempt, it does not pretend to diagnose.
 */

import type { ActionKind, MitigationResult, SignalClass } from './incident.js'

/** One ranked cause. */
export interface Hypothesis {
  cause: string
  /** 0-100, coarse ranking rather than a probability. */
  confidence: number
  evidence: string
}

/**
 * One escalation step. `kind` names the action class the step asks the operator
 * to perform, so a class that already failed can be suppressed without
 * string-matching the advice text (which would also delete counterfactual
 * advice such as "don't keep restarting, check the network instead").
 */
export interface AdviceStep {
  text: string
  kind?: ActionKind
}

/** Short helper: fewer parentheses in the tree below. */
function adv(text: string, kind?: ActionKind): AdviceStep {
  return kind === undefined ? { text } : { text, kind }
}

/** One alert family: ranked causes and the ordered first-response checklist. */
export interface Branch {
  label: string
  hypotheses: readonly Hypothesis[]
  checklist: readonly string[]
  /** Where to go after an attempt that did not recover the service. */
  escalation: readonly AdviceStep[]
  /** Where to go after a partial recovery. */
  stabilize: readonly AdviceStep[]
}

/** Keyword rules in specificity order (a memory alert often mentions timeouts). */
const RULES: readonly { readonly signal: SignalClass; readonly pattern: RegExp }[] = [
  { signal: 'memory', pattern: /oom|out\s*of\s*memory|内存|堆内存|heap|gc\s*pause|memory\s*leak/i },
  { signal: 'database', pattern: /mysql|postgres|redis|mongo|连接池|pool\s*exhaust|slow\s*query|慢查询|deadlock|死锁|数据库/i },
  { signal: 'cpu', pattern: /cpu|load\s*average|负载|满载|线程池|thread\s*pool/i },
  { signal: 'timeout', pattern: /timeout|超时|deadline|timed\s*out|504|网关超时/i },
  { signal: 'error-rate', pattern: /5\d\d|error\s*rate|错误率|panic|exception|crash|崩溃|熔断/i },
  { signal: 'latency', pattern: /latency|p9\d|延迟|响应慢|慢请求|\brt\b/i },
]

/** The tree itself. */
const BRANCHES: Record<SignalClass, Branch> = {
  memory: {
    label: '内存 / OOM',
    hypotheses: [
      { cause: '堆内存泄漏（长生命周期缓存或未释放对象）', confidence: 45, evidence: '内存持续上涨且重启后缓慢复现' },
      { cause: '单次大请求/大文件把堆打满', confidence: 30, evidence: '故障前有批量导入或大查询' },
      { cause: '实例内存配额过小，正常峰值即触顶', confidence: 15, evidence: '历史内存使用长期贴近上限' },
      { cause: 'GC 参数不当导致回收跟不上', confidence: 10, evidence: 'GC 停顿时间随负载线性上升' },
    ],
    checklist: [
      '确认 OOM 发生时间点与最近一次发布/配置变更的时间差',
      '抓取一份堆快照与 GC 日志（重启前优先）',
      '确认单实例内存上限与当前实际用量',
      '扩容或重启一个实例止血，保留其余实例现场',
      '按「最近变更」优先回滚',
    ],
    escalation: [
      adv('不要连续重启：先保存堆快照与 GC 日志，否则证据丢失'),
      adv('对比故障前后内存曲线，确认是突增还是缓慢上涨'),
      adv('若为突增，定位故障时间窗内的异常请求（大文件、批量任务、递归查询）'),
      adv('若为缓慢上涨，开启内存采样并观察 30 分钟，再决定回滚还是修泄漏', 'rollback'),
    ],
    stabilize: [
      adv('把临时扩容保留到根因确认之后，避免二次 OOM'),
      adv('为内存用量设置 80%/90% 两级告警'),
      adv('记录本次峰值，反推容量水位'),
    ],
  },
  database: {
    label: '数据库 / 连接池',
    hypotheses: [
      { cause: '慢查询或缺失索引把连接长期占住', confidence: 40, evidence: '查询耗时与连接数同时上升' },
      { cause: '连接池耗尽（泄漏或上限偏小）', confidence: 30, evidence: '获取连接等待时间升高' },
      { cause: '数据库主从切换/锁等待/死锁', confidence: 20, evidence: '出现 lock wait 或 deadlock 日志' },
      { cause: '下游流量突增超过数据库承载', confidence: 10, evidence: 'QPS 曲线在故障前陡增' },
    ],
    checklist: [
      '拉取当前连接数、等待队列与慢查询 Top N',
      '确认是否发生主从切换或锁等待堆积',
      '定位故障时间窗内新增的查询模式（发布、定时任务、爬虫）',
      '必要时限流或降级读请求，避免连接被打满',
      '确认写入是否丢失，评估是否需要补偿',
    ],
    escalation: [
      adv('若连接池耗尽：先确认是泄漏还是容量不足，再决定扩池还是回滚代码'),
      adv('若慢查询突增：对比执行计划，确认是否因数据量或索引变更'),
      adv('若锁等待：找出持锁事务，评估回滚或终止会话的风险'),
      adv('任何终止会话/切主操作前，先确认可接受的写入损失'),
    ],
    stabilize: [
      adv('把限流阈值保留到数据库指标回到基线'),
      adv('补齐慢查询告警与连接池水位告警'),
      adv('核对故障窗口内是否有数据不一致'),
    ],
  },
  cpu: {
    label: 'CPU / 负载',
    hypotheses: [
      { cause: '热点代码或正则回溯导致 CPU 打满', confidence: 40, evidence: '单实例 CPU 高、其他实例正常' },
      { cause: '流量突增超过实例承载', confidence: 30, evidence: '所有实例同时升高且 QPS 同步上升' },
      { cause: '死循环或频繁 GC', confidence: 20, evidence: 'CPU 曲线呈锯齿且伴随 GC 活动' },
      { cause: '上游重试风暴放大请求量', confidence: 10, evidence: '请求量远高于正常，且多为重复请求' },
    ],
    checklist: [
      '确认是单实例还是全实例 CPU 高',
      '抓取一份 CPU profile（重启前优先）',
      '确认 QPS 是否同步上升，区分流量问题与代码问题',
      '扩容或摘除异常实例止血',
      '排查最近发布与定时任务',
    ],
    escalation: [
      adv('先确认 QPS 是否异常；流量问题优先限流而不是改代码', 'config'),
      adv('单实例异常优先摘除并保留现场，避免整组重启掩盖问题', 'drain'),
      adv('确认上游是否在重试；重试风暴需要同时加压上游限流', 'config'),
      adv('抓 profile 后再回滚，否则无法确认热点'),
    ],
    stabilize: [
      adv('观察 CPU 回落并保持 10 分钟'),
      adv('核对延迟与错误率是否同步恢复'),
      adv('记录峰值 QPS 与实例数，更新容量基线'),
    ],
  },
  'error-rate': {
    label: '错误率 / 5xx',
    hypotheses: [
      { cause: '最近发布引入缺陷', confidence: 40, evidence: '错误率与发布时间点重合' },
      { cause: '下游依赖故障被透传', confidence: 25, evidence: '错误集中在调用某个下游的路径上' },
      { cause: '配置/证书/密钥变更', confidence: 20, evidence: '错误为 401/403/证书过期类' },
      { cause: '流量或数据异常触发未覆盖分支', confidence: 15, evidence: '错误 payload 集中在少数输入形态' },
    ],
    checklist: [
      '按接口/错误码拆分错误率，确认是否集中在单一路径',
      '对照最近一次发布与配置变更时间',
      '确认下游依赖健康状态',
      '必要时回滚最近发布或关闭相关开关',
      '保留错误样本与 trace id',
    ],
    escalation: [
      adv('优先回滚：错误率类故障的回滚收益通常高于继续定位', 'rollback'),
      adv('若回滚无效，按错误码确认是否下游透传，再联系下游'),
      adv('保留至少 20 条错误样本与 trace，避免回滚后无法复盘'),
      adv('确认是否有数据写坏，评估补偿方案', 'data'),
    ],
    stabilize: [
      adv('确认错误率回到基线并保持 10 分钟'),
      adv('观察回滚后是否有延迟或队列积压'),
      adv('把本次错误码加入监控看板'),
    ],
  },
  timeout: {
    label: '超时 / 网关',
    hypotheses: [
      { cause: '下游依赖响应变慢或不可达', confidence: 40, evidence: '超时集中在调用同一依赖的路径' },
      { cause: '网络链路抖动或 DNS 异常', confidence: 25, evidence: '多实例同时超时且与流量无关' },
      { cause: '线程/连接池被慢请求占满', confidence: 20, evidence: '队列长度与等待时间同时上升' },
      { cause: '超时阈值设置不合理', confidence: 15, evidence: 'P99 长期贴近阈值' },
    ],
    checklist: [
      '确认超时是全局还是集中在某个下游',
      '检查 DNS 解析与到下游的网络连通性',
      '确认连接池/工作线程是否被占满',
      '对非核心依赖做降级或熔断止血',
      '保留超时请求的 trace 与下游耗时分布',
    ],
    escalation: [
      adv('重启无效时优先查网络链路与下游健康，而不是继续重启', 'network'),
      adv('确认是否为重试放大：超时 + 重试会让下游更慢'),
      adv('对非核心依赖先降级，保住核心链路', 'config'),
      adv('若仅个别实例超时，摘除实例并保留现场', 'drain'),
    ],
    stabilize: [
      adv('确认 P99 回到基线并保持 10 分钟'),
      adv('解除临时降级前先确认下游已恢复'),
      adv('复核超时与重试参数，避免下次放大'),
    ],
  },
  latency: {
    label: '延迟 / 慢请求',
    hypotheses: [
      { cause: '下游慢调用拖累整体响应', confidence: 40, evidence: '慢请求集中在调用同一依赖的链路' },
      { cause: '资源饱和（CPU/连接池/GC）', confidence: 30, evidence: '资源指标与延迟同步上升' },
      { cause: '流量突增排队', confidence: 20, evidence: 'QPS 上升且排队时间占比高' },
      { cause: '慢查询或大对象序列化', confidence: 10, evidence: '延迟分布在特定接口' },
    ],
    checklist: [
      '按接口拆分 P99，确认慢在入口、内部还是下游',
      '检查资源水位（CPU、连接池、GC）',
      '确认 QPS 是否突增',
      '对最慢接口做限流或缓存止血',
      '保留慢请求 trace',
    ],
    escalation: [
      adv('先区分「变慢」与「排队」：排队类优先扩容或限流', 'scale'),
      adv('下游慢调用优先降级非核心依赖', 'config'),
      adv('资源饱和时不要盲目扩容，先确认是否存在泄漏'),
      adv('保留 trace 后再调整参数，避免掩盖问题'),
    ],
    stabilize: [
      adv('确认 P99 与错误率同时回到基线'),
      adv('观察队列是否清空'),
      adv('复核限流阈值与容量水位'),
    ],
  },
  generic: {
    label: '通用故障',
    hypotheses: [
      { cause: '最近一次变更（发布/配置/依赖升级）', confidence: 35, evidence: '故障时间与变更时间接近' },
      { cause: '资源饱和或容量不足', confidence: 25, evidence: '资源指标贴近上限' },
      { cause: '下游依赖异常', confidence: 25, evidence: '错误或超时集中在下游调用' },
      { cause: '流量异常', confidence: 15, evidence: 'QPS 或请求形态异常' },
    ],
    checklist: [
      '确认影响面：哪些用户、接口、地域受影响',
      '对照最近变更时间线',
      '检查核心依赖与资源水位',
      '选择收益最高的止血动作（回滚/降级/扩容）',
      '记录时间线与动作结果',
    ],
    escalation: [
      adv('缩小影响面：先确认是单接口、单实例还是全局'),
      adv('对照变更记录，回滚类动作优先', 'rollback'),
      adv('保留现场证据后再重启或扩容'),
      adv('每做一步记录结果，避免复盘时凭记忆'),
    ],
    stabilize: [
      adv('确认核心指标回到基线'),
      adv('观察 10 分钟无反复'),
      adv('整理待办并生成复盘'),
    ],
  },
}

/**
 * Resolve the alert family from free-form symptom text.
 * @param symptoms - alert body, logs, or the operator's description.
 * @returns the most specific matching family, else `generic`.
 */
export function classify(symptoms: string): SignalClass {
  for (const rule of RULES) {
    if (rule.pattern.test(symptoms)) return rule.signal
  }
  return 'generic'
}

/** One alert family's tree. */
export function branchOf(signal: SignalClass): Branch {
  return BRANCHES[signal]
}

/**
 * Infer the action class from the action text, so a failed `restart` is not
 * recommended again.
 * @param action - operator's action text.
 * @returns the best matching class, else `other`.
 */
export function actionKindOf(action: string): ActionKind {
  if (/回滚|rollback|revert|降级版本/i.test(action)) return 'rollback'
  if (/重启|restart|reboot|reload/i.test(action)) return 'restart'
  if (/扩容|scale|加机器|扩副本|提升规格/i.test(action)) return 'scale'
  if (/摘除|下线|drain|摘流量|剔除/i.test(action)) return 'drain'
  if (/配置|参数|开关|feature\s*flag|config|限流|熔断/i.test(action)) return 'config'
  if (/网络|dns|链路|防火墙|安全组|network|proxy/i.test(action)) return 'network'
  if (/数据|补偿|修数|回填|库表|索引|migration/i.test(action)) return 'data'
  return 'other'
}

/**
 * The next step after one recorded mitigation.
 * @param signal - alert family.
 * @param result - outcome of the action just recorded.
 * @param attempted - action classes already attempted, oldest first.
 * @returns ordered suggestions, most useful first.
 */
export function nextSteps(signal: SignalClass, result: MitigationResult, attempted: readonly ActionKind[]): string[] {
  const branch = BRANCHES[signal]
  if (result === 'worked') {
    return [
      '确认核心指标（错误率/延迟/资源）回到基线并保持 10 分钟',
      '导出故障时段日志、监控快照与 trace 留档',
      '用 incident_postmortem 生成复盘报告，再补根因',
    ]
  }
  const steps = result === 'partial' ? [...branch.stabilize, ...branch.escalation] : [...branch.escalation]
  const filtered = steps.filter(step => step.kind === undefined || !attempted.includes(step.kind))
  return filtered.map(step => step.text).slice(0, 5)
}
