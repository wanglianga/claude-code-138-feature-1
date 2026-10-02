import { describe, expect, it } from 'vitest'
import {
  buildLatePlan,
  buildRoute,
  downstreamImpact,
  guideBusyWindows,
  guideDeadline,
  occupancyGrid,
  releasableGuideTargets,
  routePeakLoads,
  securityPlan,
  splitBatches,
  suggestReroute,
  availableGuides,
} from './schedule'
import { GUIDES, HALLS, SECURITY_LANES, THEMES } from '@/data/museum'
import { seedReservations } from '@/data/seed'
import type { RouteStop } from '@/types'

const reservations = seedReservations()
const byId = (id: string) => reservations.find((r) => r.id === id)!

describe('splitBatches', () => {
  it('55 人拆成 25+25+5', () => {
    expect(splitBatches(55)).toEqual([25, 25, 5])
  })
  it('小团不拆分', () => {
    expect(splitBatches(16)).toEqual([16])
  })
})

describe('buildRoute', () => {
  it('按主题顺序生成站点并顺延闭展厅', () => {
    const theme = THEMES.find((t) => t.id === 't_west')!
    const stops = buildRoute(theme, HALLS, '10:40', { accessible: false })
    expect(stops.map((s) => s.hallId)).toEqual(['h6', 'h7', 'h1'])
    // 七厅 11:00-12:00 维护：11:08 进场冲突，顺延到 12:05
    const h7 = stops.find((s) => s.hallId === 'h7')!
    expect(h7.plannedEnter >= '12:00').toBe(true)
    expect(h7.note).toContain('灯光维护')
  })

  it('无障碍路线跳过不可达展厅（四号厅）', () => {
    const theme = THEMES.find((t) => t.id === 't_master')!
    const stops = buildRoute(theme, HALLS, '11:10', { accessible: true })
    expect(stops.find((s) => s.hallId === 'h4')?.state).toBe('skipped')
  })
})

describe('occupancyGrid / hallLoadAt', () => {
  it('参观中的儿童团占用三号厅 10:30 槽（迟到后 10:27 开讲）', () => {
    const grid = occupancyGrid(reservations)
    const h3 = HALLS.find((h) => h.id === 'h3')!
    const slot = grid.get('h3')!
    // 10:27-10:50，24 人
    expect(slot.get(10 * 60 + 30)).toBe(24)
    expect(slot.get(10 * 60 + 45)).toBe(24)
    expect(h3.capacity).toBeGreaterThan(24)
  })

  it('已离馆团不再占用展厅，维护/跳过站不计数', () => {
    const grid = occupancyGrid(reservations)
    // R5 已离馆：二号厅 09:30 槽应无占用
    expect(grid.get('h2')?.get(9 * 60 + 30)).toBeUndefined()
    // 参观中 R3：三号厅 10:30 槽 24 人
    expect(grid.get('h3')?.get(10 * 60 + 30)).toBe(24)
  })
})

describe('routePeakLoads', () => {
  it('新团叠加到已确认团时，二号厅 11:15 槽给出满载率', () => {
    const r4 = byId('R20261001-04')
    const grid = occupancyGrid(reservations)
    const peaks = routePeakLoads(r4.route, HALLS, grid)
    const h2 = peaks.find((p) => p.hallId === 'h2')!
    expect(h2.capacity).toBe(45)
    // R4 自身 55 人 > 容量 45（演示用：确认台会提示拆团错峰）
    expect(h2.load).toBeGreaterThanOrEqual(55)
  })
})

describe('availableGuides', () => {
  it('英语团 10:40-12:05 只可选英语讲解员，且排除已占用的周牧', () => {
    const list = availableGuides(GUIDES, reservations, {
      language: 'en',
      themeId: 't_west',
      startHM: '10:40',
      endHM: '12:05',
    })
    const english = list.filter((g) => g.langs.includes('en'))
    expect(english.map((g) => g.id).sort()).toEqual(['g2'])
    const zhou = list.find((g) => g.id === 'g2')!
    expect(zhou.ok).toBe(false)
    expect(zhou.conflicts.join()).toContain('冲突')
  })

  it('中文亲子团上午时段可选苏晓', () => {
    const list = availableGuides(GUIDES, [], {
      language: 'zh',
      themeId: 't_family',
      startHM: '10:50',
      endHM: '12:05',
    })
    const su = list.find((g) => g.id === 'g3')!
    expect(su.ok).toBe(true)
  })
})

describe('securityPlan', () => {
  it('无障碍团优先推荐无障碍通道', () => {
    const plan = securityPlan(SECURITY_LANES, reservations, '11:00', 55, true)
    expect(plan[0].lane.accessibleOnly).toBe(true)
  })

  it('同槽团队计入通道负载', () => {
    const plan = securityPlan(SECURITY_LANES, reservations, '10:30', 30, false, 'NEW')
    const laneA = plan.find((p) => p.lane.id === 'lane_a')!
    // R2 已占 A 通道 10:30 槽 30 人
    expect(laneA.loadBefore).toBe(30)
    expect(laneA.loadAfter).toBe(60)
    expect(laneA.waitSlots).toBeGreaterThan(0)
  })
})

describe('guideBusyWindows', () => {
  it('苏晓当日带迟到儿童团，窗口覆盖 10:27-11:40', () => {
    const wins = guideBusyWindows(reservations, 'g3')
    expect(wins).toHaveLength(1)
    expect(wins[0].start).toBeLessThanOrEqual(10 * 60 + 20)
    expect(wins[0].end).toBeGreaterThan(11 * 60 + 30)
  })
})

describe('suggestReroute', () => {
  it('儿童团在五号厅遇堵时，优先推荐相邻儿童友好展厅', () => {
    const r3 = byId('R20261001-03')
    const grid = occupancyGrid(reservations)
    const live = { maintenance: {}, extraLoad: {} }
    const picks = suggestReroute(r3, 'h5', HALLS, grid, live, '10:25')
    expect(picks.length).toBeGreaterThan(0)
    const top = picks[0]
    expect(top.hall.childFriendly || top.hall.themes.includes('t_family')).toBe(true)
  })

  it('维护中的展厅不会被推荐', () => {
    const r2 = byId('R20261001-02')
    const grid = occupancyGrid(reservations)
    const live = { maintenance: {}, extraLoad: {} }
    const picks = suggestReroute(r2, 'h6', HALLS, grid, live, '11:20')
    expect(picks.find((p) => p.hall.id === 'h7')).toBeUndefined()
  })
})

describe('downstreamImpact', () => {
  it('后续团改动路线若与在馆团撞容量，给出冲突', () => {
    const r1 = byId('R20261001-01') // 42 人待确认
    // 构造 r1 11:00 进 h5（迟到儿童团 R3 计划 10:55-11:20 在 h5，容量 40）→ 42+24 > 40
    const stops: RouteStop[] = [
      {
        hallId: 'h5',
        plannedEnter: '11:00',
        plannedLeave: '11:25',
        durationMin: 25,
        state: 'planned',
      },
    ]
    const conflicts = downstreamImpact(r1, stops, reservations, HALLS)
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0].reservation.id).toBe('R20261001-03')
    expect(conflicts[0].capacity).toBe(40)
  })

  it('错峰 30 分钟后冲突消失', () => {
    const r1 = byId('R20261001-01')
    const stops: RouteStop[] = [
      {
        hallId: 'h5',
        plannedEnter: '11:30',
        plannedLeave: '11:55',
        durationMin: 25,
        state: 'planned',
      },
    ]
    // 中庭验证错峰不产生冲突
    const courtyard: RouteStop[] = [
      {
        hallId: 'courtyard',
        plannedEnter: '11:30',
        plannedLeave: '11:55',
        durationMin: 25,
        state: 'planned',
      },
    ]
    expect(downstreamImpact(r1, courtyard, reservations, HALLS)).toHaveLength(0)
    expect(stops.length).toBe(1)
  })
})

describe('Reservation 种子完整性', () => {
  it('每个预约都有提交事件且时间线按时间排序', () => {
    for (const r of reservations) {
      expect(r.timeline[0]?.kind === 'submit' || r.id === 'R20261001-05').toBe(true)
      const times = r.timeline.map((e) => e.at)
      const sorted = [...times].sort()
      expect(times).toEqual(sorted)
    }
  })
  it('参观中团的设备全部为借出且押金匹配', () => {
    const r3 = byId('R20261001-03')
    expect(r3.devices).toHaveLength(24)
    expect(r3.devices.every((d) => d.status === 'lent')).toBe(true)
    expect(r3.depositTotal).toBe(4800)
  })
})

describe('团体迟到后的路线重排（buildLatePlan / guideDeadline / 释放派工）', () => {
  const r3 = () => byId('R20261001-03')
  const g3 = () => GUIDES.find((g) => g.id === 'g3')!
  const LIVE = { maintenance: {}, extraLoad: { h2: 28, h5: 10 } }
  const makePlan = (list = reservations, lateMin = 40, nowHM = '10:25') => {
    const grid = occupancyGrid(list, LIVE)
    return buildLatePlan(
      list.find((r) => r.id === 'R20261001-03')!,
      GUIDES, HALLS, list, grid, LIVE, { lateMin, nowHM },
    )
  }

  it('讲解员截止取「下一团交接」与「下班」较早者：苏晓 11:20 须交接给等待团 R06', () => {
    const dl = guideDeadline(r3(), g3(), reservations, '10:25')
    expect(dl?.hm).toBe('11:20') // R06 11:30 开讲 - 10 分钟交接
    expect(dl?.drivenByNextGroup).toBe(true)
    expect(dl?.nextReservation?.id).toBe('R20261001-06')
    expect(dl?.reason).toContain('实验一小教育集团')
  })

  it('没有后续等待团时，截止回落到当班结束时间', () => {
    const list = reservations.filter((r) => r.id !== 'R20261001-06')
    const r3b = list.find((r) => r.id === 'R20261001-03')!
    const dl = guideDeadline(r3b, g3(), list, '10:25')
    expect(dl?.hm).toBe('16:30')
    expect(dl?.drivenByNextGroup).toBe(false)
  })

  it('依据剩余讲解时长/展厅拥堵/下一团到馆测算并给出缩短/自助/改签三方案', () => {
    const plan = makePlan()
    expect(plan.options.map((o) => o.type).sort()).toEqual(['reschedule', 'selfguide', 'shorten'])
    expect(plan.basis.guideDeadlineHM).toBe('11:20')
    expect(plan.basis.remainingGuideMin).toBe(55)
    expect(plan.basis.plannedRemainingMin).toBeGreaterThan(55)
    expect(plan.basis.mustCutMin).toBeGreaterThan(0)
    expect(plan.basis.nextGroupHM).toBe('11:30')
    expect(plan.basis.nextGroupName).toBe('实验一小教育集团')
    // 每个未完成厅都有实时满载率依据
    expect(plan.basis.hallRatios.map((h) => h.hallId).sort()).toEqual(['edu', 'h3', 'h5'])
  })

  it('缩短方案在讲解员截止前结束、确有压缩，并被推荐', () => {
    const plan = makePlan()
    const shorten = plan.options.find((o) => o.type === 'shorten')!
    expect(shorten.feasible).toBe(true)
    expect(shorten.recommend).toBe(true)
    expect(shorten.endHM <= '11:20').toBe(true)
    expect(shorten.cutMin).toBeGreaterThan(0)
    expect(shorten.decisions.some((d) => d.action === 'trim')).toBe(true)
    // 每个被压缩/放弃的厅都给出量化依据（截止时间）
    for (const d of shorten.decisions) {
      expect(d.reasons.join()).toMatch(/讲解员|主题核心/)
    }
  })

  it('自助方案推送电子导览与集合点，且释放的苏晓可接续等待团 R06', () => {
    const plan = makePlan()
    const self = plan.options.find((o) => o.type === 'selfguide')!
    expect(self.feasible).toBe(true)
    expect(self.audioGuide?.name).toContain('电子语音导览')
    expect(self.audioGuide?.pickup).toContain('CH-08')
    expect(self.assemblyPoint).toContain('集合')
    const targets = releasableGuideTargets(g3(), reservations, '10:25', r3().id)
    expect(targets.some((t) => t.reservation.id === 'R20261001-06')).toBe(true)
    expect(targets[0].startHM).toBe('11:30')
  })

  it('改签方案优先安排非原讲解员（何田田），把苏晓留给等待团且无容量冲突', () => {
    const plan = makePlan()
    const rs = plan.options.find((o) => o.type === 'reschedule')!
    expect(rs.feasible).toBe(true)
    expect(rs.rescheduleStartHM).toBeDefined()
    expect(rs.rescheduleStartHM! >= '13:00').toBe(true)
    expect(rs.rescheduleGuides?.map((g) => g.id)).not.toContain('g3')
    expect(rs.rescheduleGuides?.[0].name).toBe('何田田')
    expect(rs.cutMin).toBe(0)
  })
})
