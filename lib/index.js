// src/host/index.ts
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import path2 from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/core/incident.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
var SEVERITIES = ["SEV1", "SEV2", "SEV3", "SEV4"];
var MITIGATION_RESULTS = ["worked", "partial", "failed"];
var ACTION_KINDS = ["restart", "rollback", "scale", "drain", "config", "network", "data", "other"];
var SIGNAL_CLASSES = ["memory", "database", "cpu", "error-rate", "timeout", "latency", "generic"];
function incidentRoot(workspace) {
  return path.join(workspace, ".incident");
}
function stateFile(workspace, id) {
  return path.join(incidentRoot(workspace), id, "state.json");
}
function currentFile(workspace) {
  return path.join(incidentRoot(workspace), "current.json");
}
function clip(value, max) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`;
}
function stamp(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}
async function uniqueId(workspace, base) {
  let id = base;
  let suffix = 2;
  while (await readJson(stateFile(workspace, id)) !== null) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}
async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, "utf8");
  await rename(temporary, file);
}
async function readJson(file) {
  try {
    const text2 = await readFile(file, "utf8");
    return JSON.parse(text2);
  } catch (cause) {
    const code = cause.code;
    if (code === "ENOENT") return null;
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6 ${file}\uFF1A${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseEntry(value) {
  if (!isRecord(value)) return null;
  const { at, phase, action, result, note, kind } = value;
  if (typeof at !== "string" || typeof action !== "string") return null;
  if (phase !== "alert" && phase !== "mitigate" && phase !== "postmortem") return null;
  return {
    at,
    phase,
    action,
    result: typeof result === "string" ? result : "",
    note: typeof note === "string" ? note : "",
    kind: ACTION_KINDS.includes(kind) ? kind : "other"
  };
}
function parseState(value) {
  if (!isRecord(value)) throw new Error("\u6545\u969C\u72B6\u6001\u6587\u4EF6\u4E0D\u662F\u5BF9\u8C61");
  const { id, title, service, severity, startedAt, symptoms, signal, status, recoveredAt, timeline } = value;
  if (typeof id !== "string" || typeof title !== "string" || typeof startedAt !== "string") {
    throw new Error("\u6545\u969C\u72B6\u6001\u6587\u4EF6\u7F3A\u5C11 id/title/startedAt");
  }
  const entries = Array.isArray(timeline) ? timeline.map(parseEntry).filter((entry) => entry !== null) : [];
  return {
    id,
    title,
    service: typeof service === "string" ? service : "",
    severity: SEVERITIES.includes(severity) ? severity : "SEV2",
    startedAt,
    symptoms: typeof symptoms === "string" ? symptoms : "",
    signal: SIGNAL_CLASSES.includes(signal) ? signal : "generic",
    status: status === "recovered" || status === "closed" ? status : "active",
    recoveredAt: typeof recoveredAt === "string" ? recoveredAt : null,
    timeline: entries
  };
}
async function startIncident(workspace, input, signal) {
  const previous = await loadCurrent(workspace, { required: false });
  const state = {
    id: await uniqueId(workspace, `INC-${stamp(input.startedAt)}`),
    title: clip(input.alert, 160),
    service: clip(input.service, 80),
    severity: input.severity,
    startedAt: input.startedAt,
    symptoms: clip(input.symptoms, 2e3),
    signal,
    status: "active",
    recoveredAt: null,
    timeline: [{ at: input.startedAt, phase: "alert", action: `\u544A\u8B66\uFF1A${clip(input.alert, 160)}`, result: "", note: clip(input.symptoms, 600), kind: "other" }]
  };
  await saveState(workspace, state);
  await writeJsonAtomic(currentFile(workspace), { id: state.id });
  return { state, replacedPrevious: previous !== null && previous.status !== "closed" };
}
async function saveState(workspace, state) {
  await writeJsonAtomic(stateFile(workspace, state.id), state);
}
async function loadCurrent(workspace, options) {
  const pointer = await readJson(currentFile(workspace));
  if (pointer === null) {
    if (options.required) throw new Error("\u5F53\u524D\u5DE5\u4F5C\u533A\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u6545\u969C\uFF1A\u5148\u8C03\u7528 incident_oncall \u542F\u52A8");
    return null;
  }
  const id = isRecord(pointer) && typeof pointer.id === "string" ? pointer.id : "";
  if (id === "") throw new Error("\u5F53\u524D\u6545\u969C\u6307\u9488\u635F\u574F\uFF1A\u7F3A\u5C11 id\uFF0C\u8BF7\u91CD\u65B0 incident_oncall");
  const raw = await readJson(stateFile(workspace, id));
  if (raw === null) throw new Error(`\u5F53\u524D\u6545\u969C\u6307\u9488\u6307\u5411\u4E0D\u5B58\u5728\u7684\u72B6\u6001\u6587\u4EF6\uFF1A.incident/${id}/state.json`);
  return parseState(raw);
}
function addMitigation(state, input) {
  state.timeline.push({
    at: input.at,
    phase: "mitigate",
    action: clip(input.action, 400),
    result: input.result,
    note: clip(input.note, 600),
    kind: input.kind
  });
  if (input.result === "worked" && (state.recoveredAt === null || Date.parse(input.at) < Date.parse(state.recoveredAt))) {
    const firstRecovery = state.recoveredAt === null;
    state.recoveredAt = input.at;
    state.status = "recovered";
    return firstRecovery;
  }
  return false;
}
function minutesBetween(from, to) {
  const delta = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.round(delta / 6e4);
}
function mttrMinutes(state) {
  return state.recoveredAt === null ? null : minutesBetween(state.startedAt, state.recoveredAt);
}
function elapsedMinutes(state, now) {
  return minutesBetween(state.startedAt, state.recoveredAt ?? now);
}
function countResults(state) {
  const counts = { worked: 0, partial: 0, failed: 0 };
  for (const entry of state.timeline) {
    if (entry.phase !== "mitigate") continue;
    if (entry.result === "worked" || entry.result === "partial" || entry.result === "failed") counts[entry.result] += 1;
  }
  return counts;
}

// src/core/fault-tree.ts
function adv(text2, kind) {
  return kind === void 0 ? { text: text2 } : { text: text2, kind };
}
var RULES = [
  { signal: "memory", pattern: /oom|out\s*of\s*memory|内存|堆内存|heap|gc\s*pause|memory\s*leak/i },
  { signal: "database", pattern: /mysql|postgres|redis|mongo|连接池|pool\s*exhaust|slow\s*query|慢查询|deadlock|死锁|数据库/i },
  { signal: "cpu", pattern: /cpu|load\s*average|负载|满载|线程池|thread\s*pool/i },
  { signal: "timeout", pattern: /timeout|超时|deadline|timed\s*out|504|网关超时/i },
  { signal: "error-rate", pattern: /5\d\d|error\s*rate|错误率|panic|exception|crash|崩溃|熔断/i },
  { signal: "latency", pattern: /latency|p9\d|延迟|响应慢|慢请求|\brt\b/i }
];
var BRANCHES = {
  memory: {
    label: "\u5185\u5B58 / OOM",
    hypotheses: [
      { cause: "\u5806\u5185\u5B58\u6CC4\u6F0F\uFF08\u957F\u751F\u547D\u5468\u671F\u7F13\u5B58\u6216\u672A\u91CA\u653E\u5BF9\u8C61\uFF09", confidence: 45, evidence: "\u5185\u5B58\u6301\u7EED\u4E0A\u6DA8\u4E14\u91CD\u542F\u540E\u7F13\u6162\u590D\u73B0" },
      { cause: "\u5355\u6B21\u5927\u8BF7\u6C42/\u5927\u6587\u4EF6\u628A\u5806\u6253\u6EE1", confidence: 30, evidence: "\u6545\u969C\u524D\u6709\u6279\u91CF\u5BFC\u5165\u6216\u5927\u67E5\u8BE2" },
      { cause: "\u5B9E\u4F8B\u5185\u5B58\u914D\u989D\u8FC7\u5C0F\uFF0C\u6B63\u5E38\u5CF0\u503C\u5373\u89E6\u9876", confidence: 15, evidence: "\u5386\u53F2\u5185\u5B58\u4F7F\u7528\u957F\u671F\u8D34\u8FD1\u4E0A\u9650" },
      { cause: "GC \u53C2\u6570\u4E0D\u5F53\u5BFC\u81F4\u56DE\u6536\u8DDF\u4E0D\u4E0A", confidence: 10, evidence: "GC \u505C\u987F\u65F6\u95F4\u968F\u8D1F\u8F7D\u7EBF\u6027\u4E0A\u5347" }
    ],
    checklist: [
      "\u786E\u8BA4 OOM \u53D1\u751F\u65F6\u95F4\u70B9\u4E0E\u6700\u8FD1\u4E00\u6B21\u53D1\u5E03/\u914D\u7F6E\u53D8\u66F4\u7684\u65F6\u95F4\u5DEE",
      "\u6293\u53D6\u4E00\u4EFD\u5806\u5FEB\u7167\u4E0E GC \u65E5\u5FD7\uFF08\u91CD\u542F\u524D\u4F18\u5148\uFF09",
      "\u786E\u8BA4\u5355\u5B9E\u4F8B\u5185\u5B58\u4E0A\u9650\u4E0E\u5F53\u524D\u5B9E\u9645\u7528\u91CF",
      "\u6269\u5BB9\u6216\u91CD\u542F\u4E00\u4E2A\u5B9E\u4F8B\u6B62\u8840\uFF0C\u4FDD\u7559\u5176\u4F59\u5B9E\u4F8B\u73B0\u573A",
      "\u6309\u300C\u6700\u8FD1\u53D8\u66F4\u300D\u4F18\u5148\u56DE\u6EDA"
    ],
    escalation: [
      adv("\u4E0D\u8981\u8FDE\u7EED\u91CD\u542F\uFF1A\u5148\u4FDD\u5B58\u5806\u5FEB\u7167\u4E0E GC \u65E5\u5FD7\uFF0C\u5426\u5219\u8BC1\u636E\u4E22\u5931"),
      adv("\u5BF9\u6BD4\u6545\u969C\u524D\u540E\u5185\u5B58\u66F2\u7EBF\uFF0C\u786E\u8BA4\u662F\u7A81\u589E\u8FD8\u662F\u7F13\u6162\u4E0A\u6DA8"),
      adv("\u82E5\u4E3A\u7A81\u589E\uFF0C\u5B9A\u4F4D\u6545\u969C\u65F6\u95F4\u7A97\u5185\u7684\u5F02\u5E38\u8BF7\u6C42\uFF08\u5927\u6587\u4EF6\u3001\u6279\u91CF\u4EFB\u52A1\u3001\u9012\u5F52\u67E5\u8BE2\uFF09"),
      adv("\u82E5\u4E3A\u7F13\u6162\u4E0A\u6DA8\uFF0C\u5F00\u542F\u5185\u5B58\u91C7\u6837\u5E76\u89C2\u5BDF 30 \u5206\u949F\uFF0C\u518D\u51B3\u5B9A\u56DE\u6EDA\u8FD8\u662F\u4FEE\u6CC4\u6F0F", "rollback")
    ],
    stabilize: [
      adv("\u628A\u4E34\u65F6\u6269\u5BB9\u4FDD\u7559\u5230\u6839\u56E0\u786E\u8BA4\u4E4B\u540E\uFF0C\u907F\u514D\u4E8C\u6B21 OOM"),
      adv("\u4E3A\u5185\u5B58\u7528\u91CF\u8BBE\u7F6E 80%/90% \u4E24\u7EA7\u544A\u8B66"),
      adv("\u8BB0\u5F55\u672C\u6B21\u5CF0\u503C\uFF0C\u53CD\u63A8\u5BB9\u91CF\u6C34\u4F4D")
    ]
  },
  database: {
    label: "\u6570\u636E\u5E93 / \u8FDE\u63A5\u6C60",
    hypotheses: [
      { cause: "\u6162\u67E5\u8BE2\u6216\u7F3A\u5931\u7D22\u5F15\u628A\u8FDE\u63A5\u957F\u671F\u5360\u4F4F", confidence: 40, evidence: "\u67E5\u8BE2\u8017\u65F6\u4E0E\u8FDE\u63A5\u6570\u540C\u65F6\u4E0A\u5347" },
      { cause: "\u8FDE\u63A5\u6C60\u8017\u5C3D\uFF08\u6CC4\u6F0F\u6216\u4E0A\u9650\u504F\u5C0F\uFF09", confidence: 30, evidence: "\u83B7\u53D6\u8FDE\u63A5\u7B49\u5F85\u65F6\u95F4\u5347\u9AD8" },
      { cause: "\u6570\u636E\u5E93\u4E3B\u4ECE\u5207\u6362/\u9501\u7B49\u5F85/\u6B7B\u9501", confidence: 20, evidence: "\u51FA\u73B0 lock wait \u6216 deadlock \u65E5\u5FD7" },
      { cause: "\u4E0B\u6E38\u6D41\u91CF\u7A81\u589E\u8D85\u8FC7\u6570\u636E\u5E93\u627F\u8F7D", confidence: 10, evidence: "QPS \u66F2\u7EBF\u5728\u6545\u969C\u524D\u9661\u589E" }
    ],
    checklist: [
      "\u62C9\u53D6\u5F53\u524D\u8FDE\u63A5\u6570\u3001\u7B49\u5F85\u961F\u5217\u4E0E\u6162\u67E5\u8BE2 Top N",
      "\u786E\u8BA4\u662F\u5426\u53D1\u751F\u4E3B\u4ECE\u5207\u6362\u6216\u9501\u7B49\u5F85\u5806\u79EF",
      "\u5B9A\u4F4D\u6545\u969C\u65F6\u95F4\u7A97\u5185\u65B0\u589E\u7684\u67E5\u8BE2\u6A21\u5F0F\uFF08\u53D1\u5E03\u3001\u5B9A\u65F6\u4EFB\u52A1\u3001\u722C\u866B\uFF09",
      "\u5FC5\u8981\u65F6\u9650\u6D41\u6216\u964D\u7EA7\u8BFB\u8BF7\u6C42\uFF0C\u907F\u514D\u8FDE\u63A5\u88AB\u6253\u6EE1",
      "\u786E\u8BA4\u5199\u5165\u662F\u5426\u4E22\u5931\uFF0C\u8BC4\u4F30\u662F\u5426\u9700\u8981\u8865\u507F"
    ],
    escalation: [
      adv("\u82E5\u8FDE\u63A5\u6C60\u8017\u5C3D\uFF1A\u5148\u786E\u8BA4\u662F\u6CC4\u6F0F\u8FD8\u662F\u5BB9\u91CF\u4E0D\u8DB3\uFF0C\u518D\u51B3\u5B9A\u6269\u6C60\u8FD8\u662F\u56DE\u6EDA\u4EE3\u7801"),
      adv("\u82E5\u6162\u67E5\u8BE2\u7A81\u589E\uFF1A\u5BF9\u6BD4\u6267\u884C\u8BA1\u5212\uFF0C\u786E\u8BA4\u662F\u5426\u56E0\u6570\u636E\u91CF\u6216\u7D22\u5F15\u53D8\u66F4"),
      adv("\u82E5\u9501\u7B49\u5F85\uFF1A\u627E\u51FA\u6301\u9501\u4E8B\u52A1\uFF0C\u8BC4\u4F30\u56DE\u6EDA\u6216\u7EC8\u6B62\u4F1A\u8BDD\u7684\u98CE\u9669"),
      adv("\u4EFB\u4F55\u7EC8\u6B62\u4F1A\u8BDD/\u5207\u4E3B\u64CD\u4F5C\u524D\uFF0C\u5148\u786E\u8BA4\u53EF\u63A5\u53D7\u7684\u5199\u5165\u635F\u5931")
    ],
    stabilize: [
      adv("\u628A\u9650\u6D41\u9608\u503C\u4FDD\u7559\u5230\u6570\u636E\u5E93\u6307\u6807\u56DE\u5230\u57FA\u7EBF"),
      adv("\u8865\u9F50\u6162\u67E5\u8BE2\u544A\u8B66\u4E0E\u8FDE\u63A5\u6C60\u6C34\u4F4D\u544A\u8B66"),
      adv("\u6838\u5BF9\u6545\u969C\u7A97\u53E3\u5185\u662F\u5426\u6709\u6570\u636E\u4E0D\u4E00\u81F4")
    ]
  },
  cpu: {
    label: "CPU / \u8D1F\u8F7D",
    hypotheses: [
      { cause: "\u70ED\u70B9\u4EE3\u7801\u6216\u6B63\u5219\u56DE\u6EAF\u5BFC\u81F4 CPU \u6253\u6EE1", confidence: 40, evidence: "\u5355\u5B9E\u4F8B CPU \u9AD8\u3001\u5176\u4ED6\u5B9E\u4F8B\u6B63\u5E38" },
      { cause: "\u6D41\u91CF\u7A81\u589E\u8D85\u8FC7\u5B9E\u4F8B\u627F\u8F7D", confidence: 30, evidence: "\u6240\u6709\u5B9E\u4F8B\u540C\u65F6\u5347\u9AD8\u4E14 QPS \u540C\u6B65\u4E0A\u5347" },
      { cause: "\u6B7B\u5FAA\u73AF\u6216\u9891\u7E41 GC", confidence: 20, evidence: "CPU \u66F2\u7EBF\u5448\u952F\u9F7F\u4E14\u4F34\u968F GC \u6D3B\u52A8" },
      { cause: "\u4E0A\u6E38\u91CD\u8BD5\u98CE\u66B4\u653E\u5927\u8BF7\u6C42\u91CF", confidence: 10, evidence: "\u8BF7\u6C42\u91CF\u8FDC\u9AD8\u4E8E\u6B63\u5E38\uFF0C\u4E14\u591A\u4E3A\u91CD\u590D\u8BF7\u6C42" }
    ],
    checklist: [
      "\u786E\u8BA4\u662F\u5355\u5B9E\u4F8B\u8FD8\u662F\u5168\u5B9E\u4F8B CPU \u9AD8",
      "\u6293\u53D6\u4E00\u4EFD CPU profile\uFF08\u91CD\u542F\u524D\u4F18\u5148\uFF09",
      "\u786E\u8BA4 QPS \u662F\u5426\u540C\u6B65\u4E0A\u5347\uFF0C\u533A\u5206\u6D41\u91CF\u95EE\u9898\u4E0E\u4EE3\u7801\u95EE\u9898",
      "\u6269\u5BB9\u6216\u6458\u9664\u5F02\u5E38\u5B9E\u4F8B\u6B62\u8840",
      "\u6392\u67E5\u6700\u8FD1\u53D1\u5E03\u4E0E\u5B9A\u65F6\u4EFB\u52A1"
    ],
    escalation: [
      adv("\u5148\u786E\u8BA4 QPS \u662F\u5426\u5F02\u5E38\uFF1B\u6D41\u91CF\u95EE\u9898\u4F18\u5148\u9650\u6D41\u800C\u4E0D\u662F\u6539\u4EE3\u7801", "config"),
      adv("\u5355\u5B9E\u4F8B\u5F02\u5E38\u4F18\u5148\u6458\u9664\u5E76\u4FDD\u7559\u73B0\u573A\uFF0C\u907F\u514D\u6574\u7EC4\u91CD\u542F\u63A9\u76D6\u95EE\u9898", "drain"),
      adv("\u786E\u8BA4\u4E0A\u6E38\u662F\u5426\u5728\u91CD\u8BD5\uFF1B\u91CD\u8BD5\u98CE\u66B4\u9700\u8981\u540C\u65F6\u52A0\u538B\u4E0A\u6E38\u9650\u6D41", "config"),
      adv("\u6293 profile \u540E\u518D\u56DE\u6EDA\uFF0C\u5426\u5219\u65E0\u6CD5\u786E\u8BA4\u70ED\u70B9")
    ],
    stabilize: [
      adv("\u89C2\u5BDF CPU \u56DE\u843D\u5E76\u4FDD\u6301 10 \u5206\u949F"),
      adv("\u6838\u5BF9\u5EF6\u8FDF\u4E0E\u9519\u8BEF\u7387\u662F\u5426\u540C\u6B65\u6062\u590D"),
      adv("\u8BB0\u5F55\u5CF0\u503C QPS \u4E0E\u5B9E\u4F8B\u6570\uFF0C\u66F4\u65B0\u5BB9\u91CF\u57FA\u7EBF")
    ]
  },
  "error-rate": {
    label: "\u9519\u8BEF\u7387 / 5xx",
    hypotheses: [
      { cause: "\u6700\u8FD1\u53D1\u5E03\u5F15\u5165\u7F3A\u9677", confidence: 40, evidence: "\u9519\u8BEF\u7387\u4E0E\u53D1\u5E03\u65F6\u95F4\u70B9\u91CD\u5408" },
      { cause: "\u4E0B\u6E38\u4F9D\u8D56\u6545\u969C\u88AB\u900F\u4F20", confidence: 25, evidence: "\u9519\u8BEF\u96C6\u4E2D\u5728\u8C03\u7528\u67D0\u4E2A\u4E0B\u6E38\u7684\u8DEF\u5F84\u4E0A" },
      { cause: "\u914D\u7F6E/\u8BC1\u4E66/\u5BC6\u94A5\u53D8\u66F4", confidence: 20, evidence: "\u9519\u8BEF\u4E3A 401/403/\u8BC1\u4E66\u8FC7\u671F\u7C7B" },
      { cause: "\u6D41\u91CF\u6216\u6570\u636E\u5F02\u5E38\u89E6\u53D1\u672A\u8986\u76D6\u5206\u652F", confidence: 15, evidence: "\u9519\u8BEF payload \u96C6\u4E2D\u5728\u5C11\u6570\u8F93\u5165\u5F62\u6001" }
    ],
    checklist: [
      "\u6309\u63A5\u53E3/\u9519\u8BEF\u7801\u62C6\u5206\u9519\u8BEF\u7387\uFF0C\u786E\u8BA4\u662F\u5426\u96C6\u4E2D\u5728\u5355\u4E00\u8DEF\u5F84",
      "\u5BF9\u7167\u6700\u8FD1\u4E00\u6B21\u53D1\u5E03\u4E0E\u914D\u7F6E\u53D8\u66F4\u65F6\u95F4",
      "\u786E\u8BA4\u4E0B\u6E38\u4F9D\u8D56\u5065\u5EB7\u72B6\u6001",
      "\u5FC5\u8981\u65F6\u56DE\u6EDA\u6700\u8FD1\u53D1\u5E03\u6216\u5173\u95ED\u76F8\u5173\u5F00\u5173",
      "\u4FDD\u7559\u9519\u8BEF\u6837\u672C\u4E0E trace id"
    ],
    escalation: [
      adv("\u4F18\u5148\u56DE\u6EDA\uFF1A\u9519\u8BEF\u7387\u7C7B\u6545\u969C\u7684\u56DE\u6EDA\u6536\u76CA\u901A\u5E38\u9AD8\u4E8E\u7EE7\u7EED\u5B9A\u4F4D", "rollback"),
      adv("\u82E5\u56DE\u6EDA\u65E0\u6548\uFF0C\u6309\u9519\u8BEF\u7801\u786E\u8BA4\u662F\u5426\u4E0B\u6E38\u900F\u4F20\uFF0C\u518D\u8054\u7CFB\u4E0B\u6E38"),
      adv("\u4FDD\u7559\u81F3\u5C11 20 \u6761\u9519\u8BEF\u6837\u672C\u4E0E trace\uFF0C\u907F\u514D\u56DE\u6EDA\u540E\u65E0\u6CD5\u590D\u76D8"),
      adv("\u786E\u8BA4\u662F\u5426\u6709\u6570\u636E\u5199\u574F\uFF0C\u8BC4\u4F30\u8865\u507F\u65B9\u6848", "data")
    ],
    stabilize: [
      adv("\u786E\u8BA4\u9519\u8BEF\u7387\u56DE\u5230\u57FA\u7EBF\u5E76\u4FDD\u6301 10 \u5206\u949F"),
      adv("\u89C2\u5BDF\u56DE\u6EDA\u540E\u662F\u5426\u6709\u5EF6\u8FDF\u6216\u961F\u5217\u79EF\u538B"),
      adv("\u628A\u672C\u6B21\u9519\u8BEF\u7801\u52A0\u5165\u76D1\u63A7\u770B\u677F")
    ]
  },
  timeout: {
    label: "\u8D85\u65F6 / \u7F51\u5173",
    hypotheses: [
      { cause: "\u4E0B\u6E38\u4F9D\u8D56\u54CD\u5E94\u53D8\u6162\u6216\u4E0D\u53EF\u8FBE", confidence: 40, evidence: "\u8D85\u65F6\u96C6\u4E2D\u5728\u8C03\u7528\u540C\u4E00\u4F9D\u8D56\u7684\u8DEF\u5F84" },
      { cause: "\u7F51\u7EDC\u94FE\u8DEF\u6296\u52A8\u6216 DNS \u5F02\u5E38", confidence: 25, evidence: "\u591A\u5B9E\u4F8B\u540C\u65F6\u8D85\u65F6\u4E14\u4E0E\u6D41\u91CF\u65E0\u5173" },
      { cause: "\u7EBF\u7A0B/\u8FDE\u63A5\u6C60\u88AB\u6162\u8BF7\u6C42\u5360\u6EE1", confidence: 20, evidence: "\u961F\u5217\u957F\u5EA6\u4E0E\u7B49\u5F85\u65F6\u95F4\u540C\u65F6\u4E0A\u5347" },
      { cause: "\u8D85\u65F6\u9608\u503C\u8BBE\u7F6E\u4E0D\u5408\u7406", confidence: 15, evidence: "P99 \u957F\u671F\u8D34\u8FD1\u9608\u503C" }
    ],
    checklist: [
      "\u786E\u8BA4\u8D85\u65F6\u662F\u5168\u5C40\u8FD8\u662F\u96C6\u4E2D\u5728\u67D0\u4E2A\u4E0B\u6E38",
      "\u68C0\u67E5 DNS \u89E3\u6790\u4E0E\u5230\u4E0B\u6E38\u7684\u7F51\u7EDC\u8FDE\u901A\u6027",
      "\u786E\u8BA4\u8FDE\u63A5\u6C60/\u5DE5\u4F5C\u7EBF\u7A0B\u662F\u5426\u88AB\u5360\u6EE1",
      "\u5BF9\u975E\u6838\u5FC3\u4F9D\u8D56\u505A\u964D\u7EA7\u6216\u7194\u65AD\u6B62\u8840",
      "\u4FDD\u7559\u8D85\u65F6\u8BF7\u6C42\u7684 trace \u4E0E\u4E0B\u6E38\u8017\u65F6\u5206\u5E03"
    ],
    escalation: [
      adv("\u91CD\u542F\u65E0\u6548\u65F6\u4F18\u5148\u67E5\u7F51\u7EDC\u94FE\u8DEF\u4E0E\u4E0B\u6E38\u5065\u5EB7\uFF0C\u800C\u4E0D\u662F\u7EE7\u7EED\u91CD\u542F", "network"),
      adv("\u786E\u8BA4\u662F\u5426\u4E3A\u91CD\u8BD5\u653E\u5927\uFF1A\u8D85\u65F6 + \u91CD\u8BD5\u4F1A\u8BA9\u4E0B\u6E38\u66F4\u6162"),
      adv("\u5BF9\u975E\u6838\u5FC3\u4F9D\u8D56\u5148\u964D\u7EA7\uFF0C\u4FDD\u4F4F\u6838\u5FC3\u94FE\u8DEF", "config"),
      adv("\u82E5\u4EC5\u4E2A\u522B\u5B9E\u4F8B\u8D85\u65F6\uFF0C\u6458\u9664\u5B9E\u4F8B\u5E76\u4FDD\u7559\u73B0\u573A", "drain")
    ],
    stabilize: [
      adv("\u786E\u8BA4 P99 \u56DE\u5230\u57FA\u7EBF\u5E76\u4FDD\u6301 10 \u5206\u949F"),
      adv("\u89E3\u9664\u4E34\u65F6\u964D\u7EA7\u524D\u5148\u786E\u8BA4\u4E0B\u6E38\u5DF2\u6062\u590D"),
      adv("\u590D\u6838\u8D85\u65F6\u4E0E\u91CD\u8BD5\u53C2\u6570\uFF0C\u907F\u514D\u4E0B\u6B21\u653E\u5927")
    ]
  },
  latency: {
    label: "\u5EF6\u8FDF / \u6162\u8BF7\u6C42",
    hypotheses: [
      { cause: "\u4E0B\u6E38\u6162\u8C03\u7528\u62D6\u7D2F\u6574\u4F53\u54CD\u5E94", confidence: 40, evidence: "\u6162\u8BF7\u6C42\u96C6\u4E2D\u5728\u8C03\u7528\u540C\u4E00\u4F9D\u8D56\u7684\u94FE\u8DEF" },
      { cause: "\u8D44\u6E90\u9971\u548C\uFF08CPU/\u8FDE\u63A5\u6C60/GC\uFF09", confidence: 30, evidence: "\u8D44\u6E90\u6307\u6807\u4E0E\u5EF6\u8FDF\u540C\u6B65\u4E0A\u5347" },
      { cause: "\u6D41\u91CF\u7A81\u589E\u6392\u961F", confidence: 20, evidence: "QPS \u4E0A\u5347\u4E14\u6392\u961F\u65F6\u95F4\u5360\u6BD4\u9AD8" },
      { cause: "\u6162\u67E5\u8BE2\u6216\u5927\u5BF9\u8C61\u5E8F\u5217\u5316", confidence: 10, evidence: "\u5EF6\u8FDF\u5206\u5E03\u5728\u7279\u5B9A\u63A5\u53E3" }
    ],
    checklist: [
      "\u6309\u63A5\u53E3\u62C6\u5206 P99\uFF0C\u786E\u8BA4\u6162\u5728\u5165\u53E3\u3001\u5185\u90E8\u8FD8\u662F\u4E0B\u6E38",
      "\u68C0\u67E5\u8D44\u6E90\u6C34\u4F4D\uFF08CPU\u3001\u8FDE\u63A5\u6C60\u3001GC\uFF09",
      "\u786E\u8BA4 QPS \u662F\u5426\u7A81\u589E",
      "\u5BF9\u6700\u6162\u63A5\u53E3\u505A\u9650\u6D41\u6216\u7F13\u5B58\u6B62\u8840",
      "\u4FDD\u7559\u6162\u8BF7\u6C42 trace"
    ],
    escalation: [
      adv("\u5148\u533A\u5206\u300C\u53D8\u6162\u300D\u4E0E\u300C\u6392\u961F\u300D\uFF1A\u6392\u961F\u7C7B\u4F18\u5148\u6269\u5BB9\u6216\u9650\u6D41", "scale"),
      adv("\u4E0B\u6E38\u6162\u8C03\u7528\u4F18\u5148\u964D\u7EA7\u975E\u6838\u5FC3\u4F9D\u8D56", "config"),
      adv("\u8D44\u6E90\u9971\u548C\u65F6\u4E0D\u8981\u76F2\u76EE\u6269\u5BB9\uFF0C\u5148\u786E\u8BA4\u662F\u5426\u5B58\u5728\u6CC4\u6F0F"),
      adv("\u4FDD\u7559 trace \u540E\u518D\u8C03\u6574\u53C2\u6570\uFF0C\u907F\u514D\u63A9\u76D6\u95EE\u9898")
    ],
    stabilize: [
      adv("\u786E\u8BA4 P99 \u4E0E\u9519\u8BEF\u7387\u540C\u65F6\u56DE\u5230\u57FA\u7EBF"),
      adv("\u89C2\u5BDF\u961F\u5217\u662F\u5426\u6E05\u7A7A"),
      adv("\u590D\u6838\u9650\u6D41\u9608\u503C\u4E0E\u5BB9\u91CF\u6C34\u4F4D")
    ]
  },
  generic: {
    label: "\u901A\u7528\u6545\u969C",
    hypotheses: [
      { cause: "\u6700\u8FD1\u4E00\u6B21\u53D8\u66F4\uFF08\u53D1\u5E03/\u914D\u7F6E/\u4F9D\u8D56\u5347\u7EA7\uFF09", confidence: 35, evidence: "\u6545\u969C\u65F6\u95F4\u4E0E\u53D8\u66F4\u65F6\u95F4\u63A5\u8FD1" },
      { cause: "\u8D44\u6E90\u9971\u548C\u6216\u5BB9\u91CF\u4E0D\u8DB3", confidence: 25, evidence: "\u8D44\u6E90\u6307\u6807\u8D34\u8FD1\u4E0A\u9650" },
      { cause: "\u4E0B\u6E38\u4F9D\u8D56\u5F02\u5E38", confidence: 25, evidence: "\u9519\u8BEF\u6216\u8D85\u65F6\u96C6\u4E2D\u5728\u4E0B\u6E38\u8C03\u7528" },
      { cause: "\u6D41\u91CF\u5F02\u5E38", confidence: 15, evidence: "QPS \u6216\u8BF7\u6C42\u5F62\u6001\u5F02\u5E38" }
    ],
    checklist: [
      "\u786E\u8BA4\u5F71\u54CD\u9762\uFF1A\u54EA\u4E9B\u7528\u6237\u3001\u63A5\u53E3\u3001\u5730\u57DF\u53D7\u5F71\u54CD",
      "\u5BF9\u7167\u6700\u8FD1\u53D8\u66F4\u65F6\u95F4\u7EBF",
      "\u68C0\u67E5\u6838\u5FC3\u4F9D\u8D56\u4E0E\u8D44\u6E90\u6C34\u4F4D",
      "\u9009\u62E9\u6536\u76CA\u6700\u9AD8\u7684\u6B62\u8840\u52A8\u4F5C\uFF08\u56DE\u6EDA/\u964D\u7EA7/\u6269\u5BB9\uFF09",
      "\u8BB0\u5F55\u65F6\u95F4\u7EBF\u4E0E\u52A8\u4F5C\u7ED3\u679C"
    ],
    escalation: [
      adv("\u7F29\u5C0F\u5F71\u54CD\u9762\uFF1A\u5148\u786E\u8BA4\u662F\u5355\u63A5\u53E3\u3001\u5355\u5B9E\u4F8B\u8FD8\u662F\u5168\u5C40"),
      adv("\u5BF9\u7167\u53D8\u66F4\u8BB0\u5F55\uFF0C\u56DE\u6EDA\u7C7B\u52A8\u4F5C\u4F18\u5148", "rollback"),
      adv("\u4FDD\u7559\u73B0\u573A\u8BC1\u636E\u540E\u518D\u91CD\u542F\u6216\u6269\u5BB9"),
      adv("\u6BCF\u505A\u4E00\u6B65\u8BB0\u5F55\u7ED3\u679C\uFF0C\u907F\u514D\u590D\u76D8\u65F6\u51ED\u8BB0\u5FC6")
    ],
    stabilize: [
      adv("\u786E\u8BA4\u6838\u5FC3\u6307\u6807\u56DE\u5230\u57FA\u7EBF"),
      adv("\u89C2\u5BDF 10 \u5206\u949F\u65E0\u53CD\u590D"),
      adv("\u6574\u7406\u5F85\u529E\u5E76\u751F\u6210\u590D\u76D8")
    ]
  }
};
function classify(symptoms) {
  for (const rule of RULES) {
    if (rule.pattern.test(symptoms)) return rule.signal;
  }
  return "generic";
}
function branchOf(signal) {
  return BRANCHES[signal];
}
function actionKindOf(action) {
  if (/回滚|rollback|revert|降级版本/i.test(action)) return "rollback";
  if (/重启|restart|reboot|reload/i.test(action)) return "restart";
  if (/扩容|scale|加机器|扩副本|提升规格/i.test(action)) return "scale";
  if (/摘除|下线|drain|摘流量|剔除/i.test(action)) return "drain";
  if (/配置|参数|开关|feature\s*flag|config|限流|熔断/i.test(action)) return "config";
  if (/网络|dns|链路|防火墙|安全组|network|proxy/i.test(action)) return "network";
  if (/数据|补偿|修数|回填|库表|索引|migration/i.test(action)) return "data";
  return "other";
}
function nextSteps(signal, result, attempted) {
  const branch = BRANCHES[signal];
  if (result === "worked") {
    return [
      "\u786E\u8BA4\u6838\u5FC3\u6307\u6807\uFF08\u9519\u8BEF\u7387/\u5EF6\u8FDF/\u8D44\u6E90\uFF09\u56DE\u5230\u57FA\u7EBF\u5E76\u4FDD\u6301 10 \u5206\u949F",
      "\u5BFC\u51FA\u6545\u969C\u65F6\u6BB5\u65E5\u5FD7\u3001\u76D1\u63A7\u5FEB\u7167\u4E0E trace \u7559\u6863",
      "\u7528 incident_postmortem \u751F\u6210\u590D\u76D8\u62A5\u544A\uFF0C\u518D\u8865\u6839\u56E0"
    ];
  }
  const steps = result === "partial" ? [...branch.stabilize, ...branch.escalation] : [...branch.escalation];
  const filtered = steps.filter((step) => step.kind === void 0 || !attempted.includes(step.kind));
  return filtered.map((step) => step.text).slice(0, 5);
}

// src/core/postmortem.ts
function html(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function cell(value) {
  return html(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
function inline(value) {
  return html(value).replace(/\r?\n/g, " ");
}
function text(value) {
  return html(value.replace(/\r/g, "").trim());
}
function sortedTimeline(state) {
  return state.timeline.slice().sort((left, right) => {
    const delta = Date.parse(left.at) - Date.parse(right.at);
    return Number.isFinite(delta) && delta !== 0 ? delta : 0;
  });
}
function clock(at, startedAt) {
  if (Date.parse(at) === 0) return "\u672A\u8BB0\u5F55";
  const sameDay = new Date(at).toISOString().slice(0, 10) === new Date(startedAt).toISOString().slice(0, 10);
  const time = at.slice(11, 19);
  return sameDay ? time : `${at.slice(0, 10)} ${time}`;
}
function timelineWhen(entry, startedAt) {
  return `${clock(entry.at, startedAt)}\uFF08+${minutesBetween(startedAt, entry.at)} \u5206\u949F\uFF09`;
}
function timelineTable(state) {
  const rows = sortedTimeline(state).map((entry) => {
    const result = entry.phase === "alert" ? "\u2014" : entry.phase === "postmortem" ? "\u5DF2\u751F\u6210" : entry.result === "worked" ? "\u6709\u6548" : entry.result === "partial" ? "\u90E8\u5206\u6709\u6548" : "\u65E0\u6548";
    return `| ${cell(timelineWhen(entry, state.startedAt))} | ${cell(entry.phase)} | ${cell(entry.action)} | ${cell(result)} | ${cell(entry.note === "" ? "\u2014" : entry.note)} |`;
  });
  return ["| \u65F6\u95F4 | \u9636\u6BB5 | \u52A8\u4F5C | \u7ED3\u679C | \u5907\u6CE8 |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}
function hypotheses(state) {
  const branch = branchOf(state.signal);
  return branch.hypotheses.map((item, index) => `${index + 1}. **${item.cause}**\uFF08\u521D\u59CB\u7F6E\u4FE1\u5EA6 ${item.confidence}\uFF09
   - \u5224\u65AD\u4F9D\u636E\uFF1A${item.evidence}`).join("\n");
}
function improvements(state) {
  const counts = countResults(state);
  const branch = branchOf(state.signal);
  const items = [];
  if (counts.failed > 0) {
    items.push(`\u590D\u76D8 ${counts.failed} \u6B21\u65E0\u6548\u52A8\u4F5C\uFF1A\u786E\u8BA4\u662F\u5224\u65AD\u9519\u8BEF\u3001\u4FE1\u606F\u7F3A\u5931\uFF0C\u8FD8\u662F\u52A8\u4F5C\u672C\u8EAB\u4E0D\u53EF\u7528`);
  }
  const wasRollback = state.timeline.some((entry) => entry.kind === "rollback");
  if (!wasRollback && (state.signal === "error-rate" || state.signal === "memory")) {
    items.push("\u628A\u300C\u56DE\u6EDA\u6700\u8FD1\u53D8\u66F4\u300D\u524D\u79FB\u4E3A\u4E00\u7EA7\u6B62\u8840\u52A8\u4F5C\uFF0C\u5E76\u6F14\u7EC3\u4E00\u6B21");
  }
  for (const step of branch.checklist.slice(0, 2)) {
    items.push(`\u8865\u9F50\u53EF\u89C2\u6D4B\u6027\uFF1A${step}`);
  }
  items.push("\u5728\u672C\u5B63\u5EA6\u6F14\u7EC3\u4E00\u6B21\u540C\u7C7B\u6545\u969C\uFF0C\u9A8C\u8BC1\u672C\u6B21\u6539\u8FDB\u9879\u662F\u5426\u751F\u6548");
  return items.map((item) => `- [ ] ${item}`).join("\n");
}
function summary(state, mttr, elapsed) {
  const counts = countResults(state);
  const resolution = mttr === null ? `\u622A\u81F3 ${state.recoveredAt === null ? "\u5F53\u524D" : "\u8BB0\u5F55\u7ED3\u675F"}\u4ECD\u672A\u6062\u590D\uFF0C\u5DF2\u6301\u7EED ${elapsed} \u5206\u949F` : `\u9996\u6B21\u6709\u6548\u52A8\u4F5C\u540E\u6062\u590D\uFF0CMTTR ${mttr} \u5206\u949F`;
  return [
    `${state.severity} \u6545\u969C\u300C${inline(state.title)}\u300D${state.service === "" ? "" : `\u5F71\u54CD ${inline(state.service)}\uFF0C`}${resolution}\u3002`,
    `\u671F\u95F4\u5171\u8BB0\u5F55 ${counts.worked + counts.partial + counts.failed} \u4E2A\u7F13\u89E3\u52A8\u4F5C\uFF08\u6709\u6548 ${counts.worked} / \u90E8\u5206\u6709\u6548 ${counts.partial} / \u65E0\u6548 ${counts.failed}\uFF09\u3002`,
    `\u544A\u8B66\u7279\u5F81\u5F52\u4E3A\u300C${branchOf(state.signal).label}\u300D\uFF0C\u6839\u56E0\u5F85\u7528\u4E0B\u65B9\u5047\u8BBE\u9010\u6761\u6392\u9664\u3002`
  ].join("");
}
function renderPostmortem(state, options) {
  const mttr = mttrMinutes(state);
  const elapsed = elapsedMinutes(state, options.now);
  const counts = countResults(state);
  const blockers = sortedTimeline(state).filter((entry) => entry.phase === "mitigate" && entry.result === "failed");
  const lines = [
    `# \u6545\u969C\u590D\u76D8\uFF1A${inline(state.title)}`,
    "",
    `- \u4E8B\u6545\u7F16\u53F7\uFF1A${state.id}`,
    `- \u4E25\u91CD\u7EA7\u522B\uFF1A${state.severity}`,
    `- \u5F71\u54CD\u670D\u52A1\uFF1A${state.service === "" ? "\u672A\u586B\u5199" : inline(state.service)}`,
    `- \u5F00\u59CB\u65F6\u95F4\uFF1A${state.startedAt}`,
    `- \u6062\u590D\u65F6\u95F4\uFF1A${state.recoveredAt === null ? "\u5C1A\u672A\u6062\u590D" : state.recoveredAt}`,
    `- MTTR\uFF1A${mttr === null ? `\u672A\u6062\u590D\uFF08\u5DF2\u6301\u7EED ${elapsed} \u5206\u949F\uFF09` : `${mttr} \u5206\u949F`}`,
    `- \u72B6\u6001\uFF1A${state.status}`,
    `- \u6D89\u53CA\u52A8\u4F5C\uFF1A${counts.worked + counts.partial + counts.failed} \u4E2A\uFF08\u6709\u6548 ${counts.worked} / \u90E8\u5206 ${counts.partial} / \u65E0\u6548 ${counts.failed}\uFF09`,
    "- \u65F6\u95F4\u57FA\u51C6\uFF1AUTC\uFF08ISO 8601\uFF09"
  ];
  if (options.author !== "") lines.push(`- \u8BB0\u5F55\u4EBA\uFF1A${inline(options.author)}`);
  lines.push(
    "",
    "## 1. \u6458\u8981",
    "",
    summary(state, mttr, elapsed),
    "",
    "## 2. \u5F71\u54CD",
    "",
    state.service === "" ? "\u5F71\u54CD\u670D\u52A1\u672A\u5728\u544A\u8B66\u65F6\u586B\u5199\uFF0C\u8BF7\u8865\u5145\u53D7\u5F71\u54CD\u7684\u529F\u80FD\u3001\u7528\u6237\u89C4\u6A21\u4E0E\u65F6\u957F\u3002" : `- \u670D\u52A1\uFF1A${inline(state.service)}`,
    `- \u6301\u7EED\u65F6\u957F\uFF1A${mttr === null ? `${elapsed} \u5206\u949F\uFF08\u672A\u6062\u590D\uFF09` : `${mttr} \u5206\u949F`}`,
    "- \u7528\u6237\u5F71\u54CD\uFF1A\u5F85\u8865\u5145\uFF08\u53D7\u5F71\u54CD\u7528\u6237\u6570\u3001\u5931\u8D25\u8BF7\u6C42\u5360\u6BD4\u3001\u662F\u5426\u6709\u6570\u636E\u4E0D\u4E00\u81F4\uFF09",
    "",
    "## 3. \u65F6\u95F4\u7EBF",
    "",
    timelineTable(state),
    "",
    "## 4. \u6839\u56E0\u5206\u6790",
    "",
    "### 4.1 \u521D\u59CB\u5047\u8BBE\uFF08\u6309\u53EF\u80FD\u6027\u6392\u5E8F\uFF09",
    "",
    hypotheses(state),
    "",
    "### 4.2 \u5DF2\u9A8C\u8BC1\u7ED3\u8BBA",
    "",
    mttr === null ? "\u5C1A\u672A\u6062\u590D\uFF0C\u6682\u4E0D\u80FD\u786E\u8BA4\u6839\u56E0\u3002\u5B8C\u6210\u6062\u590D\u540E\u8BF7\u628A\u300C\u6709\u6548\u52A8\u4F5C\u300D\u5BF9\u5E94\u5230\u4E0A\u9762\u67D0\u6761\u5047\u8BBE\uFF0C\u5E76\u5220\u9664\u5176\u4F59\u5047\u8BBE\u6216\u6807\u6CE8\u300C\u5DF2\u6392\u9664\u300D\u3002" : "\u51FA\u73B0\u6709\u6548\u52A8\u4F5C\u5373\u8BF4\u660E\u670D\u52A1\u5DF2\u6062\u590D\uFF0C\u4F46\u6062\u590D\u4E0D\u7B49\u4E8E\u6839\u56E0\u786E\u8BA4\uFF1A\u8BF7\u628A\u6709\u6548\u52A8\u4F5C\u5BF9\u5E94\u5230\u4E0A\u9762\u67D0\u6761\u5047\u8BBE\uFF0C\u5E76\u5728\u590D\u76D8\u4F1A\u4E0A\u786E\u8BA4\u3002",
    "",
    "## 5. \u5904\u7F6E\u4E0E\u6062\u590D",
    "",
    state.timeline.filter((entry) => entry.phase === "mitigate").length === 0 ? "\u6CA1\u6709\u8BB0\u5F55\u7F13\u89E3\u52A8\u4F5C\u3002\u8BF7\u5728\u4E0B\u4E00\u6B21\u5148\u6267\u884C incident_mitigate \u8BB0\u5F55\u52A8\u4F5C\u4E0E\u7ED3\u679C\uFF0C\u5426\u5219\u590D\u76D8\u7F3A\u5C11\u4E8B\u5B9E\u4F9D\u636E\u3002" : sortedTimeline(state).filter((entry) => entry.phase === "mitigate").map((entry) => `- ${timelineWhen(entry, state.startedAt)} **${inline(entry.action)}** \u2192 ${entry.result}${entry.note === "" ? "" : `\uFF08${inline(entry.note)}\uFF09`}`).join("\n"),
    "",
    "## 6. \u963B\u585E\u70B9",
    "",
    blockers.length === 0 ? "\u672C\u6B21\u6CA1\u6709\u8BB0\u5F55\u65E0\u6548\u52A8\u4F5C\u3002" : blockers.map((entry) => `- ${inline(entry.action)}\uFF1A\u672A\u751F\u6548${entry.note === "" ? "" : `\uFF08${inline(entry.note)}\uFF09`}\uFF0C\u9700\u8981\u786E\u8BA4\u662F\u5426\u73AF\u5883\u4E0D\u5141\u8BB8\u6216\u5224\u65AD\u6709\u504F\u5DEE`).join("\n"),
    "",
    "## 7. \u6539\u8FDB\u9879",
    "",
    improvements(state),
    "",
    "## 8. \u7ECF\u9A8C\u6559\u8BAD",
    "",
    `- \u544A\u8B66\u7279\u5F81\uFF1A${text(state.symptoms) === "" ? "\u544A\u8B66\u65F6\u672A\u63D0\u4F9B\u75C7\u72B6\u6587\u672C\uFF0C\u4E0B\u6B21\u8BF7\u7C98\u8D34\u5173\u952E\u65E5\u5FD7\u6216\u6307\u6807\u3002" : `\u300C${text(state.symptoms).replace(/\r?\n/g, " ").slice(0, 300)}\u300D`}`,
    `- \u6B62\u8840\u987A\u5E8F\uFF1A\u5148\u4FDD\u5B58\u8BC1\u636E\uFF0C\u518D\u505A\u9AD8\u6536\u76CA\u52A8\u4F5C\uFF08\u56DE\u6EDA/\u964D\u7EA7/\u6269\u5BB9\uFF09\uFF0C\u6700\u540E\u624D\u91CD\u542F\u3002`,
    `- \u4E0B\u4E00\u6B21\u540C\u7C7B\u6545\u969C\u7684\u5165\u53E3\uFF1A\u76F4\u63A5\u8C03\u7528 incident_oncall\uFF0C\u6309\u300C${branchOf(state.signal).label}\u300D\u5206\u652F\u6E05\u5355\u63A8\u8FDB\u3002`,
    ""
  );
  return lines.join("\n");
}

// src/host/index.ts
var name = "incident-full-chain";
var inject = ["tools"];
function workspaceOf(exec) {
  const view = exec;
  const cwd = view.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}
function isoOr(value, fallback) {
  if (value === void 0) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`\u65F6\u95F4\u683C\u5F0F\u65E0\u6CD5\u89E3\u6790\uFF1A${value}\uFF08\u8BF7\u7528 ISO 8601\uFF0C\u4F8B\u5982 2026-11-18T10:30:00+08:00\uFF09`);
  return new Date(parsed).toISOString();
}
var HYPOTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    cause: { type: "string", required: true },
    confidence: { type: "integer", required: true },
    evidence: { type: "string", required: true }
  }
};
function rank(hypotheses2) {
  return hypotheses2.map((item, index) => `${index + 1}. ${item.cause}\uFF08${item.confidence}\uFF09`).join("\n");
}
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "incident_oncall",
    description: [
      "Start (or restart) an incident in the current workspace: classify the alert family from the symptom text, rank the likely causes, and return an ordered first-response checklist.",
      "Persists `.incident/current.json` and `.incident/<id>/state.json`; a later incident_mitigate continues the same incident even in a new process.",
      "Call this first when an alert fires, before changing anything. Use the returned checklist as the plan and record every step with incident_mitigate."
    ].join(" "),
    parameters: {
      alert: { type: "string", required: true, description: "\u4E00\u884C\u544A\u8B66\u63CF\u8FF0\uFF0C\u4F8B\u5982\u300Capi \u7F51\u5173 5xx \u9519\u8BEF\u7387 12%\u300D" },
      symptoms: { type: "string", description: "\u5173\u952E\u75C7\u72B6\uFF1A\u65E5\u5FD7\u7247\u6BB5\u3001\u9519\u8BEF\u7801\u3001\u76D1\u63A7\u6307\u6807\u3002\u7528\u4E8E\u5F52\u7C7B\u544A\u8B66\u65CF\u4E0E\u6392\u5E8F\u5047\u8BBE" },
      service: { type: "string", description: "\u53D7\u5F71\u54CD\u670D\u52A1/\u6A21\u5757\u540D" },
      severity: { type: "string", enum: SEVERITIES, description: "SEV1\uFF08\u5168\u7AD9\u4E0D\u53EF\u7528\uFF09\u5230 SEV4\uFF08\u8F7B\u5FAE\uFF09\uFF0C\u9ED8\u8BA4 SEV2" },
      at: { type: "string", description: "\u544A\u8B66\u53D1\u751F\u65F6\u95F4\uFF08ISO 8601\uFF09\uFF1B\u9ED8\u8BA4\u5F53\u524D\u65F6\u95F4\u3002\u8865\u5F55\u65F6\u586B\u5199\u771F\u5B9E\u65F6\u95F4" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          incidentId: { type: "string", required: true },
          title: { type: "string", required: true },
          service: { type: "string", required: true },
          severity: { type: "string", required: true, enum: SEVERITIES },
          signal: { type: "string", required: true },
          signalLabel: { type: "string", required: true },
          startedAt: { type: "string", required: true },
          hypotheses: { type: "array", required: true, items: HYPOTHESIS_SCHEMA },
          checklist: { type: "array", required: true, items: { type: "string" } },
          replacedPrevious: { type: "boolean", required: true },
          statePath: { type: "string", required: true }
        }
      },
      render(_args, value) {
        return [{
          type: "text",
          text: [
            `### \u6545\u969C\u542F\u52A8 ${value.incidentId} \xB7 ${value.severity} \xB7 ${value.signalLabel}`,
            `**\u53EF\u80FD\u6839\u56E0\u6392\u5E8F**`,
            rank(value.hypotheses),
            "",
            "**\u5EFA\u8BAE\u6392\u67E5\u8DEF\u5F84**",
            value.checklist.map((step, index) => `${index + 1}. ${step}`).join("\n"),
            "",
            `\u6BCF\u505A\u4E00\u6B65\u7528 incident_mitigate \u8BB0\u5F55\u52A8\u4F5C\u4E0E\u7ED3\u679C\uFF1B\u6062\u590D\u540E\u8FD0\u884C incident_postmortem\u3002`
          ].join("\n")
        }];
      }
    },
    presentCall(args) {
      return { card: "generic", title: `\u6545\u969C\u542F\u52A8\uFF1A${args.alert}`, kind: "other", rawInput: { service: args.service, severity: args.severity } };
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(exec);
      const at = isoOr(args.at, (/* @__PURE__ */ new Date()).toISOString());
      const signal = classify(`${args.alert} ${args.symptoms ?? ""}`);
      const branch = branchOf(signal);
      const started = await startIncident(workspace, {
        alert: args.alert,
        service: args.service ?? "",
        severity: args.severity ?? "SEV2",
        symptoms: args.symptoms ?? "",
        startedAt: at
      }, signal);
      return {
        incidentId: started.state.id,
        title: started.state.title,
        service: started.state.service,
        severity: started.state.severity,
        signal,
        signalLabel: branch.label,
        startedAt: started.state.startedAt,
        hypotheses: branch.hypotheses.map((item) => ({ cause: item.cause, confidence: item.confidence, evidence: item.evidence })),
        checklist: [...branch.checklist],
        replacedPrevious: started.replacedPrevious,
        statePath: `.incident/${started.state.id}/state.json`
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: "incident_mitigate",
    description: [
      "Record one mitigation action and its result on the current incident timeline, then return the next step from the built-in fault tree.",
      "The first `worked` result marks the incident recovered and freezes MTTR; `partial` and `failed` move to the branch-specific escalation path, filtered so an already-failed action class is not suggested again.",
      "Always record what you actually did, even when it did not work \u2014 the postmortem is generated from this timeline only."
    ].join(" "),
    parameters: {
      action: { type: "string", required: true, description: "\u5B9E\u9645\u6267\u884C\u7684\u52A8\u4F5C\uFF0C\u4F8B\u5982\u300C\u56DE\u6EDA api \u5230 v1.42\u300D\u6216\u300C\u6269\u5BB9\u5230 6 \u526F\u672C\u300D" },
      result: { type: "string", required: true, enum: MITIGATION_RESULTS, description: "worked \u5DF2\u6062\u590D / partial \u90E8\u5206\u7F13\u89E3 / failed \u65E0\u6548" },
      note: { type: "string", description: "\u7ED3\u679C\u7EC6\u8282\uFF1A\u6307\u6807\u53D8\u5316\u3001\u62A5\u9519\u3001\u94FE\u63A5" },
      kind: { type: "string", enum: ACTION_KINDS, description: "\u52A8\u4F5C\u7C7B\u578B\uFF08\u4E0D\u586B\u5219\u6309 action \u6587\u672C\u63A8\u65AD\uFF09\uFF0C\u7528\u4E8E\u907F\u514D\u91CD\u590D\u5EFA\u8BAE" },
      at: { type: "string", description: "\u52A8\u4F5C\u6267\u884C\u65F6\u95F4\uFF08ISO 8601\uFF09\uFF1B\u9ED8\u8BA4\u5F53\u524D\u65F6\u95F4" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          recorded: { type: "boolean", required: true },
          recovered: { type: "boolean", required: true },
          recoveredNow: { type: "boolean", required: true },
          incidentId: { type: "string", required: true },
          mttrMinutes: { required: true, oneOf: [{ type: "integer" }, { type: "null" }] },
          elapsedMinutes: { type: "integer", required: true },
          actionCount: { type: "integer", required: true },
          nextSteps: { type: "array", required: true, items: { type: "string" } },
          warnings: { type: "array", required: true, items: { type: "string" } }
        }
      },
      render(_args, value) {
        return [{
          type: "text",
          text: [
            `\u52A8\u4F5C\u5DF2\u8BB0\u5F55\uFF08\u7B2C ${value.actionCount} \u4E2A\uFF09\u3002${value.recovered ? `\u5DF2\u6062\u590D\uFF0CMTTR ${value.mttrMinutes} \u5206\u949F\u3002` : `\u4ECD\u672A\u6062\u590D\uFF0C\u5DF2\u6301\u7EED ${value.elapsedMinutes} \u5206\u949F\u3002`}`,
            value.warnings.length === 0 ? "" : `\u6CE8\u610F\uFF1A${value.warnings.join("\uFF1B")}`,
            "**\u4E0B\u4E00\u6B65\u5EFA\u8BAE**",
            value.nextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")
          ].filter((line) => line !== "").join("\n")
        }];
      }
    },
    presentCall(args) {
      return { card: "generic", title: `\u8BB0\u5F55\u52A8\u4F5C\uFF1A${args.action}`, kind: "other", rawInput: { result: args.result } };
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(exec);
      const state = await loadCurrent(workspace, { required: true });
      const at = isoOr(args.at, (/* @__PURE__ */ new Date()).toISOString());
      const kind = args.kind ?? actionKindOf(args.action);
      const recoveredNow = addMitigation(state, {
        action: args.action,
        result: args.result,
        note: args.note ?? "",
        kind,
        at
      });
      await saveState(workspace, state);
      const attempted = state.timeline.filter((entry) => entry.phase === "mitigate").map((entry) => entry.kind);
      const warnings = [];
      if (state.recoveredAt !== null && Date.parse(at) > Date.parse(state.recoveredAt)) {
        warnings.push("\u6545\u969C\u5DF2\u6062\u590D\uFF0C\u672C\u6761\u52A8\u4F5C\u4E0D\u8BA1\u5165 MTTR\uFF08\u6309\u9996\u4E2A\u6709\u6548\u52A8\u4F5C\u8BA1\u65F6\uFF09");
      }
      if (args.result === "worked" && state.timeline.filter((entry) => entry.result === "worked").length > 1) {
        warnings.push("\u5DF2\u6709\u66F4\u65E9\u7684\u6709\u6548\u52A8\u4F5C\uFF0CMTTR \u4ECD\u4EE5\u9996\u6B21\u4E3A\u51C6");
      }
      const counts = countResults(state);
      if (!recoveredNow && counts.failed >= 3) {
        warnings.push("\u5DF2\u8FDE\u7EED 3 \u4E2A\u4EE5\u4E0A\u52A8\u4F5C\u65E0\u6548\uFF0C\u5EFA\u8BAE\u5148\u4FDD\u5B58\u73B0\u573A\u8BC1\u636E\u518D\u7EE7\u7EED\uFF0C\u907F\u514D\u63A9\u76D6\u771F\u5B9E\u6839\u56E0");
      }
      return {
        recorded: true,
        recovered: state.recoveredAt !== null,
        recoveredNow,
        incidentId: state.id,
        mttrMinutes: mttrMinutes(state),
        elapsedMinutes: elapsedMinutes(state, at),
        actionCount: counts.worked + counts.partial + counts.failed,
        nextSteps: nextSteps(state.signal, args.result, attempted),
        warnings
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: "incident_postmortem",
    description: [
      "Generate `postmortem.md` from the recorded incident timeline: summary, impact, timestamped timeline table, ranked hypotheses, mitigation log, blockers, improvement checklist, lessons.",
      "MTTR is computed from the alert time to the first `worked` action \u2014 never inferred from the model. The incident is marked closed and the file is written inside the session workspace.",
      "Run this after recovery, or mid-incident to snapshot progress; pass `output` to change the file name."
    ].join(" "),
    parameters: {
      output: { type: "string", description: "\u5DE5\u4F5C\u533A\u5185\u8F93\u51FA\u8DEF\u5F84\uFF0C\u9ED8\u8BA4 postmortem.md" },
      author: { type: "string", description: "\u590D\u76D8\u8BB0\u5F55\u4EBA" },
      at: { type: "string", description: "\u751F\u6210\u65F6\u95F4\uFF08ISO 8601\uFF09\uFF1B\u9ED8\u8BA4\u5F53\u524D\u65F6\u95F4\uFF0C\u7528\u4E8E\u8BA1\u7B97\u672A\u6062\u590D\u65F6\u957F" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          incidentId: { type: "string", required: true },
          mttrMinutes: { required: true, oneOf: [{ type: "integer" }, { type: "null" }] },
          actionCount: { type: "integer", required: true },
          closed: { type: "boolean", required: true },
          report: { type: "string", required: true }
        }
      },
      render(_args, value) {
        return [{
          type: "text",
          text: [
            `\u590D\u76D8\u62A5\u544A\u5DF2\u751F\u6210\uFF1A\`${value.path}\`\uFF08${value.mttrMinutes === null ? "\u5C1A\u672A\u6062\u590D" : `MTTR ${value.mttrMinutes} \u5206\u949F`} \xB7 ${value.actionCount} \u4E2A\u52A8\u4F5C\uFF09`,
            "",
            value.report
          ].join("\n")
        }];
      }
    },
    presentCall(args) {
      return { card: "generic", title: "\u751F\u6210\u590D\u76D8\u62A5\u544A", kind: "other", rawInput: { output: args.output } };
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(exec);
      const state = await loadCurrent(workspace, { required: true });
      const now = isoOr(args.at, (/* @__PURE__ */ new Date()).toISOString());
      const requested = args.output === void 0 || args.output.trim() === "" ? "postmortem.md" : args.output;
      const target = path2.resolve(workspace, requested);
      const relativeToWorkspace = path2.relative(workspace, target);
      if (relativeToWorkspace === "" || relativeToWorkspace.split(path2.sep)[0] === ".." || path2.isAbsolute(relativeToWorkspace)) {
        throw new Error("output \u5FC5\u987B\u4F4D\u4E8E\u5F53\u524D\u5DE5\u4F5C\u533A\u5185");
      }
      state.status = "closed";
      state.timeline.push({
        at: now,
        phase: "postmortem",
        action: `\u751F\u6210\u590D\u76D8\u62A5\u544A\uFF1A${relativeToWorkspace.split(path2.sep).join("/")}`,
        result: "",
        note: "",
        kind: "other"
      });
      const report = renderPostmortem(state, { author: args.author ?? "", now });
      await mkdir2(path2.dirname(target), { recursive: true });
      await writeFile2(target, report, "utf8");
      await saveState(workspace, state);
      const counts = countResults(state);
      return {
        path: relativeToWorkspace.split(path2.sep).join("/"),
        incidentId: state.id,
        mttrMinutes: mttrMinutes(state),
        actionCount: counts.worked + counts.partial + counts.failed,
        closed: true,
        report
      };
    }
  }));
}
export {
  apply,
  inject,
  name
};
