/** 领域模型：美术馆团体参观预约 · 设备借还 · 展厅分流 */

export type GroupType = 'school' | 'enterprise' | 'travel'
export type AgeBand = 'children' | 'youth' | 'adult' | 'senior' | 'mixed'
export type Language = 'zh' | 'en' | 'ja'

export type ReservationStatus =
  | 'submitted' // 已提交，待馆方确认
  | 'confirmed' // 馆方已确认
  | 'arrived' // 已到馆，前台核验中
  | 'touring' // 参观进行中
  | 'completed' // 已离馆
  | 'rejected' // 馆方驳回
  | 'cancelled' // 预约方取消

export const STATUS_LABEL: Record<ReservationStatus, string> = {
  submitted: '待确认',
  confirmed: '已确认',
  arrived: '已到馆',
  touring: '参观中',
  completed: '已离馆',
  rejected: '已驳回',
  cancelled: '已取消',
}

export const GROUP_TYPE_LABEL: Record<GroupType, string> = {
  school: '学校',
  enterprise: '企业',
  travel: '旅行社',
}

export const AGE_LABEL: Record<AgeBand, string> = {
  children: '儿童为主',
  youth: '青少年',
  adult: '成人',
  senior: '银发长者',
  mixed: '年龄混合',
}

export const LANG_LABEL: Record<Language, string> = {
  zh: '中文',
  en: '英语',
  ja: '日语',
}

/** 路线站点 */
export interface RouteStop {
  hallId: string
  plannedEnter: string // HH:mm
  plannedLeave: string
  durationMin: number
  actualEnter?: string
  actualLeave?: string
  /** planned 待参观 / current 正在参观 / done 已完成 / skipped 跳过 / maintenance 临时维护 / congested 拥堵避让 / selfguided 自助参观（无讲解员） */
  state: 'planned' | 'current' | 'done' | 'skipped' | 'maintenance' | 'congested' | 'selfguided'
  note?: string
}

export type EventKind =
  | 'submit'
  | 'confirm'
  | 'reject'
  | 'cancel'
  | 'arrive'
  | 'headcount'
  | 'device_handout'
  | 'device_exchange'
  | 'guide_assign'
  | 'guide_swap'
  | 'guide_release'
  | 'batch_admit'
  | 'start_tour'
  | 'hall_congestion'
  | 'late'
  | 'shorten_route'
  | 'self_guide'
  | 'reschedule'
  | 'child_lost'
  | 'device_broken'
  | 'reroute'
  | 'maintenance'
  | 'wait'
  | 'device_return'
  | 'deposit_settle'
  | 'satisfaction'
  | 'complete'
  | 'complaint'

export interface TimelineEvent {
  id: string
  at: string // ISO 时间
  kind: EventKind
  title: string
  detail?: string
  amount?: number // 涉及金额（元）
  by: string // 操作人/系统
}

export type DeviceStatus = 'available' | 'lent' | 'returned' | 'damaged' | 'lost'

export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  available: '在库',
  lent: '借出',
  returned: '已归还',
  damaged: '损坏',
  lost: '遗失',
}

export interface DeviceUnit {
  code: string
  status: DeviceStatus
  deposit: number // 单台押金
  resId?: string // 当前借出预约
  lentAt?: string
  returnedAt?: string
  damageFee?: number // 损坏/遗失扣款
  /** 自助参观/迟到重排后调整的耳麦应归还截止时间（ISO） */
  dueBackAt?: string
  note?: string
}

/** 迟到重排：单个展厅的压缩/保留/改自助依据 */
export interface LateStopDecision {
  hallId: string
  /** keep 保留讲解 / trim 压缩时长 / drop 放弃讲解（改自助或跳过） / self 自助参观 / done 已完成 */
  action: 'keep' | 'trim' | 'drop' | 'self' | 'done'
  originalEnter: string
  originalLeave: string
  newEnter?: string
  newLeave?: string
  originalMin: number
  newMin: number
  /** 该厅压缩/放弃的量化依据 */
  reasons: string[]
}

/** 生成方案时的客观依据（剩余讲解时长 / 拥堵 / 下一团到馆 / 讲解员截止） */
export interface LatePlanBasis {
  lateMin: number
  /** 原定讲解员最迟必须离场的分钟数与原因（下班或下一团交接） */
  guideDeadlineHM: string
  guideDeadlineReason: string
  /** 从当前时刻到讲解员截止，可用于讲解的分钟数 */
  remainingGuideMin: number
  /** 原计划剩余讲解分钟数（未完成站点） */
  plannedRemainingMin: number
  /** 下一团到馆时间与团体名 */
  nextGroupHM?: string
  nextGroupName?: string
  /** 受影响（未完成）站点在当前时刻的实时满载率 */
  hallRatios: { hallId: string; ratio: number }[]
  /** 综合判定：必须压缩的分钟数 */
  mustCutMin: number
}

export type LatePlanType = 'shorten' | 'selfguide' | 'reschedule'

export interface LatePlanOption {
  type: LatePlanType
  title: string
  /** 该方案当前是否可行（不可行时置灰并说明原因，如当日已无可改签时段） */
  feasible: boolean
  /** 推荐分，越高越推荐；前端按此排序并标记「推荐」 */
  score: number
  recommend?: boolean
  /** 讲解员讲解结束时间 */
  endHM: string
  /** 缩短/自助方案保留的讲解分钟数（改签为 0，尚未开始） */
  guidedMin: number
  /** 相比原计划压缩的讲解分钟数 */
  cutMin: number
  decisions: LateStopDecision[]
  /** 改签方案的建议到馆/开讲时间 */
  rescheduleArriveHM?: string
  rescheduleStartHM?: string
  rescheduleGuides?: { id: string; name: string }[]
  /** 方案级说明 */
  summary: string
  reasons: string[]
  /** 自助参观：电子导览与集合点 */
  audioGuide?: { name: string; pickup: string }
  assemblyPoint?: string
}

/** 一次迟到重排的完整记录（生成依据 + 三方案 + 联系人确认结果） */
export interface LatePlan {
  id: string
  createdAt: string
  lateMin: number
  basis: LatePlanBasis
  options: LatePlanOption[]
  confirmed?: {
    type: LatePlanType
    optionTitle: string
    by: string // 确认的联系人
    at: string
  }
}

export interface Reservation {
  id: string
  orgType: GroupType
  orgName: string
  groupSize: number
  ageBand: AgeBand
  language: Language
  accessible: boolean
  themeId: string
  arriveTime: string // ISO，预计到馆
  contactName: string
  contactPhone: string
  busInfo: string
  needHeadsets: boolean
  headsetCount: number
  note: string

  status: ReservationStatus
  createdAt: string

  // —— 馆方确认 ——
  confirmedAt?: string
  confirmNote?: string
  assignedGuideIds: string[]
  batchNo?: string
  securityLane?: string

  // —— 到馆核验 ——
  actualArrive?: string
  verifiedSize?: number

  // —— 路线与时长 ——
  route: RouteStop[]
  durationMin: number
  /** guided 讲解员带团（默认）/ selfguided 联系人确认后改为自助参观 */
  visitMode: 'guided' | 'selfguided'
  /** 团体迟到后的路线重排记录（含压缩依据与联系人确认结果） */
  latePlans: LatePlan[]

  // —— 设备与押金 ——
  devices: DeviceUnit[]
  depositTotal: number
  depositDeduction: number

  // —— 离馆 ——
  departAt?: string
  satisfaction?: number // 1-5
  complaint?: string
  complaintReply?: string

  timeline: TimelineEvent[]
}

export interface Exhibit {
  id: string
  name: string
  hot?: boolean // 热门展品
  noPhoto?: boolean // 禁止拍照
  recommendedAge?: number // 建议最低年龄
}

export interface HallClosure {
  start: string // HH:mm
  end: string
  reason: string
}

export interface Hall {
  id: string
  name: string
  floor: string
  capacity: number
  childFriendly: boolean
  accessible: boolean // 无障碍可达
  quiet: 1 | 2 | 3 // 安静等级：3 最安静
  themes: string[]
  exhibits: Exhibit[]
  closures: HallClosure[] // 当日临时闭展/维护
  nearTo: string[] // 相邻展厅（用于步行时间/分流）
}

export interface Theme {
  id: string
  name: string
  desc: string
  durationMin: number
  hallIds: string[] // 标准参观顺序
}

export interface GuideShift {
  start: string
  end: string
}

export interface Guide {
  id: string
  name: string
  langs: Language[]
  themes: string[]
  shifts: GuideShift[] // 当日排班
  phone: string
  rating: number // 近30日好评率
}

export interface SecurityLane {
  id: string
  name: string
  perSlot: number // 每 15 分钟可检人数
  accessibleOnly?: boolean
}
