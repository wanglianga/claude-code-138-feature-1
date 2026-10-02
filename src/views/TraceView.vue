<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { useSessionStore } from '@/stores/session'
import { hmOfISO, toMin } from '@/lib/time'
import { LATE_PLAN_LABEL } from '@/types'
import StatusBadge from '@/components/StatusBadge.vue'
import RouteChain from '@/components/RouteChain.vue'
import TimelineView from '@/components/TimelineView.vue'

const store = useReservationsStore()
const museum = useMuseumStore()
const session = useSessionStore()
const route = useRoute()

const list = computed(() =>
  [...store.list].sort((a, b) => {
    const ac = a.complaint ? 0 : 1
    const bc = b.complaint ? 0 : 1
    return ac - bc || b.arriveTime.localeCompare(a.arriveTime)
  }),
)
const selectedId = ref((route.params.id as string) || list.value[0]?.id || '')
watch(list, (l) => {
  if (!l.some((x) => x.id === selectedId.value) && l[0]) selectedId.value = l[0].id
}, { immediate: true })

const r = computed(() => store.byId(selectedId.value))
const newComplaint = ref('')
const reply = ref('')
watch(selectedId, () => {
  newComplaint.value = ''
  reply.value = r.value?.complaintReply ?? ''
}, { immediate: true })

/** 实际在厅讲解时长：各站 actualLeave-actualEnter 之和（压缩停留会直接体现为"讲解缩水"） */
const actualDuration = computed(() => {
  if (!r.value) return null
  const withActual = r.value.route.filter((s) => s.actualEnter && s.actualLeave)
  if (!withActual.length) return null
  const inHall = withActual.reduce(
    (sum, s) => sum + toMin(s.actualLeave!) - toMin(s.actualEnter!),
    0,
  )
  const start = withActual[0].actualEnter!
  const end = r.value.departAt ? hmOfISO(r.value.departAt) : withActual[withActual.length - 1].actualLeave!
  return { start, end, min: inHall }
})

const guideChanges = computed(() =>
  r.value?.timeline.filter((e) => e.kind === 'guide_swap' || e.kind === 'guide_assign') ?? [],
)

function submitComplaint() {
  if (!newComplaint.value.trim()) return
  store.addComplaint(selectedId.value, newComplaint.value.trim(), r.value?.contactName ?? '团体联系人')
  newComplaint.value = ''
}
function submitReply() {
  store.replyComplaint(selectedId.value, reply.value.trim(), session.staffName)
}

const deviceRows = computed(() => r.value?.devices ?? [])
</script>

<template>
  <div class="grid" style="grid-template-columns: 260px 1fr; align-items:start">
    <div class="card" style="padding:6px">
      <div class="card-title" style="margin:6px 8px">预约档案</div>
      <div v-for="x in list" :key="x.id" style="padding:9px 12px; cursor:pointer; border-radius:8px"
           :style="x.id === selectedId ? 'background:var(--paper-2)' : ''" @click="selectedId = x.id">
        <div style="display:flex; gap:6px; align-items:center">
          <strong style="font-size:13px">{{ x.orgName }}</strong>
          <span v-if="x.complaint" title="有投诉" style="color:var(--red)">❗</span>
        </div>
        <div class="small muted mono">{{ x.id }} · {{ hmOfISO(x.arriveTime) }}</div>
        <div style="margin-top:3px"><StatusBadge :status="x.status" /></div>
      </div>
    </div>

    <div v-if="r" style="display:flex; flex-direction:column; gap:14px">
      <!-- 投诉条 -->
      <div class="card" :style="r.complaint ? 'border-color:var(--red)' : ''">
        <div class="card-title">
          团体投诉与解释
          <span class="aside">证据来自同一预约的全流程留痕，不依赖人工回忆</span>
        </div>
        <div v-if="r.complaint" class="callout danger">
          <strong>团体投诉（{{ r.contactName }}）：</strong>{{ r.complaint }}
        </div>
        <div v-if="r.complaintReply" class="callout ok" style="margin-bottom:10px">
          <strong>馆方答复（{{ session.staffName }}）：</strong>{{ r.complaintReply }}
        </div>
        <div v-if="r.complaint && r.status === 'completed'" class="field">
          <label>馆方处理答复</label>
          <textarea v-model="reply" placeholder="根据下方证据链说明情况、致歉与改进措施"></textarea>
          <div><button class="btn-gold" :disabled="!reply.trim()" @click="submitReply">保存答复</button></div>
        </div>
        <div v-else-if="!r.complaint">
          <div class="field">
            <label>登记团体反馈/投诉</label>
            <textarea v-model="newComplaint" placeholder="如：讲解缩水、等待过长、设备问题……"></textarea>
          </div>
          <button class="btn-danger" :disabled="!newComplaint.trim()" @click="submitComplaint">登记投诉</button>
        </div>
      </div>

      <!-- 关键事实 -->
      <div class="grid grid-4">
        <div class="card tight">
          <div class="stat-label">预约 / 实际到馆</div>
          <div class="stat-num" style="font-size:20px">{{ hmOfISO(r.arriveTime) }}</div>
          <div class="small" :style="r.actualArrive ? '' : 'color:var(--ink-3)'">
            {{ r.actualArrive ? `实际 ${hmOfISO(r.actualArrive)}` : '尚未到馆' }}
          </div>
        </div>
        <div class="card tight">
          <div class="stat-label">预约 / 实到人数</div>
          <div class="stat-num">{{ r.groupSize }} <span style="font-size:15px">/ {{ r.verifiedSize ?? '—' }}</span></div>
          <div v-if="r.verifiedSize !== undefined && r.verifiedSize !== r.groupSize" class="small" style="color:var(--amber)">
            人数差异 {{ r.verifiedSize - r.groupSize > 0 ? `+${r.verifiedSize - r.groupSize}` : r.verifiedSize - r.groupSize }}
          </div>
        </div>
        <div class="card tight">
          <div class="stat-label">计划 / 实际讲解时长</div>
          <div class="stat-num">{{ r.durationMin }} <span style="font-size:15px">/ {{ actualDuration?.min ?? '—' }} 分钟</span></div>
          <div v-if="actualDuration && actualDuration.min < r.durationMin - 10" class="small" style="color:var(--red)">
            ⚠ 实际少 {{ r.durationMin - actualDuration.min }} 分钟
          </div>
        </div>
        <div class="card tight">
          <div class="stat-label">满意度</div>
          <div class="stars" style="font-size:22px">{{ r.satisfaction ? '★'.repeat(r.satisfaction) + '☆'.repeat(5 - r.satisfaction) : '—' }}</div>
          <div class="small muted">{{ r.departAt ? `离馆 ${hmOfISO(r.departAt)}` : '' }}</div>
        </div>
      </div>

      <!-- 迟到压缩依据：投诉「讲解内容减少」时直接回放决策现场 -->
      <div v-if="r.lateReplan" class="card" :style="r.complaint ? 'border-color:var(--red)' : ''">
        <div class="card-title">
          ⏰ 迟到压缩依据
          <span class="aside">
            {{ r.lateReplan.decidedAt.slice(11, 16) }} 决策 · 经办 {{ r.lateReplan.decidedBy }} · 联系人 {{ r.lateReplan.confirmedBy }} 已确认
          </span>
        </div>
        <div v-if="r.complaint" class="callout danger" style="margin-bottom:12px">
          团体投诉内容减少 —— 以下为迟到 {{ r.lateReplan.lateMin }} 分钟导致压缩的完整依据，可直接用于答复。
        </div>
        <div class="grid grid-4" style="margin-bottom:10px">
          <div><div class="stat-label">迟到</div><div class="stat-num" style="color:var(--red)">{{ r.lateReplan.lateMin }}<span style="font-size:14px"> 分钟</span></div></div>
          <div><div class="stat-label">决策时剩余可讲解</div><div class="stat-num">{{ r.lateReplan.remainMin }}<span style="font-size:14px"> 分钟</span></div></div>
          <div><div class="stat-label">处置方案</div><div class="stat-num" style="font-size:21px">{{ LATE_PLAN_LABEL[r.lateReplan.kind] }}</div></div>
          <div>
            <div class="stat-label">计划结束 原 → 新</div>
            <div class="stat-num mono" style="font-size:21px">{{ r.lateReplan.beforeEndHM }} → {{ r.lateReplan.afterEndHM }}</div>
          </div>
        </div>
        <dl class="kv">
          <dt>讲解员约束</dt><dd>{{ r.lateReplan.guideConstraint }}</dd>
          <dt>下一团到馆</dt><dd>{{ r.lateReplan.nextArrivalNote }}</dd>
          <dt>决策时拥堵</dt><dd>{{ r.lateReplan.congestionNote }}</dd>
        </dl>
        <div style="margin-top:10px">
          <div class="small muted" style="margin-bottom:4px">压缩 / 改派依据（逐条）</div>
          <div v-for="(x, i) in r.lateReplan.reasons" :key="i" class="small" style="margin-bottom:2px">· {{ x }}</div>
        </div>
        <template v-if="r.lateReplan.droppedHalls.length">
          <div class="small muted" style="margin:10px 0 4px">被压缩展厅及原因</div>
          <table class="data">
            <thead><tr><th>展厅</th><th>压缩原因</th></tr></thead>
            <tbody>
              <tr v-for="d in r.lateReplan.droppedHalls" :key="d.hallId">
                <td class="small"><strong>{{ museum.hallById(d.hallId)?.name }}</strong></td>
                <td class="small">{{ d.reason }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <div v-if="r.selfGuideInfo" class="callout info" style="margin:10px 0 0">
          <strong>自助参观已推送：</strong>电子导览 {{ r.selfGuideInfo.points.length }} 个展厅要点 ·
          集合 {{ r.selfGuideInfo.meetingHM }} {{ r.selfGuideInfo.meetingPoint }} ·
          讲解员 {{ r.selfGuideInfo.releasedGuideNames.join('、') }} 释放 {{ r.selfGuideInfo.releasedWindow }} 时段
          <template v-if="r.selfGuideInfo.assignableNotes.length">（{{ r.selfGuideInfo.assignableNotes.join('；') }}）</template>
        </div>
      </div>

      <!-- 分流决策 & 讲解员 -->
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <div class="card-title">分流决策与展厅容量回放</div>
          <RouteChain :reservation="r" />
          <hr class="divider" />
          <table class="data">
            <thead><tr><th>展厅</th><th>计划</th><th>实际</th><th>情况说明</th></tr></thead>
            <tbody>
              <tr v-for="(s, i) in r.route" :key="i">
                <td class="small"><strong>{{ museum.hallById(s.hallId)?.name.replace(/^.*? · /, '') }}</strong></td>
                <td class="small mono">{{ s.plannedEnter }}~{{ s.plannedLeave }}</td>
                <td class="small mono">{{ s.actualEnter ?? '—' }}~{{ s.actualLeave ?? '—' }}</td>
                <td class="small">{{ s.note || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style="display:flex; flex-direction:column; gap:14px">
          <div class="card">
            <div class="card-title">讲解员派工与变更</div>
            <div v-if="!guideChanges.length" class="empty small">无记录</div>
            <div v-for="e in guideChanges" :key="e.id" style="padding:7px 0; border-bottom:1px dashed var(--line)" class="small">
              <span class="mono muted">{{ e.at.slice(11, 16) }}</span> {{ e.title }}
              <div v-if="e.detail" class="muted">{{ e.detail }}</div>
            </div>
            <div class="divider" />
            <dl class="kv">
              <dt>最终讲解员</dt>
              <dd>{{ r.assignedGuideIds.map((g) => `${museum.guideById(g)?.name}（好评 ${museum.guideById(g)?.rating}）`).join('、') || '—' }}</dd>
              <dt>入馆批次</dt><dd>{{ r?.batchNo ?? '—' }} · {{ museum.lanes.find((l) => l.id === r?.securityLane)?.name ?? '—' }}</dd>
            </dl>
          </div>

          <div class="card">
            <div class="card-title">
              设备借还与押金
              <span class="aside">借出 {{ deviceRows.length }} 台</span>
            </div>
            <div v-if="!deviceRows.length" class="empty small">未借用耳麦</div>
            <table v-else class="data">
              <thead><tr><th>编号</th><th>借出</th><th>归还</th><th>状态</th><th>扣款</th></tr></thead>
              <tbody>
                <tr v-for="d in deviceRows" :key="d.code">
                  <td class="mono small">{{ d.code }}</td>
                  <td class="small mono">{{ d.lentAt?.slice(11, 16) }}</td>
                  <td class="small mono">{{ d.returnedAt?.slice(11, 16) ?? '—' }}</td>
                  <td class="small">
                    <span class="tag" :class="{ 'tag-ok': d.status === 'returned', 'tag-maint': d.status === 'damaged' || d.status === 'lost', 'tag-warn': d.status === 'lent' }">
                      {{ { available: '在库', lent: '借出中', returned: '完好归还', damaged: '损坏', lost: '遗失' }[d.status] }}
                    </span>
                    <div v-if="d.note" class="muted">{{ d.note }}</div>
                  </td>
                  <td class="small money">{{ d.damageFee ? `¥${d.damageFee}` : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <dl class="kv" style="margin-top:10px">
              <dt>押金合计</dt><dd class="money">¥{{ r.depositTotal.toLocaleString() }}</dd>
              <dt>扣款</dt><dd class="money">¥{{ r.depositDeduction }}</dd>
              <dt>实退</dt><dd class="money">¥{{ (r.depositTotal - r.depositDeduction).toLocaleString() }}</dd>
            </dl>
          </div>
        </div>
      </div>

      <!-- 完整时间线 -->
      <div class="card">
        <div class="card-title">完整操作时间线 <span class="aside">到馆 · 分流 · 讲解变更 · 容量 · 设备 · 押金，全部可查</span></div>
        <TimelineView :events="r.timeline" />
      </div>
    </div>
  </div>
</template>
