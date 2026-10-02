<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DAMAGE_FEE, LOST_FEE } from '@/data/museum'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { useSessionStore } from '@/stores/session'
import StatusBadge from '@/components/StatusBadge.vue'

const store = useReservationsStore()
const museum = useMuseumStore()
const session = useSessionStore()
const route = useRoute()
const router = useRouter()

const queue = computed(() =>
  [...store.list].filter((r) => r.status === 'touring')
    .sort((a, b) => (b.actualArrive ?? '').localeCompare(a.actualArrive ?? '')),
)
const selectedId = ref((route.params.id as string) || '')
watch(queue, (q) => {
  if (!q.some((r) => r.id === selectedId.value) && q[0]) selectedId.value = q[0].id
}, { immediate: true })

const r = computed(() => store.byId(selectedId.value))

type CheckResult = 'ok' | 'damaged' | 'lost'
const checks = ref<Record<string, { result: CheckResult; note: string }>>({})
const satisfaction = ref(5)

watch(selectedId, () => {
  checks.value = {}
  satisfaction.value = 5
  if (r.value) {
    for (const d of r.value.devices) {
      checks.value[d.code] = { result: d.status === 'damaged' ? 'damaged' : 'ok', note: d.note ?? '' }
    }
  }
}, { immediate: true })

const stats = computed(() => {
  let ok = 0, damaged = 0, lost = 0
  for (const v of Object.values(checks.value)) {
    if (v.result === 'ok') ok++
    else if (v.result === 'damaged') damaged++
    else lost++
  }
  const deduction = damaged * DAMAGE_FEE + lost * LOST_FEE
  return { ok, damaged, lost, deduction }
})

const returned = computed(() => r.value?.timeline.some((e) => e.kind === 'device_return'))

function submitReturn() {
  if (!r.value) return
  const results = Object.entries(checks.value).map(([code, v]) => ({ code, result: v.result, note: v.note }))
  store.returnDevices(selectedId.value, results, session.staffName)
}
function settle() {
  store.settleDeposit(selectedId.value, session.staffName)
}
function finish() {
  store.complete(selectedId.value, satisfaction.value, session.staffName)
  router.push('/trace/' + selectedId.value)
}
</script>

<template>
  <div v-if="!r" class="card empty">没有参观中、等待离馆核销的团队。</div>

  <div v-else class="grid" style="grid-template-columns: 280px 1fr; align-items:start">
    <div class="card" style="padding:6px">
      <div class="card-title" style="margin:6px 8px">待离馆团队</div>
      <div v-for="q in queue" :key="q.id" style="padding:10px 12px; cursor:pointer; border-radius:8px"
           :style="q.id === selectedId ? 'background:var(--paper-2)' : ''" @click="selectedId = q.id">
        <strong style="font-size:13px">{{ q.orgName }}</strong>
        <div class="small muted">{{ q.verifiedSize ?? q.groupSize }} 人 · 借出 {{ q.devices.length }} 台</div>
        <div style="margin-top:4px"><StatusBadge :status="q.status" /></div>
      </div>
    </div>

    <div style="display:flex; flex-direction:column; gap:14px">
      <div class="card">
        <div class="card-title">
          {{ r.orgName }} · {{ r.id }}
          <span class="aside">计划讲解 {{ r.durationMin }} 分钟 · 入馆 {{ r.actualArrive?.slice(11, 16) }} → 当前 {{ museum.nowHM }}</span>
        </div>

        <div class="grid grid-4">
          <div>
            <div class="stat-label">应还耳麦</div>
            <div class="stat-num">{{ r.devices.length }}</div>
            <div v-if="r.headsetDueHM" class="small muted">应于 <strong class="mono">{{ r.headsetDueHM }}</strong> 前归还</div>
          </div>
          <div><div class="stat-label">完好</div><div class="stat-num" style="color:var(--green)">{{ stats.ok }}</div></div>
          <div><div class="stat-label">损坏 / 遗失</div><div class="stat-num" style="color:var(--red)">{{ stats.damaged }} / {{ stats.lost }}</div></div>
          <div><div class="stat-label">应扣赔偿</div><div class="stat-num money">¥{{ stats.deduction }}</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          逐台核对耳麦归还
          <span class="aside">损坏 ¥{{ DAMAGE_FEE }}/台 · 遗失 ¥{{ LOST_FEE }}/台</span>
        </div>
        <div v-if="!r.devices.length" class="empty">该团未借用耳麦。</div>
        <table v-else class="data">
          <thead><tr><th>设备编号</th><th>借出时间</th><th>归还状态</th><th>备注</th></tr></thead>
          <tbody>
            <tr v-for="d in r.devices" :key="d.code">
              <td class="mono"><strong>{{ d.code }}</strong></td>
              <td class="small mono">{{ d.lentAt?.slice(11, 16) }}</td>
              <td>
                <div class="pill-row">
                  <button class="btn-sm" :style="checks[d.code]?.result === 'ok' ? 'background:var(--green);color:#fff;border-color:var(--green)' : ''"
                          @click="checks[d.code].result = 'ok'">✓ 完好归还</button>
                  <button class="btn-sm btn-danger" :style="checks[d.code]?.result === 'damaged' ? 'background:var(--red);color:#fff' : ''"
                          @click="checks[d.code].result = 'damaged'">损 坏</button>
                  <button class="btn-sm" style="border-color:#7a6740;color:var(--amber)"
                          :style="checks[d.code]?.result === 'lost' ? 'background:var(--amber);color:#fff;border-color:var(--amber)' : ''"
                          @click="checks[d.code].result = 'lost'">遗 失</button>
                </div>
              </td>
              <td style="min-width:220px">
                <input v-model="checks[d.code].note" :disabled="checks[d.code]?.result === 'ok'"
                       :placeholder="checks[d.code]?.result === 'lost' ? '遗失情况说明' : '损坏部位描述'" />
              </td>
            </tr>
          </tbody>
        </table>
        <div style="margin-top:12px">
          <button class="btn-primary" :disabled="returned" @click="submitReturn">
            {{ returned ? '✓ 归还已登记' : '确认归还清点结果' }}
          </button>
        </div>
      </div>

      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <div class="card-title">押金结算</div>
          <dl class="kv">
            <dt>已收押金</dt><dd class="money">¥{{ r.depositTotal.toLocaleString() }}</dd>
            <dt>损坏赔偿</dt><dd>{{ stats.damaged }} 台 × ¥{{ DAMAGE_FEE }} = ¥{{ stats.damaged * DAMAGE_FEE }}</dd>
            <dt>遗失赔偿</dt><dd>{{ stats.lost }} 台 × ¥{{ LOST_FEE }} = ¥{{ stats.lost * LOST_FEE }}</dd>
            <dt>应退金额</dt><dd class="money" style="font-size:17px">¥{{ (r.depositTotal - (returned ? r.depositDeduction : stats.deduction)).toLocaleString() }}</dd>
          </dl>
          <button class="btn-gold" style="width:100%; justify-content:center; margin-top:10px"
                  :disabled="!returned" @click="settle">
            完成押金结算并记录流水
          </button>
        </div>

        <div class="card">
          <div class="card-title">满意度与离馆</div>
          <label class="field"><span class="muted small">团体整体满意度</span></label>
          <div style="font-size:30px; letter-spacing:6px; cursor:pointer">
            <span v-for="n in 5" :key="n"
                  :style="n <= satisfaction ? '' : 'opacity:.25'"
                  :class="n <= satisfaction ? 'stars' : ''"
                  @click="satisfaction = n">★</span>
            <span class="small muted" style="font-size:13px; margin-left:8px">{{ ['', '很不满意', '不满意', '一般', '满意', '非常满意'][satisfaction] }}</span>
          </div>
          <div class="callout info" style="margin:10px 0">
            如满意度 ≤ 3，系统会提示在「投诉与追溯」页核对讲解时长、等待与改道记录，主动跟进解释。
          </div>
          <button class="btn-primary" style="width:100%; justify-content:center"
                  :disabled="!returned" @click="finish">
            团队离馆，结束本次预约
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
