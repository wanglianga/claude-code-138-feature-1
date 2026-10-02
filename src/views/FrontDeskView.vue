<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { useSessionStore } from '@/stores/session'
import { hmOfISO, toMin } from '@/lib/time'
import { occupancyGrid } from '@/lib/schedule'
import {
  LATE_REPLAN_THRESHOLD,
  analyzeLate,
  buildReschedulePlan,
  buildSelfGuidePlan,
  buildShortenPlan,
  congestionNoteFor,
} from '@/lib/latePlan'
import { LATE_PLAN_LABEL, type LatePlanKind } from '@/types'
import StatusBadge from '@/components/StatusBadge.vue'

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
const chosenPlan = ref<LatePlanKind | ''>('')
watch(selectedId, () => {
  headcount.value = r.value?.groupSize ?? 0
  headsetCount.value = r.value?.headsetCount ?? 0
  chosenPlan.value = ''
}, { immediate: true })

const lateMin = computed(() => {
  if (!r.value?.actualArrive) return null
  return toMin(hmOfISO(r.value.actualArrive)) - toMin(hmOfISO(r.value.arriveTime))
})

// ---------- 迟到路线重排 ----------
/** 迟到上下文：剩余讲解时长 / 讲解员后续任务 / 下一团到馆 */
const lateCtx = computed(() => {
  const res = r.value
  if (!res || !res.actualArrive || res.lateReplan || res.status !== 'arrived') return null
  const ctx = analyzeLate(res, store.list, museum.guides, museum.nowHM)
  return ctx.lateMin >= LATE_REPLAN_THRESHOLD ? ctx : null
})
/** 容量栅格（排除本团，避免自我叠加） */
const lateGrid = computed(() =>
  occupancyGrid(
    store.list.filter((x) => x.id !== selectedId.value),
    { maintenance: museum.maintenance, extraLoad: museum.extraLoad },
  ),
)
const liveState = computed(() => ({ maintenance: museum.maintenance, extraLoad: museum.extraLoad }))
const congestionNote = computed(() =>
  r.value
    ? congestionNoteFor(museum.halls, lateGrid.value, museum.nowHM, r.value.verifiedSize ?? r.value.groupSize)
    : '',
)
const shortenPlan = computed(() =>
  r.value && lateCtx.value
    ? buildShortenPlan(r.value, lateCtx.value, museum.halls, lateGrid.value, liveState.value)
    : null,
)
const selfPlan = computed(() =>
  r.value && lateCtx.value
    ? buildSelfGuidePlan(r.value, lateCtx.value, museum.halls, store.list, museum.guides)
    : null,
)
const reschedulePlan = computed(() =>
  r.value && lateCtx.value
    ? buildReschedulePlan(r.value, lateCtx.value, museum.halls, store.list, museum.guides, liveState.value, museum.nowHM)
    : null,
)

function confirmLatePlan() {
  const res = r.value
  if (!res || !lateCtx.value || !chosenPlan.value) return
  if (chosenPlan.value === 'shorten' && shortenPlan.value && shortenPlan.value.stops.length) {
    store.applyLateShorten(res.id, shortenPlan.value, lateCtx.value, congestionNote.value, session.staffName)
  } else if (chosenPlan.value === 'self' && selfPlan.value) {
    store.applyLateSelf(res.id, selfPlan.value, lateCtx.value, congestionNote.value, session.staffName)
  } else if (chosenPlan.value === 'reschedule' && reschedulePlan.value) {
    store.applyLateReschedule(res.id, reschedulePlan.value, lateCtx.value, congestionNote.value, session.staffName)
  } else {
    return
  }
  chosenPlan.value = ''
}

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
        <div v-if="lateMin !== null && lateMin !== 0 && !r.lateReplan"
             class="callout" :class="lateMin > 10 ? 'danger' : 'info'" style="margin-top:12px; margin-bottom:0">
          团队{{ lateMin > 0 ? `迟到 ${lateMin} 分钟` : `早到 ${-lateMin} 分钟` }}，
          {{ lateMin > 10 ? '需顺延后续展厅计划并评估对其他团队的影响（在分流调度页操作）。' : '可按原计划入馆。' }}
          <template v-if="lateCtx">请在下方「迟到路线重排」中与联系人确认方案后再放行。</template>
        </div>
      </div>

      <!-- ⏰ 迟到路线重排：依据剩余讲解时长 / 展厅拥堵 / 下一团到馆生成三方案 -->
      <div v-if="lateCtx" class="card" style="border-color:var(--amber)">
        <div class="card-title">
          ⏰ 迟到路线重排建议
          <span class="aside">依据：剩余讲解时长 · 展厅当前拥堵 · 下一团到馆时间</span>
        </div>
        <div class="grid grid-4" style="margin-bottom:12px">
          <div><div class="stat-label">迟到</div><div class="stat-num" style="color:var(--red)">{{ lateCtx.lateMin }}<span style="font-size:14px"> 分钟</span></div></div>
          <div>
            <div class="stat-label">剩余可讲解时长</div>
            <div class="stat-num">{{ lateCtx.remainMin }}<span style="font-size:14px"> 分钟</span></div>
            <div class="small muted">{{ lateCtx.enterHM }} 进场 → {{ lateCtx.mustLeaveByHM }} 前结束</div>
          </div>
          <div>
            <div class="stat-label">讲解员后续任务</div>
            <div class="small" style="margin-top:6px">{{ lateCtx.guideConstraint }}</div>
          </div>
          <div>
            <div class="stat-label">下一团到馆 / 当前拥堵</div>
            <div class="small" style="margin-top:6px">
              {{ lateCtx.nextArrivals.length ? lateCtx.nextArrivals.map((n) => `「${n.orgName}」${n.arriveHM}`).join('、') : '后续无团队到馆' }}
              <div class="muted">{{ congestionNote }}</div>
            </div>
          </div>
        </div>

        <div class="grid grid-3" style="align-items:stretch">
          <!-- 方案一：缩短路线 -->
          <div class="tight" data-plan="shorten" style="border:1px solid var(--line); border-radius:9px; padding:12px 14px; cursor:pointer; display:flex; flex-direction:column"
               :style="chosenPlan === 'shorten' ? 'border-color:var(--gold); box-shadow:0 0 0 3px rgba(201,178,128,.22)' : ''"
               @click="shortenPlan?.stops.length && (chosenPlan = 'shorten')">
            <strong>① 缩短路线 <span class="tag tag-warn">压缩讲解</span></strong>
            <template v-if="shortenPlan && shortenPlan.stops.length">
              <div class="small" style="margin:7px 0">
                <div v-for="s in shortenPlan.stops" :key="s.hallId" class="mono">
                  {{ s.plannedEnter }}~{{ s.plannedLeave }} {{ museum.hallById(s.hallId)?.name.replace(/^.*? · /, '') }}（{{ s.durationMin }} 分钟）
                </div>
              </div>
              <div v-if="shortenPlan.dropped.length" class="small" style="color:var(--red)">
                舍弃：{{ shortenPlan.dropped.map((d) => museum.hallById(d.hallId)?.name.replace(/^.*? · /, '')).join('、') }}
              </div>
              <div class="small muted" style="margin-top:4px">{{ shortenPlan.endHM }} 结束，讲解员可按时接下一任务</div>
            </template>
            <div v-else class="small muted" style="margin:7px 0">剩余时长不足一站（{{ lateCtx.remainMin }} 分钟），不可行。</div>
            <span style="flex:1"></span>
            <span class="hint">耳麦应还随路线自动调整</span>
          </div>

          <!-- 方案二：自助参观 -->
          <div class="tight" data-plan="self" style="border:1px solid var(--line); border-radius:9px; padding:12px 14px; cursor:pointer; display:flex; flex-direction:column"
               :style="chosenPlan === 'self' ? 'border-color:var(--gold); box-shadow:0 0 0 3px rgba(201,178,128,.22)' : ''"
               @click="chosenPlan = 'self'">
            <strong>② 自助参观 <span class="tag tag-ok">内容不压缩</span></strong>
            <div class="small" style="margin:7px 0">
              推送电子导览（{{ selfPlan?.points.length ?? 0 }} 个展厅要点）<br />
              集合：<span class="mono">{{ selfPlan?.meetingHM }}</span> {{ selfPlan?.meetingPoint }}
            </div>
            <div class="small" style="color:var(--green)">
              释放讲解员 {{ selfPlan?.releasedWindow }} 时段
              <template v-if="selfPlan?.assignable.length">，可支援：{{ selfPlan.assignable.map((a) => a.orgName).join('、') }}</template>
            </div>
            <span style="flex:1"></span>
            <span class="hint">讲解员排班自动释放</span>
          </div>

          <!-- 方案三：改签时段 -->
          <div class="tight" data-plan="reschedule" style="border:1px solid var(--line); border-radius:9px; padding:12px 14px; cursor:pointer; display:flex; flex-direction:column"
               :style="chosenPlan === 'reschedule' ? 'border-color:var(--gold); box-shadow:0 0 0 3px rgba(201,178,128,.22)' : reschedulePlan ? '' : 'opacity:.55'"
               @click="reschedulePlan && (chosenPlan = 'reschedule')">
            <strong>③ 改签时段 <span class="tag">当日稍后</span></strong>
            <template v-if="reschedulePlan">
              <div class="small" style="margin:7px 0">
                改签至 <strong class="mono">{{ reschedulePlan.slotHM }}~{{ reschedulePlan.endHM }}</strong>，完整参观不压缩<br />
                讲解员：{{ reschedulePlan.guideName }}{{ reschedulePlan.sameGuide ? '（原讲解员顺延）' : '（改派）' }}
              </div>
              <div class="small muted">各展厅叠加本团后均未超容量</div>
            </template>
            <div v-else class="small muted" style="margin:7px 0">当日稍后无「讲解员有空 + 展厅不超载」的完整时段，建议电话协商改期。</div>
            <span style="flex:1"></span>
            <span class="hint">安检批次与容量自动重算</span>
          </div>
        </div>

        <div style="display:flex; gap:10px; align-items:center; margin-top:12px">
          <button class="btn-gold" :disabled="!chosenPlan" @click="confirmLatePlan">
            📞 联系人确认采用{{ chosenPlan ? `「${LATE_PLAN_LABEL[chosenPlan]}」` : '方案' }}
          </button>
          <span class="hint">确认后：耳麦借用时间与讲解员排班自动调整，压缩依据写入档案（投诉时可回放）。</span>
        </div>
      </div>

      <!-- 已应用的迟到重排结果 -->
      <div v-if="r.lateReplan" class="card" style="border-color:var(--green)">
        <div class="card-title">
          ✓ 已按「{{ LATE_PLAN_LABEL[r.lateReplan.kind] }}」重排
          <span class="aside">迟到 {{ r.lateReplan.lateMin }} 分钟 · 联系人 {{ r.lateReplan.confirmedBy }} 已确认 · 依据已存档</span>
        </div>
        <div v-if="r.selfGuided && r.selfGuideInfo" class="grid grid-2" style="align-items:start">
          <div>
            <div class="small muted" style="margin-bottom:6px">📱 已推送电子导览（{{ r.selfGuideInfo.pushedAt.slice(11, 16) }}）</div>
            <div v-for="p in r.selfGuideInfo.points" :key="p.hallId" class="small" style="margin-bottom:6px">
              <strong>{{ museum.hallById(p.hallId)?.name }}</strong>
              <div class="muted">{{ p.highlights.join('；') }}</div>
            </div>
            <div class="callout info" style="margin:8px 0 0">
              集合：<strong class="mono">{{ r.selfGuideInfo.meetingHM }}</strong> · {{ r.selfGuideInfo.meetingPoint }}
            </div>
          </div>
          <div>
            <div class="small muted" style="margin-bottom:6px">🔄 讲解员释放时段再分配</div>
            <dl class="kv">
              <dt>释放讲解员</dt><dd>{{ r.selfGuideInfo.releasedGuideNames.join('、') }}</dd>
              <dt>空出时段</dt><dd class="mono">{{ r.selfGuideInfo.releasedWindow }}</dd>
              <dt>耳麦应还</dt><dd class="mono">{{ r.headsetDueHM ?? '—' }} 前</dd>
            </dl>
            <div v-if="r.selfGuideInfo.assignableNotes.length" class="callout ok" style="margin:8px 0 0">
              <div v-for="(note, i) in r.selfGuideInfo.assignableNotes" :key="i" class="small">✓ {{ note }}</div>
            </div>
            <div v-else class="small muted" style="margin-top:8px">该时段暂无可接续的等待团队，讲解员回岗待命。</div>
          </div>
        </div>
        <div v-else class="small">
          <div v-for="(reason, i) in r.lateReplan.reasons" :key="i" style="margin-bottom:3px">· {{ reason }}</div>
          <div class="muted" style="margin-top:6px">
            计划结束 {{ r.lateReplan.beforeEndHM }} → {{ r.lateReplan.afterEndHM }} · 耳麦应还 {{ r.headsetDueHM ?? '—' }} 前
          </div>
        </div>
      </div>

      <div class="grid grid-3" style="align-items:start">
        <!-- 步骤1 到馆 -->
        <div class="card" :style="r.status === 'confirmed' ? 'border-color:var(--gold)' : ''">
          <div class="card-title">① 到馆登记</div>
          <dl class="kv">
            <dt>联系人</dt><dd>{{ r.contactName }} {{ r.contactPhone }}</dd>
            <dt>车辆</dt><dd>{{ r.busInfo }}</dd>
            <dt>讲解员</dt><dd>{{ r.selfGuided ? '自助参观（讲解员已释放）' : r.assignedGuideIds.map((g) => museum.guideById(g)?.name).join('、') || '待排班' }}</dd>
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
              <span v-if="r.headsetDueHM" class="hint">应于 <strong class="mono">{{ r.headsetDueHM }}</strong> 前归还（随路线重排自动调整）</span>
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
            <template v-if="r.selfGuided">
              自助参观团：<strong>无需讲解员就位</strong><br />
              电子导览与集合点已推送联系人。
            </template>
            <template v-else>
              已排讲解员：<strong>{{ r.assignedGuideIds.map((g) => museum.guideById(g)?.name).join('、') || '—' }}</strong><br />
              如需临时更换，请到「途中分流调度」页操作。
            </template>
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
                :disabled="r.status !== 'arrived' || r.verifiedSize === undefined || !!lateCtx"
                @click="admit">
          🎫 {{ r.batchNo }} 批次安检入馆，{{ r.selfGuided ? '开始自助参观' : '开始讲解' }}
        </button>
        <div v-if="lateCtx" class="hint" style="margin-top:6px; text-align:center">
          ⏰ 该团迟到 {{ lateCtx.lateMin }} 分钟：请先在上方「迟到路线重排」中与联系人确认方案，确认后自动解除暂缓。
        </div>
      </div>
    </div>
  </div>
</template>
