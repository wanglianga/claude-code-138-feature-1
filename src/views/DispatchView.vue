<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { useSessionStore } from '@/stores/session'
import {
  availableGuides,
  downstreamImpact,
  hallLoadAt,
  occupancyGrid,
  suggestReroute,
} from '@/lib/schedule'
import { addHM } from '@/lib/time'
import HallTags from '@/components/HallTags.vue'
import CapacityBar from '@/components/CapacityBar.vue'
import RouteChain from '@/components/RouteChain.vue'
import LatePlanPanel from '@/components/LatePlanPanel.vue'
import type { HallClosure, RouteStop } from '@/types'

const store = useReservationsStore()
const museum = useMuseumStore()
const session = useSessionStore()

const touring = computed(() =>
  [...store.list].filter((r) => r.status === 'touring')
    .sort((a, b) => (b.actualArrive ?? '').localeCompare(a.actualArrive ?? '')),
)
const selectedId = ref(touring.value[0]?.id ?? '')
const r = computed(() => store.byId(selectedId.value))

const grid = computed(() =>
  occupancyGrid(store.list, { maintenance: museum.maintenance, extraLoad: museum.extraLoad }),
)

const hallRows = computed(() =>
  museum.halls.map((h) => ({ hall: h, ...hallLoadAt(h, museum.nowHM, grid.value) })),
)

type Mode = '' | 'congestion' | 'reroute' | 'maintenance' | 'child' | 'broken' | 'swap' | 'delay'
const mode = ref<Mode>('')
const latePanelOpen = ref(false)

// —— 拥堵 / 改道 ——
const blockedHallId = ref('')
const targetHallId = ref('')
const rerouteDuration = ref(25)
const rerouteReason = ref('')

const suggestions = computed(() => {
  if (!r.value || !blockedHallId.value) return []
  return suggestReroute(
    r.value, blockedHallId.value, museum.halls, grid.value,
    { maintenance: museum.maintenance, extraLoad: museum.extraLoad },
    museum.nowHM,
  )
})

/** 改道后的站点草案（仅用于预览对后续团队的影响） */
const previewStops = computed<RouteStop[]>(() => {
  if (!r.value || !targetHallId.value) return []
  const out: RouteStop[] = [
    {
      hallId: targetHallId.value,
      plannedEnter: museum.nowHM,
      plannedLeave: addHM(museum.nowHM, rerouteDuration.value),
      durationMin: rerouteDuration.value,
      state: 'planned',
    },
  ]
  for (const s of r.value.route) {
    if (s.hallId === blockedHallId.value && s.state !== 'done') continue
    if (s.state === 'done' || s.state === 'skipped' || s.state === 'maintenance') continue
    out.push({ ...s })
  }
  return out
})

const impact = computed(() =>
  r.value && targetHallId.value
    ? downstreamImpact(r.value, previewStops.value, store.list, museum.halls)
    : [],
)

function startCongestion() {
  latePanelOpen.value = false
  mode.value = 'congestion'
  blockedHallId.value = r.value?.route.find((s) => s.state === 'current')?.hallId ?? ''
  targetHallId.value = ''
}
function startVisitorReroute() {
  if (!r.value) return
  latePanelOpen.value = false
  mode.value = 'reroute'
  blockedHallId.value = r.value?.route.find((s) => s.state === 'current')?.hallId ?? ''
  targetHallId.value = ''
  rerouteReason.value = '游客要求调整路线'
}
function applyReroute() {
  if (!blockedHallId.value || !targetHallId.value) return
  store.applyReroute(selectedId.value, {
    blockedHallId: blockedHallId.value,
    targetHallId: targetHallId.value,
    atHM: museum.nowHM,
    durationMin: rerouteDuration.value,
    reason: rerouteReason.value || (mode.value === 'congestion' ? '展厅拥堵分流' : '游客要求改道'),
  }, session.staffName)
  mode.value = ''
  blockedHallId.value = ''
  targetHallId.value = ''
}

// —— 迟到 / 顺延 ——
const delayMin = ref(15)
function applyDelay(kind: 'late' | 'wait') {
  store.delay(
    selectedId.value, delayMin.value, kind,
    kind === 'late' ? `团体迟到，整体顺延 ${delayMin.value} 分钟` : `现场等待 ${delayMin.value} 分钟`,
    kind === 'late' ? '安检排队/集合耗时超预期' : '团队集合、如厕等导致等待',
    session.staffName,
  )
  mode.value = ''
}

// —— 儿童走散 ——
const childName = ref('')
const pauseMin = ref(15)
function childEvent(resolved: boolean) {
  store.childLost(selectedId.value, childName.value || '一名儿童', pauseMin.value, resolved, session.staffName)
  if (resolved) { mode.value = ''; childName.value = '' }
}

// —— 耳麦损坏 ——
const brokenCode = ref('')
const brokenNote = ref('')
function exchangeHeadset() {
  if (!brokenCode.value) return
  store.exchangeHeadset(selectedId.value, brokenCode.value, brokenNote.value || '耳麦故障', session.staffName)
  brokenCode.value = ''
  brokenNote.value = ''
  mode.value = ''
}

// —— 讲解员替换 ——
const swapGuideId = ref('')
const swapReason = ref('')
const swapCandidates = computed(() => {
  const res = r.value
  if (!res) return []
  return availableGuides(museum.guides, store.list, {
    language: res.language,
    themeId: res.themeId,
    startHM: museum.nowHM,
    endHM: addHM(museum.nowHM, 30),
  }).filter((g) => !res.assignedGuideIds.includes(g.id))
})
function doSwap() {
  if (!swapGuideId.value || !r.value) return
  store.swapGuide(selectedId.value, r.value.assignedGuideIds[0], swapGuideId.value, swapReason.value || '讲解员临时无法继续带团')
  mode.value = ''
  swapGuideId.value = ''
  swapReason.value = ''
}

// —— 临时维护 ——
const maintHallId = ref('')
const maintStart = ref('')
const maintEnd = ref('')
const maintReason = ref('')
function declareMaintenance() {
  if (!maintHallId.value) return
  const closure: HallClosure = {
    start: maintStart.value || museum.nowHM,
    end: maintEnd.value || addHM(museum.nowHM, 60),
    reason: maintReason.value || '设备临时维护',
  }
  store.declareMaintenance(maintHallId.value, closure, session.staffName)
  mode.value = ''
  maintHallId.value = ''
  maintReason.value = ''
}

// —— 散客占用录入 ——
const loadInputs = ref<Record<string, number>>({})
</script>

<template>
  <!-- 展厅实时态势 -->
  <div class="card" style="margin-bottom:14px">
    <div class="card-title">
      展厅实时态势（{{ museum.nowHM }}）
      <span class="aside">调整路线时可直接查看：儿童友好 · 禁拍展品 · 维护状态 · 实时容量</span>
    </div>
    <div class="grid grid-3">
      <div v-for="row in hallRows" :key="row.hall.id" class="tight"
           style="border:1px solid var(--line); border-radius:9px; padding:10px 12px">
        <div style="display:flex; justify-content:space-between; align-items:center">
          <strong style="font-size:13px">{{ row.hall.floor }} · {{ row.hall.name.replace(/^.*? · /, '') }}</strong>
          <span v-if="museum.maintenance[row.hall.id]" class="tag tag-maint">维护中</span>
        </div>
        <div style="margin:6px 0"><CapacityBar :load="row.load" :capacity="row.capacity" compact /></div>
        <HallTags :hall="row.hall" :ratio="row.ratio" />
        <div style="margin-top:7px; display:flex; gap:6px; align-items:center">
          <span class="hint">散客占用</span>
          <input v-model.number="loadInputs[row.hall.id]" type="number" min="0" :placeholder="String(museum.extraLoad[row.hall.id] ?? 0)"
                 style="width:56px; padding:3px 6px" @change="museum.setExtraLoad(row.hall.id, Number(loadInputs[row.hall.id]) || 0)" />
        </div>
      </div>
    </div>
  </div>

  <div class="grid" style="grid-template-columns: 290px 1fr; align-items:start">
    <!-- 在馆团队 -->
    <div style="display:flex; flex-direction:column; gap:12px">
      <div class="card" style="padding:6px">
        <div class="card-title" style="margin:6px 8px">在馆团队</div>
        <div v-for="t in touring" :key="t.id" style="padding:10px 12px; cursor:pointer; border-radius:8px"
             :style="t.id === selectedId ? 'background:var(--paper-2)' : ''" @click="selectedId = t.id">
          <strong style="font-size:13px">{{ t.orgName }}</strong>
          <div class="small muted">{{ t.verifiedSize ?? t.groupSize }} 人 · {{ t.assignedGuideIds.map((g) => museum.guideById(g)?.name).join('、') }}</div>
          <div class="small" style="color:var(--gold); margin-top:2px">
            当前：{{ museum.hallById(t.route.find((s) => s.state === 'current')?.hallId ?? '')?.name ?? '—' }}
          </div>
        </div>
        <div v-if="!touring.length" class="empty small">暂无参观中团队，请到到馆前台放行一个批次。</div>
      </div>

      <div class="card tight">
        <div class="card-title">全馆事件登记</div>
        <button class="btn-sm btn-danger" style="width:100%; margin-bottom:6px" @click="mode = 'maintenance'">🛠 展厅临时维护</button>
        <div class="hint">维护登记后，所有在馆/待入馆团经过该厅的站点会自动标记，并在改道建议中排除该厅。</div>
      </div>
    </div>

    <!-- 调度主区 -->
    <div v-if="r" style="display:flex; flex-direction:column; gap:14px">
      <div class="card">
        <div class="card-title">
          {{ r.orgName }} · {{ r.id }}
          <span class="aside">计划讲解 {{ r.route.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance').length > 2 ? r.durationMin : r.durationMin }} 分钟 · 讲解员 {{ r.assignedGuideIds.map((g) => museum.guideById(g)?.name).join('、') }}</span>
        </div>
        <RouteChain :reservation="r" />
      </div>

      <!-- 事件操作 -->
      <div class="card">
        <div class="card-title">现场事件处置 <span class="aside">所有处置将沿同一预约联动路线、时长、押金与后续团队</span></div>
        <div class="pill-row" style="gap:8px">
          <button class="btn-sm" @click="r.route.some((s) => s.state === 'current') && store.advanceStop(selectedId, session.staffName)">✓ 当前展厅讲解完成，进入下一站</button>
          <button class="btn-sm" style="border-color:var(--amber); color:var(--amber)" @click="startCongestion">🚧 展厅拥堵分流</button>
          <button class="btn-sm" @click="startVisitorReroute">🧭 游客要求改路线</button>
          <button class="btn-sm" style="border-color:var(--blue); color:var(--blue)"
                  @click="mode = ''; latePanelOpen = !latePanelOpen">⏱ 团体迟到路线重排</button>
          <button class="btn-sm" @click="latePanelOpen = false; mode = 'delay'">⏳ 现场等待顺延</button>
          <button class="btn-sm" style="border-color:var(--purple); color:var(--purple)" @click="latePanelOpen = false; mode = 'child'">🧒 儿童走散</button>
          <button class="btn-sm btn-danger" @click="latePanelOpen = false; mode = 'broken'">🎧 耳麦损坏换机</button>
          <button class="btn-sm" style="border-color:var(--green); color:var(--green)" @click="latePanelOpen = false; mode = 'swap'">🔄 讲解员临时替换</button>
        </div>

        <!-- 拥堵/改道面板 -->
        <div v-if="mode === 'congestion' || mode === 'reroute'" style="margin-top:14px">
          <div class="field">
            <label>受阻展厅</label>
            <select v-model="blockedHallId">
              <option v-for="s in r.route.filter((x) => ['current', 'planned', 'congested', 'maintenance'].includes(x.state))" :key="s.hallId" :value="s.hallId">
                {{ museum.hallById(s.hallId)?.name }}
              </option>
            </select>
          </div>
          <div v-if="mode === 'congestion'" class="field">
            <label>拥堵情况</label>
            <input v-model="rerouteReason" placeholder="如：散客激增，在场约 44/45，通道被婴儿车占用" />
          </div>
          <div class="grid grid-2" style="gap:10px">
            <div v-for="sug in suggestions" :key="sug.hall.id"
                 class="tight"
                 style="border:1px solid var(--line); border-radius:9px; padding:11px 13px; cursor:pointer"
                 :style="targetHallId === sug.hall.id ? 'border-color:var(--gold); box-shadow:0 0 0 3px rgba(201,178,128,.22)' : ''"
                 @click="targetHallId = sug.hall.id">
              <div style="display:flex; justify-content:space-between">
                <strong>{{ sug.hall.name }}</strong>
                <CapacityBar :load="Math.round(sug.ratio * sug.hall.capacity)" :capacity="sug.hall.capacity" compact />
              </div>
              <div style="margin:5px 0; font-size:12px">
                当前满载率 <strong :style="sug.ratio > 0.85 ? 'color:var(--red)' : 'color:var(--green)'">{{ Math.round(sug.ratio * 100) }}%</strong>
                · 预计 {{ sug.enterHM }} 可进场
              </div>
              <HallTags :hall="sug.hall" :ratio="sug.ratio" />
              <div class="small muted" style="margin-top:6px">{{ sug.reasons.join('；') }}</div>
            </div>
          </div>
          <div v-if="suggestions.length" class="form-row" style="margin-top:10px; align-items:end">
            <div class="field" style="margin:0">
              <label>替代展厅停留时长（分钟）</label>
              <input v-model.number="rerouteDuration" type="number" min="10" max="60" />
            </div>
            <button class="btn-gold" :disabled="!targetHallId" @click="applyReroute">确认改道并顺延后续站点</button>
          </div>
          <div v-if="impact.length" class="callout danger" style="margin-top:10px; margin-bottom:0">
            ⚠ 对后续团队入场的影响：
            <div v-for="(c, i) in impact" :key="i" class="small" style="margin-top:3px">
              {{ c.hm }} 「{{ museum.hallById(c.hallId)?.name }}」叠加后 {{ c.loadAfter }} 人，超过容量 {{ c.capacity }} 人 ——
              受影响团队：<strong>{{ c.reservation.orgName }}（{{ c.reservation.batchNo }}）</strong>，建议通知其错峰或改道。
            </div>
          </div>
          <div v-else-if="targetHallId" class="callout ok" style="margin-top:10px; margin-bottom:0">
            ✓ 该改道方案不会造成其他在馆团队超容量。
          </div>
        </div>

        <!-- 团体迟到路线重排：缩短 / 自助 / 改签 -->
        <LatePlanPanel v-if="latePanelOpen" v-model:open="latePanelOpen" :res-id="selectedId" />

        <!-- 现场等待顺延（集合/如厕等，不含迟到重排） -->
        <div v-if="mode === 'delay'" class="grid" style="grid-template-columns:160px 1fr; gap:10px; align-items:end; margin-top:12px">
          <div class="field" style="margin:0"><label>顺延分钟数</label><input v-model.number="delayMin" type="number" min="5" step="5" /></div>
          <button class="btn-sm" @click="applyDelay('wait')">按现场等待登记并顺延</button>
        </div>

        <!-- 儿童走散 -->
        <div v-if="mode === 'child'" class="callout danger" style="margin-top:12px">
          <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end">
            <div class="field" style="margin:0; min-width:140px"><label>儿童姓名/特征</label><input v-model="childName" placeholder="如：三年级男生，黄色帽子" /></div>
            <div class="field" style="margin:0; width:130px"><label>暂停时长（分钟）</label><input v-model.number="pauseMin" type="number" min="5" step="5" /></div>
            <button class="btn-sm btn-danger" @click="childEvent(false)">📢 广播寻人并暂停</button>
            <button class="btn-sm btn-gold" @click="childEvent(true)">✓ 已找回，顺延继续</button>
          </div>
          <div class="small" style="margin-top:6px">已自动通知安保与广播室；找回后后续站点按暂停时长顺延。</div>
        </div>

        <!-- 耳麦损坏 -->
        <div v-if="mode === 'broken'" style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end">
          <div class="field" style="margin:0; width:170px">
            <label>故障设备编号</label>
            <select v-model="brokenCode">
              <option value="" disabled>选择借出中的耳麦</option>
              <option v-for="d in r.devices.filter((x) => x.status === 'lent')" :key="d.code" :value="d.code">{{ d.code }}</option>
            </select>
          </div>
          <div class="field" style="margin:0; width:260px"><label>故障情况</label><input v-model="brokenNote" placeholder="如：无声音 / 头梁断裂" /></div>
          <button class="btn-sm btn-danger" :disabled="!brokenCode" @click="exchangeHeadset">登记损坏并从设备间补发</button>
          <span class="hint">旧机转损坏待赔（¥50），补发新机不重复收押金。</span>
        </div>

        <!-- 讲解员替换 -->
        <div v-if="mode === 'swap'" style="margin-top:12px">
          <div class="field" style="max-width:360px"><label>替换原因</label><input v-model="swapReason" placeholder="如：讲解员突发身体不适" /></div>
          <div class="grid grid-3" style="gap:8px">
            <div v-for="g in swapCandidates" :key="g.id" class="tight"
                 style="border:1px solid var(--line); border-radius:8px; padding:9px 11px; cursor:pointer"
                 :style="swapGuideId === g.id ? 'border-color:var(--gold); box-shadow:0 0 0 3px rgba(201,178,128,.22)' : !g.ok ? 'opacity:.55' : ''"
                 @click="g.ok && (swapGuideId = g.id)">
              <strong>{{ g.name }}</strong>
              <span class="small muted"> · {{ g.langs.map((l) => ({ zh: '中', en: '英', ja: '日' }[l])).join('/') }} · 好评 {{ g.rating }}</span>
              <div v-if="g.conflicts.length" class="small" style="color:var(--red)">✕ {{ g.conflicts.join('；') }}</div>
              <div v-else class="small" style="color:var(--green)">✓ 现在可接替</div>
            </div>
          </div>
          <button class="btn-sm btn-gold" style="margin-top:10px" :disabled="!swapGuideId" @click="doSwap">确认讲解员变更并通知团队</button>
        </div>

        <!-- 临时维护 -->
        <div v-if="mode === 'maintenance'" style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end">
          <div class="field" style="margin:0; width:200px">
            <label>展厅</label>
            <select v-model="maintHallId">
              <option value="" disabled>选择展厅</option>
              <option v-for="h in museum.halls" :key="h.id" :value="h.id">{{ h.name }}</option>
            </select>
          </div>
          <div class="field" style="margin:0"><label>起</label><input v-model="maintStart" type="time" :placeholder="museum.nowHM" /></div>
          <div class="field" style="margin:0"><label>止</label><input v-model="maintEnd" type="time" :placeholder="addHM(museum.nowHM, 60)" /></div>
          <div class="field" style="margin:0; width:220px"><label>原因</label><input v-model="maintReason" placeholder="如：展项漏水抢修" /></div>
          <button class="btn-sm btn-danger" :disabled="!maintHallId" @click="declareMaintenance">广播维护并联动改道</button>
        </div>
      </div>

      <!-- 设备与押金快览 -->
      <div class="grid grid-3">
        <div class="card tight">
          <div class="stat-label">借出耳麦</div>
          <div class="stat-num">{{ r.devices.filter((d) => d.status === 'lent').length }}</div>
          <div class="small muted">其中损坏待赔 {{ r.devices.filter((d) => d.status === 'damaged').length }} 台</div>
        </div>
        <div class="card tight">
          <div class="stat-label">已收押金</div>
          <div class="stat-num money">¥{{ r.depositTotal.toLocaleString() }}</div>
          <div class="small muted">途中换机不重复收取</div>
        </div>
        <div class="card tight">
          <div class="stat-label">路线最后站计划结束</div>
          <div class="stat-num">{{ r.route[r.route.length - 1]?.plannedLeave }}</div>
          <div class="small muted">所有顺延已联动更新</div>
        </div>
      </div>
    </div>

    <div v-else class="card empty">请选择一个在馆团队。</div>
  </div>
</template>
