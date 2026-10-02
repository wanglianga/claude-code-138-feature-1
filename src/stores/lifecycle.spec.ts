import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'

describe('预约全生命周期集成', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('提交→确认→到馆→发设备→入场→途中事件→离馆押金结算', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('14:00')

    // 1. 预约方提交
    const r = store.create({
      orgType: 'enterprise',
      orgName: '测试科技有限公司',
      groupSize: 30,
      ageBand: 'adult',
      language: 'zh',
      accessible: false,
      themeId: 't_modern',
      arriveTime: '2026-10-01T14:00:00',
      contactName: '测试领队',
      contactPhone: '13800000000',
      busInfo: '大巴 1 辆',
      needHeadsets: true,
      headsetCount: 30,
      note: '',
    })
    expect(r.status).toBe('submitted')
    expect(r.route.length).toBeGreaterThan(0)
    expect(r.timeline[0].kind).toBe('submit')

    // 2. 馆方确认（林岚 09-17 当班且下午空闲）
    store.confirm(r.id, { guideIds: ['g1'], laneId: 'lane_a', batchNo: 'B1400', note: '正常确认' }, '沈姐')
    expect(r.status).toBe('confirmed')
    expect(r.assignedGuideIds).toEqual(['g1'])

    // 3. 到馆（时钟设为 14:05 → 迟到 5 分钟）
    museum.setNow('14:05')
    store.markArrived(r.id)
    expect(r.status).toBe('arrived')
    expect(r.actualArrive).toBe('2026-10-01T14:05:00')
    expect(r.timeline.some((e) => e.kind === 'arrive' && e.title.includes('迟到 5'))).toBe(true)

    // 4. 核验人数：少 2 人
    store.verifyHeadcount(r.id, 28, '小唐')
    expect(r.verifiedSize).toBe(28)

    // 5. 发耳麦
    store.handoutHeadsets(r.id, 28, '老郭')
    expect(r.devices).toHaveLength(28)
    expect(r.devices.every((d) => d.status === 'lent')).toBe(true)
    expect(r.depositTotal).toBe(28 * 200)

    // 6. 入场
    store.admit(r.id, '安检员')
    expect(r.status).toBe('touring')
    expect(r.route.some((s) => s.state === 'current')).toBe(true)
    expect(museum.inventory.lent).toBeGreaterThanOrEqual(28 + 24) // 本团 28 + 种子儿童团 24

    // 7. 迟到顺延 15 分钟
    const before = r.route.find((s) => s.state === 'planned')!.plannedEnter
    store.delay(r.id, 15, 'late', '团体迟到顺延15分钟', '', '沈姐')
    const after = r.route.find((s) => s.state === 'planned')!.plannedEnter
    expect(after > before).toBe(true)

    // 8. 改道：当前站 → h3
    const blocked = r.route.find((s) => s.state === 'current')!.hallId
    store.applyReroute(r.id, {
      blockedHallId: blocked,
      targetHallId: 'h3',
      atHM: museum.nowHM,
      durationMin: 25,
      reason: '游客对雕塑感兴趣',
    }, '林岚')
    expect(r.route.find((s) => s.hallId === 'h3' && s.state === 'current')).toBeTruthy()
    expect(r.timeline.some((e) => e.kind === 'reroute')).toBe(true)

    // 9. 儿童走散（成人团也可调用通用等待事件）
    store.childLost(r.id, '随行儿童一名', 10, true, '林岚')
    expect(r.timeline.some((e) => e.kind === 'child_lost')).toBe(true)

    // 10. 耳麦损坏换机
    const oldCode = r.devices[0].code
    store.exchangeHeadset(r.id, oldCode, '无声音', '老郭')
    expect(r.devices.find((d) => d.code === oldCode)?.status).toBe('damaged')
    expect(r.devices.filter((d) => d.status === 'lent').length).toBe(28)
    expect(r.timeline.some((e) => e.kind === 'device_exchange')).toBe(true)

    // 11. 讲解员替换：何田田下午当班且无团
    store.swapGuide(r.id, 'g1', 'g5', '林岚嗓子不适')
    expect(r.assignedGuideIds).toEqual(['g5'])

    // 12. 离馆：28 台归还，其中 1 台损坏（换机时已登记）、1 台遗失
    const results = r.devices
      .filter((d) => d.status === 'lent')
      .map((d, i) => ({ code: d.code, result: i === 0 ? ('lost' as const) : ('ok' as const) }))
    store.returnDevices(r.id, results, '老郭')
    // 27 完好 + 1 遗失 + 换机旧机损坏
    expect(r.depositDeduction).toBe(200 + 50)
    store.settleDeposit(r.id, '老郭')
    expect(r.timeline.some((e) => e.kind === 'deposit_settle' && e.amount === 250)).toBe(true)

    // 13. 完成
    store.complete(r.id, 4, '小唐')
    expect(r.status).toBe('completed')
    expect(r.satisfaction).toBe(4)
    expect(r.departAt).toBeTruthy()

    // 时间线按时间排序且覆盖关键环节
    const kinds = r.timeline.map((e) => e.kind)
    for (const k of ['submit', 'confirm', 'arrive', 'headcount', 'device_handout', 'batch_admit', 'reroute', 'device_exchange', 'guide_swap', 'device_return', 'deposit_settle', 'complete']) {
      expect(kinds).toContain(k)
    }
    const times = r.timeline.map((e) => e.at)
    expect([...times].sort()).toEqual(times)
  })

  it('临时维护会联动所有在馆/已确认团的受影响站点', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('10:25')
    // 种子儿童团 R3 正在 h5（10:20-10:45）
    store.declareMaintenance('h5', { start: '10:00', end: '11:00', reason: '光影设备抢修' }, '工程部')
    const r3 = store.byId('R20261001-03')!
    const stop = r3.route.find((s) => s.hallId === 'h5')!
    expect(stop.state).toBe('maintenance')
    expect(museum.maintenance.h5?.reason).toBe('光影设备抢修')
  })

  it('团体迟到 40 分钟：缩短路线——联系人确认后压缩到讲解员交接前、耳麦截止随之前移', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('10:25')
    const r3 = store.byId('R20261001-03')!
    const plan = store.generateLatePlan(r3.id, 40)!
    expect(plan.basis.guideDeadlineHM).toBe('11:20')
    expect(plan.basis.mustCutMin).toBeGreaterThan(0)

    store.confirmLatePlan(r3.id, plan.id, 'shorten', '孙老师')
    const after = store.byId(r3.id)!
    // 联系人确认留痕
    expect(after.latePlans[0].confirmed?.by).toBe('孙老师')
    expect(after.latePlans[0].confirmed?.type).toBe('shorten')
    // 所有未完成站点不晚于讲解员 11:20 交接
    const last = after.route.filter((s) => s.state !== 'skipped' && s.state !== 'maintenance').slice(-1)[0]
    expect(last.plannedLeave <= '11:20').toBe(true)
    // 各厅时长被压缩（h3 23→16 等）
    expect(after.route.find((s) => s.hallId === 'h3')!.durationMin).toBeLessThan(23)
    expect(after.route.some((s) => s.note?.includes('迟到压缩'))).toBe(true)
    // 讲解员仍带本团，耳麦借用截止时间随新结束时间调整
    expect(after.assignedGuideIds).toContain('g3')
    expect(after.devices[0].dueBackAt).toBe('2026-10-01T11:20:00')
    // 时间线含生成方案与执行缩短
    expect(after.timeline.some((e) => e.kind === 'late' && e.title.includes('路线重排方案'))).toBe(true)
    expect(after.timeline.some((e) => e.kind === 'shorten_route')).toBe(true)
  })

  it('团体迟到：改自助参观——推送导览/集合点、释放苏晓并自动派给等待团 R06、耳麦截止调整', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('10:25')
    const r3 = store.byId('R20261001-03')!
    const plan = store.generateLatePlan(r3.id, 40)!
    store.confirmLatePlan(r3.id, plan.id, 'selfguide', '孙老师')

    const after = store.byId(r3.id)!
    expect(after.visitMode).toBe('selfguided')
    expect(after.route.every((s) => s.state === 'selfguided' || s.state === 'done')).toBe(true)
    // 讲解员释放
    expect(after.assignedGuideIds).not.toContain('g3')
    // 释放时段自动派给后续等待团 R06
    const r06 = store.byId('R20261001-06')!
    expect(r06.assignedGuideIds).toContain('g3')
    expect(r06.timeline.some((e) => e.kind === 'guide_assign' && e.title.includes('接续派工'))).toBe(true)
    // 耳麦继续借用、截止随集合点（投影后 11:40）
    expect(after.devices.every((d) => d.status === 'lent' && d.dueBackAt === '2026-10-01T11:40:00')).toBe(true)
    // 自助与释放留痕
    expect(after.timeline.some((e) => e.kind === 'self_guide' && e.detail?.includes('云川导览') && e.detail?.includes('集合点'))).toBe(true)
    expect(after.timeline.some((e) => e.kind === 'guide_release')).toBe(true)
  })

  it('团体迟到：改签——平移路线到新时段、改派何田田、苏晓释放给 R06、耳麦随改签平移', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('10:25')
    const r3 = store.byId('R20261001-03')!
    const plan = store.generateLatePlan(r3.id, 40)!
    const rs = plan.options.find((o) => o.type === 'reschedule')!
    expect(rs.feasible).toBe(true)
    store.confirmLatePlan(r3.id, plan.id, 'reschedule', '孙老师')

    const after = store.byId(r3.id)!
    expect(after.status).toBe('confirmed')
    expect(after.assignedGuideIds).toContain('g5')
    expect(after.assignedGuideIds).not.toContain('g3')
    // 站点平移到 13:10 开讲、按完整时长
    const first = after.route.find((s) => s.state === 'planned')!
    expect(first.plannedEnter).toBe(rs.rescheduleStartHM)
    expect(first.durationMin).toBe(23)
    // 苏晓释放派给等待团
    expect(store.byId('R20261001-06')!.assignedGuideIds).toContain('g3')
    // 耳麦截止随改签结束时间
    expect(after.devices[0].dueBackAt).toBe(`2026-10-01T${rs.endHM}:00`)
    expect(after.timeline.some((e) => e.kind === 'reschedule')).toBe(true)
    expect(after.timeline.some((e) => e.kind === 'guide_assign' && e.title.includes('何田田'))).toBe(true)
  })
})
