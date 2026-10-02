// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { mount } from '@vue/test-utils'
import BookView from '@/views/BookView.vue'
import ReservationsView from '@/views/ReservationsView.vue'
import ConfirmView from '@/views/ConfirmView.vue'
import FrontDeskView from '@/views/FrontDeskView.vue'
import DispatchView from '@/views/DispatchView.vue'
import CheckoutView from '@/views/CheckoutView.vue'
import TraceView from '@/views/TraceView.vue'
import OpsView from '@/views/OpsView.vue'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { occupancyGrid } from '@/lib/schedule'
import { analyzeLate, buildShortenPlan } from '@/lib/latePlan'
import { HALLS } from '@/data/museum'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/book', component: BookView },
      { path: '/confirm/:id?', component: ConfirmView },
      { path: '/front/:id?', component: FrontDeskView },
      { path: '/dispatch', component: DispatchView },
      { path: '/checkout/:id?', component: CheckoutView },
      { path: '/trace/:id?', component: TraceView },
    ],
  })
}

function mountView(component: unknown) {
  const router = makeRouter()
  return mount(component as never, {
    global: { plugins: [router] },
  })
}

describe('八大业务视图挂载冒烟', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('运营看板渲染展厅与讲解员表', () => {
    const w = mountView(OpsView)
    expect(w.text()).toContain('展厅实时负载')
    expect(w.text()).toContain('讲解员排班')
  })

  it('预约表单渲染全部必填字段', () => {
    const w = mountView(BookView)
    expect(w.text()).toContain('团体人数')
    expect(w.text()).toContain('讲解主题')
    expect(w.text()).toContain('无障碍路线')
    expect(w.text()).toContain('车辆停靠')
    expect(w.text()).toContain('借用')
  })

  it('预约列表渲染种子数据', () => {
    const w = mountView(ReservationsView)
    expect(w.text()).toContain('云川中学')
    expect(w.text()).toContain('星辉国际旅行社')
  })

  it('确认台展示容量、讲解员与安检校验', () => {
    const w = mountView(ConfirmView)
    expect(w.text()).toContain('展厅容量与临时闭展校验')
    expect(w.text()).toContain('讲解员排班匹配')
    expect(w.text()).toContain('安检通道')
  })

  it('到馆前台四步流程', () => {
    const w = mountView(FrontDeskView)
    expect(w.text()).toContain('到馆登记')
    expect(w.text()).toContain('核验人数')
    expect(w.text()).toContain('发放耳麦')
    expect(w.text()).toContain('批次安检入馆')
  })

  it('到馆前台：迟到 40 分钟触发路线重排，确认自助参观后推送电子导览', async () => {
    const w = mountView(FrontDeskView)
    // 队列首个为育英中学（预约 09:45，馆内时钟 10:25）
    expect(w.text()).toContain('育英中学')
    const arriveBtn = w.findAll('button').find((b) => b.text().includes('登记到馆'))!
    await arriveBtn.trigger('click')
    // 迟到 40 分钟 → 三方案面板
    expect(w.text()).toContain('迟到路线重排建议')
    expect(w.text()).toContain('剩余可讲解时长')
    expect(w.text()).toContain('远瞻科技') // 讲解员后续任务
    expect(w.text()).toContain('缩短路线')
    expect(w.text()).toContain('自助参观')
    expect(w.text()).toContain('改签时段')
    // 选择自助参观 → 联系人确认
    await w.find('[data-plan="self"]').trigger('click')
    const confirmBtn = w.findAll('button').find((b) => b.text().includes('联系人确认采用'))!
    await confirmBtn.trigger('click')
    // 电子导览 + 集合点 + 讲解员释放时段再分配
    expect(w.text()).toContain('已按「自助参观」重排')
    expect(w.text()).toContain('已推送电子导览')
    expect(w.text()).toContain('中庭')
    expect(w.text()).toContain('云川中学')
  })

  it('途中调度页展示七类事件入口与实时态势', () => {
    const w = mountView(DispatchView)
    expect(w.text()).toContain('展厅实时态势')
    expect(w.text()).toContain('展厅拥堵分流')
    expect(w.text()).toContain('儿童走散')
    expect(w.text()).toContain('耳麦损坏换机')
    expect(w.text()).toContain('讲解员临时替换')
    expect(w.text()).toContain('游客要求改路线')
    expect(w.text()).toContain('展厅临时维护')
  })

  it('离馆核销页渲染设备清点与押金结算', () => {
    const w = mountView(CheckoutView)
    expect(w.text()).toContain('逐台核对耳麦归还')
    expect(w.text()).toContain('押金结算')
    expect(w.text()).toContain('满意度')
  })

  it('追溯页渲染晨光职校投诉档案证据链', () => {
    const w = mountView(TraceView)
    expect(w.text()).toContain('晨光职业学校')
    expect(w.text()).toContain('讲解缩水')
    expect(w.text()).toContain('完整操作时间线')
  })

  it('追溯页：投诉内容减少时展示迟到压缩依据', () => {
    // 育英中学迟到 40 分钟 → 缩短路线 → 离馆后投诉内容减少
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('10:25')
    store.markArrived('R20261001-06')
    const r = store.byId('R20261001-06')!
    const ctx = analyzeLate(r, store.list, museum.guides, museum.nowHM)
    const grid = occupancyGrid(
      store.list.filter((x) => x.id !== r.id),
      { maintenance: museum.maintenance, extraLoad: museum.extraLoad },
    )
    const plan = buildShortenPlan(r, ctx, HALLS, grid, {
      maintenance: museum.maintenance,
      extraLoad: museum.extraLoad,
    })
    store.applyLateShorten(r.id, plan, ctx, '近现代名家 28/45，叠加本团将超容量', '沈姐')
    store.addComplaint(r.id, '讲解内容比预约少了一个展厅，要求说明。', r.contactName)

    const w = mountView(TraceView)
    expect(w.text()).toContain('迟到压缩依据')
    expect(w.text()).toContain('迟到 40')
    expect(w.text()).toContain('被压缩展厅及原因')
    expect(w.text()).toContain('为避免超载舍弃')
    expect(w.text()).toContain('远瞻科技') // 讲解员后续任务约束
  })
})
