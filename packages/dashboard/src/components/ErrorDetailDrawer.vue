<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { fetchErrorDetail } from '../api'
import { categoryLabel, categoryType, formatDate, relativeTime } from '../format'
import type { ErrorDetail, ErrorRow, ResolvedFrame } from '../types'

const props = defineProps<{
  modelValue: boolean
  appId: string
  error: ErrorRow | null
}>()

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

const detail = ref<ErrorDetail | null>(null)
const loading = ref(false)
const loadError = ref('')

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

/** 还原后的栈帧（服务端用 sourcemap 还原过） */
const resolvedFrames = computed<ResolvedFrame[]>(() => {
  if (!detail.value?.error.resolved_stack) return []
  try {
    return JSON.parse(detail.value.error.resolved_stack) as ResolvedFrame[]
  } catch {
    return []
  }
})

/** 最近一次事件的完整 payload —— 里面有面包屑和上下文 */
const latestPayload = computed<Record<string, unknown> | null>(() => {
  const first = detail.value?.events?.[0]
  if (!first) return null
  try {
    return JSON.parse(first.payload_json) as Record<string, unknown>
  } catch {
    return null
  }
})

const breadcrumbs = computed<Array<Record<string, unknown>>>(() => {
  const payload = latestPayload.value
  const list = payload?.breadcrumbs
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []
})

const httpInfo = computed<Record<string, unknown> | null>(() => {
  if (!detail.value?.error.http_json) return null
  try {
    return JSON.parse(detail.value.error.http_json) as Record<string, unknown>
  } catch {
    return null
  }
})

const resourceInfo = computed<Record<string, unknown> | null>(() => {
  if (!detail.value?.error.resource_json) return null
  try {
    return JSON.parse(detail.value.error.resource_json) as Record<string, unknown>
  } catch {
    return null
  }
})

watch(
  () => [props.modelValue, props.appId, props.error?.fingerprint] as const,
  async ([visible]) => {
    if (!visible || !props.appId || !props.error) return
    loading.value = true
    loadError.value = ''
    detail.value = null
    try {
      detail.value = await fetchErrorDetail(props.appId, props.error.fingerprint)
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : String(error)
    } finally {
      loading.value = false
    }
  }
)
</script>

<template>
  <el-drawer v-model="open" size="760px" :title="error?.name || error?.kind || '错误详情'">
    <div v-loading="loading" class="drawer-body">
      <div v-if="loadError" class="err-line">{{ loadError }}</div>

      <template v-if="detail">
        <section class="block">
          <div class="block-title">错误</div>
          <div class="message">{{ detail.error.message }}</div>
          <div class="kv-grid">
            <div class="kv">
              <span class="k">分类</span>
              <el-tag :type="categoryType(detail.error.category)" size="small" effect="plain">
                {{ categoryLabel(detail.error.category) }}
              </el-tag>
            </div>
            <div class="kv">
              <span class="k">发生次数</span>
              <span class="v tabular">{{ detail.error.count }}</span>
            </div>
            <div class="kv">
              <span class="k">首次出现</span>
              <span class="v tabular">{{ formatDate(detail.error.first_seen) }}</span>
            </div>
            <div class="kv">
              <span class="k">最近出现</span>
              <span class="v tabular">{{ relativeTime(detail.error.last_seen) }}</span>
            </div>
            <div class="kv">
              <span class="k">浏览器</span>
              <span class="v">{{ detail.error.browser || '未知' }}</span>
            </div>
            <div class="kv">
              <span class="k">系统</span>
              <span class="v">{{ detail.error.os || '未知' }}</span>
            </div>
            <div class="kv">
              <span class="k">版本</span>
              <span class="v tabular">{{ detail.error.release || '—' }}</span>
            </div>
            <div class="kv">
              <span class="k">环境</span>
              <span class="v">{{ detail.error.environment || '—' }}</span>
            </div>
          </div>
          <div class="kv-grid">
            <div class="kv wide">
              <span class="k">页面</span>
              <span class="v mono">{{ detail.error.url || '—' }}</span>
            </div>
            <div class="kv wide">
              <span class="k">指纹</span>
              <span class="v mono">{{ detail.error.fingerprint }}</span>
            </div>
            <div v-if="detail.error.user_agent" class="kv wide">
              <span class="k">UA</span>
              <span class="v mono small">{{ detail.error.user_agent }}</span>
            </div>
          </div>
        </section>

        <section v-if="httpInfo" class="block">
          <div class="block-title">接口</div>
          <div class="kv-grid">
            <div class="kv">
              <span class="k">方法</span>
              <span class="v mono">{{ httpInfo.method }}</span>
            </div>
            <div class="kv">
              <span class="k">状态码</span>
              <span class="v tabular">{{ httpInfo.status }}</span>
            </div>
            <div class="kv">
              <span class="k">耗时</span>
              <span class="v tabular">{{ httpInfo.durationMs }} ms</span>
            </div>
          </div>
          <div class="mono url">{{ httpInfo.url }}</div>
        </section>

        <section v-if="resourceInfo" class="block">
          <div class="block-title">资源</div>
          <div class="kv-grid">
            <div class="kv">
              <span class="k">标签</span>
              <span class="v mono">{{ resourceInfo.tag }}</span>
            </div>
            <div class="kv">
              <span class="k">类型</span>
              <span class="v">{{ resourceInfo.type }}</span>
            </div>
          </div>
          <div class="mono url">{{ resourceInfo.src }}</div>
        </section>

        <section v-if="resolvedFrames.length > 0" class="block">
          <div class="block-title">
            还原后的栈
            <span class="block-hint">sourcemap 已还原到源码位置</span>
          </div>
          <ol class="stack">
            <li v-for="(frame, index) in resolvedFrames" :key="index" class="stack-item">
              <span class="fn">{{
                frame.original?.functionName || frame.functionName || '(匿名)'
              }}</span>
              <span class="loc mono">
                {{ frame.original?.filename || frame.filename }}:{{
                  frame.original?.lineno || frame.lineno
                }}
              </span>
            </li>
          </ol>
        </section>

        <section v-if="detail.error.raw_stack" class="block">
          <div class="block-title">
            原始栈
            <span class="block-hint">生产环境压缩后的栈</span>
          </div>
          <pre class="stack-raw mono">{{ detail.error.raw_stack }}</pre>
        </section>

        <section v-if="breadcrumbs.length > 0" class="block">
          <div class="block-title">
            出错前的操作
            <span class="block-hint">最近 {{ breadcrumbs.length }} 条</span>
          </div>
          <ol class="crumbs">
            <li v-for="(crumb, index) in breadcrumbs" :key="index" class="crumb">
              <span class="crumb-type mono">{{ crumb.type }}</span>
              <span class="crumb-msg">{{ crumb.message }}</span>
            </li>
          </ol>
        </section>

        <section v-if="detail.events.length > 0" class="block">
          <div class="block-title">最近事件</div>
          <table class="events">
            <thead>
              <tr>
                <th>时间</th>
                <th>发生</th>
                <th>收到</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in detail.events.slice(0, 8)" :key="event.id">
                <td class="mono small">{{ formatDate(event.occurred_at) }}</td>
                <td class="muted small">{{ relativeTime(event.occurred_at) }}</td>
                <td class="muted small">{{ relativeTime(event.received_at) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.drawer-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-bottom: 40px;
}

.err-line {
  color: var(--vigil-danger);
  font-size: 13px;
}

.block {
  border: 1px solid var(--vigil-border);
  border-radius: 4px;
  padding: 14px 16px;
}

.block-title {
  font-size: 12px;
  color: var(--vigil-text-3);
  letter-spacing: 0.03em;
  margin-bottom: 10px;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.block-hint {
  font-size: 11px;
  color: var(--vigil-text-3);
  opacity: 0.7;
}

.message {
  font-size: 14px;
  line-height: 1.55;
  color: var(--vigil-text-1);
  margin-bottom: 14px;
  word-break: break-word;
}

.kv-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px 20px;
}

.kv {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.kv.wide {
  grid-column: 1 / -1;
}

.k {
  font-size: 12px;
  color: var(--vigil-text-3);
  flex: 0 0 64px;
}

.v {
  font-size: 13px;
  color: var(--vigil-text-1);
  word-break: break-all;
}

.v.small,
.small {
  font-size: 11px;
}

.mono {
  font-family: 'SF Mono', 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}

.url {
  margin-top: 10px;
  color: var(--vigil-text-2);
  word-break: break-all;
}

.stack {
  margin: 0;
  padding-left: 20px;
}

.stack-item {
  margin-bottom: 6px;
  font-size: 12px;
  line-height: 1.6;
}

.fn {
  color: var(--vigil-text-1);
  margin-right: 8px;
}

.loc {
  color: var(--vigil-text-3);
}

.stack-raw {
  margin: 0;
  padding: 12px;
  background: var(--vigil-bg-sunken);
  border-radius: 3px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--vigil-text-2);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.crumbs {
  margin: 0;
  padding-left: 18px;
}

.crumb {
  margin-bottom: 5px;
  font-size: 12px;
  line-height: 1.6;
}

.crumb-type {
  color: var(--vigil-text-3);
  margin-right: 8px;
  font-size: 11px;
}

.crumb-msg {
  color: var(--vigil-text-2);
}

.events {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.events th {
  text-align: left;
  font-weight: 400;
  color: var(--vigil-text-3);
  padding: 4px 8px 8px 0;
  border-bottom: 1px solid var(--vigil-border);
}

.events td {
  padding: 6px 8px 6px 0;
  border-bottom: 1px solid var(--vigil-border);
}

.muted {
  color: var(--vigil-text-3);
}
</style>
