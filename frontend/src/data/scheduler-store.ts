import { addMinuteKeys, compareMinuteKeys, parseMinuteKey } from './schedule-rules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'
import type {
  BatchView,
  CompensationRun,
  ExecutionBatch,
  ExecutionTask,
  PendingTaskView,
  SchedulerState,
} from './scheduler-types'

/**
 * 调度运行态的本地持久化。
 * 与业务登记数据分开存放，重置业务模块不会冲掉执行批次与补偿记录。
 */
const SCHEDULER_KEY = 'scraper-config-studio:scheduler'

/** 表达式变更 / 长时间停机后，补偿最多回溯的天数，避免异常表达式把链路拖死。 */
const MAX_BACKFILL_MINUTES = 24 * 60

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyState(): SchedulerState {
  return {
    version: 1,
    clockMinute: null,
    seq: { batch: 0, task: 0, run: 0 },
    ruleStates: {},
    batches: [],
    tasks: [],
    compensationRuns: [],
  }
}

function seedSpiderRows(): EntryRow[] {
  return clone(SEED_ROWS.spider ?? [])
}

let cache: SchedulerState | null = null

/**
 * 状态修复。历史数据里可能出现同一 batchKey 的记录被写了两次
 * （重复补偿、并发补偿、页面重复提交），这里统一收敛成一份：
 * - 批次按 batchKey 去重，保留最早创建的那条，任务并入保留批次；
 * - 执行任务按 batchKey 去重，避免“同一执行批次显示成两条”；
 * - 补偿记录按 runKey 去重，避免“补跑记录重复显示”。
 */
function repairState(raw: unknown): SchedulerState {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') {
    return state
  }
  const source = raw as Partial<SchedulerState>
  state.clockMinute =
    typeof source.clockMinute === 'string' && parseMinuteKey(source.clockMinute)
      ? source.clockMinute
      : null
  if (source.seq && typeof source.seq === 'object') {
    state.seq = {
      batch: Number(source.seq.batch) || 0,
      task: Number(source.seq.task) || 0,
      run: Number(source.seq.run) || 0,
    }
  }
  state.ruleStates =
    source.ruleStates && typeof source.ruleStates === 'object' ? clone(source.ruleStates) : {}
  const rawBatches = Array.isArray(source.batches) ? clone(source.batches) : []
  const rawTasks = Array.isArray(source.tasks) ? clone(source.tasks) : []
  const rawRuns = Array.isArray(source.compensationRuns) ? clone(source.compensationRuns) : []

  rawBatches.sort((left, right) => left.id - right.id)
  const keeperByKey = new Map<string, ExecutionBatch>()
  const remapBatchId = new Map<number, number>()
  for (const batch of rawBatches) {
    batch.taskIds = Array.isArray(batch.taskIds) ? batch.taskIds : []
    const keeper = keeperByKey.get(batch.batchKey)
    if (keeper) {
      keeper.taskIds = [...new Set([...keeper.taskIds, ...batch.taskIds])]
      remapBatchId.set(batch.id, keeper.id)
      continue
    }
    keeperByKey.set(batch.batchKey, batch)
    remapBatchId.set(batch.id, batch.id)
  }
  state.batches = [...keeperByKey.values()].sort((left, right) => left.id - right.id)

  const taskByKey = new Map<string, ExecutionTask>()
  for (const task of rawTasks.sort((left, right) => left.id - right.id)) {
    if (taskByKey.has(task.batchKey)) {
      continue
    }
    const keeperBatchId = remapBatchId.get(task.batchId)
    if (keeperBatchId === undefined) {
      continue
    }
    task.batchId = keeperBatchId
    taskByKey.set(task.batchKey, task)
  }
  state.tasks = [...taskByKey.values()].sort((left, right) => left.id - right.id)

  // 批次的 taskIds 与真实任务表保持一致，避免展示重复任务号。
  for (const batch of state.batches) {
    batch.taskIds = state.tasks
      .filter((task) => task.batchId === batch.id)
      .map((task) => task.id)
  }

  const runByKey = new Map<string, CompensationRun>()
  for (const run of rawRuns.sort((left, right) => left.id - right.id)) {
    const keeper = runByKey.get(run.runKey)
    if (keeper) {
      keeper.created = [...new Set([...keeper.created, ...(run.created ?? [])])]
      keeper.resumed = [...new Set([...keeper.resumed, ...(run.resumed ?? [])])]
      keeper.skipped = [...new Set([...keeper.skipped, ...(run.skipped ?? [])])]
      if (run.status === '成功') {
        keeper.status = '成功'
      }
      continue
    }
    runByKey.set(run.runKey, run)
  }
  state.compensationRuns = [...runByKey.values()].sort((left, right) => left.id - right.id)
  return state
}

export function schedulerState(): SchedulerState {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = emptyState()
    return cache
  }
  const raw = window.localStorage.getItem(SCHEDULER_KEY)
  if (!raw) {
    cache = emptyState()
    return cache
  }
  try {
    cache = repairState(JSON.parse(raw))
  } catch {
    cache = emptyState()
  }
  return cache
}

export function saveSchedulerState(state: SchedulerState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SCHEDULER_KEY, JSON.stringify(state))
  }
}

/**
 * 放弃内存缓存并从 localStorage 重新读取。
 * 多个标签页共用同一份 localStorage 时，写操作前后都用它对齐，避免用旧内存状态覆盖别的页面刚写入的批次。
 */
export function reloadSchedulerState(): SchedulerState {
  cache = null
  return schedulerState()
}

export function resetSchedulerState(): void {
  cache = null
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(SCHEDULER_KEY)
  }
}

/** 采集任务模块的当前登记行；为空时用种子行兜底，保证执行任务有可落库的采集任务。 */
export function taskRowsForSync(): EntryRow[] {
  return seedSpiderRows()
}

function taskRowOf(taskRowId: number): EntryRow | null {
  return taskRowsForSync().find((row) => Number(row.id) === taskRowId) ?? null
}

/** 待执行清单：只包含尚未结束的执行任务，已完成/已失败的不会再出现。 */
export function pendingTasks(state: SchedulerState): PendingTaskView[] {
  const batchMap = new Map(state.batches.map((batch) => [batch.id, batch]))
  return state.tasks
    .filter((task) => task.status === '待执行' || task.status === '执行中')
    .map((task) => {
      const batch = batchMap.get(task.batchId)
      if (!batch) {
        return null
      }
      const row = taskRowOf(task.taskRowId)
      return {
        executionTaskId: task.id,
        batchId: task.batchId,
        batchKey: task.batchKey,
        ruleId: batch.ruleId,
        ruleNo: batch.ruleNo,
        priority: batch.priority,
        roundOrder: batch.roundOrder,
        triggerMinute: task.triggerMinute,
        expression: batch.expression,
        source: batch.source,
        batchStatus: batch.status,
        taskRowId: task.taskRowId,
        taskNo: task.taskNo,
        site: row ? String(row['目标站点'] ?? task.site) : task.site,
        status: task.status,
      }
    })
    .filter((view): view is PendingTaskView => view !== null)
    .sort((left, right) => {
      if (left.triggerMinute !== right.triggerMinute) {
        return compareMinuteKeys(left.triggerMinute, right.triggerMinute)
      }
      if (left.priority !== right.priority) {
        return right.priority - left.priority
      }
      return left.roundOrder - right.roundOrder
    })
}

/** 执行计划清单：每个 batchKey 一行，任务号按任务 id 去重。 */
export function batchViews(state: SchedulerState): BatchView[] {
  const tasksByBatch = new Map<number, ExecutionTask[]>()
  for (const task of state.tasks) {
    tasksByBatch.set(task.batchId, [...(tasksByBatch.get(task.batchId) ?? []), task])
  }
  return state.batches
    .map((batch) => {
      const tasks = (tasksByBatch.get(batch.id) ?? []).sort((a, b) => a.id - b.id)
      const active = tasks.find((task) => task.status === '执行中')
      return {
        ...batch,
        taskCount: tasks.length,
        taskNos: [...new Set(tasks.map((task) => task.taskNo))],
        taskStatus: active ? active.status : tasks[0]?.status ?? null,
      }
    })
    .sort((left, right) => {
      if (left.triggerMinute !== right.triggerMinute) {
        return compareMinuteKeys(left.triggerMinute, right.triggerMinute)
      }
      if (left.roundOrder !== right.roundOrder) {
        return left.roundOrder - right.roundOrder
      }
      return left.id - right.id
    })
}

export function compensationRunOf(
  state: SchedulerState,
  key: string,
): CompensationRun | undefined {
  return state.compensationRuns.find((run) => run.runKey === key)
}

export function backfillFloor(nowMinute: string, lastScannedMinute: string): string {
  const bounded = addMinuteKeys(nowMinute, -MAX_BACKFILL_MINUTES)
  return compareMinuteKeys(bounded, lastScannedMinute) > 0 ? bounded : lastScannedMinute
}
