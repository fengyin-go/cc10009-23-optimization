/**
 * 调度表达式解析。
 *
 * 支持：
 * - 5 段 cron：`分 时 日 月 周`，支持 `*`、`* / n`、`a-b`、`a-b/n`、`a,b`
 * - 固定时刻：`HH:mm`
 * - 固定间隔：`every 5m` / `每5分钟`
 *
 * 解析失败会返回 invalid，调度链路会把它视为“不触发”，而不是退化成每分钟触发。
 */

export type ParsedSchedule =
  | {
      kind: 'cron'
      minutes: number[]
      hours: number[]
      daysOfMonth: number[]
      months: number[]
      daysOfWeek: number[]
      domRestricted: boolean
      dowRestricted: boolean
    }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'invalid'; reason: string }

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1)
const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1)
const DAYS_OF_WEEK = [0, 1, 2, 3, 4, 5, 6]

const CRON_ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
}

const parseCache = new Map<string, ParsedSchedule>()

function invalid(reason: string): ParsedSchedule {
  return { kind: 'invalid', reason }
}

function parseNumberField(raw: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const segment of raw.split(',')) {
    if (segment === '') {
      return null
    }
    let rangePart = segment
    let step = 1
    const slash = segment.indexOf('/')
    if (slash >= 0) {
      rangePart = segment.slice(0, slash)
      const stepText = segment.slice(slash + 1)
      if (!/^\d+$/.test(stepText)) {
        return null
      }
      step = Number(stepText)
      if (step <= 0) {
        return null
      }
    }

    let start: number
    let end: number
    if (rangePart === '*' || rangePart === '?') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const [left, right] = rangePart.split('-')
      if (!/^\d+$/.test(left ?? '') || !/^\d+$/.test(right ?? '')) {
        return null
      }
      start = Number(left)
      end = Number(right)
    } else {
      if (!/^\d+$/.test(rangePart)) {
        return null
      }
      start = Number(rangePart)
      // `5/10` 的语义与 cron 一致：从 5 开始按步长走到上界。
      end = slash >= 0 ? max : start
    }

    if (start < min || end > max || start > end) {
      return null
    }
    for (let value = start; value <= end; value += step) {
      values.add(value)
    }
  }
  return values.size > 0 ? [...values].sort((a, b) => a - b) : null
}

function isFullRange(values: number[], min: number, max: number): boolean {
  if (values.length !== max - min + 1) {
    return false
  }
  for (let value = min; value <= max; value += 1) {
    if (!values.includes(value)) {
      return false
    }
  }
  return true
}

export function parseScheduleExpression(raw: string): ParsedSchedule {
  const expression = String(raw ?? '').trim()
  const cached = parseCache.get(expression)
  if (cached) {
    return cached
  }

  let parsed: ParsedSchedule
  if (expression === '') {
    parsed = invalid('调度表达式为空')
  } else if (/^\d{1,2}:\d{2}$/.test(expression)) {
    const [hourText, minuteText] = expression.split(':')
    const hour = Number(hourText)
    const minute = Number(minuteText)
    parsed =
      hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
        ? { kind: 'daily', hour, minute }
        : invalid('固定时刻超出范围')
  } else {
    const interval =
      /^(?:every\s*|每\s*)(\d{1,4})\s*(?:m|min|mins|minute|minutes|分钟)$/i.exec(expression)
    if (interval) {
      const everyMinutes = Number(interval[1])
      parsed =
        everyMinutes > 0 && everyMinutes <= 1440
          ? { kind: 'interval', everyMinutes }
          : invalid('固定间隔超出范围')
    } else {
      const normalized = CRON_ALIASES[expression.toLowerCase()] ?? expression
      const parts = normalized.split(/\s+/)
      if (parts.length !== 5) {
        parsed = invalid('仅支持 5 段 cron、HH:mm 或 every Nm')
      } else {
        const minutes = parseNumberField(parts[0], 0, 59)
        const hours = parseNumberField(parts[1], 0, 23)
        const daysOfMonth = parseNumberField(parts[2], 1, 31)
        const months = parseNumberField(parts[3], 1, 12)
        // cron 里 7 也表示周日，统一收敛到 0。
        const daysOfWeekRaw = parseNumberField(parts[4].replace(/\b7\b/g, '0'), 0, 6)
        if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeekRaw) {
          parsed = invalid('cron 字段格式不正确')
        } else {
          parsed = {
            kind: 'cron',
            minutes,
            hours,
            daysOfMonth,
            months,
            daysOfWeek: [...new Set(daysOfWeekRaw)].sort((a, b) => a - b),
            domRestricted: !isFullRange(daysOfMonth, 1, 31),
            dowRestricted: !isFullRange(daysOfWeekRaw, 0, 6),
          }
        }
      }
    }
  }

  parseCache.set(expression, parsed)
  return parsed
}

export function matchesParsedSchedule(parsed: ParsedSchedule, date: Date): boolean {
  switch (parsed.kind) {
    case 'invalid':
      return false
    case 'daily':
      return date.getHours() === parsed.hour && date.getMinutes() === parsed.minute
    case 'interval':
      return date.getMinutes() % parsed.everyMinutes === 0
    case 'cron': {
      if (!parsed.minutes.includes(date.getMinutes())) return false
      if (!parsed.hours.includes(date.getHours())) return false
      if (!parsed.months.includes(date.getMonth() + 1)) return false

      const domMatches = parsed.daysOfMonth.includes(date.getDate())
      const dowMatches = parsed.daysOfWeek.includes(date.getDay())
      if (parsed.domRestricted && parsed.dowRestricted) {
        // 标准 cron 语义：日与周都受限时取“或”。
        return domMatches || dowMatches
      }
      if (parsed.domRestricted) return domMatches
      if (parsed.dowRestricted) return dowMatches
      return true
    }
    default:
      return false
  }
}

export function matchesScheduleExpression(raw: string, date: Date): boolean {
  return matchesParsedSchedule(parseScheduleExpression(raw), date)
}

export function isValidScheduleExpression(raw: string): boolean {
  return parseScheduleExpression(raw).kind !== 'invalid'
}
