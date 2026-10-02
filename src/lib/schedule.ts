import type {
  Guide,
  Hall,
  HallClosure,
  LatePlan,
  LatePlanBasis,
  LatePlanOption,
  LateStopDecision,
  Reservation,
  RouteStop,
  SecurityLane,
  Theme,
} from '@/types'
import { addHM, durationHM, hmOfISO, overlap, toHM, toMin } from './time'
import { TOUR_INTERVAL_MIN } from '@/data/museum'

/** 有效闭馆时间 = 展厅静态闭展 + 工作人员临时登记的维护 */
export function closureAt(
  hall: Hall,
  hm: string,
  live: Record<string, HallClosure>,
): HallClosure | undefined {
  const m = toMin(hm)
  const all = [...hall.closures]
  if (live[hall.id]) all.push(live[hall.id])
  return all.find((c) => m >= toMin(c.start) && m < toMin(c.end))
}

export function isClosedAt(
  hall: Hall,
  hm: string,
  live: Record<string, HallClosure> = {},
): boolean {
  return !!closureAt(hall, hm, live)
}

/** 团队某站的有效时间：途中已发生用实际，未发生用计划 */
function effectiveWindow(stop: RouteStop): { enter: string; leave: string } {
  return {
    enter: stop.actualEnter ?? stop.plannedEnter,
    leave: stop.actualLeave ?? stop.plannedLeave,
  }
}

/** 仍占用展厅容量的团队：已确认 / 已到馆 / 参观中 */
export const OCCUPYING_STATUSES = ['confirmed', 'arrived', 'touring'] as const

export interface LiveState {
  maintenance: Record<string, HallClosure>
  /** 散客/其他团队实时占用（展厅探头人工录入） */
  extraLoad: Record<string, number>
}

/**
 * 展厅 15 分钟栅格占用：Map<hallId, Map<槽起点分钟, 团队人数>>
 */
export function occupancyGrid(
  reservations: Reservation[],
  live: LiveState = { maintenance: {}, extraLoad: {} },
): Map<string, Map<number, number>> {
  const grid = new Map<string, Map<number, number>>()
  const add = (hallId: string, startMin: number, endMin: number, size: number) => {
    let row = grid.get(hallId)
    if (!row) {
      row = new Map()
      grid.set(hallId, row)
    }
    for (let t = Math.floor(startMin / 15) * 15; t < endMin; t += 15) {
      row.set(t, (row.get(t) ?? 0) + size)
    }
  }
  for (const r of reservations) {
    if (!OCCUPYING_STATUSES.includes(r.status as (typeof OCCUPYING_STATUSES)[number])) continue
    const size = r.verifiedSize ?? r.groupSize
    for (const stop of r.route) {
      if (stop.state === 'skipped' || stop.state === 'maintenance') continue
      const w = effectiveWindow(stop)
      add(stop.hallId, toMin(w.enter), toMin(w.leave), size)
    }
  }
  for (const [hallId, extra] of Object.entries(live.extraLoad ?? {})) {
    if (extra > 0) {
      // 散客视为全天均匀占用（运营当日视角）
      for (let t = 9 * 60; t < 17 * 60; t += 15) add(hallId, t, t + 15, extra)
    }
  }
  return grid
}

/** 查询某展厅在某时刻的预计在场人数与满载率 */
export function hallLoadAt(
  hall: Hall,
  hm: string,
  grid: Map<string, Map<number, number>>,
): { load: number; capacity: number; ratio: number } {
  const slot = Math.floor(toMin(hm) / 15) * 15
  const load = grid.get(hall.id)?.get(slot) ?? 0
  return { load, capacity: hall.capacity, ratio: hall.capacity ? load / hall.capacity : 0 }
}

/** 整个团队路线期间，每一站的满载率峰值（确认预约时用） */
export function routePeakLoads(
  stops: RouteStop[],
  halls: Hall[],
  grid: Map<string, Map<number, number>>,
): { hallId: string; ratio: number; load: number; capacity: number }[] {
  return stops
    .filter((s) => s.state !== 'skipped' && s.state !== 'maintenance')
    .map((s) => {
      const hall = halls.find((h) => h.id === s.hallId)!
      let peak = 0
      for (let t = toMin(s.plannedEnter); t < toMin(s.plannedLeave); t += 15) {
        peak = Math.max(peak, grid.get(s.hallId)?.get(Math.floor(t / 15) * 15) ?? 0)
      }
      return {
        hallId: s.hallId,
        load: peak,
        capacity: hall.capacity,
        ratio: hall.capacity ? peak / hall.capacity : 0,
      }
    })
}

/** 讲解员当日带团窗口（含前后 10 分钟交接缓冲） */
export function guideBusyWindows(
  reservations: Reservation[],
  guideId: string,
): { start: number; end: number; reservation: Reservation }[] {
  const out: { start: number; end: number; reservation: Reservation }[] = []
  for (const r of reservations) {
    if (!r.assignedGuideIds.includes(guideId)) continue
    if (r.status === 'rejected' || r.status === 'cancelled' || r.status === 'completed') continue
    const active = r.route.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance')
    if (!active.length) continue
    const first = active[0]
    const last = active[active.length - 1]
    out.push({
      start: toMin(first.actualEnter ?? first.plannedEnter) - TOUR_INTERVAL_MIN,
      end: toMin(last.actualLeave ?? last.plannedLeave) + TOUR_INTERVAL_MIN,
      reservation: r,
    })
  }
  return out
}

export interface GuideCandidate extends Guide {
  ok: boolean
  conflicts: string[] // 冲突原因
}

/** 为某语言/主题/时段匹配合适讲解员 */
export function availableGuides(
  guides: Guide[],
  reservations: Reservation[],
  opts: { language: string; themeId: string; startHM: string; endHM: string },
): GuideCandidate[] {
  const s = toMin(opts.startHM)
  const e = toMin(opts.endHM)
  return guides.map((g) => {
    const conflicts: string[] = []
    if (!g.langs.includes(opts.language as Guide['langs'][number]))
      conflicts.push(`不支持${opts.language === 'zh' ? '中文' : opts.language === 'en' ? '英语' : '日语'}`)
    if (!g.themes.includes(opts.themeId)) conflicts.push('不熟悉该讲解主题')
    const inShift = g.shifts.some((sh) => s >= toMin(sh.start) && e <= toMin(sh.end))
    if (!inShift) conflicts.push('排班时段不覆盖')
    const clash = guideBusyWindows(reservations, g.id).find((w) => overlap(s, e, w.start, w.end))
    if (clash) conflicts.push(`与「${clash.reservation.orgName}」带团时间冲突`)
    return { ...g, ok: conflicts.length === 0, conflicts }
  })
}

/** 大团拆分入馆批次 */
export function splitBatches(size: number, perBatch = 25): number[] {
  const batches: number[] = []
  let rest = size
  while (rest > 0) {
    const n = Math.min(perBatch, rest)
    batches.push(n)
    rest -= n
  }
  return batches
}

/** 安检通道安排：按到馆 15 分钟槽聚合已确认人数 */
export function securityPlan(
  lanes: SecurityLane[],
  reservations: Reservation[],
  arriveHM: string,
  size: number,
  accessible: boolean,
  selfId?: string,
): { lane: SecurityLane; slot: string; loadBefore: number; loadAfter: number; waitSlots: number }[] {
  const slot = Math.floor(toMin(arriveHM) / 15) * 15
  const slotKey = `${String(Math.floor(slot / 60)).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}`
  const used = new Map<string, number>()
  for (const r of reservations) {
    if (!OCCUPYING_STATUSES.includes(r.status as (typeof OCCUPYING_STATUSES)[number])) continue
    if (r.id === selfId || !r.securityLane) continue
    const hm = r.actualArrive ? hmOfISO(r.actualArrive) : hmOfISO(r.arriveTime)
    if (Math.floor(toMin(hm) / 15) * 15 !== slot) continue
    used.set(r.securityLane, (used.get(r.securityLane) ?? 0) + (r.verifiedSize ?? r.groupSize))
  }
  // 需无障碍时优先无障碍通道，同时给出普通通道备选；否则隐藏无障碍专道
  const ordered = accessible
    ? [...lanes].sort((a, b) => Number(!!b.accessibleOnly) - Number(!!a.accessibleOnly))
    : lanes.filter((l) => !l.accessibleOnly)
  return ordered.map((lane) => {
    const before = used.get(lane.id) ?? 0
    const after = before + size
    const waitSlots = Math.max(0, Math.ceil(after / lane.perSlot) - 1)
    return { lane, slot: slotKey, loadBefore: before, loadAfter: after, waitSlots }
  })
}

/**
 * 按主题生成路线：顺排展厅、分配时长、避让闭展与无障碍不可达
 */
export function buildRoute(
  theme: Theme,
  halls: Hall[],
  startHM: string,
  opts: { accessible: boolean; live?: Record<string, HallClosure> } = {
    accessible: false,
  },
): RouteStop[] {
  const live = opts.live ?? {}
  const per = Math.floor(theme.durationMin / theme.hallIds.length)
  let cursor = toMin(startHM)
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

  return theme.hallIds.map((hallId, idx) => {
    const hall = halls.find((h) => h.id === hallId)!
    const dur = idx === theme.hallIds.length - 1
      ? theme.durationMin - per * (theme.hallIds.length - 1)
      : per
    let enter = cursor
    let leave = cursor + dur
    let state: RouteStop['state'] = 'planned'
    let note: string | undefined

    if (opts.accessible && !hall.accessible) {
      state = 'skipped'
      note = '该展厅暂不支持无障碍通行，已从路线移除'
    } else {
      const closed = hall.closures
        .concat(live[hallId] ? [live[hallId]] : [])
        .find((c) => overlap(enter, leave, toMin(c.start), toMin(c.end)))
      if (closed) {
        const reopen = toMin(closed.end)
        if (reopen < leave + 20) {
          // 闭展结束后仍可补看：顺延本站，后续站整体后移
          enter = Math.max(enter, reopen + 5)
          leave = enter + dur
          note = `${closed.reason}（${closed.start}-${closed.end}），已顺延至 ${fmt(enter)}`
          cursor = enter
        } else {
          state = 'maintenance'
          note = `${closed.reason}（${closed.start}-${closed.end}），当日无法参观`
        }
      }
    }

    const stop: RouteStop = {
      hallId,
      plannedEnter: fmt(enter),
      plannedLeave: fmt(state === 'maintenance' ? cursor + dur : leave),
      durationMin: dur,
      state,
      note,
    }
    if (state !== 'maintenance' && state !== 'skipped') cursor = leave + 5
    return stop
  })
}

export interface RerouteCandidate {
  hall: Hall
  score: number
  reasons: string[]
  enterHM: string
  ratio: number
}

/**
 * 途中智能改道：给出可替换/增补展厅建议
 * 综合：同主题、儿童友好、无障碍、实时满载率、相邻少走动、热门展品、安静等级
 */
export function suggestReroute(
  reservation: Reservation,
  blockedHallId: string,
  halls: Hall[],
  grid: Map<string, Map<number, number>>,
  live: LiveState,
  nowHM: string,
): RerouteCandidate[] {
  const visited = new Set(
    reservation.route.filter((s) => s.state === 'done').map((s) => s.hallId),
  )
  const kids = reservation.ageBand === 'children' || reservation.ageBand === 'mixed'
  const blocked = halls.find((h) => h.id === blockedHallId)
  const adjacent = new Set(blocked?.nearTo ?? [])

  return halls
    .filter((h) => h.id !== blockedHallId && !visited.has(h.id))
    .filter((h) => !(reservation.accessible && !h.accessible))
    .filter((h) => !isClosedAt(h, nowHM, live.maintenance))
    .map((hall) => {
      let score = 0
      const reasons: string[] = []
      const { ratio } = hallLoadAt(hall, nowHM, grid)
      score -= Math.round(ratio * 200)
      if (hall.themes.includes(reservation.themeId)) {
        score += 100
        reasons.push('属于本团讲解主题')
      }
      if (kids && hall.childFriendly) {
        score += 40
        reasons.push('儿童友好展厅')
      }
      if (!kids && hall.quiet === 3) {
        score += 20
        reasons.push('安静展厅，适合深度观展')
      }
      if (reservation.accessible && hall.accessible) reasons.push('无障碍可达')
      if (adjacent.has(hall.id)) {
        score += 25
        reasons.push('与当前位置相邻，步行 ≤ 2 分钟')
      }
      if (ratio < 0.5) reasons.push('当前人流稀疏')
      else if (ratio >= 0.85) reasons.push('即将达到限流阈值')
      if (hall.exhibits.some((e) => e.hot)) reasons.push('含热门展品')
      if (hall.exhibits.some((e) => e.noPhoto)) reasons.push('含禁止拍照展品，需提前提醒')
      score += Math.round((hall.capacity / 120) * 15)
      return {
        hall,
        score,
        reasons,
        enterHM: addHM(nowHM, adjacent.has(hall.id) ? 2 : 6),
        ratio,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
}

export interface DownstreamConflict {
  reservation: Reservation
  hallId: string
  hm: string
  loadAfter: number
  capacity: number
}

/**
 * 评估某团队新路线对后续团队入场的影响：逐槽叠加后是否突破展厅容量
 */
export function downstreamImpact(
  target: Reservation,
  newStops: RouteStop[],
  reservations: Reservation[],
  halls: Hall[],
  extraDelayMin = 0,
): DownstreamConflict[] {
  const others = reservations.filter(
    (r) =>
      r.id !== target.id &&
      OCCUPYING_STATUSES.includes(r.status as (typeof OCCUPYING_STATUSES)[number]),
  )
  const grid = occupancyGrid(others)
  const size = target.verifiedSize ?? target.groupSize
  const conflicts: DownstreamConflict[] = []

  for (const stop of newStops) {
    if (stop.state === 'skipped' || stop.state === 'maintenance') continue
    const s = toMin(stop.plannedEnter) + extraDelayMin
    const e = toMin(stop.plannedLeave) + extraDelayMin
    const hall = halls.find((h) => h.id === stop.hallId)!
    for (let t = Math.floor(s / 15) * 15; t < e; t += 15) {
      const load = (grid.get(hall.id)?.get(t) ?? 0) + size
      if (load > hall.capacity) {
        const owner = others.find((r) =>
          r.route.some((rs) => {
            if (rs.hallId !== hall.id || rs.state === 'skipped' || rs.state === 'maintenance')
              return false
            const w = effectiveWindow(rs)
            return t >= toMin(w.enter) && t < toMin(w.leave)
          }),
        )
        if (owner) {
          conflicts.push({
            reservation: owner,
            hallId: hall.id,
            hm: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`,
            loadAfter: load,
            capacity: hall.capacity,
          })
        }
      }
    }
  }
  // 去重
  const seen = new Set<string>()
  return conflicts.filter((c) => {
    const k = `${c.reservation.id}-${c.hallId}-${c.hm}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 计划讲解总时长（分钟） */
export function plannedDuration(stops: RouteStop[]): number {
  const active = stops.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance')
  if (!active.length) return 0
  const first = active[0]
  const last = active[active.length - 1]
  return durationHM(first.plannedEnter, last.plannedLeave)
}

// ===================== 团体迟到后的路线重排 =====================

const WALK_MIN = 5 // 厅间步行/缓冲
const REBUFFER_MIN = 2 // 重排后集结缓冲
const MIN_GUIDED_PER_HALL = 10 // 缩短方案单厅最少讲解分钟，低于该时长宁可放弃该厅
export const SELF_GUIDE_CHANNEL = 'CH-08' // 耳麦自助导览频道

export interface GuideDeadline {
  hm: string
  min: number
  reason: string
  /** 截止是否由「下一个团」触发（true=还有带团任务；false=仅排班下班） */
  drivenByNextGroup: boolean
  nextReservation?: Reservation
}

/**
 * 讲解员带本团的最迟离场时刻：
 * 下一团（已派给 TA，或已确认/到馆但讲解员未配齐、语言主题排班匹配、拟由 TA 接续的等待团）
 * 首站开讲前 10 分钟交接，与当班结束取较早者。
 */
export function guideDeadline(
  reservation: Reservation,
  guide: Guide,
  reservations: Reservation[],
  fromHM?: string,
): GuideDeadline | null {
  const shiftEnds = guide.shifts.map((s) => toMin(s.end))
  const fromMin = fromHM ? toMin(fromHM) : -1
  let nextStart = Infinity
  let nextRes: Reservation | undefined
  let nextAssigned = false
  for (const o of reservations) {
    if (o.id === reservation.id) continue
    if (!OCCUPYING_STATUSES.includes(o.status as (typeof OCCUPYING_STATUSES)[number])) continue
    const active = o.route.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance')
    if (!active.length) continue
    const start = toMin(active[0].actualEnter ?? active[0].plannedEnter)
    const end = toMin(active[active.length - 1].actualLeave ?? active[active.length - 1].plannedLeave)
    if (start < fromMin) continue // 已开始/已错过的团不构成"后续任务"
    const assigned = o.assignedGuideIds.includes(guide.id)
    const need = Math.ceil((o.verifiedSize ?? o.groupSize) / 25)
    let eligible = assigned
    if (!eligible && o.assignedGuideIds.length < need) {
      // 未配齐的等待团：语言/主题/排班匹配，且与该讲解员其他已派团不冲突
      eligible =
        guide.langs.includes(o.language) &&
        guide.themes.includes(o.themeId) &&
        guide.shifts.some((sh) => start >= toMin(sh.start) && end <= toMin(sh.end))
      if (eligible) {
        const clash = reservations.some((x) => {
          if (x.id === reservation.id || x.id === o.id || !x.assignedGuideIds.includes(guide.id)) return false
          if (!OCCUPYING_STATUSES.includes(x.status as (typeof OCCUPYING_STATUSES)[number])) return false
          const xa = x.route.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance')
          if (!xa.length) return false
          const xs = toMin(xa[0].actualEnter ?? xa[0].plannedEnter) - TOUR_INTERVAL_MIN
          const xe = toMin(xa[xa.length - 1].actualLeave ?? xa[xa.length - 1].plannedLeave) + TOUR_INTERVAL_MIN
          return overlap(start, end, xs, xe)
        })
        if (clash) eligible = false
      }
    }
    if (eligible && start < nextStart) {
      nextStart = start
      nextRes = o
      nextAssigned = assigned
    }
  }
  const shiftEnd = shiftEnds.length ? Math.min(...shiftEnds) : Infinity
  const cands: { min: number; reason: string; byNext: boolean; r?: Reservation }[] = []
  if (nextRes) {
    cands.push({
      min: nextStart - TOUR_INTERVAL_MIN,
      reason: nextAssigned
        ? `下一团「${nextRes.orgName}」计划 ${toHM(nextStart)} 到馆开讲，需提前 ${TOUR_INTERVAL_MIN} 分钟交接`
        : `后续等待团「${nextRes.orgName}」计划 ${toHM(nextStart)} 开讲（讲解员未配齐，拟由 ${guide.name} 接续），需提前 ${TOUR_INTERVAL_MIN} 分钟交接`,
      byNext: true,
      r: nextRes,
    })
  }
  if (shiftEnd !== Infinity) {
    cands.push({
      min: shiftEnd,
      reason: `讲解员 ${guide.name} 当班至 ${toHM(shiftEnd)} 下班`,
      byNext: false,
    })
  }
  if (!cands.length) return null
  cands.sort((a, b) => a.min - b.min)
  const c = cands[0]
  return { hm: toHM(c.min), min: c.min, reason: c.reason, drivenByNextGroup: c.byNext, nextReservation: c.r }
}

/** 未完成站点（不含已完成/已跳过/临时维护） */
export function unfinishedStops(r: Reservation): RouteStop[] {
  return r.route.filter((s) => ['current', 'planned', 'congested'].includes(s.state))
}

/** 某厅在重排时刻的拥堵依据文案 */
function congestionReasons(ratio: number, blocked: boolean): string[] {
  const out: string[] = []
  if (blocked) out.push('该厅已登记拥堵并启动避让')
  if (ratio >= 1) out.push(`实时满载率 ${Math.round(ratio * 100)}%，已达限流`)
  else if (ratio >= 0.85) out.push(`实时满载率 ${Math.round(ratio * 100)}%，接近限流、排队风险高`)
  else if (ratio >= 0.6) out.push(`实时满载率 ${Math.round(ratio * 100)}%，较为拥挤`)
  return out
}

function selfGuidePack(lastLeaveHM: string) {
  return {
    audioGuide: {
      name: '「云川导览」电子语音导览（同主题讲解包）',
      pickup: `已推送至联系人手机电子票二维码；借用耳麦切至自助频道 ${SELF_GUIDE_CHANNEL}`,
    },
    assemblyPoint: `一层前厅服务台，${lastLeaveHM} 准时集合归还耳麦`,
  }
}

/**
 * 团体迟到后，依据 剩余讲解时长 / 展厅当前拥堵 / 下一团到馆时间
 * 生成三个方案：缩短讲解路线、改为自助参观、改签其他时段。
 */
export function buildLatePlan(
  reservation: Reservation,
  guides: Guide[],
  halls: Hall[],
  reservations: Reservation[],
  grid: Map<string, Map<number, number>>,
  live: LiveState,
  input: { lateMin: number; nowHM: string },
): LatePlan {
  const now = toMin(input.nowHM)
  const guide = guides.find((g) => reservation.assignedGuideIds.includes(g.id))
  const deadline =
    (guide ? guideDeadline(reservation, guide, reservations, input.nowHM) : null) ??
    ({ hm: '17:00', min: 17 * 60, reason: '按闭馆时间兜底', drivenByNextGroup: false } as GuideDeadline)

  const raw = unfinishedStops(reservation)
  // 迟到后一律按「当前时刻 + 集结缓冲」重新投影尚未完成的站点，再评估剩余讲解时长
  let projectCursor = now + REBUFFER_MIN
  const remaining: RouteStop[] = raw.map((s) => {
    const enter = projectCursor
    const leave = enter + s.durationMin
    projectCursor = leave + WALK_MIN
    return { ...s, plannedEnter: toHM(enter), plannedLeave: toHM(leave) }
  })
  const walks = Math.max(0, remaining.length - 1) * WALK_MIN
  const plannedRemainingMin =
    remaining.reduce((sum, s) => sum + s.durationMin, 0) + walks
  const remainingGuideMin = Math.max(0, deadline.min - now)
  const mustCutMin = Math.max(0, plannedRemainingMin - remainingGuideMin)

  const hallRatio = (hallId: string) => {
    const hall = halls.find((h) => h.id === hallId)!
    return hallLoadAt(hall, input.nowHM, grid).ratio
  }
  const hallRatios = remaining.map((s) => ({ hallId: s.hallId, ratio: hallRatio(s.hallId) }))

  const basis: LatePlanBasis = {
    lateMin: input.lateMin,
    guideDeadlineHM: deadline.hm,
    guideDeadlineReason: deadline.reason,
    remainingGuideMin,
    plannedRemainingMin,
    nextGroupHM: deadline.nextReservation
      ? deadline.nextReservation.route.find((s) => s.state !== 'skipped' && s.state !== 'maintenance')
        ?.plannedEnter
      : undefined,
    nextGroupName: deadline.nextReservation?.orgName,
    hallRatios,
    mustCutMin,
  }

  // ---------- 方案一：缩短讲解路线 ----------
  const shorten = (() => {
    // 丢弃优先级：已拥堵 > 满载率高 > 排序列表靠后的非核心厅
    const ranked = remaining.map((s, order) => {
      const hall = halls.find((h) => h.id === s.hallId)!
      const ratio = hallRatio(s.hallId)
      let dropPrio = ratio * 100
      if (s.state === 'congested') dropPrio += 100
      if (hall.themes.includes(reservation.themeId)) dropPrio -= 15 // 主题核心厅尽量保留
      return { s, hall, ratio, dropPrio, order }
    })
    const dropped = new Set<string>()
    const keep = () => ranked.filter((x) => !dropped.has(x.s.hallId))
    const fits = () => {
      const k = keep()
      if (!k.length) return false
      const w = Math.max(0, k.length - 1) * WALK_MIN
      return k.length * MIN_GUIDED_PER_HALL + w <= remainingGuideMin
    }
    // 只要保留全部时放不下，就按优先级放弃展厅；同优先级先放弃路线靠后的厅
    while (!fits()) {
      const k = keep()
      if (k.length <= 1) break
      const victim = [...k].sort((a, b) => b.dropPrio - a.dropPrio || b.order - a.order)[0]
      dropped.add(victim.s.hallId)
    }
    const kept = keep()
    const feasible = kept.length > 0 && remainingGuideMin >= 5
    const walkKept = Math.max(0, kept.length - 1) * WALK_MIN
    const contentBudget = Math.max(0, remainingGuideMin - walkKept - REBUFFER_MIN)
    const totalOrig = kept.reduce((sum, x) => sum + x.s.durationMin, 0) || 1
    // 按原时长比例分配可用讲解预算，再把总额钳制到预算内，保证结束不晚于讲解员离场
    let alloc = kept.map((x) =>
      Math.min(x.s.durationMin, Math.round((x.s.durationMin / totalOrig) * contentBudget)),
    )
    while (alloc.reduce((a, b) => a + b, 0) > contentBudget) {
      const i = alloc.indexOf(Math.max(...alloc))
      if (alloc[i] <= 0) break
      alloc[i] -= 1
    }
    let headroom = contentBudget - alloc.reduce((a, b) => a + b, 0)
    while (headroom > 0) {
      const i = alloc.findIndex((v, idx) => v < kept[idx].s.durationMin)
      if (i < 0) break
      alloc[i] += 1
      headroom -= 1
    }
    let cursor = now + REBUFFER_MIN
    const decisions: LateStopDecision[] = []
    kept.forEach((x, i) => {
      const enter = cursor + (i === 0 ? 0 : WALK_MIN)
      const leave = enter + alloc[i]
      const reasons: string[] = []
      const cr = congestionReasons(x.ratio, x.s.state === 'congested')
      reasons.push(...cr)
      if (alloc[i] < x.s.durationMin) {
        reasons.push(`在讲解员 ${deadline.hm} 离场前完成，压缩至 ${alloc[i]} 分钟，保留核心展品讲解`)
      } else {
        reasons.push('为讲解主题核心厅，按原时长保留')
      }
      decisions.push({
        hallId: x.s.hallId,
        action: alloc[i] < x.s.durationMin ? 'trim' : 'keep',
        originalEnter: x.s.plannedEnter,
        originalLeave: x.s.plannedLeave,
        newEnter: toHM(enter),
        newLeave: toHM(leave),
        originalMin: x.s.durationMin,
        newMin: alloc[i],
        reasons,
      })
      cursor = leave
    })
    for (const x of ranked.filter((x) => dropped.has(x.s.hallId))) {
      const reasons = congestionReasons(x.ratio, x.s.state === 'congested')
      reasons.push(`为保证讲解员 ${deadline.hm} 前结束并交接，本厅放弃人工讲解（团队可快速自行观看）`)
      decisions.push({
        hallId: x.s.hallId,
        action: 'drop',
        originalEnter: x.s.plannedEnter,
        originalLeave: x.s.plannedLeave,
        originalMin: x.s.durationMin,
        newMin: 0,
        reasons,
      })
    }
    // 恢复路线顺序
    decisions.sort(
      (a, b) =>
        remaining.findIndex((s) => s.hallId === a.hallId) -
        remaining.findIndex((s) => s.hallId === b.hallId),
    )
    const endHM = decisions.filter((d) => d.action !== 'drop').slice(-1)[0]?.newLeave ?? input.nowHM
    const guidedMin = feasible ? toMin(endHM) - (now + REBUFFER_MIN) : 0
    const cutMin = Math.max(0, plannedRemainingMin - guidedMin)
    const guidedRatio = plannedRemainingMin ? guidedMin / plannedRemainingMin : 1
    const hallNames = (ids: string[]) =>
      ids.map((id) => halls.find((h) => h.id === id)?.name.replace(/^.*? · /, '') ?? id).join('、')
    const droppedNames = hallNames([...dropped])
    return {
      type: 'shorten' as const,
      title: '缩短讲解路线（讲解员带精华线）',
      feasible,
      score: feasible ? 60 + Math.round(guidedRatio * 30) : 0,
      endHM,
      guidedMin,
      cutMin,
      decisions,
      summary: feasible
        ? `保留 ${kept.length}/${remaining.length} 个展厅人工讲解，${input.nowHM} 集结后 ${endHM} 前结束，讲解员准时交接。`
        : '剩余时间不足以完成任一展厅的最低讲解',
      reasons: [
        `距讲解员离场（${deadline.hm}）仅剩 ${remainingGuideMin} 分钟，需压缩 ${mustCutMin} 分钟`,
        dropped.size ? `放弃：${droppedNames}` : '全部未完成展厅均可保留，仅压缩单厅时长',
      ],
    }
  })()

  // ---------- 方案二：改为自助参观 ----------
  const selfguide = (() => {
    const lastLeave = remaining[remaining.length - 1]?.plannedLeave ?? input.nowHM
    const decisions: LateStopDecision[] = remaining.map((s) => {
      const ratio = hallRatio(s.hallId)
      return {
        hallId: s.hallId,
        action: 'self' as const,
        originalEnter: s.plannedEnter,
        originalLeave: s.plannedLeave,
        newEnter: s.plannedEnter,
        newLeave: s.plannedLeave,
        originalMin: s.durationMin,
        newMin: s.durationMin,
        reasons: [
          ...congestionReasons(ratio, s.state === 'congested'),
          '改为自助参观：电子导览覆盖该厅，团队按推送动线自行观看',
        ],
      }
    })
    return {
      type: 'selfguide' as const,
      title: '改为自助参观（推送电子导览 + 集合点）',
      feasible: true,
      score: 45,
      endHM: lastLeave,
      guidedMin: 0,
      cutMin: plannedRemainingMin,
      decisions,
      ...selfGuidePack(lastLeave),
      summary: `讲解员即刻释放，团队凭电子导览按原计划自助参观，${lastLeave} 在一层前厅集合还机。`,
      reasons: [
        `人工讲解 ${plannedRemainingMin} 分钟全部转为电子导览，团队可按自己的节奏看完剩余 ${remaining.length} 个展厅`,
        `讲解员 ${guide?.name ?? ''} 释放后可立即接应后续等待团队`,
        reservation.needHeadsets
          ? `已借耳麦保留借用，截止时间随集合点调整为 ${lastLeave}`
          : '电子导览推送至联系人手机，无需额外设备',
      ],
    }
  })()

  // ---------- 方案三：改签其他时段 ----------
  const reschedule = (() => {
    const windowMin = plannedRemainingMin
    const need = Math.ceil((reservation.verifiedSize ?? reservation.groupSize) / 25)
    let found: { start: number; guides: Guide[] } | null = null
    let fallback: { start: number; guides: Guide[] } | null = null
    for (let t = now + 30; t <= 16 * 60; t += 15) {
      const end = t + windowMin
      if (end > 17 * 60) break
      const cands = availableGuides(guides, reservations, {
        language: reservation.language,
        themeId: reservation.themeId,
        startHM: toHM(t),
        endHM: toHM(end),
      }).filter((g) => g.ok)
      // 容量与闭展校验：用候选时段排一遍剩余站
      const trial: RouteStop[] = []
      let cur = t
      let closed = false
      for (const s of remaining) {
        const hall = halls.find((h) => h.id === s.hallId)!
        if (closureAt(hall, toHM(cur), live.maintenance)) {
          closed = true
          break
        }
        trial.push({
          hallId: s.hallId,
          plannedEnter: toHM(cur),
          plannedLeave: toHM(cur + s.durationMin),
          durationMin: s.durationMin,
          state: 'planned',
        })
        cur += s.durationMin + WALK_MIN
      }
      if (closed || cands.length < need) continue
      if (downstreamImpact(reservation, trial, reservations, halls).length) continue
      // 优先安排非原讲解员，把原讲解员留给后续等待团队
      const fresh = cands.filter((g) => !reservation.assignedGuideIds.includes(g.id))
      const pick = (fresh.length >= need ? fresh : cands).slice(0, need)
      const usesFreshGuide = fresh.length >= need
      if (usesFreshGuide) {
        found = { start: t, guides: pick }
        break
      }
      if (!fallback) fallback = { start: t, guides: pick }
    }
    if (!found) found = fallback
    const decisions: LateStopDecision[] = remaining.map((s) => ({
      hallId: s.hallId,
      action: 'drop' as const,
      originalEnter: s.plannedEnter,
      originalLeave: s.plannedLeave,
      originalMin: s.durationMin,
      newMin: 0,
      reasons: ['本次到馆不再讲解，改签后按新时段重新安排这些展厅'],
    }))
    if (!found) {
      return {
        type: 'reschedule' as const,
        title: '改签其他时段（今日稍后/协调改期）',
        feasible: false,
        score: 0,
        endHM: deadline.hm,
        guidedMin: 0,
        cutMin: plannedRemainingMin,
        decisions,
        summary: '当日已无同时满足讲解员、展厅容量且不闭展的整段时段。',
        reasons: ['建议前台与学校协调改至其他参观日，或回到上方选择缩短/自助方案'],
      }
    }
    const end = found.start + windowMin
    return {
      type: 'reschedule' as const,
      title: `改签至今日 ${toHM(found.start)} 开讲`,
      feasible: true,
      score: 55,
      endHM: toHM(end),
      guidedMin: windowMin,
      cutMin: 0,
      decisions,
      rescheduleArriveHM: toHM(found.start - 10),
      rescheduleStartHM: toHM(found.start),
      rescheduleGuides: found.guides.map((g) => ({ id: g.id, name: g.name })),
      summary: `建议 ${toHM(found.start - 10)} 重新到馆集结、${toHM(found.start)} 开讲，由${found.guides
        .map((g) => g.name)
        .join('、')}带团，剩余 ${remaining.length} 厅按完整时长讲解，${toHM(end)} 结束。`,
      reasons: [
        `新时段讲解员语言/主题/排班满足，且与其他团队无带团冲突`,
        `剩余展厅该时段容量充足、无临时闭展`,
        '本次不产生讲解缩水，耳麦借用随改签时段平移',
      ],
    }
  })()

  // ---------- 推荐 ----------
  const options: LatePlanOption[] = [shorten, selfguide, reschedule]
  const guidedRatio = plannedRemainingMin ? shorten.guidedMin / plannedRemainingMin : 1
  let rec: LatePlanOption['type']
  if (shorten.feasible && remainingGuideMin >= 30 && guidedRatio >= 0.45) rec = 'shorten'
  else if (reservation.orgType === 'school' && reschedule.feasible) rec = 'reschedule'
  else rec = 'selfguide'
  for (const o of options) o.recommend = o.type === rec

  return {
    id: `lp_${reservation.id}_${input.lateMin}`,
    createdAt: `2026-10-01T${input.nowHM}:00`,
    lateMin: input.lateMin,
    basis,
    options,
  }
}

export interface ReassignMatch {
  guide: Guide
  reservation: Reservation
  startHM: string
  endHM: string
  reasons: string[]
}

/**
 * 讲解员被释放后，可接应的「后续等待团队」：
 * 已确认/已到馆但讲解员未配齐，且该讲解员语言/主题/时段满足者。
 */
export function releasableGuideTargets(
  releasedGuide: Guide,
  reservations: Reservation[],
  fromHM: string,
  excludeReservationId?: string,
): ReassignMatch[] {
  const out: ReassignMatch[] = []
  for (const r of reservations) {
    if (r.id === excludeReservationId) continue
    if (!OCCUPYING_STATUSES.includes(r.status as (typeof OCCUPYING_STATUSES)[number])) continue
    if (r.status === 'touring') continue
    if (r.assignedGuideIds.includes(releasedGuide.id)) continue
    const need = Math.ceil((r.verifiedSize ?? r.groupSize) / 25)
    if (r.assignedGuideIds.length >= need) continue
    const active = r.route.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance')
    if (!active.length) continue
    const start = active[0].plannedEnter
    const end = active[active.length - 1].plannedLeave
    if (toMin(start) < toMin(fromHM) - 15) continue
    // 预测讲解员已从本团释放：计算其忙闲窗口时移除该团占用
    const forCheck = excludeReservationId
      ? reservations.map((x) =>
          x.id === excludeReservationId
            ? { ...x, assignedGuideIds: x.assignedGuideIds.filter((g) => g !== releasedGuide.id) }
            : x,
        )
      : reservations
    const [cand] = availableGuides([releasedGuide], forCheck, {
      language: r.language,
      themeId: r.themeId,
      startHM: start,
      endHM: end,
    })
    if (!cand?.ok) continue
    out.push({
      guide: releasedGuide,
      reservation: r,
      startHM: start,
      endHM: end,
      reasons: [
        `${r.orgName}（${r.verifiedSize ?? r.groupSize} 人）讲解员未配齐，计划 ${start} 开讲`,
        '语言/主题/排班均满足，可在交接后接续带团',
      ],
    })
  }
  return out.sort((a, b) => toMin(a.startHM) - toMin(b.startHM))
}
