import type { EntryRow } from './types'
import type {
  ExpressionHistoryEntry,
  ScheduleRuleState,
  SchedulerState,
} from './scheduler-types'

/** 调度规则在某一分钟内的只读取值结果。 */
export type ScheduleRule = {
  ruleId: number
  ruleNo: string
  site: string
  expression: string
  priority: number
  maxConcurrency: number
  /** 「生效时段」解析出的最早生效分钟；空字符串表示不限制。 */
  activeFrom: string
  /** 「漏触发补偿」是否开启；关闭时补偿不会为这条规则补批次。 */
  compensationEnabled: boolean
  status: string
}

/** 分钟键：YYYY-MM-DDTHH:mm，本地时区。所有计划与批次都以它为准。 */
export function minuteKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

export function parseMinuteKey(key: string): Date | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(key)
  if (!matched) {
    return null
  }
  const [, year, month, day, hour, minute] = matched
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0)
}

export function addMinuteKeys(key: string, deltaMinutes: number): string {
  const date = parseMinuteKey(key)
  if (!date) {
    return key
  }
  date.setMinutes(date.getMinutes() + deltaMinutes)
  return minuteKey(date)
}

export function compareMinuteKeys(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function toInt(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseEffectiveFrom(value: unknown): string {
  const text = String(value ?? '').trim()
  if (text === '') {
    return ''
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    return `${text}T00:00`
  }
  const withTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(text)
  if (withTime) {
    const pad = (part: string) => part.padStart(2, '0')
    return `${withTime[1]}-${withTime[2]}-${withTime[3]}T${pad(withTime[4])}:${withTime[5]}`
  }
  return ''
}

/** 从调度策略模块的登记行里取出规则快照，按 ruleId 升序（登记先后就是最早的人队列顺序）。 */
export function readScheduleRules(rows: EntryRow[]): ScheduleRule[] {
  return rows
    .map((row) => ({
      ruleId: Number(row.id),
      ruleNo: String(row['规则编号'] ?? `SCHE-${Number(row.id)}`),
      site: String(row['关联站点'] ?? ''),
      expression: String(row['调度表达式'] ?? '').trim(),
      priority: toInt(row['优先级']),
      maxConcurrency: toPositiveInt(row['最大并发'], 1),
      activeFrom: parseEffectiveFrom(row['生效时段']),
      compensationEnabled: !['关闭', '禁用', 'false', '否', '0'].includes(
        String(row['漏触发补偿'] ?? '').trim().toLowerCase(),
      ),
      status: String(row.status ?? ''),    }))
    .filter((rule) => Number.isFinite(rule.ruleId))
    .sort((left, right) => left.ruleId - right.ruleId)
}

/** 规则必须处于已启用状态才会生成计划。 */
export function isRuleEnabled(rule: ScheduleRule): boolean {
  return rule.status === '已启用'
}

/**
 * 同一分钟到期的规则排序：
 * 1. 优先级高的先执行；
 * 2. 优先级相同时，以规则进入调度队列的先后（queueSeq）为准，绝不以数组/列表顺序裁决；
 * 3. ruleId 只作为最后兜底，保证同样的输入永远得到同样的顺序。
 */
export function compareRulesForRound(
  left: ScheduleRule,
  leftSeq: number,
  right: ScheduleRule,
  rightSeq: number,
): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority
  }
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq
  }
  return left.ruleId - right.ruleId
}

function sortHistory(history: ExpressionHistoryEntry[]): ExpressionHistoryEntry[] {
  return [...history].sort((left, right) => {
    if (left.effectiveFrom === right.effectiveFrom) return 0
    if (left.effectiveFrom === '') return -1
    if (right.effectiveFrom === '') return 1
    return left.effectiveFrom < right.effectiveFrom ? -1 : 1
  })
}

/** 取在某一分钟实际生效的表达式（表达式历史里的快照，不受之后修改影响）。 */
export function expressionAt(history: ExpressionHistoryEntry[], minute: string): string {
  const sorted = sortHistory(history.length > 0 ? history : [{ expression: '', effectiveFrom: '' }])
  let current = sorted[0].expression
  for (const entry of sorted) {
    if (entry.effectiveFrom === '' || entry.effectiveFrom <= minute) {
      current = entry.expression
    } else {
      break
    }
  }
  return current
}

/**
 * 记录表达式变更：变更只从 atMinute 起生效。
 * 历史批次保存的是创建时的表达式快照，所以不会被这里改写。
 */
export function syncExpressionHistory(
  history: ExpressionHistoryEntry[],
  expression: string,
  atMinute: string,
): boolean {
  const effective = expressionAt(history, atMinute)
  if (effective === expression) {
    return false
  }
  const existing = history.find((entry) => entry.effectiveFrom === atMinute)
  if (existing) {
    existing.expression = expression
  } else {
    history.push({ expression, effectiveFrom: atMinute })
  }
  history.splice(0, history.length, ...sortHistory(history))
  return true
}

function maxRuleIdSeq(states: Record<string, ScheduleRuleState>): number {
  return Object.values(states).reduce(
    (max, state) => Math.max(max, state.queueSeq, state.ruleId),
    0,
  )
}

/**
 * 为每个规则补齐调度状态：入队序号、表达式历史、上次扫描到的分钟。
 * 这里只补缺，不重排已有的 queueSeq，保证“进入队列的先后”是稳定事实。
 */
export function ensureRuleStates(
  state: SchedulerState,
  rules: ScheduleRule[],
  atMinute: string,
): void {
  let nextSeq = maxRuleIdSeq(state.ruleStates)
  for (const rule of rules) {
    const key = String(rule.ruleId)
    let ruleState = state.ruleStates[key]
    if (!ruleState) {
      nextSeq += 1
      ruleState = {
        ruleId: rule.ruleId,
        queueSeq: nextSeq,
        expressionHistory: [
          { expression: rule.expression, effectiveFrom: rule.activeFrom },
        ],
        lastScannedMinute: addMinuteKeys(atMinute, -1),
        enabled: isRuleEnabled(rule),
        enabledSince: isRuleEnabled(rule) ? atMinute : '',
      }
      state.ruleStates[key] = ruleState
    }
    if (!ruleState.expressionHistory || ruleState.expressionHistory.length === 0) {
      ruleState.expressionHistory = [
        { expression: rule.expression, effectiveFrom: rule.activeFrom },
      ]
    }
    if (!ruleState.lastScannedMinute || parseMinuteKey(ruleState.lastScannedMinute) === null) {
      ruleState.lastScannedMinute = addMinuteKeys(atMinute, -1)
    }
    applyEnableTransition(ruleState, isRuleEnabled(rule), atMinute)
    syncExpressionHistory(ruleState.expressionHistory, rule.expression, atMinute)
  }
}

/**
 * 记录启用/停用切换：
 * - 重新启用时把 enabledSince 推到当前分钟，补偿不会回补停用期间的分钟；
 * - 停用再启用时也一样；首次见到规则时按当前状态初始化，不回补历史。
 */
export function applyEnableTransition(
  ruleState: ScheduleRuleState,
  enabled: boolean,
  atMinute: string,
): void {
  if (typeof ruleState.enabled !== 'boolean') {
    ruleState.enabled = enabled
    ruleState.enabledSince = enabled ? atMinute : ''
    return
  }
  if (ruleState.enabled === enabled) {
    return
  }
  ruleState.enabled = enabled
  ruleState.enabledSince = enabled ? atMinute : ''
}

/** 规则是否已到生效时段。 */
export function isRuleActiveAt(rule: ScheduleRule, minute: string): boolean {
  return rule.activeFrom === '' || minute >= rule.activeFrom
}
