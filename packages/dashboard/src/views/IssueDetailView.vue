<script setup lang="ts">
/**
 * 问题详情页。
 *
 * 一条问题就是一��工单：它有状态机、有活动流、有评论、
 * 有每一次发生的原始现场。这一页把这几块拼起来 ——
 * 「什么时候开始」「谁动过」「在哪一页崩的」一眼看全。
 */
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  archiveIssue,
  assignIssue,
  commentIssue,
  getIssue,
  markIssueSeen,
  resolveIssue,
  setIssueBookmark,
  unarchiveIssue
} from '../api/client'
import { formatDate, relativeTime } from '../format'
import {
  ACTIVITY_ACTION_LABELS,
  ACTOR_TYPE_LABELS,
  ARCHIVE_STRATEGY_LABELS,
  ISSUE_LEVEL_LABELS,
  PANEL_CONTEXT,
  type ArchiveStrategy,
  type IssueDetail
} from '../types'
import PanelSection from '../components/PanelSection.vue'
import StatusTag from '../components/StatusTag.vue'

const ctx = inject(PANEL_CONTEXT)!
const route = useRoute()

const issue = ref<IssueDetail | null>(null)
const loading = ref(false)
const acting = ref(false)

const resolveVisible = ref(false)
const resolveRelease = ref('')
const resolveReason = ref('')

const archiveVisible = ref(false)
const archiveStrategy = ref<ArchiveStrategy>('forever')
const archiveReason = ref('')

const assignVisible = ref(false)
const assignMemberId = ref<number | undefined>(undefined)
const assignReason = ref('')

const commentText = ref('')

const issueId = computed(() => Number(route.params.id))

const canUnarchive = computed(() => issue.value?.status === 'archived')

const headerFacts = computed(() => {
  const current = issue.value
  if (!current) return []
  return [
    { label: '发生次数', value: current.count.toLocaleString('zh-CN') },
    { label: '受影响用户', value: current.userCount.toLocaleString('zh-CN') },
    { label: '首次出现', value: formatDate(current.firstSeen) },
    { label: '最近出现', value: relativeTime(current.lastSeen) },
    { label: '解决版本', value: current.resolvedInRelease ?? '—' },
    { label: '负责人', value: current.assigneeName ?? '未分配' }
  ]
})

const resolvedStackLines = computed(() => {
  const frames = issue.value?.resolvedStack ?? []
  return frames.map((frame) => {
    const origin = frame.original
    const current = `${frame.functionName ?? '匿名'} @ ${frame.filename}:${frame.lineno ?? 0}:${frame.colno ?? 0}`
    if (!origin) return current
    return `${current}\n    ← ${origin.functionName ?? '匿名'} @ ${origin.filename}:${origin.lineno}:${origin.colno}`
  })
})

const rawStackLines = computed(() => (issue.value?.rawStack ?? '').split('\n'))

function vitalsText(vitals: Record<string, number | undefined> | undefined): string {
  if (!vitals) return '—'
  const parts = Object.entries(vitals)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([key, value]) => `${key.toUpperCase()} ${value}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

async function load(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null || Number.isNaN(issueId.value)) {
    issue.value = null
    return
  }

  loading.value = true
  try {
    issue.value = await getIssue(projectId, issueId.value)
  } catch (error) {
    issue.value = null
    ElMessage.error(`加载问题详情失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

/** 所有状态操作都走这里：成功后重新拉详情，活动流会多一条记录 */
async function run(action: () => Promise<IssueDetail>, successText: string): Promise<void> {
  acting.value = true
  try {
    issue.value = await action()
    ElMessage.success(successText)
  } catch (error) {
    ElMessage.error(`操作失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    acting.value = false
  }
}

async function submitResolve(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null || issue.value === null) return
  const release = resolveRelease.value.trim()
  const reason = resolveReason.value.trim()
  resolveVisible.value = false
  resolveRelease.value = ''
  resolveReason.value = ''
  await run(
    () =>
      resolveIssue(projectId, issue.value!.id, {
        ...(release ? { release } : {}),
        ...(reason ? { reason } : {})
      }),
    '已标记为解决'
  )
}

async function submitArchive(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null || issue.value === null) return
  const strategy = archiveStrategy.value
  const reason = archiveReason.value.trim()
  archiveVisible.value = false
  archiveReason.value = ''
  await run(
    () =>
      archiveIssue(projectId, issue.value!.id, {
        strategy,
        ...(reason ? { reason } : {})
      }),
    '已归档'
  )
}

async function submitAssign(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null || issue.value === null) return
  const memberId = assignMemberId.value
  if (memberId === undefined) {
    ElMessage.warning('请填写成员 ID')
    return
  }
  const reason = assignReason.value.trim()
  assignVisible.value = false
  assignReason.value = ''
  await run(
    () => assignIssue(projectId, issue.value!.id, { memberId, ...(reason ? { reason } : {}) }),
    '已分配负责人'
  )
}

async function unarchive(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null || issue.value === null) return
  await run(() => unarchiveIssue(projectId, issue.value!.id), '已解除归档')
}

async function markSeen(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null || issue.value === null) return
  await run(() => markIssueSeen(projectId, issue.value!.id), '已标记为已阅')
}

async function toggleBookmark(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null || issue.value === null) return
  const next = !issue.value.isBookmarked
  await run(
    () => setIssueBookmark(projectId, issue.value!.id, next),
    next ? '已收藏' : '已取消收藏'
  )
}

async function submitComment(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null || issue.value === null) return
  const body = commentText.value.trim()
  if (body === '') {
    ElMessage.warning('评论内容不能为空')
    return
  }
  commentText.value = ''
  await run(() => commentIssue(projectId, issue.value!.id, body), '评论已提交')
}

watch(
  () => [ctx.projectId, route.params.id],
  () => void load()
)
onMounted(() => void load())
</script>

<template>
  <div v-loading="loading" class="detail-page">
    <div v-if="issue === null && !loading" class="not-found">没有找到这条问题</div>

    <template v-else-if="issue">
      <section class="head">
        <div class="head-main">
          <div class="head-title-row">
            <StatusTag :status="issue.status" :substatus="issue.substatus" />
            <el-tag :type="'info'" effect="plain" size="small">
              {{ ISSUE_LEVEL_LABELS[issue.level] ?? issue.level }}
            </el-tag>
            <span class="short-id tabular">{{ issue.shortId }}</span>
          </div>
          <h1 class="head-title">{{ issue.title }}</h1>
          <div class="head-message">{{ issue.message || '（无消息）' }}</div>
          <div class="fingerprint tabular">
            指纹 <span class="mono">{{ issue.fingerprint }}</span>
          </div>
        </div>

        <div class="head-facts">
          <div v-for="fact in headerFacts" :key="fact.label" class="fact">
            <div class="fact-label">{{ fact.label }}</div>
            <div class="fact-value tabular">{{ fact.value }}</div>
          </div>
        </div>
      </section>

      <section class="actions">
        <el-button
          type="primary"
          size="small"
          :disabled="issue.status === 'resolved'"
          @click="resolveVisible = true"
        >
          标记已解决
        </el-button>
        <el-button
          size="small"
          :disabled="issue.status === 'archived'"
          @click="archiveVisible = true"
        >
          归档
        </el-button>
        <el-button size="small" :disabled="!canUnarchive" @click="unarchive"> 解除归档 </el-button>
        <el-button size="small" @click="markSeen">标记已阅</el-button>
        <el-button size="small" @click="toggleBookmark">
          {{ issue.isBookmarked ? '取消收藏' : '收藏' }}
        </el-button>
        <el-button size="small" @click="assignVisible = true">分配负责人</el-button>
      </section>

      <div class="split">
        <PanelSection title="活动流" :count="issue.activity.length">
          <el-timeline v-if="issue.activity.length > 0" class="timeline">
            <el-timeline-item
              v-for="entry in issue.activity"
              :key="entry.id"
              :timestamp="formatDate(entry.createdAt)"
              placement="top"
              :type="entry.actorType === 'system' ? 'info' : 'primary'"
            >
              <div class="activity-action">
                {{ ACTIVITY_ACTION_LABELS[entry.action] ?? entry.action }}
                <span class="actor">· {{ ACTOR_TYPE_LABELS[entry.actorType] }}</span>
              </div>
              <div v-if="entry.reason" class="activity-reason">{{ entry.reason }}</div>
            </el-timeline-item>
          </el-timeline>
          <div v-else class="empty-hint">还没有活动记录</div>
        </PanelSection>

        <PanelSection title="评论" :count="issue.comments.length">
          <div class="comment-box">
            <el-input
              v-model="commentText"
              type="textarea"
              :rows="3"
              placeholder="写下这条问题的处理说明（会进入活动流）"
            />
            <div class="comment-actions">
              <el-button type="primary" size="small" @click="submitComment">发表评论</el-button>
            </div>
          </div>

          <ul v-if="issue.comments.length > 0" class="comment-list">
            <li v-for="comment in issue.comments" :key="comment.id" class="comment">
              <div class="comment-head">
                <span>{{ comment.authorName ?? `成员 #${comment.authorId ?? '未知'}` }}</span>
                <span class="tabular muted">{{ formatDate(comment.createdAt) }}</span>
              </div>
              <div class="comment-body">{{ comment.body }}</div>
            </li>
          </ul>
          <div v-else class="empty-hint">还没有评论</div>
        </PanelSection>
      </div>

      <PanelSection title="发生记录" :count="issue.events.length" hint="最近 20 次发生">
        <el-table :data="issue.events" size="small" max-height="360">
          <el-table-column label="时间" width="150">
            <template #default="{ row }">
              <span class="tabular">{{ formatDate(row.occurredAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="用户" width="120">
            <template #default="{ row }">
              <span class="tabular muted">{{ row.userId ?? '匿名' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="页面" min-width="240">
            <template #default="{ row }">
              <span class="mono muted">{{ row.url ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="版本" width="96">
            <template #default="{ row }">
              <span class="tabular muted">{{ row.release ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="报错瞬间的性能" min-width="200">
            <template #default="{ row }">
              <span class="vitals">{{ vitalsText(row.vitals) }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <div class="empty-hint">没有发生记录</div>
          </template>
        </el-table>
      </PanelSection>

      <PanelSection title="调用栈" :count="issue.resolvedStack?.length ?? 0">
        <template #actions>
          <span v-for="tag in issue.tags" :key="`${tag.key}-${tag.value}`" class="tag">
            <el-tag size="small" effect="plain">{{ tag.key }}={{ tag.value }}</el-tag>
          </span>
        </template>

        <el-collapse>
          <el-collapse-item title="还原后的栈" name="resolved">
            <pre v-if="resolvedStackLines.length > 0" class="stack">{{
              resolvedStackLines.join('\n')
            }}</pre>
            <div v-else class="empty-hint">暂无还原后的栈（需要先上传 sourcemap）</div>
          </el-collapse-item>
          <el-collapse-item title="原始栈" name="raw">
            <pre v-if="rawStackLines.length > 0" class="stack">{{ rawStackLines.join('\n') }}</pre>
            <div v-else class="empty-hint">暂无原始栈</div>
          </el-collapse-item>
        </el-collapse>
      </PanelSection>
    </template>

    <el-dialog v-model="resolveVisible" title="标记已解决" width="440px">
      <el-form label-width="96px">
        <el-form-item label="解决版本">
          <el-input v-model="resolveRelease" placeholder="例如 1.4.3" clearable />
        </el-form-item>
        <el-form-item label="解决原因">
          <el-input v-model="resolveReason" type="textarea" :rows="3" placeholder="选填" />
        </el-form-item>
      </el-form>
      <p class="dialog-hint">
        <b>解决版本是回归判定的锚</b>：填写后，这条问题在更新的版本里再次出现会被判定为「回归」。
      </p>
      <template #footer>
        <el-button @click="resolveVisible = false">取消</el-button>
        <el-button type="primary" @click="submitResolve">确认解决</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="archiveVisible" title="归档" width="440px">
      <el-form label-width="96px">
        <el-form-item label="归档策略">
          <el-select v-model="archiveStrategy" class="full-width">
            <el-option
              v-for="(label, value) in ARCHIVE_STRATEGY_LABELS"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="归档原因">
          <el-input v-model="archiveReason" type="textarea" :rows="3" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="archiveVisible = false">取消</el-button>
        <el-button type="primary" @click="submitArchive">确认归档</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="assignVisible" title="分配负责人" width="440px">
      <el-form label-width="96px">
        <el-form-item label="成员 ID">
          <el-input-number
            v-model="assignMemberId"
            :min="1"
            :controls="false"
            placeholder="成员 ID"
          />
        </el-form-item>
        <el-form-item label="分配说明">
          <el-input v-model="assignReason" type="textarea" :rows="3" placeholder="选填" />
        </el-form-item>
      </el-form>
      <p class="dialog-hint">当前后端未开放成员列表接口，请直接填写成员 ID。</p>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAssign">确认分配</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.detail-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 20px;
  padding: 18px;
  background: var(--vigil-bg-raised);
  border: 1px solid var(--vigil-border);
  border-radius: 4px;
}

.head-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.short-id {
  font-size: 11px;
  color: var(--vigil-text-3);
}

.head-title {
  margin: 10px 0 6px;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.4;
}

.head-message {
  color: var(--vigil-text-2);
  font-size: 13px;
  word-break: break-word;
}

.fingerprint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--vigil-text-3);
}

.mono {
  font-family: 'SF Mono', 'Cascadia Mono', Consolas, monospace;
}

.head-facts {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px 16px;
  align-content: start;
}

.fact-label {
  font-size: 11px;
  color: var(--vigil-text-3);
}

.fact-value {
  font-size: 15px;
  color: var(--vigil-text-1);
  margin-top: 2px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.timeline {
  padding-left: 2px;
}

.activity-action {
  font-size: 13px;
  color: var(--vigil-text-1);
}

.actor {
  color: var(--vigil-text-3);
  font-size: 12px;
}

.activity-reason {
  margin-top: 3px;
  font-size: 12px;
  color: var(--vigil-text-2);
}

.comment-box {
  margin-bottom: 14px;
}

.comment-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.comment-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.comment {
  padding: 9px 0;
  border-bottom: 1px solid var(--vigil-border);
}

.comment:last-child {
  border-bottom: none;
}

.comment-head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--vigil-text-2);
}

.comment-body {
  margin-top: 4px;
  font-size: 13px;
  color: var(--vigil-text-1);
  white-space: pre-wrap;
  word-break: break-word;
}

.vitals {
  font-size: 11px;
  color: var(--vigil-text-2);
}

.stack {
  margin: 0;
  padding: 12px;
  background: var(--vigil-bg-sunken);
  border: 1px solid var(--vigil-border);
  border-radius: 4px;
  font-family: 'SF Mono', 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: var(--vigil-text-1);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.tag {
  margin-left: 6px;
}

.muted {
  color: var(--vigil-text-3);
}

.empty-hint {
  padding: 22px;
  text-align: center;
  color: var(--vigil-text-3);
  font-size: 13px;
}

.not-found {
  padding: 48px;
  text-align: center;
  color: var(--vigil-text-3);
}

.full-width {
  width: 100%;
}

.dialog-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vigil-text-3);
  line-height: 1.6;
}

@media (max-width: 1200px) {
  .head,
  .split {
    grid-template-columns: 1fr;
  }
}
</style>
