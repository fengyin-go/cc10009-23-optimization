<template>
  <section class="page" data-module="spider">
    <header class="page-head">
      <div>
        <h2>采集任务管理</h2>
        <p class="page-desc">
          维护采集作业的输入、执行约束与结果记录。调度执行计划生成的待执行任务会同步到这里，
          批次完成后对应作业不会再回到待执行清单。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记采集作业</button>
        <button class="btn" type="button" @click="exportRows">导出采集任务清单</button>
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
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无采集任务数据，可先登记采集作业</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条采集任务记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="scheduler-panel">
      <header class="panel-head">
        <div>
          <h3>调度待执行任务</h3>
          <p class="page-desc">
            与执行计划同一口径：按计划触发时刻、优先级和轮次排序，只展示尚未完成的批次。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" @click="reload">刷新待执行清单</button>
        </div>
      </header>
      <p class="page-desc">调度时钟 {{ clock }}，待执行 {{ pending.length }} 条。</p>

      <table class="data-table compact-table">
        <thead>
          <tr>
            <th>执行批次</th>
            <th>规则</th>
            <th>优先级</th>
            <th>轮次</th>
            <th>采集作业</th>
            <th>目标站点</th>
            <th>计划触发时刻</th>
            <th>表达式快照</th>
            <th>来源</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in pending" :key="item.executionTaskId">
            <td>{{ item.batchKey }}</td>
            <td>{{ item.ruleNo }}</td>
            <td>{{ item.priority }}</td>
            <td>{{ item.roundOrder }}</td>
            <td>{{ item.taskNo }}</td>
            <td>{{ item.site }}</td>
            <td>{{ item.triggerMinute }}</td>
            <td>{{ item.expression }}</td>
            <td>{{ item.source }}</td>
            <td>{{ item.status }}</td>
          </tr>
          <tr v-if="!pending.length">
            <td colspan="10" class="empty-state">当前没有待执行的调度任务</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { scheduleBoard, schedulerClock } from '@/api/scheduler'
import type { PendingTaskView } from '@/data/scheduler-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spider')
const columns = ["作业编号", "目标站点", "抽取模板", "起始地址", "并发线程数", "请求间隔秒", "每日上限条数", "超时秒数"]
const actions = ["提交执行", "启动采集", "终止采集", "归档结果"]
const statuses = ["草稿", "待执行", "运行中", "已完成", "已失败"]
const stats = computed(() => [
  { label: '采集作业总数', value: rows.value.length },
  { label: '运行中作业', value: rows.value.filter((row) => row.status === '运行中').length },
  { label: '已完成作业', value: rows.value.filter((row) => row.status === '已完成').length },
])
const pending = ref<PendingTaskView[]>([])
const clock = ref('')

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '采集作业登记入口尚未接入审批流'
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

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '采集任务列表读取失败'
  }
  const board = scheduleBoard()
  pending.value = board.pending
  clock.value = schedulerClock()
}

onMounted(reload)
</script>
