import { defineStore } from 'pinia'
import { DAMAGE_FEE, LOST_FEE, TODAY } from '@/data/museum'
import { seedReservations } from '@/data/seed'
import {
  buildLatePlan,
  buildRoute,
  occupancyGrid,
  plannedDuration,
  releasableGuideTargets,
} from '@/lib/schedule'
import { addHM, hmOfISO, toHM, toMin, uid } from '@/lib/time'
import { useMuseumStore } from './museum'
import type {
  AgeBand,
  EventKind,
  GroupType,
  Guide,
  HallClosure,
  Language,
  LatePlan,
  LatePlanOption,
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
        visitMode: 'guided',
        latePlans: [],
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
      const codes = picked.length ? `${picked[0].code} ~ ${picked[picked.length - 1].code}` : ''
      this.log(r, 'device_handout', `发放耳麦 ${picked.length} 台（${codes}）`, at, by, {
        amount: r.depositTotal,
        detail: `押金 ¥${r.depositTotal.toLocaleString()} 已收取${picked.length < count ? '，库存不足部分未发' : ''}`,
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
      this.log(r, 'start_tour', `${museum.themeById(r.themeId)?.name ?? ''}开始讲解`, museum.nowISO, museum.guideById(r.assignedGuideIds[0])?.name ?? by)
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

    // ---------- 团体迟到后的路线重排 ----------
    /** 依据 剩余讲解时长 / 展厅拥堵 / 下一团到馆 生成缩短/自助/改签三方案 */
    generateLatePlan(id: string, lateMin: number): LatePlan | null {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return null
      const grid = occupancyGrid(this.list, {
        maintenance: museum.maintenance,
        extraLoad: museum.extraLoad,
      })
      const plan = buildLatePlan(r, museum.guides, museum.halls, this.list, grid, {
        maintenance: museum.maintenance,
        extraLoad: museum.extraLoad,
      }, { lateMin, nowHM: museum.nowHM })
      r.latePlans.push(plan)
      const b = plan.basis
      this.log(
        r,
        'late',
        `团体迟到 ${lateMin} 分钟，生成路线重排方案`,
        museum.nowISO,
        '系统',
        {
          detail:
            `原定讲解员最迟 ${b.guideDeadlineHM} 离场（${b.guideDeadlineReason}）；剩余可讲解 ${b.remainingGuideMin} 分钟、` +
            `原计划剩余 ${b.plannedRemainingMin} 分钟，需压缩 ${b.mustCutMin} 分钟` +
            `${b.nextGroupName ? `；下一团「${b.nextGroupName}」${b.nextGroupHM} 到馆` : ''}。`,
        },
      )
      return plan
    },

    /** 联系人确认某一方案后执行，联动路线、耳麦借用时间与讲解员排班 */
    confirmLatePlan(id: string, planId: string, type: LatePlanOption['type'], by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const plan = r.latePlans.find((p) => p.id === planId)
      const option = plan?.options.find((o) => o.type === type && o.feasible)
      if (!plan || !option) return
      plan.confirmed = { type, optionTitle: option.title, by, at: museum.nowISO }
      this.log(r, 'late', `联系人 ${by} 确认：${option.title}`, museum.nowISO, by, { detail: option.summary })
      if (type === 'shorten') this.applyShortenRoute(r, option, by)
      else if (type === 'selfguide') this.applySelfGuide(r, option, by)
      else this.applyReschedule(r, plan, option, by)
    },

    /** 方案一：缩短讲解路线 */
    applyShortenRoute(r: Reservation, option: LatePlanOption, by: string) {
      const museum = useMuseumStore()
      const droppedNames: string[] = []
      for (const d of option.decisions) {
        const stop = r.route.find(
          (s) => s.hallId === d.hallId && ['current', 'planned', 'congested'].includes(s.state),
        )
        if (!stop) continue
        if (d.action === 'drop') {
          stop.state = 'skipped'
          stop.durationMin = 0
          stop.note = `迟到压缩：放弃人工讲解（${d.reasons.join('；')}），团队可快速自行观看`
          droppedNames.push(museum.hallById(d.hallId)?.name ?? d.hallId)
        } else {
          stop.plannedEnter = d.newEnter!
          stop.plannedLeave = d.newLeave!
          stop.durationMin = d.newMin
          if (stop.state === 'congested') stop.state = 'planned'
          stop.note = `迟到压缩为 ${d.newMin} 分钟：${d.reasons.join('；')}`
        }
      }
      this.refreshDuration(r)
      this.adjustHeadsetDue(r, option.endHM)
      this.log(
        r,
        'shorten_route',
        `执行缩短路线：保留人工讲解至 ${option.endHM}，压缩 ${option.cutMin} 分钟`,
        museum.nowISO,
        by,
        {
          detail:
            `${option.summary}${droppedNames.length ? `；放弃讲解的展厅：${droppedNames.join('、')}` : ''} ` +
            '耳麦借用截止时间与讲解员排班已按新结束时间调整。',
        },
      )
    },

    /** 方案二：改为自助参观，释放讲解员并派给后续等待团队 */
    applySelfGuide(r: Reservation, option: LatePlanOption, by: string) {
      const museum = useMuseumStore()
      r.visitMode = 'selfguided'
      for (const d of option.decisions) {
        const stop = r.route.find(
          (s) => s.hallId === d.hallId && ['current', 'planned', 'congested'].includes(s.state),
        )
        if (!stop) continue
        stop.state = 'selfguided'
        stop.actualEnter = undefined
        stop.actualLeave = undefined
        stop.plannedEnter = d.newEnter ?? stop.plannedEnter
        stop.plannedLeave = d.newLeave ?? stop.plannedLeave
        stop.note = `联系人确认改为自助参观：电子导览覆盖，${option.assemblyPoint ?? ''}`
      }
      this.refreshDuration(r)
      this.adjustHeadset(r, option.endHM)
      const released = [...r.assignedGuideIds]
      r.assignedGuideIds = []
      const reassigns: { guideId: string; targetId: string; targetName: string }[] = []
      for (const guideId of released) {
        const guide = museum.guideById(guideId)
        const target = this.releaseGuideToWaiting(r, guideId, by)
        if (guide) {
          this.log(r, 'guide_release', `讲解员 ${guide.name} 随自助参观释放`, museum.nowISO, by, {
            detail: target
              ? `释放时段已派给后续等待团队「${target.orgName}」（计划 ${target.route.find((s) => s.state !== 'skipped' && s.state !== 'maintenance')?.plannedEnter} 开讲）。`
              : '当前无匹配的等待团队，转为机动待命。',
          })
        }
        if (target) reassigns.push({ guideId, targetId: target.id, targetName: target.orgName })
      }
      this.log(r, 'self_guide', `改为自助参观：推送电子导览与集合点`, museum.nowISO, by, {
        detail:
          `已向联系人 ${r.contactName} 推送${option.audioGuide?.name ?? '电子导览'}（${option.audioGuide?.pickup ?? ''}）；` +
          `集合点：${option.assemblyPoint}。耳麦继续借用、归还截止调整为 ${option.endHM}。` +
          (reassigns.length
            ? ` 释放的讲解员已派给：${reassigns.map((x) => `${museum.guideById(x.guideId)?.name}→「${x.targetName}」`).join('；')}。`
            : ' 释放的讲解员当前无匹配等待团，转入机动待命。'),
      })
    },

    /** 方案三：改签新时段：本站等待改期，原讲解员释放、为新时段指派讲解员 */
    applyReschedule(r: Reservation, plan: LatePlan, option: LatePlanOption, by: string) {
      const museum = useMuseumStore()
      const newGuideIds = (option.rescheduleGuides ?? []).map((g) => g.id)
      // 未完成站点平移到新时段
      let cursor = toMin(option.rescheduleStartHM!)
      for (const d of option.decisions) {
        const stop = r.route.find(
          (s) => s.hallId === d.hallId && ['current', 'planned', 'congested'].includes(s.state),
        )
        if (!stop) continue
        const enter = cursor
        const leave = enter + d.originalMin
        stop.state = 'planned'
        stop.actualEnter = undefined
        stop.actualLeave = undefined
        stop.plannedEnter = toHM(enter)
        stop.plannedLeave = toHM(leave)
        stop.durationMin = d.originalMin
        stop.note = `团体迟到 ${plan.lateMin} 分钟，改签至 ${option.rescheduleStartHM} 开讲，本站按完整时长参观`
        cursor = leave + 5
      }
      this.refreshDuration(r)
      this.adjustHeadset(r, option.endHM)
      // 原讲解员（新时段不再由其带的）释放并派给等待团
      const released = r.assignedGuideIds.filter((g) => !newGuideIds.includes(g))
      const reassignNames: string[] = []
      for (const guideId of released) {
        const target = this.releaseGuideToWaiting(r, guideId, by)
        const gname = museum.guideById(guideId)?.name ?? guideId
        this.log(r, 'guide_release', `讲解员 ${gname} 的原带团时段随改签释放`, museum.nowISO, by, {
          detail: target ? `已改派给等待团队「${target.orgName}」。` : '转为机动待命。',
        })
        if (target) reassignNames.push(`${gname}→「${target.orgName}」`)
      }
      r.assignedGuideIds = newGuideIds.length
        ? newGuideIds
        : r.assignedGuideIds.filter((g) => !released.includes(g))
      for (const g of option.rescheduleGuides ?? []) {
        this.log(r, 'guide_assign', `改签新时段讲解员就位：${g.name}`, museum.nowISO, g.name, {
          detail: `${option.rescheduleStartHM} 开讲，语言/主题/排班与容量均已校验。`,
        })
      }
      r.status = 'confirmed'
      this.log(
        r,
        'reschedule',
        `团体改签：${option.rescheduleArriveHM} 重新到馆，${option.rescheduleStartHM} 开讲`,
        museum.nowISO,
        by,
        {
          detail:
            `${option.summary} 耳麦借用随改签平移、归还截止 ${option.endHM}。` +
            (reassignNames.length ? ` 原讲解员释放派工：${reassignNames.join('；')}。` : ''),
        },
      )
    },

    /** 把某讲解员从本团释放并自动派给最匹配的后续等待团队，返回被派给的预约 */
    releaseGuideToWaiting(r: Reservation, guideId: string, by: string): Reservation | null {
      const museum = useMuseumStore()
      const guide: Guide | undefined = museum.guideById(guideId)
      if (!guide) return null
      const match = releasableGuideTargets(guide, this.list, museum.nowHM, r.id).find(
        (m) => m.reservation.id !== r.id,
      )
      if (!match) return null
      if (!match.reservation.assignedGuideIds.includes(guideId)) {
        match.reservation.assignedGuideIds.push(guideId)
      }
      this.log(
        match.reservation,
        'guide_assign',
        `讲解员 ${guide.name} 释放时段接续派工`,
        museum.nowISO,
        by,
        { detail: `${match.reservation.orgName} 讲解员未配齐，${guide.name} 于 ${match.startHM} 接续带团。` },
      )
      return match.reservation
    },

    /** 自助/改签后调整耳麦借用截止时间 */
    adjustHeadset(r: Reservation, dueHM: string) {
      const dueISO = `${TODAY}T${dueHM}:00`
      for (const d of r.devices) {
        if (d.status === 'lent') d.dueBackAt = dueISO
      }
    },
    /** 缩短路线后耳麦归还截止随新结束时间前移 */
    adjustHeadsetDue(r: Reservation, dueHM: string) {
      this.adjustHeadset(r, dueHM)
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
        if (s.state === 'current' || s.state === 'selfguided') {
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

    /** 兼容旧版本持久化数据：补齐迟到重排相关字段 */
    migrate() {
      for (const r of this.list) {
        if (r.visitMode !== 'guided' && r.visitMode !== 'selfguided') r.visitMode = 'guided'
        if (!Array.isArray(r.latePlans)) r.latePlans = []
      }
    },
  },

  persist: {
    key: 'museum-reservations',
    afterHydrate: (ctx) => (ctx.store as unknown as { migrate: () => void }).migrate(),
  },
})
