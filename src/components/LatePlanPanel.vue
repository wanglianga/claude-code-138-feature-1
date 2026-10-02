<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { releasableGuideTargets } from '@/lib/schedule'
import CapacityBar from '@/components/CapacityBar.vue'
import type { LatePlan, LatePlanOption } from '@/types'

const props = defineProps<{ resId: string }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ confirmed: [] }>()

const store = useReservationsStore()
const museum = useMuseumStore()

const lateMin = ref(40)
const agreed = ref(false)
const busy = ref(false)

watch(
  () => props.resId,
  () => {
    lateMin.value = 40
    agreed.value = false
  },
)

const r = computed(() => store.byId(props.resId))
const plan = computed<LatePlan | undefined>(() => {
  const list = r.value?.latePlans
  return list && list.length ? list[list.length - 1] : undefined
})

const hallName = (id: string) => museum.hallById(id)?.name.replace(/^.*? · /, '') ?? id

const ACTION_LABEL: Record<string, string> = {
  keep: '保留讲解',
  trim: '压缩时长',
  drop: '放弃讲解',
  self: '自助参观',
  done: '已完成',
}

/** 自助方案：讲解员释放后可接应的后续等待团队（预览） */
const releaseTargets = computed(() => {
  if (!r.value) return []
  const guideId = r.value.assignedGuideIds[0]
  const guide = museum.guideById(guideId)
  if (!guide) return []
  return releasableGuideTargets(guide, store.list, museum.nowHM, props.resId)
})

function generate() {
  if (!r.value || lateMin.value <= 0) return
  busy.value = true
  store.generateLatePlan(props.resId, Math.round(lateMin.value))
  agreed.value = false
  busy.value = false
}

function confirm(opt: LatePlanOption) {
  if (!plan.value || !agreed.value || !opt.feasible) return
  store.confirmLatePlan(props.resId, plan.value.id, opt.type, r.value?.contactName ?? '联系人')
  open.value = false
  emit('confirmed')
}

function close() {
  open.value = false
}

const sortedOptions = computed(() =>
  plan.value ? [...plan.value.options].sort((a, b) => Number(b.recommend) - Number(a.recommend) || b.score - a.score) : [],
)
</script>

<template>
  <div v-if="open && r" class="late-panel">
    <div class="late-panel-head">
      <strong>团体迟到路线重排 · {{ r.orgName }}</strong>
      <button class="btn-sm btn-ghost" @click="close">✕ 关闭</button>
    </div>

    <!-- 第 1 步：登记迟到分钟 -->
    <div class="lp-step">
      <div class="lp-step-title">① 登记团体迟到时长（时钟 {{ museum.nowHM }}）</div>
      <div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap">
        <div class="field" style="margin:0; width:150px">
          <label>实际迟到分钟</label>
          <input v-model.number="lateMin" type="number" min="5" step="5" />
        </div>
        <button class="btn-gold" :disabled="lateMin <= 0" @click="generate">
          {{ plan ? '按最新现场情况重新测算' : '依据剩余时长 / 拥堵 / 下一团到馆生成方案' }}
        </button>
        <span class="hint">系统读取原定讲解员排班与下一团交接时间、各展厅实时满载率。</span>
      </div>
    </div>

    <template v-if="plan">
      <!-- 第 2 步：测算依据 -->
      <div class="lp-step">
        <div class="lp-step-title">② 重排测算依据（迟到 {{ plan.lateMin }} 分钟）</div>
        <div class="grid grid-4" style="gap:8px">
          <div class="lp-metric">
            <div class="stat-label">原定讲解员最迟离场</div>
            <div class="stat-num" style="font-size:20px; color:var(--red)">{{ plan.basis.guideDeadlineHM }}</div>
            <div class="small muted">{{ plan.basis.guideDeadlineReason }}</div>
          </div>
          <div class="lp-metric">
            <div class="stat-label">剩余可讲解 / 原计划剩余</div>
            <div class="stat-num" style="font-size:20px">
              {{ plan.basis.remainingGuideMin }}<span style="font-size:13px"> / {{ plan.basis.plannedRemainingMin }} 分钟</span>
            </div>
            <div class="small" :style="plan.basis.mustCutMin > 0 ? 'color:var(--red)' : 'color:var(--green)'">
              {{ plan.basis.mustCutMin > 0 ? `需压缩 ${plan.basis.mustCutMin} 分钟` : '时间可容纳原计划' }}
            </div>
          </div>
          <div class="lp-metric">
            <div class="stat-label">下一团到馆</div>
            <div class="stat-num" style="font-size:20px">{{ plan.basis.nextGroupHM ?? '—' }}</div>
            <div class="small muted">{{ plan.basis.nextGroupName ? `「${plan.basis.nextGroupName}」等待讲解员接续` : '当日无后续带团任务' }}</div>
          </div>
          <div class="lp-metric">
            <div class="stat-label">未完成展厅当前拥堵</div>
            <div v-for="hr in plan.basis.hallRatios" :key="hr.hallId" style="display:flex; align-items:center; gap:6px; margin-top:2px">
              <span class="small" style="width:64px; flex:none">{{ hallName(hr.hallId) }}</span>
              <CapacityBar :load="Math.round(hr.ratio * (museum.hallById(hr.hallId)?.capacity ?? 1))" :capacity="museum.hallById(hr.hallId)?.capacity ?? 1" compact />
            </div>
          </div>
        </div>
      </div>

      <!-- 第 3 步：三个方案 -->
      <div class="lp-step">
        <div class="lp-step-title">③ 处置方案（请联系人选择并确认）</div>
        <div class="grid" style="grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px; align-items:start">
          <div v-for="opt in sortedOptions" :key="opt.type" class="lp-option"
               :class="{ recommended: opt.recommend, disabled: !opt.feasible }">
            <div class="lp-opt-head">
              <strong style="font-size:13.5px">{{ opt.title }}</strong>
              <span v-if="opt.recommend" class="tag tag-ok">系统推荐</span>
              <span v-else-if="!opt.feasible" class="tag tag-maint">当前不可行</span>
            </div>
            <div class="small" style="margin:6px 0">{{ opt.summary }}</div>
            <ul class="lp-reasons">
              <li v-for="(x, i) in opt.reasons" :key="i" class="small muted">{{ x }}</li>
            </ul>

            <table class="data" style="margin:8px 0">
              <tbody>
                <tr v-for="d in opt.decisions" :key="d.hallId">
                  <td class="small" style="padding:6px 6px">
                    <strong>{{ hallName(d.hallId) }}</strong><br />
                    <span class="tag" :class="d.action === 'keep' ? 'tag-ok' : d.action === 'self' ? 'tag-acc' : d.action === 'trim' ? 'tag-warn' : 'tag-maint'">
                      {{ ACTION_LABEL[d.action] }}
                    </span>
                    <span v-if="d.action !== 'done' && d.action !== 'drop' && d.action !== 'self'" class="small muted mono" style="margin-left:4px">
                      {{ d.originalMin }}→{{ d.newMin }} 分钟
                    </span>
                    <div v-for="(rs, k) in d.reasons" :key="k" class="small muted" style="margin-top:2px">{{ rs }}</div>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- 自助：电子导览/集合点 + 释放派工预览 -->
            <template v-if="opt.type === 'selfguide'">
              <div class="callout info tight" style="margin:6px 0; padding:8px 10px">
                📟 <strong>{{ opt.audioGuide?.name }}</strong><br />
                <span class="small">{{ opt.audioGuide?.pickup }}</span><br />
                🚩 <span class="small">集合点：{{ opt.assemblyPoint }}</span>
              </div>
              <div v-if="releaseTargets.length" class="callout ok tight" style="margin:6px 0; padding:8px 10px">
                <span class="small">讲解员释放后可接应：</span>
                <div v-for="t in releaseTargets" :key="t.reservation.id" class="small">
                  → 「{{ t.reservation.orgName }}」计划 {{ t.startHM }} 开讲
                </div>
              </div>
              <div v-else class="small muted">讲解员释放后暂无匹配等待团，转入机动待命。</div>
            </template>

            <!-- 改签：新时段信息 -->
            <template v-if="opt.type === 'reschedule' && opt.feasible">
              <dl class="kv small" style="margin:8px 0">
                <dt>重新到馆</dt><dd class="mono">{{ opt.rescheduleArriveHM }}</dd>
                <dt>开讲 / 结束</dt><dd class="mono">{{ opt.rescheduleStartHM }} ~ {{ opt.endHM }}</dd>
                <dt>讲解员</dt><dd>{{ opt.rescheduleGuides?.map((g) => g.name).join('、') }}</dd>
              </dl>
            </template>

            <div v-if="opt.type === 'shorten'" class="small muted" style="margin-top:6px">
              人工讲解 {{ opt.guidedMin }} 分钟、压缩 {{ opt.cutMin }} 分钟，{{ opt.endHM }} 前结束。
            </div>
          </div>
        </div>
      </div>

      <!-- 第 4 步：联系人确认 -->
      <div class="lp-step">
        <div class="lp-step-title">④ 联系人确认后自动联动</div>
        <label class="checkbox" style="margin-bottom:10px">
          <input type="checkbox" v-model="agreed" />
          已电话联系联系人 <strong>{{ r.contactName }}（{{ r.contactPhone }}）</strong>，其已知晓讲解时长变化并确认所选方案
        </label>
        <div class="pill-row">
          <button v-for="opt in sortedOptions" :key="opt.type"
                  class="btn-sm"
                  :class="opt.type === 'shorten' ? 'btn-gold' : opt.type === 'selfguide' ? '' : 'btn-danger'"
                  :disabled="!agreed || !opt.feasible"
                  @click="confirm(opt)">
            确认执行「{{ opt.title.replace(/（.*$/, '') }}」
          </button>
        </div>
        <div class="hint" style="margin-top:8px">
          确认后：耳麦借用截止时间按新结束时间调整、讲解员排班自动更新；自助/改签释放的讲解员将派给后续等待团队，全部处置写入预约时间线。
        </div>
      </div>

      <!-- 已确认结果 -->
      <div v-if="plan.confirmed" class="callout ok" style="margin-top:4px; margin-bottom:0">
        ✓ 联系人 {{ plan.confirmed.by }} 已于 {{ plan.confirmed.at.slice(11, 16) }} 确认「{{ plan.confirmed.optionTitle }}」，联动调整已完成，可在「投诉与追溯」查看完整压缩依据。
      </div>
    </template>
  </div>
</template>

<style scoped>
.late-panel {
  margin-top: 14px;
  border: 1px solid var(--gold-soft);
  border-radius: 10px;
  background: linear-gradient(180deg, #fffdf6, #fbf6ea);
  padding: 14px 16px;
}
.late-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-family: var(--font-serif);
  font-size: 15px;
  letter-spacing: 0.03em;
}
.lp-step { padding: 10px 0; border-top: 1px dashed var(--line); }
.lp-step:first-of-type { border-top: none; padding-top: 0; }
.lp-step-title { font-size: 13px; color: var(--ink-2); margin-bottom: 9px; font-weight: 600; }
.lp-metric {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  padding: 8px 10px;
}
.lp-option {
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--card);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
}
.lp-option.recommended { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(201, 178, 128, 0.2); }
.lp-option.disabled { opacity: 0.6; }
.lp-opt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; }
.lp-reasons { margin: 4px 0; padding-left: 16px; }
.lp-reasons li { margin: 1px 0; }
</style>
