/**
 * 调度执行链路的持久化结构。
 *
 * 设计要点：
 * - 执行批次用 batchKey（规则 + 计划触发分钟）唯一标识，正常计划与补偿共用同一把键，
 *   因此同一分钟的同一条规则无论被计算多少次、由哪条链路生成，都只会存在一个批次。
 * - 批次里保存的是表达式与触发时刻的快照，后续修改规则表达式不会回写历史批次。
 * - 规则进入队列的先后（queueSeq）与优先级一起决定同一分钟到期规则的轮次顺序。
 */

export type BatchStatus = '待执行' | '执行中' | '已完成' | '已失败'
export type BatchSource = '正常' | '补偿'

export type ExpressionHistoryEntry = {
  expression: string
  /** 分钟键（YYYY-MM-DDTHH:mm）。空字符串表示从最早开始生效。 */
  effectiveFrom: string
}

export type ScheduleRuleState = {
  ruleId: number
  /** 规则进入调度队列的序号，同优先级时用它裁决先后。 */
  queueSeq: number
  expressionHistory: ExpressionHistoryEntry[]
  /** 已经计算过计划的最后一分钟（含），用于判断漏触发区间。 */
  lastScannedMinute: string
  /** 当前是否处于已启用状态，用于检测启用/停用切换。 */
  enabled: boolean
  /** 最近一次启用时刻；补偿不会覆盖规则停用期间的分钟。 */
  enabledSince: string
}

export type ExecutionBatch = {
  id: number
  /** `${ruleId}@${triggerMinute}`，同一规则同一计划时刻的唯一键。 */
  batchKey: string
  ruleId: number
  ruleNo: string
  site: string
  /** 创建批次时的调度表达式快照。 */
  expression: string
  /** 计划触发时刻快照（分钟键）。 */
  triggerMinute: string
  priority: number
  maxConcurrency: number
  /** 本轮中的稳定顺序，从 1 开始；优先级高的在前，同优先级按入队先后。 */
  roundOrder: number
  status: BatchStatus
  source: BatchSource
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** 关联的执行任务 id（ExecutionTask.id）。 */
  taskIds: number[]
}

export type ExecutionTask = {
  id: number
  batchId: number
  batchKey: string
  /** 采集任务模块里的行 id。 */
  taskRowId: number
  taskNo: string
  site: string
  status: BatchStatus
  triggerMinute: string
  completedAt: string | null
  updatedAt: string
}

export type CompensationRunStatus = '进行中' | '成功' | '重复' | '回退'
export type CompensationResultCode = 'OK' | 'NOOP' | 'DUPLICATE' | 'BUSY' | 'ROLLED_BACK' | 'INVALID'

export type CompensationRun = {
  id: number
  /** `${ruleId}|${fromMinute}|${toMinute}`，同一次补偿扫描只落一条记录。 */
  runKey: string
  ruleId: number
  fromMinute: string
  toMinute: string
  created: string[]
  resumed: string[]
  skipped: string[]
  status: CompensationRunStatus
  createdAt: string
}

export type SchedulerState = {
  version: 1
  /** 手动推进的调度时钟；为 null 时跟随系统时间。 */
  clockMinute: string | null
  seq: { batch: number; task: number; run: number }
  ruleStates: Record<string, ScheduleRuleState>
  batches: ExecutionBatch[]
  tasks: ExecutionTask[]
  compensationRuns: CompensationRun[]
}

export type BatchView = ExecutionBatch & {
  taskCount: number
  taskNos: string[]
  taskStatus: BatchStatus | null
}

export type PendingTaskView = {
  executionTaskId: number
  batchId: number
  batchKey: string
  ruleId: number
  ruleNo: string
  priority: number
  roundOrder: number
  triggerMinute: string
  expression: string
  source: BatchSource
  batchStatus: BatchStatus
  taskRowId: number
  taskNo: string
  site: string
  status: BatchStatus
}

export type PlanOrderItem = {
  roundOrder: number
  ruleId: number
  ruleNo: string
  priority: number
  maxConcurrency: number
  expression: string
  triggerMinute: string
  batchKey: string
  status: BatchStatus | '未生成'
  source: BatchSource | '-'
}

export type CompensationSummary = {
  created: string[]
  resumed: string[]
  skipped: string[]
}

export type PlanResult = {
  ok: boolean
  minute: string
  created: string[]
  reused: string[]
  order: PlanOrderItem[]
  compensation: CompensationSummary
  message: string
}

export type CompensationResult = {
  ok: boolean
  code: CompensationResultCode
  message: string
  created: string[]
  resumed: string[]
  skipped: string[]
  runs: CompensationRun[]
}
