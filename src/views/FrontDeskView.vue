<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { useSessionStore } from '@/stores/session'
import { hmOfISO, toMin } from '@/lib/time'
import StatusBadge from '@/components/StatusBadge.vue'
import LatePlanPanel from '@/components/LatePlanPanel.vue'

const store = useReservationsStore()
const museum = useMuseumStore()
const session = useSessionStore()
const route = useRoute()
const router = useRouter()

const queue = computed(() =>
  [...store.list]
    .filter((r) => ['confirmed', 'arrived'].includes(r.status))
    .sort((a, b) => a.arriveTime.localeCompare(b.arriveTime)),
)
const selectedId = ref((route.params.id as string) || '')
watch(queue, (q) => {
  if (!q.some((r) => r.id === selectedId.value) && q[0]) selectedId.value = q[0].id
}, { immediate: true })

const r = computed(() => store.byId(selectedId.value))

const headcount = ref<number>(0)
const headsetCount = ref<number>(0)
watch(selectedId, () => {
  headcount.value = r.value?.groupSize ?? 0
  headsetCount.value = r.value?.headsetCount ?? 0
}, { immediate: true })

const lateMin = computed(() => {
  if (!r.value?.actualArrive) return null
  return toMin(hmOfISO(r.value.actualArrive)) - toMin(hmOfISO(r.value.arriveTime))
})

/** 按当前馆内时钟相对预约到馆的迟到分钟（团尚未登记到馆也可提前启动重排） */
const clockLateMin = computed(() => {
  if (!r.value) return 0
  return Math.max(0, toMin(museum.nowHM) - toMin(hmOfISO(r.value.arriveTime)))
})

function arrive() {
  store.markArrived(selectedId.value)
}
function verify() {
  store.verifyHeadcount(selectedId.value, headcount.value, session.staffName)
}
function handout() {
  store.handoutHeadsets(selectedId.value, headsetCount.value, session.staffName)
}
function admit() {
  store.admit(selectedId.value, session.staffName)
  router.push('/dispatch')
}

const availableStock = computed(() => museum.inventory.available)

// 严重迟到路线重排（已到馆/已确认但尚未入馆即可处置）
const lateOpen = ref(false)
</script>

<template>
  <div v-if="!r" class="card empty">当前没有待办理到馆的已确认团队。</div>

  <div v-else class="grid" style="grid-template-columns: 300px 1fr; align-items:start">
    <div class="card" style="padding:6px">
      <div class="card-title" style="margin:6px 8px">到馆队列</div>
      <div
        v-for="q in queue" :key="q.id"
        style="padding:10px 12px; cursor:pointer; border-radius:8px"
        :style="q.id === selectedId ? 'background:var(--paper-2)' : ''"
        @click="selectedId = q.id"
      >
        <strong style="font-size:13px">{{ q.orgName }}</strong>
        <div class="small muted mono">{{ q.groupSize }} 人 · 约 {{ hmOfISO(q.arriveTime) }}</div>
        <div style="margin-top:4px; display:flex; gap:6px; align-items:center">
          <StatusBadge :status="q.status" />
          <span v-if="q.actualArrive" class="small" style="color:var(--purple)">实际 {{ hmOfISO(q.actualArrive) }}</span>
        </div>
      </div>
    </div>

    <div style="display:flex; flex-direction:column; gap:14px">
      <div class="card">
        <div class="card-title">
          {{ r.orgName }} · {{ r.id }}
          <span class="aside">批次 {{ r?.batchNo }} · {{ museum.lanes.find((l) => l.id === r?.securityLane)?.name }}</span>
        </div>
        <div class="grid grid-4">
          <div><div class="stat-label">预约人数</div><div class="stat-num">{{ r.groupSize }}</div></div>
          <div><div class="stat-label">已核验人数</div><div class="stat-num">{{ r.verifiedSize ?? '—' }}</div></div>
          <div><div class="stat-label">耳麦库存（在库）</div><div class="stat-num">{{ availableStock }}</div></div>
          <div><div class="stat-label">预约到馆</div><div class="stat-num" style="font-size:22px">{{ hmOfISO(r.arriveTime) }}</div></div>
        </div>
        <div v-if="(lateMin !== null && lateMin !== 0) || clockLateMin >= 20"
             class="callout" :class="(lateMin ?? clockLateMin) > 10 ? 'danger' : 'info'" style="margin-top:12px; margin-bottom:0">
          <template v-if="lateMin !== null && lateMin !== 0">
            团队{{ lateMin > 0 ? `迟到 ${lateMin} 分钟` : `早到 ${-lateMin} 分钟` }}，
            {{ lateMin > 10 ? '原定讲解员后续可能还有带团任务，可立即启动路线重排（缩短/自助/改签），联系人确认后联动耳麦与排班。' : '可按原计划入馆。' }}
          </template>
          <template v-else>
            按当前时钟该团已迟到约 {{ clockLateMin }} 分钟（尚未登记到馆），可先按现场情况预演重排方案。
          </template>
          <div v-if="(lateMin ?? clockLateMin) >= 20" style="margin-top:8px">
            <button class="btn-sm btn-gold" @click="lateOpen = true">⏱ 启动团体迟到路线重排</button>
          </div>
        </div>
        <LatePlanPanel v-if="lateOpen" v-model:open="lateOpen" :res-id="selectedId" />
      </div>

      <div class="grid grid-3" style="align-items:start">
        <!-- 步骤1 到馆 -->
        <div class="card" :style="r.status === 'confirmed' ? 'border-color:var(--gold)' : ''">
          <div class="card-title">① 到馆登记</div>
          <dl class="kv">
            <dt>联系人</dt><dd>{{ r.contactName }} {{ r.contactPhone }}</dd>
            <dt>车辆</dt><dd>{{ r.busInfo }}</dd>
            <dt>讲解员</dt><dd>{{ r.assignedGuideIds.map((g) => museum.guideById(g)?.name).join('、') || '待排班' }}</dd>
          </dl>
          <button class="btn-primary" style="width:100%; justify-content:center; margin-top:8px"
                  :disabled="r.status !== 'confirmed'" @click="arrive">
            登记到馆（时钟 {{ museum.nowHM }}）
          </button>
        </div>

        <!-- 步骤2 核验 -->
        <div class="card" :style="r.verifiedSize !== undefined ? '' : ''">
          <div class="card-title">② 核验人数</div>
          <div class="field">
            <label>现场实到人数</label>
            <input v-model.number="headcount" type="number" :min="0" :max="120" />
            <span v-if="headcount !== r.groupSize" class="hint">
              与预约 {{ headcount > r.groupSize ? `多 ${headcount - r.groupSize}` : `少 ${r.groupSize - headcount}` }} 人，容量与耳麦数量将按实到重算。
            </span>
          </div>
          <button class="btn-primary" style="width:100%; justify-content:center"
                  :disabled="r.status === 'confirmed'" @click="verify">确认核验</button>
        </div>

        <!-- 步骤3 设备 -->
        <div class="card">
          <div class="card-title">③ 发放耳麦</div>
          <template v-if="r.needHeadsets">
            <div class="field">
              <label>发放数量（押金 ¥{{ museum.depositPerUnit }}/台）</label>
              <input v-model.number="headsetCount" type="number" :min="0" :max="r.verifiedSize ?? r.groupSize" />
              <span class="hint">合计押金 <strong class="money">¥{{ (headsetCount * museum.depositPerUnit).toLocaleString() }}</strong></span>
            </div>
            <button class="btn-primary" style="width:100%; justify-content:center"
                    :disabled="r.verifiedSize === undefined || !!r.devices.length" @click="handout">
              {{ r.devices.length ? `已发放 ${r.devices.length} 台` : '从设备间取机发放' }}
            </button>
          </template>
          <div v-else class="muted small">该团未申请耳麦。</div>
        </div>
      </div>

      <!-- 步骤4 入场 -->
      <div class="card">
        <div class="card-title">④ 讲解员就位 · 批次入馆</div>
        <div class="grid grid-3">
          <div class="callout info" style="margin:0">
            已排讲解员：<strong>{{ r.assignedGuideIds.map((g) => museum.guideById(g)?.name).join('、') || '—' }}</strong><br />
            如需临时更换，请到「途中分流调度」页操作。
          </div>
          <div class="callout info" style="margin:0">
            安检通道：<strong>{{ museum.lanes.find((l) => l.id === r?.securityLane)?.name }}</strong><br />
            批次号：<strong>{{ r.batchNo }}</strong>
          </div>
          <div class="callout" :class="r.verifiedSize !== undefined ? 'ok' : 'warn'" style="margin:0">
            <strong>入场前检查</strong><br />
            {{ r.verifiedSize === undefined ? '⚠ 人数未核验' : '✓ 人数已核验' }}；
            {{ !r.needHeadsets || r.devices.length ? '✓ 耳麦已处理' : '⚠ 耳麦未发放' }}
          </div>
        </div>
        <button class="btn-gold" style="width:100%; justify-content:center; margin-top:12px; font-size:15px; padding:10px"
                :disabled="r.status !== 'arrived' || r.verifiedSize === undefined"
                @click="admit">
          🎫 {{ r.batchNo }} 批次安检入馆，开始讲解
        </button>
      </div>
    </div>
  </div>
</template>
