<template>
  <section class="page" data-module="schedule">
    <header class="page-head">
      <div>
        <h2>调度策略管理</h2>
        <p class="page-desc">
          维护调度规则并查看执行计划：同一分钟到期的规则按优先级和进入队列的先后排定轮次，
          漏触发只补尚未执行的批次，历史批次保留原表达式与触发时刻。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记调度规则</button>
        <button class="btn" type="button" @click="exportRows">导出调度策略清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="editExpression(row)">改调度表达式</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无调度策略数据，可先登记调度规则</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条调度策略记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="scheduler-panel">
      <header class="panel-head">
        <div>
          <h3>执行计划</h3>
          <p class="page-desc">
            调度时钟 {{ clock }}；共 {{ planBatches.length }} 个执行批次，待执行清单
            {{ pending.length }} 条。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" @click="runPlan">生成本轮计划</button>
          <button class="btn" type="button" @click="runCompensation">漏触发补偿</button>
          <button class="btn ghost" type="button" @click="stepClock(1)">时钟 +1 分钟</button>
          <button class="btn ghost" type="button" @click="stepClock(5)">+5 分钟</button>
          <button class="btn ghost" type="button" @click="resetSchedulerClock">跟随系统时间</button>
        </div>
      </header>

      <p v-if="planMessage" class="panel-message">{{ planMessage }}</p>
      <p v-if="planError" class="error-text">{{ planError }}</p>

      <div v-if="planOrder.length" class="plan-order">
        <span class="panel-subtitle">本轮顺序</span>
        <span v-for="item in planOrder" :key="item.batchKey" class="legend-item">
          #{{ item.roundOrder }} {{ item.ruleNo }}（优先级 {{ item.priority }}）
        </span>
      </div>

      <table class="data-table compact-table">
        <thead>
          <tr>
            <th>轮次</th>
            <th>批次键</th>
            <th>规则编号</th>
            <th>优先级</th>
            <th>计划触发时刻</th>
            <th>表达式快照</th>
            <th>来源</th>
            <th>任务</th>
            <th>状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in planBatches" :key="batch.batchKey">
            <td>{{ batch.roundOrder }}</td>
            <td>{{ batch.batchKey }}</td>
            <td>{{ batch.ruleNo }}</td>
            <td>{{ batch.priority }}</td>
            <td>{{ batch.triggerMinute }}</td>
            <td>{{ batch.expression }}</td>
            <td>{{ batch.source }}</td>
            <td>{{ batch.taskNos.join('、') || '—' }}</td>
            <td>{{ batch.status }}</td>
            <td class="row-actions">
              <button
                v-if="batch.status === '待执行'"
                class="link"
                type="button"
                @click="start(batch.id)"
              >
                启动
              </button>
              <button
                v-if="batch.status === '待执行' || batch.status === '执行中'"
                class="link"
                type="button"
                @click="complete(batch.id)"
              >
                完成
              </button>
              <button
                v-if="batch.status === '待执行' || batch.status === '执行中'"
                class="link"
                type="button"
                @click="fail(batch.id)"
              >
                标记失败
              </button>
              <span v-if="batch.status === '已完成' || batch.status === '已失败'">—</span>
            </td>
          </tr>
          <tr v-if="!planBatches.length">
            <td colspan="10" class="empty-state">还没有执行批次，先启用规则并生成本轮计划</td>
          </tr>
        </tbody>
      </table>

      <details class="panel-details">
        <summary>补跑记录（{{ compensationRuns.length }}）</summary>
        <table class="data-table compact-table">
          <thead>
            <tr>
              <th>规则</th>
              <th>补偿区间</th>
              <th>新建批次</th>
              <th>跳过已存在</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in compensationRuns" :key="run.runKey">
              <td>{{ run.ruleId }}</td>
              <td>{{ run.fromMinute }} ~ {{ run.toMinute }}</td>
              <td>{{ run.created.join('、') || '—' }}</td>
              <td>{{ run.skipped.length }}</td>
              <td>{{ run.status }}</td>
            </tr>
            <tr v-if="!compensationRuns.length">
              <td colspan="5" class="empty-state">暂无补跑记录</td>
            </tr>
          </tbody>
        </table>
      </details>

      <details class="panel-details">
        <summary>采集任务待执行清单（{{ pending.length }}）</summary>
        <table class="data-table compact-table">
          <thead>
            <tr>
              <th>批次键</th>
              <th>规则</th>
              <th>轮次</th>
              <th>采集任务</th>
              <th>计划触发时刻</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in pending" :key="item.executionTaskId">
              <td>{{ item.batchKey }}</td>
              <td>{{ item.ruleNo }}</td>
              <td>{{ item.roundOrder }}</td>
              <td>{{ item.taskNo }}</td>
              <td>{{ item.triggerMinute }}</td>
              <td>{{ item.status }}</td>
            </tr>
            <tr v-if="!pending.length">
              <td colspan="6" class="empty-state">待执行清单为空，已完成批次不会再次出现</td>
            </tr>
          </tbody>
        </table>
      </details>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  advanceClock,
  compensate,
  completeBatch,
  failBatch,
  planRound,
  resetClock,
  scheduleBoard,
  schedulerClock,
  startBatch,
  updateRuleExpression,
} from '@/api/scheduler'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { BatchView, CompensationRun, PendingTaskView, PlanOrderItem } from '@/data/scheduler-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('schedule')
const columns = ["规则编号", "关联站点", "调度表达式", "最大并发", "优先级", "生效时段", "执行超时", "漏触发补偿"]
const actions = ["提交校验", "启用调度", "停用调度"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const clock = ref('')
const planBatches = ref<BatchView[]>([])
const compensationRuns = ref<CompensationRun[]>([])
const pending = ref<PendingTaskView[]>([])
const planOrder = ref<PlanOrderItem[]>([])
const planMessage = ref('')
const planError = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '调度规则总数', value: rows.value.length },
  { label: '已启用规则', value: rows.value.filter((row) => row.status === '已启用').length },
  { label: '待校验规则', value: rows.value.filter((row) => row.status === '待校验').length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '调度规则登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reloadBoard() {
  const board = scheduleBoard()
  clock.value = schedulerClock()
  planBatches.value = board.batches
  compensationRuns.value = board.runs
  pending.value = board.pending
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '调度策略列表读取失败'
  }
  reloadBoard()
}

function runPlan() {
  planError.value = ''
  const result = planRound()
  planMessage.value = result.message
  if (!result.ok) {
    planError.value = result.message
  }
  planOrder.value = result.order
  reloadBoard()
}

function runCompensation() {
  planError.value = ''
  const result = compensate()
  planMessage.value = result.message
  if (!result.ok) {
    planError.value = result.message
  }
  reloadBoard()
}

function stepClock(minutes: number) {
  planError.value = ''
  clock.value = advanceClock(minutes)
  planMessage.value = `调度时钟已推进到 ${clock.value}，可继续生成计划或执行漏触发补偿`
  planOrder.value = []
  reloadBoard()
}

function resetSchedulerClock() {
  planError.value = ''
  clock.value = resetClock()
  planMessage.value = '调度时钟已跟随系统时间'
  planOrder.value = []
  reloadBoard()
}

function start(batchId: number) {
  const result = startBatch(batchId)
  applyBatchResult(result)
}

function complete(batchId: number) {
  const result = completeBatch(batchId)
  applyBatchResult(result)
}

function fail(batchId: number) {
  const result = failBatch(batchId)
  applyBatchResult(result)
}

function applyBatchResult(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    planError.value = result.message
  } else {
    planError.value = ''
    planMessage.value = result.message
  }
  reloadBoard()
}

/**
 * 表达式变更只影响之后的计划：这里走 updateRuleExpression，
 * 已存在的批次继续保留创建时的表达式与触发时刻。
 */
function editExpression(row: EntryRow) {
  planError.value = ''
  const current = String(row['调度表达式'] ?? '')
  const next = window.prompt('修改调度表达式（支持 every Nm、HH:mm、5 段 cron）', current)
  if (next === null) {
    return
  }
  const result = updateRuleExpression(Number(row.id), next)
  planMessage.value = result.message
  if (!result.ok) {
    planError.value = result.message
  }
  reload()
}

onMounted(reload)
</script>
