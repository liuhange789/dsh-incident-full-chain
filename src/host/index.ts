/**
 * Host half of dsh-incident-full-chain.
 *
 * Three tools cover the three phases of an incident:
 * - `incident_oncall`     — qualify the alert, persist the incident, rank causes;
 * - `incident_mitigate`   — append one action + result, get the next step;
 * - `incident_postmortem` — render `postmortem.md` with an exact MTTR.
 *
 * State lives in the calling session's workspace (`.incident/`), so a second
 * tool call in a later process continues the same incident.
 *
 * @module dsh-incident-full-chain
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  ACTION_KINDS,
  MITIGATION_RESULTS,
  SEVERITIES,
  addMitigation,
  countResults,
  elapsedMinutes,
  loadCurrent,
  mttrMinutes,
  saveState,
  startIncident,
  type ActionKind,
  type IncidentState,
  type MitigationResult,
  type Severity,
} from '../core/incident.js'
import { actionKindOf, branchOf, classify, nextSteps, type Hypothesis } from '../core/fault-tree.js'
import { renderPostmortem } from '../core/postmortem.js'

/** Plugin id used by the loader entry and diagnostics. */
export const name = 'incident-full-chain'

/** Only the tool registry is a hard dependency. */
export const inject = ['tools']

/** Narrow view of the session header the file tools also read. */
interface WorkspaceExec {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** The calling session's workspace, with `process.cwd()` as the fallback. */
function workspaceOf(exec: ToolRunContext): string {
  const view = exec as unknown as WorkspaceExec
  const cwd = view.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** Round-trip an ISO timestamp or replace it with the current clock. */
function isoOr(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`时间格式无法解析：${value}（请用 ISO 8601，例如 2026-11-18T10:30:00+08:00）`)
  return new Date(parsed).toISOString()
}

/** The hypothesis shape every phase returns. */
const HYPOTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cause: { type: 'string', required: true },
    confidence: { type: 'integer', required: true },
    evidence: { type: 'string', required: true },
  },
} as const

/** Human-readable ranking used by both the model and the renderer. */
function rank(hypotheses: readonly Hypothesis[]): string {
  return hypotheses.map((item, index) => `${index + 1}. ${item.cause}（${item.confidence}）`).join('\n')
}

/** Register the host plugin. */
export function apply(ctx: { tools: { register(definition: unknown): () => void } }): void {
  ctx.tools.register(defineTool({
    name: 'incident_oncall',
    description: [
      'Start (or restart) an incident in the current workspace: classify the alert family from the symptom text, rank the likely causes, and return an ordered first-response checklist.',
      'Persists `.incident/current.json` and `.incident/<id>/state.json`; a later incident_mitigate continues the same incident even in a new process.',
      'Call this first when an alert fires, before changing anything. Use the returned checklist as the plan and record every step with incident_mitigate.',
    ].join(' '),
    parameters: {
      alert: { type: 'string', required: true, description: '一行告警描述，例如「api 网关 5xx 错误率 12%」' },
      symptoms: { type: 'string', description: '关键症状：日志片段、错误码、监控指标。用于归类告警族与排序假设' },
      service: { type: 'string', description: '受影响服务/模块名' },
      severity: { type: 'string', enum: SEVERITIES, description: 'SEV1（全站不可用）到 SEV4（轻微），默认 SEV2' },
      at: { type: 'string', description: '告警发生时间（ISO 8601）；默认当前时间。补录时填写真实时间' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          incidentId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          service: { type: 'string', required: true },
          severity: { type: 'string', required: true, enum: SEVERITIES },
          signal: { type: 'string', required: true },
          signalLabel: { type: 'string', required: true },
          startedAt: { type: 'string', required: true },
          hypotheses: { type: 'array', required: true, items: HYPOTHESIS_SCHEMA },
          checklist: { type: 'array', required: true, items: { type: 'string' } },
          replacedPrevious: { type: 'boolean', required: true },
          statePath: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: [
            `### 故障启动 ${value.incidentId} · ${value.severity} · ${value.signalLabel}`,
            `**可能根因排序**`,
            rank(value.hypotheses),
            '',
            '**建议排查路径**',
            value.checklist.map((step, index) => `${index + 1}. ${step}`).join('\n'),
            '',
            `每做一步用 incident_mitigate 记录动作与结果；恢复后运行 incident_postmortem。`,
          ].join('\n'),
        }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: `故障启动：${args.alert}`, kind: 'other', rawInput: { service: args.service, severity: args.severity } }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(exec)
      const at = isoOr(args.at, new Date().toISOString())
      const signal = classify(`${args.alert} ${args.symptoms ?? ''}`)
      const branch = branchOf(signal)
      const started = await startIncident(workspace, {
        alert: args.alert,
        service: args.service ?? '',
        severity: (args.severity ?? 'SEV2') as Severity,
        symptoms: args.symptoms ?? '',
        startedAt: at,
      }, signal)
      return {
        incidentId: started.state.id,
        title: started.state.title,
        service: started.state.service,
        severity: started.state.severity,
        signal,
        signalLabel: branch.label,
        startedAt: started.state.startedAt,
        hypotheses: branch.hypotheses.map(item => ({ cause: item.cause, confidence: item.confidence, evidence: item.evidence })),
        checklist: [...branch.checklist],
        replacedPrevious: started.replacedPrevious,
        statePath: `.incident/${started.state.id}/state.json`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'incident_mitigate',
    description: [
      'Record one mitigation action and its result on the current incident timeline, then return the next step from the built-in fault tree.',
      'The first `worked` result marks the incident recovered and freezes MTTR; `partial` and `failed` move to the branch-specific escalation path, filtered so an already-failed action class is not suggested again.',
      'Always record what you actually did, even when it did not work — the postmortem is generated from this timeline only.',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, description: '实际执行的动作，例如「回滚 api 到 v1.42」或「扩容到 6 副本」' },
      result: { type: 'string', required: true, enum: MITIGATION_RESULTS, description: 'worked 已恢复 / partial 部分缓解 / failed 无效' },
      note: { type: 'string', description: '结果细节：指标变化、报错、链接' },
      kind: { type: 'string', enum: ACTION_KINDS, description: '动作类型（不填则按 action 文本推断），用于避免重复建议' },
      at: { type: 'string', description: '动作执行时间（ISO 8601）；默认当前时间' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recorded: { type: 'boolean', required: true },
          recovered: { type: 'boolean', required: true },
          recoveredNow: { type: 'boolean', required: true },
          incidentId: { type: 'string', required: true },
          mttrMinutes: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          elapsedMinutes: { type: 'integer', required: true },
          actionCount: { type: 'integer', required: true },
          nextSteps: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: [
            `动作已记录（第 ${value.actionCount} 个）。${value.recovered ? `已恢复，MTTR ${value.mttrMinutes} 分钟。` : `仍未恢复，已持续 ${value.elapsedMinutes} 分钟。`}`,
            value.warnings.length === 0 ? '' : `注意：${value.warnings.join('；')}`,
            '**下一步建议**',
            value.nextSteps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
          ].filter(line => line !== '').join('\n'),
        }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: `记录动作：${args.action}`, kind: 'other', rawInput: { result: args.result } }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(exec)
      const state: IncidentState = (await loadCurrent(workspace, { required: true })) as IncidentState
      const at = isoOr(args.at, new Date().toISOString())
      const kind: ActionKind = (args.kind ?? actionKindOf(args.action)) as ActionKind
      const recoveredNow = addMitigation(state, {
        action: args.action,
        result: args.result as MitigationResult,
        note: args.note ?? '',
        kind,
        at,
      })
      await saveState(workspace, state)
      const attempted = state.timeline.filter(entry => entry.phase === 'mitigate').map(entry => entry.kind)
      const warnings: string[] = []
      if (state.recoveredAt !== null && Date.parse(at) > Date.parse(state.recoveredAt)) {
        warnings.push('故障已恢复，本条动作不计入 MTTR（按首个有效动作计时）')
      }
      if (args.result === 'worked' && state.timeline.filter(entry => entry.result === 'worked').length > 1) {
        warnings.push('已有更早的有效动作，MTTR 仍以首次为准')
      }
      const counts = countResults(state)
      if (!recoveredNow && counts.failed >= 3) {
        warnings.push('已连续 3 个以上动作无效，建议先保存现场证据再继续，避免掩盖真实根因')
      }
      return {
        recorded: true,
        recovered: state.recoveredAt !== null,
        recoveredNow,
        incidentId: state.id,
        mttrMinutes: mttrMinutes(state),
        elapsedMinutes: elapsedMinutes(state, at),
        actionCount: counts.worked + counts.partial + counts.failed,
        nextSteps: nextSteps(state.signal, args.result as MitigationResult, attempted),
        warnings,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'incident_postmortem',
    description: [
      'Generate `postmortem.md` from the recorded incident timeline: summary, impact, timestamped timeline table, ranked hypotheses, mitigation log, blockers, improvement checklist, lessons.',
      'MTTR is computed from the alert time to the first `worked` action — never inferred from the model. The incident is marked closed and the file is written inside the session workspace.',
      'Run this after recovery, or mid-incident to snapshot progress; pass `output` to change the file name.',
    ].join(' '),
    parameters: {
      output: { type: 'string', description: '工作区内输出路径，默认 postmortem.md' },
      author: { type: 'string', description: '复盘记录人' },
      at: { type: 'string', description: '生成时间（ISO 8601）；默认当前时间，用于计算未恢复时长' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          incidentId: { type: 'string', required: true },
          mttrMinutes: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          actionCount: { type: 'integer', required: true },
          closed: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: [
            `复盘报告已生成：\`${value.path}\`（${value.mttrMinutes === null ? '尚未恢复' : `MTTR ${value.mttrMinutes} 分钟`} · ${value.actionCount} 个动作）`,
            '',
            value.report,
          ].join('\n'),
        }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: '生成复盘报告', kind: 'other', rawInput: { output: args.output } }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(exec)
      const state: IncidentState = (await loadCurrent(workspace, { required: true })) as IncidentState
      const now = isoOr(args.at, new Date().toISOString())
      const requested = args.output === undefined || args.output.trim() === '' ? 'postmortem.md' : args.output
      const target = path.resolve(workspace, requested)
      const relativeToWorkspace = path.relative(workspace, target)
      if (relativeToWorkspace === '' || relativeToWorkspace.split(path.sep)[0] === '..' || path.isAbsolute(relativeToWorkspace)) {
        throw new Error('output 必须位于当前工作区内')
      }
      state.status = 'closed'
      state.timeline.push({
        at: now,
        phase: 'postmortem',
        action: `生成复盘报告：${relativeToWorkspace.split(path.sep).join('/')}`,
        result: '',
        note: '',
        kind: 'other',
      })
      const report = renderPostmortem(state, { author: args.author ?? '', now })
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, report, 'utf8')
      await saveState(workspace, state)
      const counts = countResults(state)
      return {
        path: relativeToWorkspace.split(path.sep).join('/'),
        incidentId: state.id,
        mttrMinutes: mttrMinutes(state),
        actionCount: counts.worked + counts.partial + counts.failed,
        closed: true,
        report,
      }
    },
  }))
}
