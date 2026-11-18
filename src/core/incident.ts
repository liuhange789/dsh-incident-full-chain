/**
 * Incident state machine: one active incident per workspace, persisted as JSON
 * under `.incident/<id>/state.json` with an atomic rename, plus a `current.json`
 * pointer so a later `incident_mitigate` finds the same incident in a new process.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Severity ladder, most severe first. */
export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const
/** One severity label. */
export type Severity = (typeof SEVERITIES)[number]

/** How a mitigation action ended. */
export const MITIGATION_RESULTS = ['worked', 'partial', 'failed'] as const
/** One mitigation outcome. */
export type MitigationResult = (typeof MITIGATION_RESULTS)[number]

/** Trial action classes used by the fault tree to rank the next step. */
export const ACTION_KINDS = ['restart', 'rollback', 'scale', 'drain', 'config', 'network', 'data', 'other'] as const
/** One action class. */
export type ActionKind = (typeof ACTION_KINDS)[number]

/** Alert families the built-in fault tree understands. */
export const SIGNAL_CLASSES = ['memory', 'database', 'cpu', 'error-rate', 'timeout', 'latency', 'generic'] as const
/** One alert family. */
export type SignalClass = (typeof SIGNAL_CLASSES)[number]

/** Kind of a timeline row. */
export type Phase = 'alert' | 'mitigate' | 'postmortem'

/** One recorded step. */
export interface TimelineEntry {
  /** ISO 8601 timestamp of the action. */
  at: string
  /** Which phase produced the row. */
  phase: Phase
  /** Human action, e.g. "重启 api-1". */
  action: string
  /** Outcome label; empty for alert rows. */
  result: string
  /** Free-form note (measurements, links, error text). */
  note: string
  /** Action class, when known. */
  kind: ActionKind
}

/** Persisted incident. */
export interface IncidentState {
  /** Stable id, e.g. INC-20261118-1030. */
  id: string
  /** One-line incident title. */
  title: string
  /** Affected service, empty when unknown. */
  service: string
  /** Severity ladder position. */
  severity: Severity
  /** ISO 8601 start of the incident (alert time). */
  startedAt: string
  /** Raw symptom text the model passed in. */
  symptoms: string
  /** Alert family resolved from the symptoms. */
  signal: SignalClass
  /** Lifecycle state. */
  status: 'active' | 'recovered' | 'closed'
  /** ISO 8601 of the first successful mitigation, null while unresolved. */
  recoveredAt: string | null
  /** Append-only timeline, oldest first. */
  timeline: TimelineEntry[]
}

/** Input of `incident_oncall`. */
export interface OncallInput {
  alert: string
  service: string
  severity: Severity
  symptoms: string
  startedAt: string
}

/** Input of `incident_mitigate`. */
export interface MitigateInput {
  action: string
  result: MitigationResult
  note: string
  kind: ActionKind
  at: string
}

/** Result of starting an incident. */
export interface StartedIncident {
  state: IncidentState
  replacedPrevious: boolean
}

 /** Absolute `.incident` directory for one workspace. */
export function incidentRoot(workspace: string): string {
  return path.join(workspace, '.incident')
}

/** Absolute state file for one incident id. */
export function stateFile(workspace: string, id: string): string {
  return path.join(incidentRoot(workspace), id, 'state.json')
}

/** Pointer to the incident that mitigation/postmortem should continue. */
export function currentFile(workspace: string): string {
  return path.join(incidentRoot(workspace), 'current.json')
}

/** Collapse whitespace and cap a free-form label. */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** `YYYYMMDD-HHMMSS` in UTC, used for the incident id. */
function stamp(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

/** First free id, so two incidents started in the same second never share a state file. */
async function uniqueId(workspace: string, base: string): Promise<string> {
  let id = base
  let suffix = 2
  while ((await readJson(stateFile(workspace, id))) !== null) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

/** Write JSON through a temporary file so a reader never sees a torn state. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/** Parse one JSON file, returning null when it is absent. */
async function readJson(file: string): Promise<unknown> {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text) as unknown
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw new Error(`无法读取 ${file}：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Narrow unknown to a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one timeline row read back from disk. */
function parseEntry(value: unknown): TimelineEntry | null {
  if (!isRecord(value)) return null
  const { at, phase, action, result, note, kind } = value
  if (typeof at !== 'string' || typeof action !== 'string') return null
  if (phase !== 'alert' && phase !== 'mitigate' && phase !== 'postmortem') return null
  return {
    at,
    phase,
    action,
    result: typeof result === 'string' ? result : '',
    note: typeof note === 'string' ? note : '',
    kind: ACTION_KINDS.includes(kind as ActionKind) ? (kind as ActionKind) : 'other',
  }
}

/** Validate a state file; unknown, corrupt, or hand-edited files fail loudly. */
function parseState(value: unknown): IncidentState {
  if (!isRecord(value)) throw new Error('故障状态文件不是对象')
  const { id, title, service, severity, startedAt, symptoms, signal, status, recoveredAt, timeline } = value
  if (typeof id !== 'string' || typeof title !== 'string' || typeof startedAt !== 'string') {
    throw new Error('故障状态文件缺少 id/title/startedAt')
  }
  const entries = Array.isArray(timeline) ? timeline.map(parseEntry).filter((entry): entry is TimelineEntry => entry !== null) : []
  return {
    id,
    title,
    service: typeof service === 'string' ? service : '',
    severity: SEVERITIES.includes(severity as Severity) ? (severity as Severity) : 'SEV2',
    startedAt,
    symptoms: typeof symptoms === 'string' ? symptoms : '',
    signal: SIGNAL_CLASSES.includes(signal as SignalClass) ? (signal as SignalClass) : 'generic',
    status: status === 'recovered' || status === 'closed' ? status : 'active',
    recoveredAt: typeof recoveredAt === 'string' ? recoveredAt : null,
    timeline: entries,
  }
}

/**
 * Create a new incident and make it current. A still-active previous incident
 * is not deleted: its state stays on disk and is reported as replaced.
 * @param workspace - absolute session workspace.
 * @param input - alert, service, severity and symptom text.
 * @param signal - alert family resolved by the fault tree.
 * @returns the stored state and whether an active incident was replaced.
 */
export async function startIncident(workspace: string, input: OncallInput, signal: SignalClass): Promise<StartedIncident> {
  const previous = await loadCurrent(workspace, { required: false })
  const state: IncidentState = {
    id: await uniqueId(workspace, `INC-${stamp(input.startedAt)}`),
    title: clip(input.alert, 160),
    service: clip(input.service, 80),
    severity: input.severity,
    startedAt: input.startedAt,
    symptoms: clip(input.symptoms, 2000),
    signal,
    status: 'active',
    recoveredAt: null,
    timeline: [{ at: input.startedAt, phase: 'alert', action: `告警：${clip(input.alert, 160)}`, result: '', note: clip(input.symptoms, 600), kind: 'other' }],
  }
  await saveState(workspace, state)
  await writeJsonAtomic(currentFile(workspace), { id: state.id })
  return { state, replacedPrevious: previous !== null && previous.status !== 'closed' }
}

/** Persist one incident state. */
export async function saveState(workspace: string, state: IncidentState): Promise<void> {
  await writeJsonAtomic(stateFile(workspace, state.id), state)
}

/**
 * Load the current incident.
 * @param workspace - absolute session workspace.
 * @param options - `required: true` throws when nobody called oncall yet.
 * @returns the state, or null when absent and not required.
 */
export async function loadCurrent(workspace: string, options: { required: boolean }): Promise<IncidentState | null> {
  const pointer = await readJson(currentFile(workspace))
  if (pointer === null) {
    if (options.required) throw new Error('当前工作区没有进行中的故障：先调用 incident_oncall 启动')
    return null
  }
  const id = isRecord(pointer) && typeof pointer.id === 'string' ? pointer.id : ''
  if (id === '') throw new Error('当前故障指针损坏：缺少 id，请重新 incident_oncall')
  const raw = await readJson(stateFile(workspace, id))
  if (raw === null) throw new Error(`当前故障指针指向不存在的状态文件：.incident/${id}/state.json`)
  return parseState(raw)
}

/**
 * Append one mitigation row and mark recovery on the first `worked` outcome.
 * @returns whether this call flipped the incident to recovered.
 */
export function addMitigation(state: IncidentState, input: MitigateInput): boolean {
  state.timeline.push({
    at: input.at,
    phase: 'mitigate',
    action: clip(input.action, 400),
    result: input.result,
    note: clip(input.note, 600),
    kind: input.kind,
  })
  if (input.result === 'worked' && (state.recoveredAt === null || Date.parse(input.at) < Date.parse(state.recoveredAt))) {
    // Recovery time is the earliest effective action, even when a backfilled
    // entry arrives after a later one. MTTR must not grow because of ordering.
    const firstRecovery = state.recoveredAt === null
    state.recoveredAt = input.at
    state.status = 'recovered'
    return firstRecovery
  }
  return false
}

/** Whole minutes between two ISO timestamps, never negative. */
export function minutesBetween(from: string, to: string): number {
  const delta = Date.parse(to) - Date.parse(from)
  if (!Number.isFinite(delta) || delta <= 0) return 0
  return Math.round(delta / 60_000)
}

/** MTTR in whole minutes, null while the incident is unresolved. */
export function mttrMinutes(state: IncidentState): number | null {
  return state.recoveredAt === null ? null : minutesBetween(state.startedAt, state.recoveredAt)
}

/** Minutes since the alert, using `now` for an unresolved incident. */
export function elapsedMinutes(state: IncidentState, now: string): number {
  return minutesBetween(state.startedAt, state.recoveredAt ?? now)
}

/** Count rows by outcome. */
export function countResults(state: IncidentState): Record<MitigationResult, number> {
  const counts: Record<MitigationResult, number> = { worked: 0, partial: 0, failed: 0 }
  for (const entry of state.timeline) {
    if (entry.phase !== 'mitigate') continue
    if (entry.result === 'worked' || entry.result === 'partial' || entry.result === 'failed') counts[entry.result] += 1
  }
  return counts
}
