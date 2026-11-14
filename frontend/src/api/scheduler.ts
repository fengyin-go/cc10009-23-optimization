import { SEED_ROWS } from '@/data/seed'
import { listRows, saveRows } from '@/data/local-store'
import { isValidScheduleExpression, matchesScheduleExpression } from '@/data/schedule-expression'
import {
  addMinuteKeys,
  compareMinuteKeys,
  compareRulesForRound,
  ensureRuleStates,
  expressionAt,
  isRuleActiveAt,
  isRuleEnabled,
  minuteKey,
  readScheduleRules,
  syncExpressionHistory,
  type ScheduleRule,
} from '@/data/schedule-rules'
import {
  backfillFloor,
  batchViews,
  compensationRunOf,
  pendingTasks,
  reloadSchedulerState,
  saveSchedulerState,
  schedulerState,
} from '@/data/scheduler-store'
import type { EntryRow } from '@/data/types'
import type {
  BatchSource,
  BatchStatus,
  BatchView,
  CompensationResult,
  CompensationRun,
  ExecutionBatch,
  ExecutionTask,
  PendingTaskView,
  PlanOrderItem,
  PlanResult,
  ScheduleRuleState,
  SchedulerState,
} from '@/data/scheduler-types'

/**
 * 调度执行链路。
 *
 * 规则 -> 本轮计划（batch）-> 采集任务待执行清单（execution task）-> 执行结果。
 * 所有写操作都以「规则 + 计划分钟」的 batchKey 作为幂等键，
 * 因此重复生成本轮计划、重复补偿、并发补偿都只会产生一份批次与任务。
 */

const LOCK_KEY = 'scraper-config-studio:scheduler-lock'
const LOCK_TTL_MS = 10_000

type LockRecord = { token: string; at: number }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readLock(): LockRecord | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(LOCK_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as LockRecord
    return parsed && typeof parsed.token === 'string' ? parsed : null
  } catch {
    return null
  }
}

function writeLock(lock: LockRecord | null): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  if (lock === null) {
    window.localStorage.removeItem(LOCK_KEY)
  } else {
    window.localStorage.setItem(LOCK_KEY, JSON.stringify(lock))
  }
}

/**
 * 抢占调度写锁：先写入自己的 token，再回读确认。
 * 两个并发调用里只有回读到自己 token 的那个能继续，另一个拿不到锁，
 * 从而保证“并发创建补偿批次只生效一次”。
 */
function acquireLock(): string | null {
  const current = readLock()
  if (current && Date.now() - current.at < LOCK_TTL_MS) {
    return null
  }
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  writeLock({ token, at: Date.now() })
  const confirmed = readLock()
  return confirmed && confirmed.token === token ? token : null
}

function releaseLock(token: string): void {
  const current = readLock()
  if (current && current.token === token) {
    writeLock(null)
  }
}

/** 已存在的调度批次按 batchKey 去重（多标签页 / 历史脏数据兜底），永不新增第二条。 */
function dedupeBatches(state: SchedulerState): void {
  if (state.batches.length === 0) {
    return
  }
  const seen = new Map<string, ExecutionBatch>()
  for (const batch of [...state.batches].sort((left, right) => left.id - right.id)) {
    const keeper = seen.get(batch.batchKey)
    if (!keeper) {
      seen.set(batch.batchKey, batch)
      continue
    }
    keeper.taskIds = [...new Set([...keeper.taskIds, ...batch.taskIds])]
  }
  state.batches = [...seen.values()]
  state.tasks = state.tasks.filter((task) => seen.has(task.batchKey))
}

/** 当前调度时钟。演示环境可以推进分钟，用来复现“漏触发”与补偿。 */
export function schedulerClock(): string {
  const state = schedulerState()
  return state.clockMinute || minuteKey(new Date())
}

export function advanceClock(minutes = 1): string {
  const state = schedulerState()
  state.clockMinute = addMinuteKeys(schedulerClock(), Math.max(1, Math.floor(minutes)))
  saveSchedulerState(state)
  return state.clockMinute as string
}

export function resetClock(): string {
  const state = schedulerState()
  state.clockMinute = null
  saveSchedulerState(state)
  return schedulerClock()
}

export function setClock(minute: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(minute)) {
    throw new Error(`调度时钟格式应为 YYYY-MM-DDTHH:mm，收到 ${minute}`)
  }
  const state = schedulerState()
  state.clockMinute = minute
  saveSchedulerState(state)
  return minute
}

function batchKeyOf(ruleId: number, minute: string): string {
  return `${ruleId}@${minute}`
}

function taskRows(): EntryRow[] {
  const rows = listRows('spider')
  return rows.length > 0 ? rows : clone(SEED_ROWS.spider ?? [])
}

function ruleRows(): EntryRow[] {
  return listRows('schedule')
}

function queueSeqOf(state: SchedulerState, rule: ScheduleRule): number {
  return state.ruleStates[String(rule.ruleId)]?.queueSeq ?? rule.ruleId
}

/** 已启用规则按「优先级 -> 入队先后 -> 规则编号」稳定排序。 */
function enabledRules(rules: ScheduleRule[], state: SchedulerState): ScheduleRule[] {
  return rules
    .filter((rule) => isRuleEnabled(rule))
    .sort((left, right) =>
      compareRulesForRound(left, queueSeqOf(state, left), right, queueSeqOf(state, right)),
    )
}

function ruleExpressionAt(state: SchedulerState, rule: ScheduleRule, minute: string): string {
  const ruleState = state.ruleStates[String(rule.ruleId)]
  return ruleState ? expressionAt(ruleState.expressionHistory, minute) : rule.expression
}

/** 采样某规则在某一分钟是否到期；计划与补偿共用同一口径。 */
function ruleFiresAt(expression: string, minute: string): boolean {
  const [datePart, timePart] = minute.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minuteOfHour] = timePart.split(':').map(Number)
  return matchesScheduleExpression(expression, new Date(year, month - 1, day, hour, minuteOfHour, 0, 0))
}

function rulesDueAt(rules: ScheduleRule[], state: SchedulerState, minute: string): ScheduleRule[] {
  return enabledRules(rules, state).filter(
    (rule) =>
      isRuleActiveAt(rule, minute) && ruleFiresAt(ruleExpressionAt(state, rule, minute), minute),
  )
}

function roundOrderOf(rule: ScheduleRule, state: SchedulerState, minute: string): number {
  const index = rulesDueAt(readScheduleRules(ruleRows()), state, minute).findIndex(
    (item) => item.ruleId === rule.ruleId,
  )
  return index >= 0 ? index + 1 : 1
}

function batchByKey(state: SchedulerState, key: string): ExecutionBatch | undefined {
  return state.batches.find((batch) => batch.batchKey === key)
}

/** 给批次挂一条执行任务；一个 batchKey 永远只有一条任务，重复调用会复用。 */
function attachTask(state: SchedulerState, batch: ExecutionBatch): ExecutionTask {
  const existing = state.tasks.find((task) => task.batchKey === batch.batchKey)
  if (existing) {
    batch.taskIds = [...new Set([...batch.taskIds, existing.id])]
    return existing
  }
  const rows = taskRows()
  const row = rows.length > 0 ? rows[(batch.id - 1) % rows.length] : null
  const id = (state.seq.task += 1)
  const task: ExecutionTask = {
    id,
    batchId: batch.id,
    batchKey: batch.batchKey,
    taskRowId: row ? Number(row.id) : 0,
    taskNo: row ? String(row['作业编号'] ?? `TASK-${row.id}`) : `TASK-${batch.id}`,
    site: row ? String(row['目标站点'] ?? batch.site) : batch.site,
    status: '待执行',
    triggerMinute: batch.triggerMinute,
    completedAt: null,
    updatedAt: minuteKey(new Date()),
  }
  batch.taskIds = [...new Set([...batch.taskIds, id])]
  state.tasks.push(task)
  return task
}

function createBatch(
  state: SchedulerState,
  rule: ScheduleRule,
  minute: string,
  roundOrder: number,
  expression: string,
  source: BatchSource,
): ExecutionBatch {
  const id = (state.seq.batch += 1)
  const batch: ExecutionBatch = {
    id,
    batchKey: batchKeyOf(rule.ruleId, minute),
    ruleId: rule.ruleId,
    ruleNo: rule.ruleNo,
    site: rule.site,
    expression,
    triggerMinute: minute,
    priority: rule.priority,
    maxConcurrency: rule.maxConcurrency,
    roundOrder,
    status: '待执行',
    source,
    createdAt: minuteKey(new Date()),
    startedAt: null,
    finishedAt: null,
    taskIds: [],
  }
  state.batches.push(batch)
  attachTask(state, batch)
  return batch
}

/** 把执行任务状态回写到采集任务模块，保证另一条链路的待执行清单同步。 */
function syncTaskRows(state: SchedulerState): void {
  const rows = taskRows()
  const referenced = new Set(state.tasks.map((task) => task.taskRowId))
  const next = rows.map((row) => {
    const rowId = Number(row.id)
    if (!referenced.has(rowId)) {
      return row
    }
    const related = state.tasks.filter((task) => task.taskRowId === rowId)
    let status: string
    if (related.some((task) => task.status === '执行中')) {
      status = '运行中'
    } else if (related.some((task) => task.status === '待执行')) {
      status = '待执行'
    } else if (related.some((task) => task.status === '已完成')) {
      status = '已完成'
    } else {
      status = '已失败'
    }
    if (String(row.status) === status) {
      return row
    }
    return {
      ...row,
      status,
      pending: status === '待执行' || status === '运行中',
    }
  })
  saveRows('spider', next)
}

function persist(state: SchedulerState): void {
  saveSchedulerState(state)
  syncTaskRows(state)
}

function snapshotSpider(): EntryRow[] {
  return clone(listRows('spider'))
}

function restore(snapshot: SchedulerState, spiderSnapshot: EntryRow[] | null): void {
  saveSchedulerState(snapshot)
  saveRows('spider', spiderSnapshot ?? clone(SEED_ROWS.spider ?? []))
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function planResult(message: string, minute: string): PlanResult {
  return {
    ok: false,
    minute,
    created: [],
    reused: [],
    order: [],
    compensation: { created: [], resumed: [], skipped: [] },
    message,
  }
}

/**
 * 生成本轮计划：只处理指定分钟（默认调度时钟当前分钟）。
 * 已存在的批次按 batchKey 复用，不重复建任务，也不改写历史批次的表达式快照。
 */
export function planRound(options: { now?: string } = {}): PlanResult {
  const minute = options.now ?? schedulerClock()
  // 写前对齐持久化状态：另一个标签页刚生成的批次要能看见。
  reloadSchedulerState()
  const token = acquireLock()
  if (!token) {
    return planResult('本轮计划正在生成，请稍后再试（并发写入只允许一次生效）', minute)
  }
  const state = schedulerState()
  const snapshot = clone(state)
  const spiderBefore = snapshotSpider()
  try {
    dedupeBatches(state)
    const rules = readScheduleRules(ruleRows())
    ensureRuleStates(state, rules, minute)
    const due = rulesDueAt(rules, state, minute)
    const created: string[] = []
    const reused: string[] = []
    const order: PlanOrderItem[] = due.map((rule, index) => {
      const key = batchKeyOf(rule.ruleId, minute)
      const existing = batchByKey(state, key)
      if (existing) {
        reused.push(key)
        return {
          roundOrder: existing.roundOrder,
          ruleId: rule.ruleId,
          ruleNo: rule.ruleNo,
          priority: rule.priority,
          maxConcurrency: rule.maxConcurrency,
          expression: existing.expression,
          triggerMinute: existing.triggerMinute,
          batchKey: key,
          status: existing.status,
          source: existing.source,
        }
      }
      const expression = ruleExpressionAt(state, rule, minute)
      const batch = createBatch(state, rule, minute, index + 1, expression, '正常')
      created.push(key)
      return {
        roundOrder: batch.roundOrder,
        ruleId: rule.ruleId,
        ruleNo: rule.ruleNo,
        priority: rule.priority,
        maxConcurrency: rule.maxConcurrency,
        expression: batch.expression,
        triggerMinute: batch.triggerMinute,
        batchKey: key,
        status: batch.status,
        source: batch.source,
      }
    })

    // 水位只在“紧接着上一分钟”时才推进；中间的缺口留给补偿，
    // 否则重复点击本轮计划会把没生成批次的分钟误标成已扫描。
    for (const rule of enabledRules(rules, state)) {
      const ruleState = state.ruleStates[String(rule.ruleId)]
      if (!ruleState || compareMinuteKeys(ruleState.lastScannedMinute, minute) >= 0) {
        continue
      }
      if (compareMinuteKeys(addMinuteKeys(ruleState.lastScannedMinute, 1), minute) === 0) {
        ruleState.lastScannedMinute = minute
      }
    }

    persist(state)
    const message =
      created.length > 0
        ? `本轮生成 ${created.length} 个执行批次，复用 ${reused.length} 个已存在批次`
        : due.length > 0
          ? `本轮 ${due.length} 条规则均已生成过批次，未重复创建`
          : '当前分钟没有到期的已启用规则'
    return {
      ok: true,
      minute,
      created,
      reused,
      order,
      compensation: { created: [], resumed: [], skipped: [] },
      message,
    }
  } catch (error) {
    restore(snapshot, spiderBefore)
    return planResult(
      error instanceof Error ? error.message : '本轮计划生成失败，已回退到原批次与原计划',
      minute,
    )
  } finally {
    releaseLock(token)
  }
}

type MissedOccurrence = {
  rule: ScheduleRule
  minute: string
  expression: string
  roundOrder: number
  priority: number
}

/**
 * 漏触发补偿：
 * - 只补「没有对应 batchKey」的分钟；已经存在（含已启动/已完成）的批次一律跳过；
 * - 同一规则同一区间只落一条补偿记录，重复补偿不会新增批次；
 * - 并发调用由写锁串行化，拿不到锁的一方不生效；
 * - 提交失败回退到调用前的批次与任务快照，并从缺口处继续补偿。
 */
export function compensate(options: { ruleIds?: number[]; now?: string } = {}): CompensationResult {
  const nowMinute = options.now ?? schedulerClock()
  const result = (partial: Partial<CompensationResult> = {}): CompensationResult => ({
    ok: true,
    code: 'NOOP',
    message: '',
    created: [],
    resumed: [],
    skipped: [],
    runs: [],
    ...partial,
  })
  // 写前对齐持久化状态：另一个标签页刚生成的批次要能看见。
  reloadSchedulerState()
  const token = acquireLock()
  if (!token) {
    return result({
      ok: false,
      code: 'BUSY',
      message: '另一个补偿任务正在提交，本次不会重复创建批次',
    })
  }
  const state = schedulerState()
  const snapshot = clone(state)
  const spiderBefore = snapshotSpider()
  try {
    dedupeBatches(state)
    const rules = readScheduleRules(ruleRows())
    ensureRuleStates(state, rules, nowMinute)
    const scope = enabledRules(rules, state).filter(
      (rule) =>
        (!options.ruleIds || options.ruleIds.includes(rule.ruleId)) && rule.compensationEnabled,
    )
    if (scope.length === 0) {
      return result({ code: 'NOOP', message: '没有可补偿的已启用调度规则' })
    }

    const existingKeys = new Set(state.batches.map((batch) => batch.batchKey))
    const missed: MissedOccurrence[] = []
    const skipped: string[] = []
    const windows = new Map<number, { from: string; to: string }>()

    for (const rule of scope) {
      const ruleState = state.ruleStates[String(rule.ruleId)]
      if (!ruleState) {
        continue
      }
      let from = backfillFloor(nowMinute, addMinuteKeys(ruleState.lastScannedMinute, 1))
      // 只补规则启用之后的分钟：停用期间不该产生计划。
      if (ruleState.enabledSince && compareMinuteKeys(from, ruleState.enabledSince) < 0) {
        from = backfillFloor(nowMinute, ruleState.enabledSince)
      }
      if (compareMinuteKeys(from, nowMinute) > 0) {
        continue
      }
      windows.set(rule.ruleId, { from, to: nowMinute })
      let cursor = from
      while (compareMinuteKeys(cursor, nowMinute) <= 0) {
        const minute = cursor
        cursor = addMinuteKeys(cursor, 1)
        if (!isRuleActiveAt(rule, minute)) {
          continue
        }
        const expression = ruleExpressionAt(state, rule, minute)
        if (!ruleFiresAt(expression, minute)) {
          continue
        }
        const key = batchKeyOf(rule.ruleId, minute)
        if (existingKeys.has(key)) {
          // 只补尚未执行的批次：已存在的一律不重复补。
          skipped.push(key)
          continue
        }
        missed.push({
          rule,
          minute,
          expression,
          roundOrder: roundOrderOf(rule, state, minute),
          priority: rule.priority,
        })
      }
    }

    if (missed.length === 0) {
      const priorRuns = [...windows.entries()]
        .map(([ruleId, window]) => compensationRunOf(state, `${ruleId}|${window.from}|${window.to}`))
        .filter((run): run is CompensationRun => Boolean(run))
      return result({
        code: priorRuns.length > 0 ? 'DUPLICATE' : 'NOOP',
        message:
          priorRuns.length > 0
            ? '该区间的漏触发批次已补偿过，本次未创建任何批次'
            : '没有发现漏触发的调度批次',
        skipped: dedupe(skipped),
        runs: priorRuns,
      })
    }

    // 先落「进行中」标记：进程若在提交途中断，下次补偿会从缺口继续。
    const resumed: string[] = []
    const runRecords = new Map<number, CompensationRun>()
    for (const [ruleId, window] of windows) {
      const runKey = `${ruleId}|${window.from}|${window.to}`
      const existing = state.compensationRuns.find((run) => run.runKey === runKey)
      if (existing) {
        if (existing.status === '进行中') {
          resumed.push(runKey)
        }
        existing.status = '进行中'
        runRecords.set(ruleId, existing)
      } else {
        const record: CompensationRun = {
          id: (state.seq.run += 1),
          runKey,
          ruleId,
          fromMinute: window.from,
          toMinute: window.to,
          created: [],
          resumed: [],
          skipped: [],
          status: '进行中',
          createdAt: minuteKey(new Date()),
        }
        state.compensationRuns.push(record)
        runRecords.set(ruleId, record)
      }
    }
    saveSchedulerState(state)

    missed.sort((left, right) => {
      if (left.minute !== right.minute) {
        return compareMinuteKeys(left.minute, right.minute)
      }
      if (left.priority !== right.priority) {
        return right.priority - left.priority
      }
      return left.roundOrder - right.roundOrder
    })

    const created: string[] = []
    const createdByRule = new Map<number, string[]>()
    for (const occurrence of missed) {
      const key = batchKeyOf(occurrence.rule.ruleId, occurrence.minute)
      if (batchByKey(state, key)) {
        continue
      }
      createBatch(
        state,
        occurrence.rule,
        occurrence.minute,
        occurrence.roundOrder,
        occurrence.expression,
        '补偿',
      )
      created.push(key)
      existingKeys.add(key)
      const list = createdByRule.get(occurrence.rule.ruleId) ?? []
      list.push(key)
      createdByRule.set(occurrence.rule.ruleId, list)
    }

    // 批次与扫描水位在同一次提交里落盘：提交失败会整体回退，下次补偿仍从缺口开始。
    for (const rule of scope) {
      const ruleState = state.ruleStates[String(rule.ruleId)]
      if (ruleState && compareMinuteKeys(ruleState.lastScannedMinute, nowMinute) < 0) {
        ruleState.lastScannedMinute = nowMinute
      }
    }

    const skippedByRule = new Map<number, string[]>()
    for (const key of skipped) {
      const ruleId = Number(key.split('@')[0])
      skippedByRule.set(ruleId, [...(skippedByRule.get(ruleId) ?? []), key])
    }

    const runs: CompensationRun[] = []
    for (const [ruleId, run] of runRecords) {
      run.created = dedupe([...run.created, ...(createdByRule.get(ruleId) ?? [])])
      run.resumed = dedupe([...run.resumed, ...(resumed.includes(run.runKey) ? [run.runKey] : [])])
      run.skipped = dedupe(skippedByRule.get(ruleId) ?? [])
      run.status = '成功'
      runs.push(run)
    }

    // 提交前再校验一次：任何 batchKey 都不能重复，否则视为提交失败并回退。
    const seen = new Set<string>()
    for (const batch of state.batches) {
      if (seen.has(batch.batchKey)) {
        throw new Error(`批次 ${batch.batchKey} 已存在，拒绝重复提交`)
      }
      seen.add(batch.batchKey)
    }

    persist(state)
    return result({
      ok: true,
      code: 'OK',
      message:
        `补偿 ${created.length} 个批次` +
        (resumed.length > 0 ? `，从 ${resumed.length} 条中断的补偿记录恢复` : '') +
        (skipped.length > 0 ? `，跳过 ${dedupe(skipped).length} 个已存在批次` : ''),
      created,
      resumed,
      skipped: dedupe(skipped),
      runs,
    })
  } catch (error) {
    restore(snapshot, spiderBefore)
    return result({
      ok: false,
      code: 'ROLLED_BACK',
      message: `补偿提交失败，已回退到原批次与原计划：${
        error instanceof Error ? error.message : String(error)
      }`,
      runs: [],
    })
  } finally {
    releaseLock(token)
  }
}

/**
 * 启动批次。同一分钟必须按 roundOrder 依次启动：
 * 高优先级先执行，同优先级按进入队列的先后。
 */
export function startBatch(batchId: number): { ok: boolean; message: string } {
  const state = reloadSchedulerState()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到编号为 ${batchId} 的执行批次` }
  }
  if (batch.status === '执行中') {
    return { ok: false, message: `执行批次 ${batch.batchKey} 已在执行中，无需重复启动` }
  }
  if (batch.status === '已完成' || batch.status === '已失败') {
    return {
      ok: false,
      message: `执行批次 ${batch.batchKey} 已经结束（${batch.status}），不能再次执行`,
    }
  }
  const earlier = state.batches.filter(
    (item) =>
      item.triggerMinute === batch.triggerMinute &&
      item.status === '待执行' &&
      item.roundOrder < batch.roundOrder,
  )
  if (earlier.length > 0) {
    return {
      ok: false,
      message: `本轮还有优先级更高的批次（${earlier[0].ruleNo}）未启动，请按轮次顺序执行`,
    }
  }
  const runningSameRule = state.batches.filter(
    (item) => item.ruleId === batch.ruleId && item.status === '执行中',
  ).length
  if (runningSameRule >= batch.maxConcurrency) {
    return {
      ok: false,
      message: `规则 ${batch.ruleNo} 已达最大并发 ${batch.maxConcurrency}，本轮批次需等待`,
    }
  }
  batch.status = '执行中'
  batch.startedAt = minuteKey(new Date())
  for (const task of state.tasks.filter((item) => item.batchId === batch.id)) {
    task.status = '执行中'
    task.updatedAt = minuteKey(new Date())
  }
  persist(state)
  return { ok: true, message: `批次 ${batch.batchKey} 已启动（第 ${batch.roundOrder} 轮）` }
}

/** 完成批次：任务移出待执行清单，采集任务清单同步为已完成。 */
export function completeBatch(batchId: number): { ok: boolean; message: string } {
  const state = reloadSchedulerState()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到编号为 ${batchId} 的执行批次` }
  }
  if (batch.status === '已完成') {
    return { ok: false, message: `执行批次 ${batch.batchKey} 已完成，重复提交不会再次生效` }
  }
  if (batch.status === '已失败') {
    return { ok: false, message: `执行批次 ${batch.batchKey} 已失败，请走重试而不是重复完成` }
  }
  batch.status = '已完成'
  batch.finishedAt = minuteKey(new Date())
  for (const task of state.tasks.filter((item) => item.batchId === batch.id)) {
    task.status = '已完成'
    task.completedAt = batch.finishedAt
    task.updatedAt = minuteKey(new Date())
  }
  persist(state)
  return { ok: true, message: `批次 ${batch.batchKey} 已完成，已从待执行清单移除` }
}

export function failBatch(batchId: number): { ok: boolean; message: string } {
  const state = reloadSchedulerState()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到编号为 ${batchId} 的执行批次` }
  }
  if (batch.status === '已失败') {
    return { ok: false, message: `执行批次 ${batch.batchKey} 已是失败状态` }
  }
  if (batch.status === '已完成') {
    return { ok: false, message: `执行批次 ${batch.batchKey} 已完成，不能再标记失败` }
  }
  batch.status = '已失败'
  batch.finishedAt = minuteKey(new Date())
  for (const task of state.tasks.filter((item) => item.batchId === batch.id)) {
    task.status = '已失败'
    task.updatedAt = minuteKey(new Date())
  }
  persist(state)
  return { ok: true, message: `批次 ${batch.batchKey} 已标记失败，不会进入待执行清单` }
}

/** 只读看板数据：执行计划页与采集任务页共用同一份状态。 */
export function scheduleBoard(): {
  minute: string
  batches: BatchView[]
  runs: CompensationRun[]
  ruleStates: Record<string, ScheduleRuleState>
  pending: PendingTaskView[]
} {
  const state = schedulerState()
  return {
    minute: schedulerClock(),
    batches: batchViews(state),
    runs: [...state.compensationRuns].sort((left, right) => right.id - left.id),
    ruleStates: state.ruleStates,
    pending: pendingTasks(state),
  }
}

export type ExpressionUpdateResult = {
  ok: boolean
  message: string
  history: { expression: string; effectiveFrom: string }[]
}

/**
 * 更新调度表达式：只写表达式历史，之后的计划按新表达式生成。
 * 已存在的批次保留创建时的表达式与触发时刻，不会被回写。
 */
export function updateRuleExpression(ruleId: number, expression: string): ExpressionUpdateResult {
  const trimmed = String(expression ?? '').trim()
  if (trimmed === '') {
    return { ok: false, message: '调度表达式不能为空', history: [] }
  }
  if (!isValidScheduleExpression(trimmed)) {
    return {
      ok: false,
      message: `调度表达式「${trimmed}」无法解析，支持 every Nm、HH:mm 或 5 段 cron`,
      history: [],
    }
  }
  const rows = ruleRows()
  const index = rows.findIndex((row) => Number(row.id) === ruleId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${ruleId} 的调度规则`, history: [] }
  }
  const minute = schedulerClock()
  const rules = readScheduleRules(rows)
  const state = reloadSchedulerState()
  ensureRuleStates(state, rules, minute)
  const ruleState = state.ruleStates[String(ruleId)]
  if (!ruleState) {
    return { ok: false, message: `调度规则 ${ruleId} 缺少运行态，无法变更表达式`, history: [] }
  }
  syncExpressionHistory(ruleState.expressionHistory, trimmed, minute)
  const next = [...rows]
  next[index] = { ...next[index], 调度表达式: trimmed }
  saveRows('schedule', next)
  saveSchedulerState(state)
  return {
    ok: true,
    message: `调度表达式已更新，从 ${minute} 之后生效，历史批次保留原表达式`,
    history: ruleState.expressionHistory.map((entry) => ({ ...entry })),
  }
}
