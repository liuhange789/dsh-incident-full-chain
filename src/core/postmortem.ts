/**
 * Postmortem generator: pure string templating over the recorded timeline.
 * No model call, no network — the same state always yields the same report.
 */

import { branchOf } from './fault-tree.js'
import {
  countResults,
  elapsedMinutes,
  mttrMinutes,
  minutesBetween,
  type IncidentState,
  type TimelineEntry,
} from './incident.js'

/** Options the caller controls. */
export interface PostmortemOptions {
  /** Who writes the report; empty leaves the line out. */
  author: string
  /** Clock used for an unresolved incident's "still open" duration. */
  now: string
}

/** Escape HTML, so alert text like `<script>` cannot execute in a viewer. */
function html(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape a value for one Markdown table cell. */
function cell(value: string): string {
  return html(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Inline text: HTML-escaped, single line. */
function inline(value: string): string {
  return html(value).replace(/\r?\n/g, ' ')
}

/** Escape text that must not be read as Markdown structure. */
function text(value: string): string {
  return html(value.replace(/\r/g, '').trim())
}

/** Timeline in chronological order; a backfilled entry cannot invert the report. */
function sortedTimeline(state: IncidentState): TimelineEntry[] {
  return state.timeline.slice().sort((left, right) => {
    const delta = Date.parse(left.at) - Date.parse(right.at)
    return Number.isFinite(delta) && delta !== 0 ? delta : 0
  })
}

/** ISO time without the date when it belongs to the incident's own day. */
function clock(at: string, startedAt: string): string {
  if (Date.parse(at) === 0) return '未记录'
  const sameDay = new Date(at).toISOString().slice(0, 10) === new Date(startedAt).toISOString().slice(0, 10)
  const time = at.slice(11, 19)
  return sameDay ? time : `${at.slice(0, 10)} ${time}`
}

/** Minutes + relative offset, e.g. `10:32:00（+12 分钟）`. */
function timelineWhen(entry: TimelineEntry, startedAt: string): string {
  return `${clock(entry.at, startedAt)}（+${minutesBetween(startedAt, entry.at)} 分钟）`
}

/** One row per recorded step, oldest first. */
function timelineTable(state: IncidentState): string {
  const rows = sortedTimeline(state).map(entry => {
    const result = entry.phase === 'alert'
      ? '—'
      : entry.phase === 'postmortem'
        ? '已生成'
        : entry.result === 'worked' ? '有效' : entry.result === 'partial' ? '部分有效' : '无效'
    return `| ${cell(timelineWhen(entry, state.startedAt))} | ${cell(entry.phase)} | ${cell(entry.action)} | ${cell(result)} | ${cell(entry.note === '' ? '—' : entry.note)} |`
  })
  return ['| 时间 | 阶段 | 动作 | 结果 | 备注 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n')
}

/** Hypotheses rendered as a ranked list with the recorded evidence. */
function hypotheses(state: IncidentState): string {
  const branch = branchOf(state.signal)
  return branch.hypotheses
    .map((item, index) => `${index + 1}. **${item.cause}**（初始置信度 ${item.confidence}）\n   - 判断依据：${item.evidence}`)
    .join('\n')
}

/** Actionable follow-ups derived only from what actually happened. */
function improvements(state: IncidentState): string {
  const counts = countResults(state)
  const branch = branchOf(state.signal)
  const items: string[] = []
  if (counts.failed > 0) {
    items.push(`复盘 ${counts.failed} 次无效动作：确认是判断错误、信息缺失，还是动作本身不可用`)
  }
  const wasRollback = state.timeline.some(entry => entry.kind === 'rollback')
  if (!wasRollback && (state.signal === 'error-rate' || state.signal === 'memory')) {
    items.push('把「回滚最近变更」前移为一级止血动作，并演练一次')
  }
  for (const step of branch.checklist.slice(0, 2)) {
    items.push(`补齐可观测性：${step}`)
  }
  items.push('在本季度演练一次同类故障，验证本次改进项是否生效')
  return items.map(item => `- [ ] ${item}`).join('\n')
}

/** Overall one-paragraph summary. */
function summary(state: IncidentState, mttr: number | null, elapsed: number): string {
  const counts = countResults(state)
  const resolution = mttr === null
    ? `截至 ${state.recoveredAt === null ? '当前' : '记录结束'}仍未恢复，已持续 ${elapsed} 分钟`
    : `首次有效动作后恢复，MTTR ${mttr} 分钟`
  return [
    `${state.severity} 故障「${inline(state.title)}」${state.service === '' ? '' : `影响 ${inline(state.service)}，`}${resolution}。`,
    `期间共记录 ${counts.worked + counts.partial + counts.failed} 个缓解动作（有效 ${counts.worked} / 部分有效 ${counts.partial} / 无效 ${counts.failed}）。`,
    `告警特征归为「${branchOf(state.signal).label}」，根因待用下方假设逐条排除。`,
  ].join('')
}

/**
 * Render the full postmortem.
 * @param state - the recorded incident.
 * @param options - author and clock.
 * @returns Markdown ready to write to disk.
 */
export function renderPostmortem(state: IncidentState, options: PostmortemOptions): string {
  const mttr = mttrMinutes(state)
  const elapsed = elapsedMinutes(state, options.now)
  const counts = countResults(state)
  const blockers = sortedTimeline(state).filter(entry => entry.phase === 'mitigate' && entry.result === 'failed')
  const lines: string[] = [
    `# 故障复盘：${inline(state.title)}`,
    '',
    `- 事故编号：${state.id}`,
    `- 严重级别：${state.severity}`,
    `- 影响服务：${state.service === '' ? '未填写' : inline(state.service)}`,
    `- 开始时间：${state.startedAt}`,
    `- 恢复时间：${state.recoveredAt === null ? '尚未恢复' : state.recoveredAt}`,
    `- MTTR：${mttr === null ? `未恢复（已持续 ${elapsed} 分钟）` : `${mttr} 分钟`}`,
    `- 状态：${state.status}`,
    `- 涉及动作：${counts.worked + counts.partial + counts.failed} 个（有效 ${counts.worked} / 部分 ${counts.partial} / 无效 ${counts.failed}）`,
    '- 时间基准：UTC（ISO 8601）',
  ]
  if (options.author !== '') lines.push(`- 记录人：${inline(options.author)}`)
  lines.push(
    '',
    '## 1. 摘要',
    '',
    summary(state, mttr, elapsed),
    '',
    '## 2. 影响',
    '',
    state.service === '' ? '影响服务未在告警时填写，请补充受影响的功能、用户规模与时长。' : `- 服务：${inline(state.service)}`,
    `- 持续时长：${mttr === null ? `${elapsed} 分钟（未恢复）` : `${mttr} 分钟`}`,
    '- 用户影响：待补充（受影响用户数、失败请求占比、是否有数据不一致）',
    '',
    '## 3. 时间线',
    '',
    timelineTable(state),
    '',
    '## 4. 根因分析',
    '',
    '### 4.1 初始假设（按可能性排序）',
    '',
    hypotheses(state),
    '',
    '### 4.2 已验证结论',
    '',
    mttr === null
      ? '尚未恢复，暂不能确认根因。完成恢复后请把「有效动作」对应到上面某条假设，并删除其余假设或标注「已排除」。'
      : '出现有效动作即说明服务已恢复，但恢复不等于根因确认：请把有效动作对应到上面某条假设，并在复盘会上确认。',
    '',
    '## 5. 处置与恢复',
    '',
    state.timeline.filter(entry => entry.phase === 'mitigate').length === 0
      ? '没有记录缓解动作。请在下一次先执行 incident_mitigate 记录动作与结果，否则复盘缺少事实依据。'
      : sortedTimeline(state)
          .filter(entry => entry.phase === 'mitigate')
          .map(entry => `- ${timelineWhen(entry, state.startedAt)} **${inline(entry.action)}** → ${entry.result}${entry.note === '' ? '' : `（${inline(entry.note)}）`}`)
          .join('\n'),
    '',
    '## 6. 阻塞点',
    '',
    blockers.length === 0
      ? '本次没有记录无效动作。'
      : blockers.map(entry => `- ${inline(entry.action)}：未生效${entry.note === '' ? '' : `（${inline(entry.note)}）`}，需要确认是否环境不允许或判断有偏差`).join('\n'),
    '',
    '## 7. 改进项',
    '',
    improvements(state),
    '',
    '## 8. 经验教训',
    '',
    `- 告警特征：${text(state.symptoms) === '' ? '告警时未提供症状文本，下次请粘贴关键日志或指标。' : `「${text(state.symptoms).replace(/\r?\n/g, ' ').slice(0, 300)}」`}`,
    `- 止血顺序：先保存证据，再做高收益动作（回滚/降级/扩容），最后才重启。`,
    `- 下一次同类故障的入口：直接调用 incident_oncall，按「${branchOf(state.signal).label}」分支清单推进。`,
    '',
  )
  return lines.join('\n')
}
