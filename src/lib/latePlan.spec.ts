import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  analyzeLate,
  buildReschedulePlan,
  buildSelfGuidePlan,
  buildShortenPlan,
  congestionNoteFor,
} from './latePlan'
import { occupancyGrid, guideBusyWindows } from './schedule'
import { GUIDES, HALLS } from '@/data/museum'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'

const NOW = '10:25' // 演示时钟：育英中学预约 09:45，此时登记到馆即迟到 40 分钟

function setupArrived() {
  const museum = useMuseumStore()
  const store = useReservationsStore()
  museum.setNow(NOW)
  store.markArrived('R20261001-06')
  const r = store.byId('R20261001-06')!
  const ctx = analyzeLate(r, store.list, museum.guides, museum.nowHM)
  const grid = occupancyGrid(
    store.list.filter((x) => x.id !== r.id),
    { maintenance: museum.maintenance, extraLoad: museum.extraLoad },
  )
  const live = { maintenance: museum.maintenance, extraLoad: museum.extraLoad }
  return { museum, store, r, ctx, grid, live }
}

describe('analyzeLate 迟到上下文', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('迟到 40 分钟：剩余讲解时长受讲解员下一任务（远瞻科技）约束', () => {
    const { ctx } = setupArrived()
    expect(ctx.lateMin).toBe(40)
    expect(ctx.enterHM).toBe('10:35')
    // 何田田 11:10 接远瞻科技，含 10 分钟交接缓冲 → 11:00 前必须结束
    expect(ctx.mustLeaveByHM).toBe('11:00')
    expect(ctx.remainMin).toBe(25)
    expect(ctx.guideConstraint).toContain('何田田')
    expect(ctx.guideConstraint).toContain('远瞻科技')
  })

  it('下一团到馆：星辉 10:30、远瞻 11:00', () => {
    const { ctx } = setupArrived()
    expect(ctx.nextArrivals.map((n) => n.orgName)).toEqual(['星辉国际旅行社', '远瞻科技'])
  })

  it('当前拥堵描述包含二号厅散客占用与本团超载提示', () => {
    const { r, grid } = setupArrived()
    const note = congestionNoteFor(HALLS, grid, NOW, r.groupSize)
    expect(note).toContain('近现代名家')
    expect(note).toContain('超容量')
  })
})

describe('buildShortenPlan 缩短路线', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('25 分钟窗口内保留 2 站，舍弃超载的二号厅', () => {
    const { r, ctx, grid, live } = setupArrived()
    const plan = buildShortenPlan(r, ctx, HALLS, grid, live)
    expect(plan.stops.map((s) => s.hallId)).toEqual(['h4', 'h6'])
    expect(plan.stops[0].plannedEnter).toBe('10:35')
    expect(plan.endHM).toBe('11:00')
    // 末站结束不晚于讲解员必须离开时间
    expect(plan.endHM <= ctx.mustLeaveByHM).toBe(true)
    expect(plan.dropped).toHaveLength(1)
    expect(plan.dropped[0].hallId).toBe('h2')
    expect(plan.dropped[0].reason).toContain('133%')
    expect(plan.dropped[0].reason).toContain('为避免超载舍弃')
    expect(plan.reasons.join()).toContain('迟到 40 分钟')
  })

  it('剩余时长不足一站时返回空方案', () => {
    const { r, grid, live } = setupArrived()
    const ctx = { ...analyzeLate(r, useReservationsStore().list, GUIDES, NOW), remainMin: 5 }
    const plan = buildShortenPlan(r, ctx, HALLS, grid, live)
    expect(plan.stops).toHaveLength(0)
    expect(plan.dropped.length).toBeGreaterThan(0)
  })
})

describe('buildSelfGuidePlan 自助参观', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('不压缩内容，推送电子导览与集合点', () => {
    const { r, ctx, store } = setupArrived()
    const plan = buildSelfGuidePlan(r, ctx, HALLS, store.list, GUIDES)
    expect(plan.stops).toHaveLength(3)
    expect(plan.stops[0].plannedEnter).toBe('10:35')
    expect(plan.meetingHM).toBe('11:40')
    expect(plan.meetingPoint).toContain('中庭')
    expect(plan.points).toHaveLength(3)
    expect(plan.points[0].highlights.join()).toContain('禁止拍照')
  })

  it('释放的讲解员时段可分配给后续等待团队（云川中学）', () => {
    const { r, ctx, store } = setupArrived()
    const plan = buildSelfGuidePlan(r, ctx, HALLS, store.list, GUIDES)
    expect(plan.releasedWindow).toBe('10:35-11:00')
    expect(plan.releasedGuideIds).toEqual(['g5'])
    expect(plan.assignable.map((a) => a.orgName)).toEqual(['云川中学'])
  })
})

describe('buildReschedulePlan 改签时段', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('优先原讲解员：改签至 13:00 何田田班次恢复后', () => {
    const { r, ctx, store, live } = setupArrived()
    const plan = buildReschedulePlan(r, ctx, HALLS, store.list, GUIDES, live, NOW)!
    expect(plan).toBeTruthy()
    expect(plan.sameGuide).toBe(true)
    expect(plan.guideId).toBe('g5')
    expect(plan.slotHM).toBe('13:00')
    expect(plan.endHM).toBe('14:05')
  })

  it('改签时段避开七号厅维护类闭展约束（本路线不含七厅，时段可行）', () => {
    const { r, ctx, store, live } = setupArrived()
    const plan = buildReschedulePlan(r, ctx, HALLS, store.list, GUIDES, live, NOW)!
    // 13:00 改签槽各厅容量与闭展校验已通过（否则不会返回该槽）
    expect(['13:00']).toContain(plan.slotHM)
  })
})

describe('迟到重排 store 集成', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('缩短路线：路线压缩、耳麦应还与讲解员排班自动调整并留痕', () => {
    const { store, r, ctx, grid, live } = setupArrived()
    const congestion = congestionNoteFor(HALLS, grid, NOW, r.groupSize)
    const plan = buildShortenPlan(r, ctx, HALLS, grid, live)
    store.applyLateShorten(r.id, plan, ctx, congestion, '沈姐')

    const after = store.byId(r.id)!
    expect(after.lateReplan?.kind).toBe('shorten')
    expect(after.lateReplan?.lateMin).toBe(40)
    expect(after.lateReplan?.confirmedBy).toBe('周老师')
    expect(after.lateReplan?.droppedHalls[0].hallId).toBe('h2')
    // 路线：h2 跳过，h4/h6 压缩
    expect(after.route.find((s) => s.hallId === 'h2')?.state).toBe('skipped')
    expect(after.route.find((s) => s.hallId === 'h4')?.plannedEnter).toBe('10:35')
    expect(after.route.find((s) => s.hallId === 'h6')?.plannedLeave).toBe('11:00')
    // 耳麦应还时间自动调整
    expect(after.headsetDueHM).toBe('11:15')
    // 讲解员排班调整留痕
    const kinds = after.timeline.map((e) => e.kind)
    expect(kinds).toContain('late_replan')
    expect(kinds).toContain('guide_assign')
    expect(after.timeline.find((e) => e.kind === 'guide_assign')?.title).toContain('排班自动调整')
  })

  it('自助参观：推送电子导览、释放讲解员、耳麦应还调整', () => {
    const { store, r, ctx, grid } = setupArrived()
    const congestion = congestionNoteFor(HALLS, grid, NOW, r.groupSize)
    const plan = buildSelfGuidePlan(r, ctx, HALLS, store.list, GUIDES)
    store.applyLateSelf(r.id, plan, ctx, congestion, '沈姐')

    const after = store.byId(r.id)!
    expect(after.selfGuided).toBe(true)
    expect(after.assignedGuideIds).toEqual([])
    expect(after.selfGuideInfo?.meetingHM).toBe('11:40')
    expect(after.selfGuideInfo?.meetingPoint).toContain('中庭')
    expect(after.selfGuideInfo?.releasedGuideNames).toEqual(['何田田'])
    expect(after.selfGuideInfo?.assignableNotes.join()).toContain('云川中学')
    expect(after.headsetDueHM).toBe('11:55')
    const kinds = after.timeline.map((e) => e.kind)
    expect(kinds).toContain('self_guide')
    expect(kinds).toContain('guide_release')
    // 释放后何田田的带团窗口不再包含本团
    const wins = guideBusyWindows(store.list, 'g5')
    expect(wins.every((w) => w.reservation.id !== r.id)).toBe(true)
  })

  it('改签时段：路线整体改到 13:00，预约到馆时间与讲解员联动', () => {
    const { store, r, ctx, grid, live } = setupArrived()
    const congestion = congestionNoteFor(HALLS, grid, NOW, r.groupSize)
    const plan = buildReschedulePlan(r, ctx, HALLS, store.list, GUIDES, live, NOW)!
    store.applyLateReschedule(r.id, plan, ctx, congestion, '沈姐')

    const after = store.byId(r.id)!
    expect(after.lateReplan?.kind).toBe('reschedule')
    expect(after.route[0].plannedEnter).toBe('13:00')
    expect(after.route[2].plannedLeave).toBe('14:05')
    expect(after.arriveTime).toBe('2026-10-01T12:50:00')
    expect(after.assignedGuideIds).toEqual(['g5'])
    expect(after.headsetDueHM).toBe('14:20')
    expect(after.timeline.map((e) => e.kind)).toContain('reschedule')
  })

  it('同一预约只能应用一次迟到重排', () => {
    const { store, r, ctx, grid, live } = setupArrived()
    const congestion = congestionNoteFor(HALLS, grid, NOW, r.groupSize)
    const plan = buildShortenPlan(r, ctx, HALLS, grid, live)
    store.applyLateShorten(r.id, plan, ctx, congestion, '沈姐')
    const before = store.byId(r.id)!.timeline.length
    store.applyLateShorten(r.id, plan, ctx, congestion, '沈姐')
    expect(store.byId(r.id)!.timeline.length).toBe(before)
  })
})
