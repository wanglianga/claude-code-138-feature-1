<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { useSessionStore } from '@/stores/session'
import { hmOfISO, toMin } from '@/lib/time'
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
  r.value?.timeline.filter((e) => e.kind === 'guide_swap' || e.kind === 'guide_assign' || e.kind === 'guide_release') ?? [],
)

/** 最近一次迟到重排（优先展示联系人已确认的） */
const latePlan = computed(() => {
  const list = r.value?.latePlans
  if (!list?.length) return undefined
  return [...list].reverse().find((p) => p.confirmed) ?? list[list.length - 1]
})
const confirmedOption = computed(() =>
  latePlan.value?.confirmed
    ? latePlan.value.options.find((o) => o.type === latePlan.value!.confirmed!.type)
    : undefined,
)
/** 投诉是否涉及讲解内容/时长减少 */
const complaintAboutReduction = computed(() =>
  !!r.value?.complaint && /缩水|减少|缩短|压缩|时长|少了|没讲完|内容/.test(r.value.complaint),
)
const hallName = (id: string) => museum.hallById(id)?.name.replace(/^.*? · /, '') ?? id
const ACTION_LABEL: Record<string, string> = {
  keep: '保留讲解', trim: '压缩时长', drop: '放弃讲解', self: '自助参观', done: '已完成',
}

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

      <!-- 迟到重排与压缩依据 -->
      <div v-if="latePlan" class="card" :style="complaintAboutReduction ? 'border-color:var(--red)' : ''">
        <div class="card-title">
          团体迟到路线重排与压缩依据
          <span class="aside">联系人确认留痕 · 投诉时直接回放，不依赖人工解释</span>
        </div>
        <div v-if="complaintAboutReduction" class="callout danger" style="margin-top:0">
          本团投诉涉及讲解内容/时长减少，以下为当日迟到重排的客观依据与各厅压缩明细，可直接据此答复。
        </div>
        <dl class="kv" style="margin-bottom:10px">
          <dt>迟到时长</dt><dd>{{ latePlan.lateMin }} 分钟（生成于 {{ latePlan.createdAt.slice(11, 16) }}）</dd>
          <dt>讲解员离场截止</dt><dd><strong>{{ latePlan.basis.guideDeadlineHM }}</strong> —— {{ latePlan.basis.guideDeadlineReason }}</dd>
          <dt>剩余可讲解 / 原计划剩余</dt><dd>{{ latePlan.basis.remainingGuideMin }} / {{ latePlan.basis.plannedRemainingMin }} 分钟，压缩 {{ latePlan.basis.mustCutMin }} 分钟</dd>
          <dt>下一团到馆</dt><dd>{{ latePlan.basis.nextGroupHM ? `${latePlan.basis.nextGroupHM} · 「${latePlan.basis.nextGroupName}」` : '当日无后续带团任务' }}</dd>
          <dt>联系人确认</dt>
          <dd>
            <template v-if="latePlan.confirmed">
              <strong>{{ latePlan.confirmed.by }}</strong> 于 {{ latePlan.confirmed.at.slice(11, 16) }} 确认「{{ latePlan.confirmed.optionTitle }}」
            </template>
            <template v-else><span class="tag tag-warn">尚未确认</span></template>
          </dd>
        </dl>
        <table class="data">
          <thead><tr><th>展厅</th><th>处置</th><th>原计划</th><th>重排后</th><th>压缩依据</th></tr></thead>
          <tbody>
            <tr v-for="d in confirmedOption?.decisions ?? []" :key="d.hallId">
              <td class="small"><strong>{{ hallName(d.hallId) }}</strong></td>
              <td class="small">
                <span class="tag" :class="d.action === 'keep' ? 'tag-ok' : d.action === 'self' ? 'tag-acc' : d.action === 'trim' ? 'tag-warn' : 'tag-maint'">
                  {{ ACTION_LABEL[d.action] }}
                </span>
              </td>
              <td class="small mono">{{ d.originalEnter }}~{{ d.originalLeave }}（{{ d.originalMin }} 分钟）</td>
              <td class="small mono">
                <template v-if="d.newEnter && d.newLeave && d.action !== 'drop'">{{ d.newEnter }}~{{ d.newLeave }}（{{ d.newMin }} 分钟）</template>
                <template v-else>—</template>
              </td>
              <td class="small muted">{{ d.reasons.join('；') }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="confirmedOption?.type === 'selfguide'" class="callout info" style="margin-bottom:0; margin-top:10px">
          📟 已推送 {{ confirmedOption.audioGuide?.name }}；{{ confirmedOption.audioGuide?.pickup }}<br />
          🚩 集合点：{{ confirmedOption.assemblyPoint }}
        </div>
        <div v-else-if="confirmedOption?.type === 'reschedule'" class="callout info" style="margin-bottom:0; margin-top:10px">
          已改签：{{ confirmedOption.rescheduleArriveHM }} 重新到馆、{{ confirmedOption.rescheduleStartHM }} 开讲，
          由 {{ confirmedOption.rescheduleGuides?.map((g) => g.name).join('、') }} 带团，未产生讲解缩水。
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
              <thead><tr><th>编号</th><th>借出</th><th>应还截止</th><th>归还</th><th>状态</th><th>扣款</th></tr></thead>
              <tbody>
                <tr v-for="d in deviceRows" :key="d.code">
                  <td class="mono small">{{ d.code }}</td>
                  <td class="small mono">{{ d.lentAt?.slice(11, 16) }}</td>
                  <td class="small mono">{{ d.dueBackAt?.slice(11, 16) ?? '—' }}</td>
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
