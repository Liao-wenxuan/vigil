<script setup lang="ts">
/**
 * 告警页。
 *
 * 告警三件套：**规则**（什么情况算异常）、**通道**（通知发到哪）、
 * **触发记录**（历史上真响过几次）。
 *
 * 「立即评估」是给排查用的：不等窗口，按当前数据立刻跑一遍规则。
 */
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createAlertRule,
  createChannel,
  deleteAlertRule,
  evaluateAlerts,
  getProject,
  listAlertIncidents,
  listAlertRules,
  listChannels,
  updateAlertRule
} from '../api/client'
import {
  ALERT_RULE_TYPE_LABELS,
  CHANNEL_TYPE_LABELS,
  INCIDENT_STATUS_LABELS,
  PANEL_CONTEXT,
  type AlertIncident,
  type AlertRule,
  type AlertRuleType,
  type ChannelType,
  type EnvironmentRow,
  type NotificationChannel
} from '../types'
import PanelSection from '../components/PanelSection.vue'
import { categoryLabel } from '../format'

const ctx = inject(PANEL_CONTEXT)!
const router = useRouter()

const RULE_TYPES = Object.entries(ALERT_RULE_TYPE_LABELS).map(([value, meta]) => ({
  value: value as AlertRuleType,
  label: meta.label,
  hint: meta.hint
}))

const CHANNEL_TYPES = Object.entries(CHANNEL_TYPE_LABELS).map(([value, label]) => ({
  value: value as ChannelType,
  label
}))

const CATEGORY_OPTIONS = [
  { value: 'javascript', label: 'JS 错误' },
  { value: 'resource', label: '资源加载' },
  { value: 'http', label: '接口错误' }
]

const rules = ref<AlertRule[]>([])
const channels = ref<NotificationChannel[]>([])
const incidents = ref<AlertIncident[]>([])
const environments = ref<EnvironmentRow[]>([])
const loading = ref(false)

const ruleVisible = ref(false)
const channelVisible = ref(false)

const ruleForm = ref({
  name: '',
  type: 'issue.new' as AlertRuleType,
  threshold: 1,
  windowSeconds: 300,
  environments: [] as string[],
  categories: [] as string[],
  channelIds: [] as number[]
})

const channelForm = ref({
  name: '',
  type: 'webhook' as ChannelType,
  configText: '{\n  "url": "https://example.com/hook"\n}'
})

const ruleTypeHint = computed(() => ALERT_RULE_TYPE_LABELS[ruleForm.value.type]?.hint ?? '')

const ruleNameById = computed(() => {
  const map = new Map<number, string>()
  for (const rule of rules.value) map.set(rule.id, rule.name)
  return map
})

async function load(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) {
    rules.value = []
    channels.value = []
    incidents.value = []
    return
  }

  loading.value = true
  try {
    const [ruleList, channelList, incidentList, detail] = await Promise.all([
      listAlertRules(projectId),
      listChannels(projectId),
      listAlertIncidents(projectId),
      getProject(projectId)
    ])
    rules.value = ruleList
    channels.value = channelList
    incidents.value = incidentList
    environments.value = detail.environments
  } catch (error) {
    ElMessage.error(`加载告警数据失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

async function toggleRule(rule: AlertRule, enabled: boolean): Promise<void> {
  try {
    const updated = await updateAlertRule(rule.id, { enabled })
    rules.value = rules.value.map((item) => (item.id === updated.id ? updated : item))
    ElMessage.success(enabled ? '规则已启用' : '规则已停用')
  } catch (error) {
    ElMessage.error(`更新规则失败：${error instanceof Error ? error.message : String(error)}`)
    await load()
  }
}

async function removeRule(rule: AlertRule): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除规则「${rule.name}」？`, '删除规则', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }

  try {
    await deleteAlertRule(rule.id)
    ElMessage.success('规则已删除')
    await load()
  } catch (error) {
    ElMessage.error(`删除规则失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function submitRule(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return

  const name = ruleForm.value.name.trim()
  if (name === '') {
    ElMessage.warning('请填写规则名称')
    return
  }

  const conditions = {
    ...(ruleForm.value.environments.length > 0 ? { environment: ruleForm.value.environments } : {}),
    ...(ruleForm.value.categories.length > 0 ? { category: ruleForm.value.categories } : {})
  }

  try {
    await createAlertRule(projectId, {
      name,
      type: ruleForm.value.type,
      threshold: ruleForm.value.threshold,
      windowSeconds: ruleForm.value.windowSeconds,
      ...(Object.keys(conditions).length > 0 ? { conditions } : {}),
      ...(ruleForm.value.channelIds.length > 0 ? { channelIds: ruleForm.value.channelIds } : {})
    })
    ElMessage.success('规则已创建')
    ruleVisible.value = false
    ruleForm.value = {
      name: '',
      type: 'issue.new',
      threshold: 1,
      windowSeconds: 300,
      environments: [],
      categories: [],
      channelIds: []
    }
    await load()
  } catch (error) {
    ElMessage.error(`创建规则失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function submitChannel(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return

  const name = channelForm.value.name.trim()
  if (name === '') {
    ElMessage.warning('请填写通道名称')
    return
  }

  let config: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(channelForm.value.configText)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      ElMessage.warning('通道配置必须是 JSON 对象')
      return
    }
    config = parsed as Record<string, unknown>
  } catch {
    ElMessage.warning('通道配置不是合法 JSON')
    return
  }

  try {
    await createChannel(projectId, { name, type: channelForm.value.type, config })
    ElMessage.success('通道已创建')
    channelVisible.value = false
    channelForm.value = {
      name: '',
      type: 'webhook',
      configText: '{\n  "url": "https://example.com/hook"\n}'
    }
    await load()
  } catch (error) {
    ElMessage.error(`创建通道失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function evaluateNow(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return

  try {
    const result = await evaluateAlerts(projectId)
    ElMessage.success(
      `评估完成：评估 ${result.evaluated.toLocaleString('zh-CN')} 条规则，` +
        `触发 ${result.triggered.toLocaleString('zh-CN')} 条，` +
        `跳过 ${result.skipped.toLocaleString('zh-CN')} 条，` +
        `失败 ${result.failed.toLocaleString('zh-CN')} 条`
    )
    await load()
  } catch (error) {
    ElMessage.error(`评估失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function payloadText(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

function openIssue(issueId: number | undefined): void {
  if (issueId === undefined) return
  void router.push(`/issues/${issueId}`)
}

watch(
  () => ctx.projectId,
  () => void load()
)
watch(
  () => ctx.refreshToken,
  () => void load()
)
onMounted(() => void load())
</script>

<template>
  <div v-loading="loading" class="alerts-page">
    <PanelSection title="告警规则" :count="rules.length">
      <template #actions>
        <el-button size="small" @click="evaluateNow">立即评估</el-button>
        <el-button size="small" type="primary" @click="ruleVisible = true">新建规则</el-button>
      </template>

      <el-table :data="rules" size="default">
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column label="类型" width="170">
          <template #default="{ row }">
            <el-tooltip
              :content="ALERT_RULE_TYPE_LABELS[row.type as AlertRuleType]?.hint ?? ''"
              placement="top"
            >
              <span>{{
                ALERT_RULE_TYPE_LABELS[row.type as AlertRuleType]?.label ?? row.type
              }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="阈值" width="100" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.threshold.toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="窗口" width="110" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.windowSeconds.toLocaleString('zh-CN') }} 秒</span>
          </template>
        </el-table-column>
        <el-table-column label="通道" width="80" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.channelIds.length }}</span>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              @click.stop
              @change="(value: string | number | boolean) => toggleRule(row, Boolean(value))"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" @click.stop="removeRule(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">还没有告警规则</div>
        </template>
      </el-table>
    </PanelSection>

    <PanelSection title="通知通道" :count="channels.length">
      <template #actions>
        <el-button size="small" type="primary" @click="channelVisible = true">新建通道</el-button>
      </template>

      <el-table :data="channels" size="default">
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column label="类型" width="140">
          <template #default="{ row }">
            <span>{{ CHANNEL_TYPE_LABELS[row.type as ChannelType] ?? row.type }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small" effect="plain">
              {{ row.enabled ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="配置" min-width="280">
          <template #default="{ row }">
            <span class="mono muted">{{ payloadText(row.config) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">还没有通知通道</div>
        </template>
      </el-table>
    </PanelSection>

    <PanelSection title="触发历史" :count="incidents.length">
      <el-table :data="incidents" size="default">
        <el-table-column label="时间" width="160">
          <template #default="{ row }">
            <span class="tabular">{{ new Date(row.triggeredAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="规则" min-width="160">
          <template #default="{ row }">
            <span>{{ ruleNameById.get(row.ruleId) ?? `规则 #${row.ruleId}` }}</span>
          </template>
        </el-table-column>
        <el-table-column label="问题" width="110">
          <template #default="{ row }">
            <el-button v-if="row.issueId" link size="small" @click="openIssue(row.issueId)">
              #{{ row.issueId }}
            </el-button>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'triggered' ? 'danger' : 'info'"
              size="small"
              effect="plain"
            >
              {{ INCIDENT_STATUS_LABELS[row.status as AlertIncident['status']] ?? row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="280">
          <template #default="{ row }">
            <span class="mono muted">{{ payloadText(row.payload) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">还没有触发记录</div>
        </template>
      </el-table>
    </PanelSection>

    <el-dialog v-model="ruleVisible" title="新建告警规则" width="560px">
      <el-form label-width="104px">
        <el-form-item label="规则名称">
          <el-input v-model="ruleForm.name" placeholder="例如：生产环境致命错误" clearable />
        </el-form-item>

        <el-form-item label="规则类型">
          <el-select v-model="ruleForm.type" class="full-width">
            <el-option
              v-for="option in RULE_TYPES"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            >
              <el-tooltip :content="option.hint" placement="left">
                <span>{{ option.label }}</span>
              </el-tooltip>
            </el-option>
          </el-select>
          <p class="type-hint">{{ ruleTypeHint }}</p>
        </el-form-item>

        <el-form-item label="阈值">
          <el-input-number v-model="ruleForm.threshold" :min="1" :controls="false" />
        </el-form-item>

        <el-form-item label="评估窗口">
          <el-input-number v-model="ruleForm.windowSeconds" :min="10" :step="60" />
          <span class="unit-hint">秒</span>
        </el-form-item>

        <el-form-item label="环境">
          <el-select v-model="ruleForm.environments" multiple class="full-width" placeholder="不限">
            <el-option
              v-for="environment in environments"
              :key="environment.id"
              :label="environment.name"
              :value="environment.slug"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="分类">
          <el-select v-model="ruleForm.categories" multiple class="full-width" placeholder="不限">
            <el-option
              v-for="option in CATEGORY_OPTIONS"
              :key="option.value"
              :label="categoryLabel(option.value)"
              :value="option.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="通知通道">
          <el-select v-model="ruleForm.channelIds" multiple class="full-width" placeholder="不通知">
            <el-option
              v-for="channel in channels"
              :key="channel.id"
              :label="`${channel.name}（${CHANNEL_TYPE_LABELS[channel.type] ?? channel.type}）`"
              :value="channel.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="ruleVisible = false">取消</el-button>
        <el-button type="primary" @click="submitRule">创建规则</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="channelVisible" title="新建通知通道" width="560px">
      <el-form label-width="104px">
        <el-form-item label="通道名称">
          <el-input v-model="channelForm.name" placeholder="例如：研发群机器人" clearable />
        </el-form-item>
        <el-form-item label="通道类型">
          <el-select v-model="channelForm.type" class="full-width">
            <el-option
              v-for="option in CHANNEL_TYPES"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="配置">
          <el-input
            v-model="channelForm.configText"
            type="textarea"
            :rows="6"
            placeholder='{ "url": "https://example.com/hook" }'
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="channelVisible = false">取消</el-button>
        <el-button type="primary" @click="submitChannel">创建通道</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alerts-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.mono {
  font-family: 'SF Mono', 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}

.muted {
  color: var(--vigil-text-2);
}

.full-width {
  width: 100%;
}

.type-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--vigil-text-3);
}

.unit-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--vigil-text-3);
}

.empty-hint {
  padding: 28px;
  text-align: center;
  color: var(--vigil-text-3);
  font-size: 13px;
}
</style>
