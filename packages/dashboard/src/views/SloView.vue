<script setup lang="ts">
/**
 * SLO 与错误预算页。
 *
 * ## 这一页回答什么
 *
 * 「错误率涨了」是症状；「这个月还能不能发布」是决策。
 * 这一页把后者变成一眼能看的东西：
 *
 * - **状态**：达标 / 有风险 / 预算已耗尽
 * - **预算条**：还能烧多少（一眼看出离「停发布」还有多远）
 * - **燃烧率**：烧得比预期快多少倍
 *
 * ## 为什么 SLI 和错误率要分开显示
 *
 * 两个是同一份数据的两个视角：
 * - **SLI**（时间口径）：窗口里有多大比例的**时间**是达标的
 * - **错误率**（事件口径）：平均有多糟
 *
 * 预算与燃烧率用事件口径，SLI 用时间口径。
 * 只显示一个都会误导 —— 错误率 5% 可能是一半时间彻底崩、
 * 一半时间完全没事，而平均值看着还挺温和。
 */
import { computed, inject, onMounted, ref, watch } from 'vue'
import { createSlo, deleteSlo, getSlo, getSloBudget, listSlos, updateSlo } from '../api/client'
import {
  PANEL_CONTEXT,
  SLO_STATUS_LABELS,
  type Slo,
  type SloBurnRateWindow,
  type SloBudgetPoint,
  type SloEvaluation,
  type SloStatus,
  type SloWithEvaluation
} from '../types'
import PanelSection from '../components/PanelSection.vue'
import StatCard from '../components/StatCard.vue'

const ctx = inject(PANEL_CONTEXT)!

const items = ref<SloWithEvaluation[]>([])
const loading = ref(false)
const createVisible = ref(false)

/** 选中的 SLO（详情区展示它的燃烧率窗口与预算趋势） */
const selectedId = ref<number | null>(null)
const burnRates = ref<SloBurnRateWindow[]>([])
const budgetPoints = ref<SloBudgetPoint[]>([])
const detailLoading = ref(false)

const form = ref({
  name: '',
  /** 目标用百分数填，写起来比 0.999 直观 */
  targetPercent: 99.9,
  windowDays: 30,
  stepMinutes: 60
})

const selected = computed(() => items.value.find((i) => i.slo.id === selectedId.value) ?? null)

const counts = computed(() => {
  const byStatus = (status: SloStatus): number =>
    items.value.filter((i) => i.evaluation.status === status).length
  return {
    total: items.value.length,
    healthy: byStatus('healthy'),
    atRisk: byStatus('at_risk'),
    exhausted: byStatus('exhausted')
  }
})

/** 状态色 —— 强调色只留给状态，数字一律白色 */
function statusColor(status: SloStatus): string {
  if (status === 'exhausted') return 'var(--vigil-danger)'
  if (status === 'at_risk') return 'var(--vigil-warn)'
  return 'var(--vigil-ok)'
}

/** 预算消耗比例（0~1+）。没有请求时是 null */
function consumedRatio(evaluation: SloEvaluation): number | null {
  return evaluation.budgetConsumedRatio
}

/** 预算条宽度（百分比，最多 100%） */
function budgetWidth(evaluation: SloEvaluation): number {
  const ratio = consumedRatio(evaluation)
  if (ratio === null) return 0
  return Math.min(100, ratio * 100)
}

function formatPercent(value: number | null, digits = 2): string {
  if (value === null) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

function formatDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}

function formatBurnRate(value: number | null): string {
  if (value === null) return '—'
  if (value >= 100) return `${value.toFixed(0)}×`
  if (value >= 10) return `${value.toFixed(1)}×`
  return `${value.toFixed(2)}×`
}

/**
 * 表格插槽给的行类型是 `DefaultRow`（Element Plus 的类型退化了），
 * 这里统一在脚本层转换 —— 模板里写断言太吵。
 */
function onRowClick(row: unknown): void {
  void select((row as SloWithEvaluation).slo)
}

function onToggle(row: unknown, value: string | number | boolean): void {
  void toggleEnabled(row as SloWithEvaluation, Boolean(value))
}

async function load(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) {
    items.value = []
    return
  }

  loading.value = true
  try {
    items.value = await listSlos(projectId)
    // 默认选第一条 —— 详情区不该是空的
    if (selectedId.value === null && items.value.length > 0) {
      selectedId.value = items.value[0].slo.id
    }
    if (selectedId.value !== null) await loadDetail()
  } catch (error) {
    ElMessage.error(`加载 SLO 失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

async function loadDetail(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null || selectedId.value === null) return

  detailLoading.value = true
  try {
    const detail = await getSlo(projectId, selectedId.value)
    burnRates.value = detail.burnRates ?? []
    const budget = await getSloBudget(projectId, selectedId.value)
    budgetPoints.value = budget.points ?? []
  } catch (error) {
    ElMessage.error(`加载 SLO 详情失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    detailLoading.value = false
  }
}

async function select(slo: Slo): Promise<void> {
  selectedId.value = slo.id
  await loadDetail()
}

async function toggleEnabled(item: SloWithEvaluation, enabled: boolean): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return
  try {
    await updateSlo(projectId, item.slo.id, { enabled })
    await load()
  } catch (error) {
    ElMessage.error(`更新失败：${error instanceof Error ? error.message : String(error)}`)
    await load()
  }
}

async function remove(item: SloWithEvaluation): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return
  try {
    await ElMessageBox.confirm(`确认删除 SLO「${item.slo.name}」？`, '删除 SLO', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }

  try {
    await deleteSlo(projectId, item.slo.id)
    ElMessage.success('SLO 已删除')
    if (selectedId.value === item.slo.id) selectedId.value = null
    await load()
  } catch (error) {
    ElMessage.error(`删除失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function submit(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return

  const name = form.value.name.trim()
  if (name === '') {
    ElMessage.warning('请填写 SLO 名称')
    return
  }
  const target = form.value.targetPercent / 100
  if (!(target > 0 && target <= 1)) {
    ElMessage.warning('目标必须在 0 到 100 之间，且大于 0')
    return
  }

  const windowSeconds = Math.round(form.value.windowDays * 86400)
  const stepSeconds = Math.round(form.value.stepMinutes * 60)
  if (windowSeconds % stepSeconds !== 0) {
    ElMessage.warning('步长必须整除窗口（否则窗口尾部会剩半步）')
    return
  }

  try {
    await createSlo(projectId, {
      name,
      target,
      windowSeconds,
      stepSeconds
    })
    ElMessage.success('SLO 已创建')
    createVisible.value = false
    form.value = { name: '', targetPercent: 99.9, windowDays: 30, stepMinutes: 60 }
    await load()
  } catch (error) {
    ElMessage.error(`创建失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

watch(
  () => ctx.projectId,
  () => {
    selectedId.value = null
    void load()
  }
)
watch(
  () => ctx.refreshToken,
  () => void load()
)
onMounted(() => void load())
</script>

<template>
  <div v-loading="loading" class="slo-page">
    <div class="stat-row">
      <StatCard label="SLO 数量" :value="counts.total" hint="按项目定义的可用性目标" />
      <StatCard label="达标" :value="counts.healthy" hint="SLI 达标且预算充足" />
      <StatCard label="有风险" :value="counts.atRisk" hint="没达标，或烧得比预期快" />
      <StatCard label="预算已耗尽" :value="counts.exhausted" hint="允许的错误已经用完" />
    </div>

    <PanelSection title="服务水平目标" :count="counts.total" hint="按项目维度评估">
      <template #actions>
        <el-button size="small" type="primary" @click="createVisible = true">新建 SLO</el-button>
      </template>

      <el-table :data="items" size="default" @row-click="onRowClick">
        <el-table-column label="名称" min-width="180">
          <template #default="{ row }">
            <span class="slo-name">{{ row.slo.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tooltip
              :content="SLO_STATUS_LABELS[row.evaluation.status as SloStatus]?.hint ?? ''"
              placement="top"
            >
              <!-- ⚠️ el-tooltip 只能有**一个**子元素 ——
                   给两个的话触发器渲染不出来，标签也跟着消失 -->
              <span class="status-cell">
                <span
                  class="status-dot"
                  :style="{ background: statusColor(row.evaluation.status) }"
                />
                <span>{{ SLO_STATUS_LABELS[row.evaluation.status as SloStatus]?.label }}</span>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="目标" width="90" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ (row.slo.target * 100).toFixed(1) }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="SLI" width="90" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatPercent(row.evaluation.sli) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="错误率" width="90" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatPercent(row.evaluation.errorRatio) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="错误预算" min-width="200">
          <template #default="{ row }">
            <div class="budget">
              <div class="budget-track">
                <div
                  class="budget-fill"
                  :style="{
                    width: `${budgetWidth(row.evaluation)}%`,
                    background: statusColor(row.evaluation.status)
                  }"
                />
              </div>
              <span class="tabular budget-note">
                {{
                  row.evaluation.budgetConsumedRatio === null
                    ? '—'
                    : `已用 ${(row.evaluation.budgetConsumedRatio * 100).toFixed(0)}%`
                }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="燃烧率" width="90" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatBurnRate(row.evaluation.burnRate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-switch
              :model-value="row.slo.enabled"
              @click.stop
              @change="(value: string | number | boolean) => onToggle(row, value)"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80" align="right">
          <template #default="{ row }">
            <el-button
              link
              size="small"
              type="danger"
              @click.stop="remove(row as SloWithEvaluation)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">还没有 SLO —— 先定一个目标，才知道还能出多少错</div>
        </template>
      </el-table>
    </PanelSection>

    <PanelSection v-if="selected" title="燃烧率窗口" :hint="selected.slo.name">
      <p class="section-note">
        长窗口配短窗口，**两个窗口同时超阈值**才告警 —— 短窗口负责快速感知，长窗口负责确认持续消耗。
      </p>
      <el-table v-loading="detailLoading" :data="burnRates" size="default">
        <el-table-column label="长窗口" width="110" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatDuration(row.longSeconds) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="短窗口" width="110" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatDuration(row.shortSeconds) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="阈值" width="90" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatBurnRate(row.threshold) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="长窗口燃烧率" width="130" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatBurnRate(row.longBurnRate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="短窗口燃烧率" width="130" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatBurnRate(row.shortBurnRate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="是否告警" width="100">
          <template #default="{ row }">
            <el-tag :type="row.alerting ? 'danger' : 'info'" size="small" effect="plain">
              {{ row.alerting ? '会告警' : '不告警' }}
            </el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">没有燃烧率数据</div>
        </template>
      </el-table>
    </PanelSection>

    <el-dialog v-model="createVisible" title="新建 SLO" width="520px">
      <el-form label-width="96px">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="例如：可用性 99.9%" clearable />
        </el-form-item>

        <el-form-item label="目标">
          <el-input-number v-model="form.targetPercent" :min="0.1" :max="100" :step="0.1" />
          <span class="unit-hint">% 达标率</span>
        </el-form-item>

        <el-form-item label="评估窗口">
          <el-input-number v-model="form.windowDays" :min="1" :max="90" />
          <span class="unit-hint">天</span>
        </el-form-item>

        <el-form-item label="判定步长">
          <el-input-number v-model="form.stepMinutes" :min="1" :max="1440" :step="5" />
          <span class="unit-hint">分钟</span>
        </el-form-item>
      </el-form>

      <p class="type-hint">
        步长决定「突发」的敏感度：步长越细，一次集中爆发在 SLI 里占的比重越小。 步长必须整除窗口。
      </p>

      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.slo-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--vigil-space-3);
}

.slo-name {
  font-weight: 500;
}

/* 状态点：强调色只用在状态上，数字一律白色 */
.status-cell {
  display: inline-flex;
  align-items: center;
}

.status-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}

.budget {
  display: flex;
  align-items: center;
  gap: var(--vigil-space-2);
}

.budget-track {
  flex: 1;
  min-width: 80px;
  height: 6px;
  background: var(--vigil-bg-base);
  border: 1px solid var(--vigil-border);
  overflow: hidden;
}

.budget-fill {
  height: 100%;
}

.budget-note {
  font-size: var(--vigil-text-2xs);
  color: var(--vigil-text-3);
  white-space: nowrap;
}

.section-note {
  margin: 0 0 var(--vigil-space-3);
  font-size: var(--vigil-text-xs);
  line-height: var(--vigil-leading-normal);
  color: var(--vigil-text-3);
}

.type-hint {
  margin: var(--vigil-space-2) 0 0;
  font-size: var(--vigil-text-xs);
  line-height: 1.6;
  color: var(--vigil-text-3);
}

.unit-hint {
  margin-left: 8px;
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-3);
}

.empty-hint {
  padding: 28px;
  text-align: center;
  color: var(--vigil-text-3);
  font-size: var(--vigil-text-sm);
}
</style>
