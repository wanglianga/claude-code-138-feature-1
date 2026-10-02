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

  it('途中调度页展示七类事件入口与实时态势', () => {
    const w = mountView(DispatchView)
    expect(w.text()).toContain('展厅实时态势')
    expect(w.text()).toContain('展厅拥堵分流')
    expect(w.text()).toContain('团体迟到路线重排')
    expect(w.text()).toContain('儿童走散')
    expect(w.text()).toContain('耳麦损坏换机')
    expect(w.text()).toContain('讲解员临时替换')
    expect(w.text()).toContain('游客要求改路线')
    expect(w.text()).toContain('展厅临时维护')
  })

  it('迟到重排面板可生成缩短/自助/改签三方案并展示依据', async () => {
    const w = mountView(DispatchView)
    // 默认选中参观中的阳光路三小（迟到 40 分钟种子团）
    expect(w.text()).toContain('阳光路第三小学')
    await w.findAll('button').find((b) => b.text().includes('团体迟到路线重排'))!.trigger('click')
    expect(w.text()).toContain('实际迟到分钟')
    await w.findAll('button').find((b) => b.text().includes('生成方案'))!.trigger('click')
    expect(w.text()).toContain('重排测算依据')
    expect(w.text()).toContain('缩短讲解路线')
    expect(w.text()).toContain('改为自助参观')
    expect(w.text()).toContain('改签')
    expect(w.text()).toContain('实验一小教育集团')
    expect(w.text()).toContain('联系人确认')
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
})
