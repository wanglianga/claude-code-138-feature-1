/**
 * 团体迟到后的路线重排引擎：
 * 依据「剩余讲解时长 + 展厅当前拥堵 + 下一团到馆时间」生成
 * ① 缩短路线 ② 自助参观 ③ 改签时段 三种方案，供联系人确认。
 */
import type {
  Guide,
  Hall,
  Reservation,
  RouteStop,
} from '@/types'
import { addHM, hmOfISO, toHM, toMin } from './time'
import {
  availableGuides,
  closureAt,
  guideBusyWindows,
  occupancyGrid,
  type LiveState,
} from './schedule'
import { TOUR_INTERVAL_MIN } from '@/data/museum'

/** 每站最短停留（分钟）与站间步行 */
export const MIN_STAY_MIN = 10
export const WALK_MIN = 5
/** 迟到达到该分钟数时，前台展示路线重排面板 */
export const LATE_REPLAN_THRESHOLD = 15

/** 尚未开始参观、可被重排的站点 */
export function pendingStops(r: Reservation): RouteStop[] {
  return r.route.filter((s) => s.state === 'planned' && !s.actualEnter)
}

export interface LateContext {
  lateMin: number
  /** 安检+集结后的预计进场时刻 */
  enterHM: string
  /** 讲解员必须离开去接下一任务的时刻（无后续任务则为班次结束） */
  mustLeaveByHM: string
  /** 剩余可用讲解时长（分钟） */
  remainMin: number
  guideNames: string[]
  /** 讲解员后续任务约束描述，如「何田田 11:10 须接「远瞻科技」」 */
  guideConstraint: string
  /** 下一团到馆情况 */
  nextArrivals: { id: string; orgName: string; arriveHM: string }[]
}

/** 分析迟到上下文：剩余讲解时长、讲解员后续任务、下一团到馆 */
export function analyzeLate(
  r: Reservation,
  reservations: Reservation[],
  guides: Guide[],
  nowHM: string,
): LateContext {
  const lateMin = r.actualArrive
    ? toMin(hmOfISO(r.actualArrive)) - toMin(hmOfISO(r.arriveTime))
    : 0
  const enterHM = addHM(nowHM, 10)

  // 讲解员最早必须离开的时刻：下一带团窗口开始（已含交接缓冲）或班次结束
  let mustLeave = 24 * 60
  let constraint = ''
  const names: string[] = []
  for (const gid of r.assignedGuideIds) {
    const g = guides.find((x) => x.id === gid)
    if (!g) continue
    names.push(g.name)
    const next = guideBusyWindows(
      reservations.filter((x) => x.id !== r.id),
      gid,
    )
      .filter((w) => w.start > toMin(nowHM))
      .sort((a, b) => a.start - b.start)[0]
    if (next) {
      if (next.start < mustLeave) {
        mustLeave = next.start
        constraint = `${g.name} ${toHM(next.start + TOUR_INTERVAL_MIN)} 须接「${next.reservation.orgName}」（含 ${TOUR_INTERVAL_MIN} 分钟交接缓冲）`
      }
    } else {
      const shiftEnd = g.shifts
        .map((s) => toMin(s.end))
        .filter((e) => e > toMin(nowHM))
        .sort((a, b) => a - b)[0]
      if (shiftEnd && shiftEnd < mustLeave) {
        mustLeave = shiftEnd
        constraint = `${g.name} ${toHM(shiftEnd)} 班次结束`
      }
    }
  }
  if (!r.assignedGuideIds.length) {
    mustLeave = toMin('17:00')
    constraint = '未分配讲解员'
  } else if (!constraint) {
    constraint = '讲解员当日后续无任务'
  }

  const nextArrivals = reservations
    .filter((x) => x.id !== r.id && ['submitted', 'confirmed'].includes(x.status))
    .map((x) => ({ id: x.id, orgName: x.orgName, arriveHM: hmOfISO(x.arriveTime) }))
    .filter((x) => x.arriveHM > nowHM)
    .sort((a, b) => a.arriveHM.localeCompare(b.arriveHM))
    .slice(0, 2)

  return {
    lateMin,
    enterHM,
    mustLeaveByHM: toHM(Math.min(mustLeave, 24 * 60 - 1)),
    remainMin: Math.max(0, Math.min(mustLeave, 24 * 60 - 1) - toMin(enterHM)),
    guideNames: names,
    guideConstraint: constraint,
    nextArrivals,
  }
}

/** 展厅在决策时的拥堵描述（含散客占用） */
export function congestionNoteFor(
  halls: Hall[],
  grid: Map<string, Map<number, number>>,
  nowHM: string,
  size: number,
): string {
  const slot = Math.floor(toMin(nowHM) / 15) * 15
  const hot: string[] = []
  for (const h of halls) {
    const load = grid.get(h.id)?.get(slot) ?? 0
    if (load / h.capacity >= 0.6) {
      hot.push(
        `${h.name.replace(/^.*? · /, '')} ${load}/${h.capacity}${load + size > h.capacity ? '，叠加本团将超容量' : ''}`,
      )
    }
  }
  return hot.length ? hot.join('；') : '各展厅当前负载平稳'
}

export interface ShortenPlan {
  kind: 'shorten'
  stops: RouteStop[]
  dropped: { hallId: string; reason: string }[]
  endHM: string
  reasons: string[]
}

/**
 * 缩短路线：在剩余讲解时长内，按「主题相关 / 热门展品 / 儿童友好 / 叠加本团后是否超容量」
 * 评分保留展厅，压缩每站停留，被舍弃的展厅逐条给出原因。
 */
export function buildShortenPlan(
  r: Reservation,
  ctx: LateContext,
  halls: Hall[],
  grid: Map<string, Map<number, number>>,
  live: LiveState,
): ShortenPlan {
  const size = r.verifiedSize ?? r.groupSize
  const kids = r.ageBand === 'children' || r.ageBand === 'mixed'
  const candidates = pendingStops(r)
  const reasons: string[] = [
    `迟到 ${ctx.lateMin} 分钟，${ctx.guideConstraint}，剩余可讲解时长仅 ${ctx.remainMin} 分钟（${ctx.enterHM} 进场 → ${ctx.mustLeaveByHM} 前结束）`,
  ]
  if (ctx.nextArrivals.length) {
    reasons.push(
      `下一团 ${ctx.nextArrivals.map((n) => `「${n.orgName}」${n.arriveHM}`).join('、')} 到馆，需为其预留展厅容量`,
    )
  }

  // 评分：超载重罚，热门/儿童友好加分
  const scored = candidates.map((s, idx) => {
    const hall = halls.find((h) => h.id === s.hallId)!
    let score = 100 - idx * 3 // 保持原路线顺序的轻微倾向
    const notes: string[] = []
    // 闭展/维护直接不可行
    const closed = closureAt(hall, ctx.enterHM, live.maintenance)
    if (closed) {
      return { s, hall, score: -Infinity, capacityRisk: false, closedNote: `${closed.reason}（${closed.start}-${closed.end}）`, notes }
    }
    // 用原计划时段的栅格负载 + 本团人数评估容量风险
    let peak = 0
    for (let t = toMin(s.plannedEnter); t < toMin(s.plannedLeave); t += 15) {
      peak = Math.max(peak, grid.get(s.hallId)?.get(Math.floor(t / 15) * 15) ?? 0)
    }
    const ratio = (peak + size) / hall.capacity
    const capacityRisk = ratio > 1
    if (capacityRisk) {
      score -= 120
      notes.push(`当前在场 ${peak} 人，叠加本团 ${size} 人达 ${Math.round(ratio * 100)}% 容量`)
    } else if (ratio >= 0.85) {
      score -= 40
      notes.push('叠加本团后接近限流')
    }
    if (hall.exhibits.some((e) => e.hot)) score += 30
    if (kids && hall.childFriendly) score += 25
    if (hall.themes.includes(r.themeId)) score += 15
    return { s, hall, score, capacityRisk, closedNote: '', notes }
  })

  // 贪心选择：按评分降序，预算 = 剩余时长（含站间步行）
  const feasible = scored.filter((x) => x.score > -Infinity)
  const byScore = [...feasible].sort((a, b) => b.score - a.score)
  const chosen = new Set<typeof byScore[number]>()
  let budget = ctx.remainMin
  for (const c of byScore) {
    const cost = MIN_STAY_MIN + (chosen.size > 0 ? WALK_MIN : 0)
    if (budget >= cost) {
      chosen.add(c)
      budget -= cost
    }
  }

  // 还原原路线顺序并分配时长：先各给最短停留，剩余按原时长比例追加
  const ordered = candidates
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => [...chosen].some((c) => c.s === s))
  const stops: RouteStop[] = []
  const dropped: { hallId: string; reason: string }[] = []

  let leftover = ctx.remainMin - ordered.length * MIN_STAY_MIN - Math.max(0, ordered.length - 1) * WALK_MIN
  const extraPool = ordered.reduce((sum, { s }) => sum + Math.max(0, s.durationMin - MIN_STAY_MIN), 0)
  let cursor = toMin(ctx.enterHM)
  ordered.forEach(({ s }, i) => {
    if (i > 0) cursor += WALK_MIN
    const want = Math.max(0, s.durationMin - MIN_STAY_MIN)
    const extra = extraPool > 0 ? Math.min(want, Math.floor((leftover * want) / extraPool)) : 0
    const dur = MIN_STAY_MIN + extra
    const meta = scored.find((x) => x.s === s)!
    stops.push({
      ...s,
      plannedEnter: toHM(cursor),
      plannedLeave: toHM(cursor + dur),
      durationMin: dur,
      note:
        `迟到压缩：停留 ${dur} 分钟（原 ${s.durationMin} 分钟）` +
        (meta.capacityRisk ? '；该厅当前拥挤，已错峰至此时间段' : ''),
    })
    cursor += dur
  })

  for (const c of scored) {
    if ([...chosen].some((x) => x.s === c.s)) continue
    dropped.push({
      hallId: c.s.hallId,
      reason:
        c.closedNote
          ? `该时段${c.closedNote}，无法安排`
          : c.capacityRisk
            ? `${c.notes.join('；')}，为避免超载舍弃`
            : '剩余讲解时长不足，优先保留评分更高的展厅',
    })
  }

  const endHM = stops.length ? stops[stops.length - 1].plannedLeave : ctx.enterHM
  if (dropped.length) {
    reasons.push(
      `舍弃 ${dropped.length} 个展厅：${dropped.map((d) => halls.find((h) => h.id === d.hallId)?.name.replace(/^.*? · /, '')).join('、')}`,
    )
  }
  return { kind: 'shorten', stops, dropped, endHM, reasons }
}

export interface SelfGuidePlan {
  kind: 'self'
  stops: RouteStop[]
  meetingPoint: string
  meetingHM: string
  points: { hallId: string; highlights: string[] }[]
  releasedWindow: string
  releasedGuideIds: string[]
  assignable: { resId: string; orgName: string; guideName: string; note: string }[]
  reasons: string[]
}

/**
 * 自助参观：不压缩内容，按电子导览自行参观；
 * 讲解员被释放，其空出的时段可分配给后续等待团队。
 */
export function buildSelfGuidePlan(
  r: Reservation,
  ctx: LateContext,
  halls: Hall[],
  reservations: Reservation[],
  guides: Guide[],
): SelfGuidePlan {
  // 自助不受讲解员时间约束：剩余站点按原时长从进场时刻顺排
  const stops: RouteStop[] = []
  let cursor = toMin(ctx.enterHM)
  for (const s of pendingStops(r)) {
    stops.push({
      ...s,
      plannedEnter: toHM(cursor),
      plannedLeave: toHM(cursor + s.durationMin),
      note: '自助参观：按电子导览自行前往',
    })
    cursor += s.durationMin + WALK_MIN
  }
  const meetingHM = stops.length ? stops[stops.length - 1].plannedLeave : ctx.enterHM
  const courtyard = halls.find((h) => h.id === 'courtyard')
  const meetingPoint = courtyard ? `${courtyard.name}（服务台旁集合点）` : '一楼服务台'

  const points = stops.map((s) => {
    const hall = halls.find((h) => h.id === s.hallId)!
    const highlights: string[] = []
    for (const e of hall.exhibits) {
      if (e.hot) highlights.push(`🔥 ${e.name}`)
      if (e.noPhoto) highlights.push(`📷「${e.name}」禁止拍照`)
    }
    if (hall.quiet === 3) highlights.push('🤫 安静展厅，请低声讲解')
    if (hall.childFriendly) highlights.push('🧒 儿童友好，含互动展项')
    if (!highlights.length) highlights.push('按导览牌自由参观')
    return { hallId: s.hallId, highlights }
  })

  const releasedWindow = `${ctx.enterHM}-${ctx.mustLeaveByHM}`
  const releasedGuideIds = [...r.assignedGuideIds]

  // 释放出的时段可支援的等待团队：语言/主题匹配且路线窗口重叠
  const [rs, re] = [toMin(ctx.enterHM), toMin(ctx.mustLeaveByHM)]
  const assignable: SelfGuidePlan['assignable'] = []
  for (const gid of releasedGuideIds) {
    const g = guides.find((x) => x.id === gid)
    if (!g) continue
    for (const other of reservations) {
      if (other.id === r.id || !['submitted', 'confirmed'].includes(other.status)) continue
      if (other.language && !g.langs.includes(other.language)) continue
      if (!g.themes.includes(other.themeId)) continue
      const active = other.route.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance')
      if (!active.length) continue
      const os = toMin(active[0].plannedEnter)
      const oe = toMin(active[active.length - 1].plannedLeave)
      if (os < re && oe > rs) {
        assignable.push({
          resId: other.id,
          orgName: other.orgName,
          guideName: g.name,
          note: `${g.name} 可支援「${other.orgName}」${releasedWindow} 时段`,
        })
      }
    }
  }

  const reasons = [
    `迟到 ${ctx.lateMin} 分钟，改为自助参观可不压缩任何展厅内容`,
    `讲解员 ${ctx.guideNames.join('、') || '—'} 释放 ${releasedWindow} 时段（${ctx.guideConstraint}）`,
    `电子导览与集合点（${meetingHM} ${meetingPoint}）将推送至联系人手机`,
  ]
  return {
    kind: 'self',
    stops,
    meetingPoint,
    meetingHM,
    points,
    releasedWindow,
    releasedGuideIds,
    assignable,
    reasons,
  }
}

export interface ReschedulePlan {
  kind: 'reschedule'
  slotHM: string
  endHM: string
  guideId: string
  guideName: string
  sameGuide: boolean
  reasons: string[]
}

/**
 * 改签：扫描当日稍后 15 分钟槽，找「讲解员有空 + 展厅开放 + 叠加后不超容量」的时段；
 * 优先保留原讲解员。散客占用不计入硬约束（馆方可临时限流）。
 */
export function buildReschedulePlan(
  r: Reservation,
  ctx: LateContext,
  halls: Hall[],
  reservations: Reservation[],
  guides: Guide[],
  live: LiveState,
  nowHM: string,
): ReschedulePlan | null {
  const pending = pendingStops(r)
  if (!pending.length) return null
  const size = r.verifiedSize ?? r.groupSize
  const needMin =
    pending.reduce((sum, s) => sum + s.durationMin, 0) + (pending.length - 1) * WALK_MIN
  const others = reservations.filter((x) => x.id !== r.id)
  const grid = occupancyGrid(others, { maintenance: live.maintenance, extraLoad: {} })

  const feasible: { slot: number; guide: Guide; same: boolean }[] = []
  const firstSlot = Math.ceil((toMin(nowHM) + 30) / 15) * 15
  for (let slot = firstSlot; slot + needMin <= 16 * 60 + 30; slot += 15) {
    const slotHM = toHM(slot)
    const endHM = toHM(slot + needMin)
    // 展厅开放 + 容量
    let ok = true
    let cursor = slot
    for (const s of pending) {
      const hall = halls.find((h) => h.id === s.hallId)!
      for (let t = cursor; t < cursor + s.durationMin; t += 15) {
        if (closureAt(hall, toHM(t), live.maintenance)) {
          ok = false
          break
        }
        const load = (grid.get(s.hallId)?.get(Math.floor(t / 15) * 15) ?? 0) + size
        if (load > hall.capacity) {
          ok = false
          break
        }
      }
      if (!ok) break
      cursor += s.durationMin + WALK_MIN
    }
    if (!ok) continue
    // 讲解员
    const cands = availableGuides(guides, others, {
      language: r.language,
      themeId: r.themeId,
      startHM: slotHM,
      endHM,
    }).filter((g) => g.ok)
    if (!cands.length) continue
    const same = cands.find((g) => r.assignedGuideIds.includes(g.id))
    feasible.push({ slot, guide: same ?? cands[0], same: !!same })
  }
  if (!feasible.length) return null

  // 优先原讲解员，其次最早时段
  feasible.sort((a, b) => Number(b.same) - Number(a.same) || a.slot - b.slot)
  const pick = feasible[0]
  const slotHM = toHM(pick.slot)
  const endHM = toHM(pick.slot + needMin)
  const reasons = [
    `迟到 ${ctx.lateMin} 分钟且 ${ctx.guideConstraint}，当日改签至 ${slotHM} 可完整参观 ${needMin} 分钟`,
    pick.same
      ? `原讲解员 ${pick.guide.name} 该时段可当班，排班自动顺延`
      : `原讲解员该时段不可用，改派 ${pick.guide.name}（语言/主题匹配）`,
    '改签时段各展厅叠加本团后均未超容量，散客高峰由馆方临时限流',
  ]
  return {
    kind: 'reschedule',
    slotHM,
    endHM,
    guideId: pick.guide.id,
    guideName: pick.guide.name,
    sameGuide: pick.same,
    reasons,
  }
}
