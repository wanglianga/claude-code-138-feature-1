import { defineStore } from 'pinia'
import { DAMAGE_FEE, LOST_FEE, TODAY } from '@/data/museum'
import { seedReservations } from '@/data/seed'
import {
  buildRoute,
  plannedDuration,
} from '@/lib/schedule'
import type { LateContext, ReschedulePlan, SelfGuidePlan, ShortenPlan } from '@/lib/latePlan'
import { addHM, hmOfISO, toHM, toMin, uid } from '@/lib/time'
import { useMuseumStore } from './museum'
import type {
  AgeBand,
  EventKind,
  GroupType,
  HallClosure,
  Language,
  LatePlanRecord,
  Reservation,
  ReservationStatus,
  RouteStop,
  TimelineEvent,
} from '@/types'

export interface NewReservationInput {
  orgType: GroupType
  orgName: string
  groupSize: number
  ageBand: AgeBand
  language: Language
  accessible: boolean
  themeId: string
  arriveTime: string // ISO
  contactName: string
  contactPhone: string
  busInfo: string
  needHeadsets: boolean
  headsetCount: number
  note: string
}

export const useReservationsStore = defineStore('reservations', {
  state: () => ({
    list: seedReservations() as Reservation[],
  }),

  getters: {
    byId: (s) => (id: string) => s.list.find((r) => r.id === id),
    byStatus: (s) => (status: ReservationStatus) =>
      [...s.list]
        .filter((r) => r.status === status)
        .sort((a, b) => a.arriveTime.localeCompare(b.arriveTime)),
    /** 当日讲解总时长（分钟），已确认+在馆团 */
    activeList: (s) =>
      s.list.filter((r) => ['confirmed', 'arrived', 'touring'].includes(r.status)),
  },

  actions: {
    // ---------- 基础工具 ----------
    log(r: Reservation, kind: EventKind, title: string, atISO: string, by: string, extra: Partial<TimelineEvent> = {}) {
      const e: TimelineEvent = { id: uid('ev'), at: atISO, kind, title, by, ...extra }
      r.timeline.push(e)
      r.timeline.sort((a, b) => a.at.localeCompare(b.at))
    },
    refreshDuration(r: Reservation) {
      r.durationMin = plannedDuration(r.route)
    },

    // ---------- 预约方 ----------
    create(input: NewReservationInput): Reservation {
      const museum = useMuseumStore()
      const theme = museum.themeById(input.themeId)!
      const enterHM = addHM(hmOfISO(input.arriveTime), 10) // 安检+集结 10 分钟
      const route = buildRoute(theme, museum.halls, enterHM, {
        accessible: input.accessible,
        live: museum.maintenance,
      })
      const seq = String(this.list.length + 1).padStart(2, '0')
      const r: Reservation = {
        id: `R20261001-${seq}`,
        ...input,
        status: 'submitted',
        createdAt: museum.nowISO,
        assignedGuideIds: [],
        route,
        durationMin: plannedDuration(route),
        devices: [],
        depositTotal: 0,
        depositDeduction: 0,
        timeline: [],
      }
      // 避免 id 冲突
      while (this.list.some((x) => x.id === r.id)) {
        r.id = `${r.id}X`
      }
      this.log(r, 'submit', '团体预约已提交', input.arriveTime, input.contactName, {
        detail: `${input.groupSize} 人 · ${theme.name}`,
      })
      this.list.unshift(r)
      return r
    },

    cancel(id: string, by: string) {
      const r = this.byId(id)
      if (!r || ['completed', 'cancelled'].includes(r.status)) return
      r.status = 'cancelled'
      this.log(r, 'cancel', '预约已取消', useMuseumStore().nowISO, by)
    },

    addComplaint(id: string, text: string, by: string) {
      const r = this.byId(id)
      if (!r) return
      r.complaint = text
      this.log(r, 'complaint', '投诉登记：' + text, useMuseumStore().nowISO, by)
    },
    replyComplaint(id: string, reply: string, by: string) {
      const r = this.byId(id)
      if (!r) return
      r.complaintReply = reply
      this.log(r, 'complaint', '馆方已答复投诉', useMuseumStore().nowISO, by, { detail: reply })
    },

    // ---------- 馆方确认 ----------
    confirm(
      id: string,
      payload: { guideIds: string[]; laneId: string; batchNo: string; note: string },
      by: string,
    ) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'submitted') return
      r.status = 'confirmed'
      r.confirmedAt = museum.nowISO
      r.assignedGuideIds = payload.guideIds
      r.securityLane = payload.laneId
      r.batchNo = payload.batchNo
      r.confirmNote = payload.note
      const names = payload.guideIds.map((g) => museum.guideById(g)?.name).join('、')
      this.log(r, 'confirm', `预约确认：${names} / ${payload.batchNo} 批次`, museum.nowISO, by, {
        detail: payload.note,
      })
    },

    reject(id: string, reason: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'submitted') return
      r.status = 'rejected'
      this.log(r, 'reject', '预约驳回：' + reason, museum.nowISO, by)
    },

    // ---------- 前台到馆 ----------
    markArrived(id: string, atISO?: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'confirmed') return
      r.status = 'arrived'
      r.actualArrive = atISO ?? museum.nowISO
      const plan = hmOfISO(r.arriveTime)
      const actual = hmOfISO(r.actualArrive)
      const delta = toMin(actual) - toMin(plan)
      this.log(r, 'arrive', `团队到馆（${delta === 0 ? '准时' : delta > 0 ? `迟到 ${delta} 分钟` : `早到 ${-delta} 分钟`}）`, r.actualArrive, r.contactName)
    },

    verifyHeadcount(id: string, n: number, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      r.verifiedSize = n
      const diff = n - r.groupSize
      this.log(
        r,
        'headcount',
        `前台核验人数：${n} 人${diff === 0 ? '，与预约一致' : diff > 0 ? `，比预约多 ${diff} 人` : `，比预约少 ${-diff} 人`}`,
        museum.nowISO,
        by,
      )
    },

    handoutHeadsets(id: string, count: number, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || !r.needHeadsets) return
      const at = museum.nowISO
      const picked = museum.lendFromPool(count, r.id, at)
      r.devices = picked
      r.depositTotal = picked.length * museum.depositPerUnit
      // 耳麦应还时间 = 路线末站结束后 15 分钟（迟到重排会自动调整）
      const active = r.route.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance')
      if (active.length) r.headsetDueHM = addHM(active[active.length - 1].plannedLeave, 15)
      const codes = picked.length ? `${picked[0].code} ~ ${picked[picked.length - 1].code}` : ''
      this.log(r, 'device_handout', `发放耳麦 ${picked.length} 台（${codes}）`, at, by, {
        amount: r.depositTotal,
        detail: `押金 ¥${r.depositTotal.toLocaleString()} 已收取${picked.length < count ? '，库存不足部分未发' : ''}${r.headsetDueHM ? `；应于 ${r.headsetDueHM} 前归还` : ''}`,
      })
    },

    admit(id: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'arrived') return
      const now = museum.nowHM
      r.status = 'touring'
      const first = r.route.find((s) => s.state === 'planned')
      if (first) {
        first.state = 'current'
        first.actualEnter = now
      }
      this.log(r, 'batch_admit', `${r.batchNo ?? ''} 批次安检入馆`, museum.nowISO, by)
      this.log(
        r,
        'start_tour',
        r.selfGuided ? '自助参观开始（电子导览已推送联系人）' : `${museum.themeById(r.themeId)?.name ?? ''}开始讲解`,
        museum.nowISO,
        r.selfGuided ? by : (museum.guideById(r.assignedGuideIds[0])?.name ?? by),
      )
    },

    // ---------- 途中调度 ----------
    /** 当前站打卡完成，进入下一站 */
    advanceStop(id: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const idx = r.route.findIndex((s) => s.state === 'current')
      if (idx < 0) return
      const cur = r.route[idx]
      cur.state = 'done'
      cur.actualLeave = museum.nowHM
      const next = r.route.slice(idx + 1).find((s) => s.state === 'planned')
      if (next) {
        next.state = 'current'
        next.actualEnter = addHM(museum.nowHM, 5)
      }
      this.log(r, 'wait', `完成「${museum.hallById(cur.hallId)?.name}」参观，转入下一展厅`, museum.nowISO, by)
    },

    /** 团体迟到 / 儿童走散暂停：整体顺延后续计划 */
    delay(id: string, minutes: number, kind: EventKind, title: string, detail: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      for (const s of r.route) {
        if (s.actualEnter || s.state === 'skipped' || s.state === 'maintenance') continue
        s.plannedEnter = addHM(s.plannedEnter, minutes)
        s.plannedLeave = addHM(s.plannedLeave, minutes)
      }
      this.refreshDuration(r)
      this.log(r, kind, title, museum.nowISO, by, { detail: `后续展厅整体顺延 ${minutes} 分钟。${detail}` })
    },

    childLost(id: string, childName: string, pauseMin: number, resolved: boolean, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      this.log(r, 'child_lost', `${resolved ? '儿童走散已找回' : '报告儿童走散'}：${childName}`, museum.nowISO, by, {
        detail: resolved ? `暂停参观 ${pauseMin} 分钟后继续，已通知广播与安保。` : '已通知广播与安保，暂停前进。',
      })
      if (resolved && pauseMin > 0) {
        this.delay(id, pauseMin, 'wait', `等待走散儿童归队（${pauseMin} 分钟）`, '', by)
      }
    },

    /** 展厅拥堵登记（只记录，改道在 applyReroute 中执行） */
    markCongestion(id: string, hallId: string, note: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const stop = r.route.find((s) => s.hallId === hallId && ['current', 'planned'].includes(s.state))
      if (stop) {
        stop.state = 'congested'
        stop.note = note
      }
      this.log(r, 'hall_congestion', `「${museum.hallById(hallId)?.name}」拥堵，启动分流`, museum.nowISO, by, {
        detail: note,
      })
    },

    /** 展厅临时维护：写入全局状态，并把所有在馆/待入场团受影响的站点标记维护 */
    declareMaintenance(hallId: string, closure: HallClosure, by: string) {
      const museum = useMuseumStore()
      museum.setMaintenance(hallId, closure)
      for (const r of this.list) {
        if (!['confirmed', 'arrived', 'touring'].includes(r.status)) continue
        for (const s of r.route) {
          if (s.hallId !== hallId || s.state === 'done' || s.state === 'skipped') continue
          const win = s.actualEnter ?? s.plannedEnter
          if (win < closure.end && s.plannedLeave > closure.start) {
            s.state = 'maintenance'
            s.note = `${closure.reason}（${closure.start}-${closure.end}），临时维护改道`
            this.log(r, 'maintenance', `「${museum.hallById(hallId)?.name}」临时维护（${closure.start}-${closure.end}）`, museum.nowISO, by, {
              detail: closure.reason,
            })
          }
        }
      }
    },

    /**
     * 改道：在被阻站点位置插入替代展厅，并顺延后续
     */
    applyReroute(
      id: string,
      payload: { blockedHallId: string; targetHallId: string; atHM: string; durationMin: number; reason: string },
      by: string,
    ) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const idx = r.route.findIndex(
        (s) => s.hallId === payload.blockedHallId && s.state !== 'done' && s.state !== 'skipped',
      )
      const blocked = idx >= 0 ? r.route[idx] : undefined
      if (blocked) {
        if (blocked.state === 'current') blocked.actualLeave = payload.atHM
        blocked.state = blocked.state === 'maintenance' ? 'maintenance' : 'congested'
        blocked.note = `${blocked.note ?? ''} 改道原因：${payload.reason}`.trim()
      }
      const target = museum.hallById(payload.targetHallId)!
      const fresh: RouteStop = {
        hallId: payload.targetHallId,
        plannedEnter: payload.atHM,
        plannedLeave: addHM(payload.atHM, payload.durationMin),
        durationMin: payload.durationMin,
        state: 'current',
        actualEnter: payload.atHM,
        note: `由${museum.hallById(payload.blockedHallId)?.name ?? ''}改道至此：${payload.reason}`,
      }
      const insertAt = idx >= 0 ? idx : r.route.length
      r.route.splice(insertAt, 0, fresh)
      // 后续计划站顺延
      let cursor = fresh.plannedLeave
      for (let i = insertAt + 1; i < r.route.length; i++) {
        const s = r.route[i]
        if (s.actualEnter || s.state === 'skipped' || s.state === 'maintenance') continue
        s.state = 'planned'
        s.plannedEnter = addHM(cursor, 5)
        s.plannedLeave = addHM(s.plannedEnter, s.durationMin)
        cursor = s.plannedLeave
      }
      this.refreshDuration(r)
      this.log(
        r,
        'reroute',
        `路线调整：${museum.hallById(payload.blockedHallId)?.name ?? '原站'} → ${target.name}`,
        museum.nowISO,
        by,
        { detail: `${payload.reason}；后续团队入场时间已联动顺延。` },
      )
    },

    /** 讲解员临时替换 */
    swapGuide(id: string, oldGuideId: string, newGuideId: string, reason: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const pos = r.assignedGuideIds.indexOf(oldGuideId)
      if (pos >= 0) r.assignedGuideIds.splice(pos, 1, newGuideId)
      else r.assignedGuideIds.push(newGuideId)
      const oldN = museum.guideById(oldGuideId)?.name ?? oldGuideId
      const newN = museum.guideById(newGuideId)?.name ?? newGuideId
      this.log(r, 'guide_swap', `讲解员变更：${oldN} → ${newN}`, museum.nowISO, newN, {
        detail: reason,
      })
    },

    /** 途中耳麦损坏：旧机登记损坏、补发新机 */
    exchangeHeadset(id: string, oldCode: string, note: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const newCode = museum.exchangeFromPool(oldCode, r.id, museum.nowISO, note)
      const oldDev = r.devices.find((d) => d.code === oldCode)
      if (oldDev) {
        oldDev.status = 'damaged'
        oldDev.damageFee = DAMAGE_FEE
        oldDev.note = note
      }
      if (newCode) {
        r.devices.push({
          code: newCode,
          status: 'lent',
          deposit: museum.depositPerUnit,
          resId: r.id,
          lentAt: museum.nowISO,
        })
      }
      this.log(r, 'device_exchange', `耳麦 ${oldCode} 损坏${newCode ? `，补发 ${newCode}` : '（库存不足，未补发）'}`, museum.nowISO, by, {
        detail: `${note}；赔偿待离馆押金结算。`,
      })
    },

    // ---------- 迟到路线重排 ----------
    /** 组装迟到重排留痕（投诉「内容减少」时的压缩依据） */
    buildLateRecord(
      r: Reservation,
      kind: LatePlanRecord['kind'],
      ctx: LateContext,
      congestion: string,
      afterEndHM: string,
      dropped: { hallId: string; reason: string }[],
      reasons: string[],
      by: string,
    ): LatePlanRecord {
      const museum = useMuseumStore()
      const active = r.route.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance')
      return {
        kind,
        lateMin: ctx.lateMin,
        decidedAt: museum.nowISO,
        decidedBy: by,
        confirmedBy: r.contactName,
        remainMin: ctx.remainMin,
        guideConstraint: ctx.guideConstraint,
        nextArrivalNote: ctx.nextArrivals.length
          ? ctx.nextArrivals.map((n) => `「${n.orgName}」${n.arriveHM} 到馆`).join('、')
          : '当日后续无其他团队到馆',
        congestionNote: congestion,
        reasons,
        droppedHalls: dropped,
        beforeEndHM: active.length ? active[active.length - 1].plannedLeave : '—',
        afterEndHM,
      }
    },

    /** 方案一：缩短路线 —— 压缩停留/舍弃低分展厅，讲解员排班与耳麦应还时间自动调整 */
    applyLateShorten(id: string, plan: ShortenPlan, ctx: LateContext, congestion: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.lateReplan) return
      r.lateReplan = this.buildLateRecord(r, 'shorten', ctx, congestion, plan.endHM, plan.dropped, plan.reasons, by)
      // 保留站：写入压缩后的时间；舍弃站：标记跳过
      for (const ns of plan.stops) {
        const s = r.route.find((x) => x.hallId === ns.hallId && x.state === 'planned' && !x.actualEnter)
        if (s) Object.assign(s, ns)
      }
      for (const d of plan.dropped) {
        const s = r.route.find((x) => x.hallId === d.hallId && x.state === 'planned' && !x.actualEnter)
        if (s) {
          s.state = 'skipped'
          s.note = `迟到压缩舍弃：${d.reason}`
        }
      }
      this.refreshDuration(r)
      r.headsetDueHM = addHM(plan.endHM, 15)
      this.log(
        r,
        'late_replan',
        `迟到 ${ctx.lateMin} 分钟路线重排：缩短为 ${plan.stops.length} 站，${plan.endHM} 结束`,
        museum.nowISO,
        by,
        {
          detail: `${plan.reasons.join('；')}。联系人 ${r.contactName} 已电话确认。耳麦应还时间自动调整为 ${r.headsetDueHM}。`,
        },
      )
      const names = r.assignedGuideIds.map((g) => museum.guideById(g)?.name).join('、')
      this.log(
        r,
        'guide_assign',
        `讲解员排班自动调整：${names} 带团窗口缩短为 ${ctx.enterHM}-${plan.endHM}`,
        museum.nowISO,
        '系统',
        { detail: `${ctx.guideConstraint}；压缩后时段已同步至排班热力图。` },
      )
    },

    /** 方案二：自助参观 —— 推送电子导览与集合点，释放讲解员时段给后续等待团队 */
    applyLateSelf(id: string, plan: SelfGuidePlan, ctx: LateContext, congestion: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.lateReplan) return
      r.lateReplan = this.buildLateRecord(r, 'self', ctx, congestion, plan.meetingHM, [], plan.reasons, by)
      for (const ns of plan.stops) {
        const s = r.route.find((x) => x.hallId === ns.hallId && x.state === 'planned' && !x.actualEnter)
        if (s) Object.assign(s, ns)
      }
      this.refreshDuration(r)
      const releasedNames = r.assignedGuideIds
        .map((g) => museum.guideById(g)?.name ?? g)
      r.selfGuided = true
      r.selfGuideInfo = {
        meetingPoint: plan.meetingPoint,
        meetingHM: plan.meetingHM,
        releasedGuideNames: releasedNames,
        releasedWindow: plan.releasedWindow,
        points: plan.points,
        assignableNotes: plan.assignable.map((a) => a.note),
        pushedAt: museum.nowISO,
      }
      r.assignedGuideIds = []
      r.headsetDueHM = addHM(plan.meetingHM, 15)
      this.log(
        r,
        'late_replan',
        `迟到 ${ctx.lateMin} 分钟路线重排：改为自助参观，${plan.meetingHM} 集合`,
        museum.nowISO,
        by,
        { detail: `${plan.reasons.join('；')}。联系人 ${r.contactName} 已电话确认。耳麦应还时间自动调整为 ${r.headsetDueHM}。` },
      )
      this.log(
        r,
        'self_guide',
        `已向联系人推送电子导览（${plan.points.length} 个展厅要点）与集合点`,
        museum.nowISO,
        '系统',
        { detail: `集合时间 ${plan.meetingHM}，集合点：${plan.meetingPoint}。` },
      )
      this.log(
        r,
        'guide_release',
        `讲解员释放：${releasedNames.join('、')} 空出 ${plan.releasedWindow} 时段`,
        museum.nowISO,
        '系统',
        {
          detail: plan.assignable.length
            ? `可分配给后续等待团队：${plan.assignable.map((a) => a.note).join('；')}`
            : '当前时段无可接续的等待团队。',
        },
      )
    },

    /** 方案三：改签时段 —— 路线整体改到当日稍后，讲解员与耳麦应还时间自动调整 */
    applyLateReschedule(id: string, plan: ReschedulePlan, ctx: LateContext, congestion: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.lateReplan) return
      r.lateReplan = this.buildLateRecord(r, 'reschedule', ctx, congestion, plan.endHM, [], plan.reasons, by)
      // 路线整体改签到新时段
      let cursor = toMin(plan.slotHM)
      for (const s of r.route) {
        if (s.state !== 'planned' || s.actualEnter) continue
        s.plannedEnter = toHM(cursor)
        s.plannedLeave = addHM(s.plannedEnter, s.durationMin)
        s.note = `改签至 ${plan.slotHM} 时段`
        cursor = toMin(s.plannedLeave) + 5
      }
      const oldArrive = hmOfISO(r.arriveTime)
      r.arriveTime = `${TODAY}T${addHM(plan.slotHM, -10)}:00`
      r.assignedGuideIds = [plan.guideId]
      this.refreshDuration(r)
      r.headsetDueHM = addHM(plan.endHM, 15)
      this.log(
        r,
        'late_replan',
        `迟到 ${ctx.lateMin} 分钟路线重排：改签至 ${plan.slotHM} 时段`,
        museum.nowISO,
        by,
        { detail: `${plan.reasons.join('；')}。联系人 ${r.contactName} 已电话确认。耳麦应还时间自动调整为 ${r.headsetDueHM}。` },
      )
      this.log(
        r,
        'reschedule',
        `预约时段 ${oldArrive} → ${hmOfISO(r.arriveTime)}，讲解员 ${plan.guideName}${plan.sameGuide ? '（原讲解员顺延）' : '（改派）'}`,
        museum.nowISO,
        '系统',
        { detail: '安检批次与容量栅格已按新时段重算，团队可先离馆休息再返回。' },
      )
    },

    // ---------- 离馆 ----------
    returnDevices(
      id: string,
      results: { code: string; result: 'ok' | 'damaged' | 'lost'; note?: string }[],
      by: string,
    ) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      let okN = 0
      let dmgN = 0
      let lostN = 0
      for (const item of results) {
        const dev = r.devices.find((d) => d.code === item.code)
        if (!dev) continue
        if (item.result === 'ok') {
          dev.status = 'returned'
          dev.returnedAt = museum.nowISO
          museum.syncPoolDevice(item.code, 'returned', { returnedAt: museum.nowISO })
          okN++
        } else if (item.result === 'damaged') {
          dev.status = 'damaged'
          dev.damageFee = DAMAGE_FEE
          dev.note = item.note ?? '设备损坏'
          dev.returnedAt = museum.nowISO
          museum.syncPoolDevice(item.code, 'damaged', {
            returnedAt: museum.nowISO,
            damageFee: DAMAGE_FEE,
            note: item.note,
          })
          dmgN++
        } else {
          dev.status = 'lost'
          dev.damageFee = LOST_FEE
          dev.note = item.note ?? '设备遗失'
          museum.syncPoolDevice(item.code, 'lost', { damageFee: LOST_FEE, note: item.note })
          lostN++
        }
      }
      // 扣款统计包含途中换机已登记损坏/遗失的设备
      r.depositDeduction = r.devices.reduce(
        (sum, d) => sum + (d.status === 'damaged' ? DAMAGE_FEE : d.status === 'lost' ? LOST_FEE : 0),
        0,
      )
      this.log(r, 'device_return', `归还耳麦：完好 ${okN}，损坏 ${dmgN}，遗失 ${lostN}`, museum.nowISO, by)
    },

    settleDeposit(id: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      this.log(
        r,
        'deposit_settle',
        `押金结算：¥${r.depositTotal.toLocaleString()} 中扣除 ¥${r.depositDeduction}，退还 ¥${(r.depositTotal - r.depositDeduction).toLocaleString()}`,
        museum.nowISO,
        by,
        { amount: r.depositDeduction },
      )
    },

    complete(id: string, satisfaction: number, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'touring') return
      r.status = 'completed'
      r.departAt = museum.nowISO
      r.satisfaction = satisfaction
      // 未关闭的站点统一收尾
      for (const s of r.route) {
        if (s.state === 'current') {
          s.state = 'done'
          s.actualLeave = museum.nowHM
        } else if (s.state === 'planned') {
          s.state = 'skipped'
          s.note = (s.note ?? '') + ' 离馆时未参观'.trim()
        }
      }
      this.log(r, 'complete', `团队离馆，满意度 ${satisfaction}/5`, museum.nowISO, by)
    },

    resetAll() {
      const museum = useMuseumStore()
      museum.resetAll()
      this.list = seedReservations()
    },
  },

  persist: { key: 'museum-reservations' },
})
