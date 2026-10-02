<script setup lang="ts">
import type { Reservation } from '@/types'
import { useMuseumStore } from '@/stores/museum'

defineProps<{ reservation: Reservation; compact?: boolean }>()
const museum = useMuseumStore()

const STATE_LABEL: Record<string, string> = {
  planned: '待参观',
  current: '正在参观',
  done: '已完成',
  skipped: '已跳过',
  maintenance: '临时维护',
  congested: '拥堵避让',
  selfguided: '自助参观',
}
</script>

<template>
  <div class="route-chain">
    <template v-for="(s, i) in reservation.route" :key="i">
      <div class="route-stop" :class="`state-${s.state}`">
        <div class="rs-time">
          <template v-if="s.actualEnter || s.actualLeave">
            实际 {{ s.actualEnter ?? '—' }}~{{ s.actualLeave ?? '…' }}
          </template>
          <template v-else>
            计划 {{ s.plannedEnter }}~{{ s.plannedLeave }}
          </template>
        </div>
        <div class="rs-name">{{ museum.hallById(s.hallId)?.name ?? s.hallId }}</div>
        <div class="rs-note">
          <span class="tag" :class="s.state === 'done' ? 'tag-ok' : s.state === 'maintenance' ? 'tag-maint' : s.state === 'congested' ? 'tag-warn' : s.state === 'selfguided' ? 'tag-acc' : ''">
            {{ STATE_LABEL[s.state] }}
          </span>
          <span v-if="!compact && s.note" style="margin-left:4px">{{ s.note }}</span>
        </div>
      </div>
      <div v-if="i < reservation.route.length - 1" class="route-arrow">→</div>
    </template>
  </div>
</template>
