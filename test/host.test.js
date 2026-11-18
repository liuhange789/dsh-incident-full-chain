import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

/** Load the built host entry the way the loader does (real plugin apply). */
async function loadHost() {
  const module = await import(pathToFileURL(path.resolve('lib/index.js')).href)
  const tools = {}
  const registrations = []
  const ctx = {
    fiber: { state: 0 },
    tools: { register(tool) { tools[tool.name] = tool; registrations.push(tool.name) } },
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    on() {},
    logger: console,
    inject() {},
  }
  module.apply(ctx)
  return { module, tools, registrations }
}

/** Real workspace exec context. */
const execFor = workspace => ({ agent: { session: { header: { cwd: workspace } } } })

/** Fresh temp workspace. */
async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'incident-full-chain-'))
}

test('host registers the three phase tools with real parameter names', async () => {
  const { registrations, tools } = await loadHost()
  assert.deepEqual(registrations, ['incident_oncall', 'incident_mitigate', 'incident_postmortem'])
  assert.ok(tools.incident_oncall.parameters.properties.alert)
  assert.ok(tools.incident_oncall.parameters.required.includes('alert'))
  assert.deepEqual(tools.incident_mitigate.parameters.properties.result.enum, ['worked', 'partial', 'failed'])
  assert.ok(tools.incident_mitigate.parameters.required.includes('action'))
})

test('three consecutive mitigations keep order and compute MTTR from the first effective action', async () => {
  const { tools } = await loadHost()
  const workspaceDir = await workspace()
  const exec = execFor(workspaceDir)

  const oncall = await tools.incident_oncall.execute({
    alert: 'api 网关 5xx 错误率 12%',
    symptoms: '日志出现 504 gateway timeout / upstream timeout',
    service: 'api-gateway',
    severity: 'SEV2',
    at: '2026-11-18T10:00:00Z',
  }, exec)
  assert.equal(oncall.incidentId, 'INC-20261118-100000')
  assert.equal(oncall.signal, 'timeout')
  assert.equal(oncall.signalLabel, '超时 / 网关')
  assert.ok(oncall.hypotheses.length >= 3)
  assert.equal(oncall.hypotheses[0].confidence >= oncall.hypotheses[1].confidence, true)
  assert.match(tools.incident_oncall.output.render({}, oncall)[0].text, /可能根因排序/)

  const first = await tools.incident_mitigate.execute({
    action: '重启 api-gateway 全部实例',
    result: 'failed',
    note: '重启后 5 分钟错误率仍为 11%',
    at: '2026-11-18T10:05:00Z',
  }, exec)
  assert.equal(first.recorded, true)
  assert.equal(first.recovered, false)
  assert.equal(first.mttrMinutes, null)
  assert.equal(first.elapsedMinutes, 5)
  assert.equal(first.actionCount, 1)
  // A failed restart must not be issued again, but the "restart is useless,
  // check the network" branch must survive the filter.
  assert.equal(first.nextSteps.some(step => /网络链路|DNS|下游健康/.test(step)), true, first.nextSteps.join(' | '))
  assert.match(tools.incident_mitigate.output.render({}, first)[0].text, /下一步建议/)

  const second = await tools.incident_mitigate.execute({
    action: '检查到上游 DNS 解析超时，切换备用解析',
    result: 'partial',
    note: '错误率从 12% 降到 4%，仍有抖动',
    kind: 'network',
    at: '2026-11-18T10:12:00Z',
  }, exec)
  assert.equal(second.recovered, false)
  assert.equal(second.actionCount, 2)
  assert.equal(second.elapsedMinutes, 12)
  // The network class already failed, so network advice is filtered out.
  assert.equal(second.nextSteps.some(step => /网络链路|DNS/.test(step)), false, second.nextSteps.join(' |'))

  const third = await tools.incident_mitigate.execute({
    action: '回滚 api-gateway 到 v1.42',
    result: 'worked',
    note: '错误率回到 0.2%',
    kind: 'rollback',
    at: '2026-11-18T10:18:00Z',
  }, exec)
  assert.equal(third.recoveredNow, true)
  assert.equal(third.recovered, true)
  assert.equal(third.mttrMinutes, 18)
  assert.equal(third.actionCount, 3)

  // A later action cannot move MTTR.
  const late = await tools.incident_mitigate.execute({
    action: '补充缓存配置',
    result: 'worked',
    at: '2026-11-18T10:31:00Z',
  }, exec)
  assert.equal(late.mttrMinutes, 18)
  assert.equal(late.recoveredNow, false)
  assert.equal(late.warnings.length > 0, true)

  const report = await tools.incident_postmortem.execute({}, exec)
  assert.equal(report.path, 'postmortem.md')
  assert.equal(report.mttrMinutes, 18)
  assert.equal(report.actionCount, 4)
  assert.equal(report.closed, true)

  const markdown = await readFile(path.join(workspaceDir, 'postmortem.md'), 'utf8')
  assert.match(markdown, /# 故障复盘：api 网关 5xx 错误率 12%/)
  assert.match(markdown, /- MTTR：18 分钟/)
  assert.match(markdown, /- 状态：closed/)
  assert.match(markdown, /## 3\. 时间线/)
  assert.match(markdown, /## 7\. 改进项/)
  assert.match(markdown, /\| 10:00:00（\+0 分钟） \| alert \|/)

  // Timeline order is chronological and the three mitigations are all present.
  const rows = markdown.split('\n').filter(line => line.startsWith('| 10:'))
  assert.equal(rows.length, 5)
  const state = JSON.parse(await readFile(path.join(workspaceDir, '.incident/INC-20261118-100000/state.json'), 'utf8'))
  assert.equal(state.timeline.length, 6)
  assert.deepEqual(state.timeline.map(entry => entry.phase), ['alert', 'mitigate', 'mitigate', 'mitigate', 'mitigate', 'postmortem'])
  const times = state.timeline.map(entry => Date.parse(entry.at))
  assert.deepEqual([...times].sort((a, b) => a - b), times)
  assert.equal(state.recoveredAt, '2026-11-18T10:18:00.000Z')
  assert.equal(state.status, 'closed')
})

test('state survives a fresh process: a new module load continues the same incident', async () => {
  const workspaceDir = await workspace()
  const first = await loadHost()
  await first.tools.incident_oncall.execute({
    alert: '订单库主从切换',
    symptoms: 'mysql deadlock / connection pool exhausted',
    service: 'order-db',
    severity: 'SEV1',
    at: '2026-11-18T02:00:00Z',
  }, execFor(workspaceDir))

  const second = await loadHost()
  const recovered = await second.tools.incident_mitigate.execute({
    action: '切换只读流量到备库并限流写入',
    result: 'worked',
    at: '2026-11-18T02:09:00Z',
  }, execFor(workspaceDir))
  assert.equal(recovered.mttrMinutes, 9)
  assert.equal(recovered.recoveredNow, true)
  assert.equal(recovered.incidentId, 'INC-20261118-020000')
})

test('a closed incident is not reported as replaced, an active one is', async () => {
  const { tools } = await loadHost()
  const workspaceDir = await workspace()
  const exec = execFor(workspaceDir)

  const open = await tools.incident_oncall.execute({ alert: 'A', at: '2026-11-18T03:00:00Z' }, exec)
  assert.equal(open.replacedPrevious, false)
  const again = await tools.incident_oncall.execute({ alert: 'B', at: '2026-11-18T03:10:00Z' }, exec)
  assert.equal(again.replacedPrevious, true)
})

test('mitigate and postmortem refuse to run without an incident', async () => {
  const { tools } = await loadHost()
  const workspaceDir = await workspace()
  await assert.rejects(tools.incident_mitigate.execute({ action: 'x', result: 'failed' }, execFor(workspaceDir)), /incident_oncall/)
  await assert.rejects(tools.incident_postmortem.execute({}, execFor(workspaceDir)), /incident_oncall/)
})

test('postmortem refuses to write outside the workspace', async () => {
  const { tools } = await loadHost()
  const workspaceDir = await workspace()
  const exec = execFor(workspaceDir)
  await tools.incident_oncall.execute({ alert: 'A', at: '2026-11-18T04:00:00Z' }, exec)
  await assert.rejects(tools.incident_postmortem.execute({ output: '../escaped.md' }, exec), /工作区内/)
  assert.deepEqual(await readdir(workspaceDir), ['.incident'])
})

test('unresolved incident reports duration instead of MTTR', async () => {
  const { tools } = await loadHost()
  const workspaceDir = await workspace()
  const exec = execFor(workspaceDir)
  await tools.incident_oncall.execute({ alert: '缓存雪崩', symptoms: 'redis timeout', at: '2026-11-18T06:00:00Z' }, exec)
  await tools.incident_mitigate.execute({ action: '预热热点 key', result: 'partial', at: '2026-11-18T06:20:00Z' }, exec)
  const report = await tools.incident_postmortem.execute({ at: '2026-11-18T06:40:00Z' }, exec)
  assert.equal(report.mttrMinutes, null)
  assert.match(report.report, /MTTR：未恢复（已持续 40 分钟）/)
})

test('a failed drain is not suggested again', async () => {
  const { tools } = await loadHost()
  const workspaceDir = await workspace()
  const exec = execFor(workspaceDir)
  await tools.incident_oncall.execute({ alert: 'cpu 负载满载', symptoms: 'load average 32', at: '2026-11-18T08:00:00Z' }, exec)
  const result = await tools.incident_mitigate.execute({ action: '摘除异常实例', result: 'failed', kind: 'drain', at: '2026-11-18T08:05:00Z' }, exec)
  assert.equal(result.nextSteps.some(step => /摘除|下线/.test(step)), false, result.nextSteps.join(' | '))
})

test('timeline is rendered chronologically and alert text is escaped', async () => {
  const { tools } = await loadHost()
  const workspaceDir = await workspace()
  const exec = execFor(workspaceDir)
  await tools.incident_oncall.execute({ alert: '<script>alert(1)</script> 5xx 错误率 30%', at: '2026-11-18T07:00:00Z' }, exec)
  await tools.incident_mitigate.execute({ action: '重启网关 <img onerror=x>', result: 'failed', at: '2026-11-18T07:20:00Z' }, exec)
  await tools.incident_mitigate.execute({ action: '检查 DNS', result: 'partial', at: '2026-11-18T07:05:00Z' }, exec)
  const report = await tools.incident_postmortem.execute({ at: '2026-11-18T07:30:00Z' }, exec)

  const rows = report.report.split('\n').filter(line => line.startsWith('| ') && line.includes('07:'))
  const early = rows.findIndex(row => row.includes('07:05:00'))
  const late = rows.findIndex(row => row.includes('07:20:00'))
  assert.equal(early >= 0 && late >= 0 && early < late, true, rows.join('\n'))
  assert.equal(/<script>|<img onerror/.test(report.report), false)
  assert.match(report.report, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('two incidents started in the same second keep separate state files', async () => {
  const { tools } = await loadHost()
  const workspaceDir = await workspace()
  const exec = execFor(workspaceDir)
  const first = await tools.incident_oncall.execute({ alert: 'A', at: '2026-11-18T09:00:00Z' }, exec)
  const second = await tools.incident_oncall.execute({ alert: 'B', at: '2026-11-18T09:00:00Z' }, exec)
  assert.notEqual(first.incidentId, second.incidentId)
  const entries = await readdir(path.join(workspaceDir, '.incident'))
  assert.equal(entries.includes(first.incidentId), true)
  assert.equal(entries.includes(second.incidentId), true)
  const pointer = JSON.parse(await readFile(path.join(workspaceDir, '.incident', 'current.json'), 'utf8'))
  assert.equal(pointer.id, second.incidentId)
})
