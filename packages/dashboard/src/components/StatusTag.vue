<script setup lang="ts">
/**
 * 问题状态标签。
 *
 * 颜色即语义：
 * - 升级中 → danger（最需要人看）
 * - 回归   → warning（老问题又出现了）
 * - 新建   → primary（强调色，代表「当前待处理的新信号」）
 * - 处理中 → info
 * - 已解决 / 已归档 → 默认灰
 */
import { computed } from 'vue'
import {
  ISSUE_STATUS_LABELS,
  ISSUE_SUBSTATUS_LABELS,
  type IssueStatus,
  type IssueSubstatus
} from '../types'

const props = defineProps<{
  status?: IssueStatus
  substatus?: IssueSubstatus
}>()

const isClosed = computed(() => props.status === 'resolved' || props.status === 'archived')

const label = computed(() => {
  if (props.status && props.status !== 'unresolved') return ISSUE_STATUS_LABELS[props.status]
  if (props.substatus) return ISSUE_SUBSTATUS_LABELS[props.substatus]
  return props.status ? ISSUE_STATUS_LABELS[props.status] : '未知'
})

const tagType = computed<'primary' | 'info' | 'warning' | 'danger'>(() => {
  if (isClosed.value) return 'info'
  switch (props.substatus) {
    case 'new':
      return 'primary'
    case 'escalating':
      return 'danger'
    case 'regressed':
      return 'warning'
    default:
      return 'info'
  }
})
</script>

<template>
  <el-tag :type="tagType" :effect="isClosed ? 'plain' : 'light'" size="small">
    {{ label }}
  </el-tag>
</template>
