/**
 * The memory evaluation's questions. Each one first plays out earlier conversations, then asks something that takes a memory to
 * get right, and a program judges the answer. The categories follow DreamBench-SWE's taxonomy (arXiv:2608.20664), which has no
 * public question set; these questions are written for this project and labelled by their author, so they test what they test
 * and no more.
 */
export type Category =
  | 'C1 逐字保留'
  | 'C2 检索精度'
  | 'C3 过期事实'
  | 'C5 作用范围'
  | 'C7 跨会话综合'
  | 'C10 该拒答'
  | '对照'

export interface SeedMemory {
  id: string
  daysAgo: number
  origin: 'human' | 'agent'
  scope: string
  pinned?: boolean
  supersedes?: string
  body: string
}

/** Earlier work on record: a request a person made, which became a Ticket of this project. */
export interface SeedTicket {
  daysAgo: number
  project: string
  title: string
  request: string
}

export interface Expectation {
  /** The outcome must be one of these: a project id, or attach, answer, remember, clarify, ignore. */
  outcomes: readonly string[]
  /** All of these must appear in what the person reads. */
  says?: readonly string[]
  /** At least one of these must appear: there is more than one way to say "I have no record of that". */
  saysAnyOf?: readonly string[]
  /** None of these may appear in what the person reads. */
  neverSays?: readonly string[]
  /** This seeded memory must have been replaced. */
  replaces?: string
  /** This text must not reach the Ticket's scope, which is what a manager would be told. */
  scopeNeverSays?: string
}

export interface MemoryCase {
  id: string
  category: Category
  /** "Recently" is the question, so unrelated records must not be newer than these, or the right answer would change. */
  recencyMatters?: boolean
  /** The records an answer cannot do without: they must reach the card, whatever else is in the store. */
  needs?: readonly string[]
  memories?: readonly SeedMemory[]
  tickets?: readonly SeedTicket[]
  ask: string
  expect: Expectation
}

export const PROJECTS = [
  { id: 'shop-api', brief: '网店后端：订单、支付、优惠券发放的接口。' },
  { id: 'shop-web', brief: '网店前端：登录页、购物车、优惠券校验和展示。' },
  { id: 'ops-tools', brief: '运维脚本：发布、备份、堡垒机。' },
]

const API = 'project:shop-api'
const WEB = 'project:shop-web'
const OPS = 'project:ops-tools'
const NO_RECORD = ['没有', '没记录', '无记录', '未记录', '查不到', '找不到', '没找到', '不知道', '不清楚']

export const CASES: readonly MemoryCase[] = [
  {
    id: 'c1-marker',
    needs: ['m'],
    category: 'C1 逐字保留',
    memories: [
      {
        id: 'm',
        daysAgo: 12,
        origin: 'human',
        scope: API,
        body: 'shop-api 发布用的内部版本标记定为 ZX-4471-Q，后面都按这个来。',
      },
    ],
    ask: 'shop-api 发布用的版本标记是什么来着？',
    expect: { outcomes: ['answer'], says: ['ZX-4471-Q'] },
  },
  {
    id: 'c1-branch',
    needs: ['m'],
    category: 'C1 逐字保留',
    memories: [
      {
        id: 'm',
        daysAgo: 5,
        origin: 'agent',
        scope: WEB,
        body: '工单「导出报表」（ready）：改动在分支 omh/T42，文件 src/report/exporter.ts，测试已通过。',
      },
    ],
    ask: '导出报表那个改动放在哪个分支了？',
    expect: { outcomes: ['answer'], says: ['omh/T42'] },
  },
  {
    id: 'c1-number',
    needs: ['m'],
    category: 'C1 逐字保留',
    memories: [{ id: 'm', daysAgo: 20, origin: 'human', scope: API, body: '支付回调的超时定成 37 秒，别再改了。' }],
    ask: '支付回调的超时我们定的多少？',
    expect: { outcomes: ['answer'], says: ['37'] },
  },
  {
    id: 'c2-which-project',
    needs: ['a'],
    category: 'C2 检索精度',
    memories: [
      {
        id: 'a',
        daysAgo: 3,
        origin: 'agent',
        scope: API,
        body: '工单「修 upload 测试」（ready）：flaky 的 upload 测试是网络抖动造成的，已加重试。',
      },
      { id: 'b', daysAgo: 2, origin: 'agent', scope: WEB, body: '工单「购物车动画」（ready）：测试全部通过。' },
    ],
    ask: '那个 flaky 的 upload 测试是哪个项目的？',
    expect: { outcomes: ['answer'], says: ['shop-api'] },
  },
  {
    id: 'c2-similar',
    needs: ['b'],
    category: 'C2 检索精度',
    memories: [
      {
        id: 'a',
        daysAgo: 4,
        origin: 'agent',
        scope: WEB,
        body: '工单「登录页」（ready）：登录页的记住我修好了，端口没动。',
      },
      {
        id: 'b',
        daysAgo: 6,
        origin: 'agent',
        scope: OPS,
        body: '工单「堡垒机」（ready）：登录堡垒机的脚本改好了，端口改成 2222。',
      },
    ],
    ask: '堡垒机那边端口改成多少了？',
    expect: { outcomes: ['answer'], says: ['2222'] },
  },
  {
    id: 'c2-continue',
    category: 'C2 检索精度',
    tickets: [
      { daysAgo: 7, project: 'shop-web', title: '优惠券校验', request: '给 shop-web 加优惠券校验' },
      { daysAgo: 6, project: 'shop-api', title: '优惠券发放', request: '给 shop-api 加优惠券发放接口' },
    ],
    ask: '再给上次的优惠券校验加一条过期券的单测。',
    expect: { outcomes: ['attach', 'shop-web'] },
  },
  {
    id: 'c2-continue-plain',
    category: 'C2 检索精度',
    tickets: [{ daysAgo: 9, project: 'ops-tools', title: '备份脚本', request: '写一个每天备份数据库的脚本' }],
    ask: '之前那个备份的脚本，再加上压缩。',
    expect: { outcomes: ['attach', 'ops-tools'] },
  },
  {
    id: 'c3-newer-wins',
    needs: ['new'],
    category: 'C3 过期事实',
    memories: [
      { id: 'old', daysAgo: 60, origin: 'human', scope: WEB, body: 'shop-web 的测试框架用 jest。' },
      { id: 'new', daysAgo: 3, origin: 'human', scope: WEB, body: 'shop-web 的测试框架改成 vitest 了，不再用 jest。' },
    ],
    ask: 'shop-web 现在测试框架用什么？',
    expect: { outcomes: ['answer'], says: ['vitest'] },
  },
  {
    id: 'c3-marked',
    needs: ['new'],
    category: 'C3 过期事实',
    memories: [
      { id: 'old', daysAgo: 30, origin: 'human', scope: OPS, pinned: true, body: '发版窗口是周二晚上。' },
      {
        id: 'new',
        daysAgo: 2,
        origin: 'human',
        scope: OPS,
        pinned: true,
        supersedes: 'old',
        body: '发版窗口改到周四晚上。',
      },
    ],
    ask: '发版窗口是什么时候？',
    expect: { outcomes: ['answer'], says: ['周四'], neverSays: ['周二'] },
  },
  {
    id: 'c3-replace',
    needs: ['rule'],
    category: 'C3 过期事实',
    memories: [
      { id: 'rule', daysAgo: 20, origin: 'human', scope: OPS, pinned: true, body: '记住：部署都走蓝绿发布。' },
    ],
    ask: '记住：部署不再走蓝绿了，改成滚动发布。',
    expect: { outcomes: ['remember'], replaces: 'rule' },
  },
  {
    id: 'c5-no-leak-answer',
    category: 'C5 作用范围',
    memories: [
      {
        id: 'rule',
        daysAgo: 10,
        origin: 'human',
        scope: API,
        pinned: true,
        body: 'shop-api 的响应字段一律 snake_case。',
      },
    ],
    ask: 'shop-web 的前端变量命名我们定过什么规范吗？',
    expect: { outcomes: ['answer'], saysAnyOf: NO_RECORD },
  },
  {
    id: 'c5-no-leak-scope',
    category: 'C5 作用范围',
    memories: [
      {
        id: 'rule',
        daysAgo: 10,
        origin: 'human',
        scope: API,
        pinned: true,
        body: 'shop-api 的响应字段一律 snake_case。',
      },
    ],
    ask: '给 shop-web 加一个把接口数据转成页面展示格式的工具函数。',
    expect: { outcomes: ['shop-web'], scopeNeverSays: 'snake_case' },
  },
  {
    id: 'c5-applies',
    needs: ['rule'],
    category: 'C5 作用范围',
    memories: [
      {
        id: 'rule',
        daysAgo: 10,
        origin: 'human',
        scope: API,
        pinned: true,
        body: 'shop-api 的响应字段一律 snake_case。',
      },
    ],
    ask: 'shop-api 新接口的响应字段命名规范是什么？',
    expect: { outcomes: ['answer'], says: ['snake_case'] },
  },
  {
    id: 'c7-three-times',
    needs: ['a', 'b', 'c'],
    category: 'C7 跨会话综合',
    memories: [
      { id: 'a', daysAgo: 9, origin: 'human', scope: API, body: '登录限流先做 IP 维度。' },
      { id: 'b', daysAgo: 6, origin: 'human', scope: API, body: '登录限流的账号维度也要做。' },
      { id: 'c', daysAgo: 2, origin: 'human', scope: API, body: '登录限流的阈值定成每分钟 30 次。' },
    ],
    ask: '登录限流最后是怎么定的？',
    expect: { outcomes: ['answer'], says: ['IP', '账号', '30'] },
  },
  {
    id: 'c7-question-answer',
    needs: ['a'],
    category: 'C7 跨会话综合',
    memories: [
      {
        id: 'q',
        daysAgo: 5,
        origin: 'agent',
        scope: API,
        body: '工单「登录限流」（blocked）：实现前要定存储。\n问题：限流计数用 Redis 还是进程内存？',
      },
      { id: 'a', daysAgo: 5, origin: 'human', scope: API, body: '限流计数用 Redis，多实例要共享。' },
    ],
    ask: '限流那个方案，计数最后选的什么存储？',
    expect: { outcomes: ['answer'], says: ['Redis'] },
  },
  {
    id: 'c7-recent-work',
    needs: ['a', 'b', 'c'],
    category: 'C7 跨会话综合',
    recencyMatters: true,
    memories: [
      {
        id: 'a',
        daysAgo: 4,
        origin: 'agent',
        scope: WEB,
        body: '工单「购物车动画」（ready）：shop-web 的购物车动画做完了。',
      },
      {
        id: 'b',
        daysAgo: 3,
        origin: 'agent',
        scope: WEB,
        body: '工单「登录页记住我」（ready）：shop-web 的登录页记住我修好了。',
      },
      {
        id: 'c',
        daysAgo: 2,
        origin: 'agent',
        scope: WEB,
        body: '工单「优惠券校验」（ready）：shop-web 的优惠券校验加好了。',
      },
    ],
    ask: 'shop-web 最近做了哪些事？',
    expect: { outcomes: ['answer'], says: ['购物车动画', '记住我', '优惠券校验'] },
  },
  {
    id: 'c10-never-said',
    category: 'C10 该拒答',
    memories: [
      { id: 'a', daysAgo: 3, origin: 'agent', scope: WEB, body: '工单「购物车动画」（ready）：购物车动画做完了。' },
    ],
    ask: '对接支付宝的商户号是多少？',
    expect: { outcomes: ['answer', 'clarify'], saysAnyOf: NO_RECORD },
  },
  {
    id: 'c10-near-miss',
    category: 'C10 该拒答',
    memories: [{ id: 'a', daysAgo: 8, origin: 'human', scope: API, body: '微信支付的商户号是 1234567。' }],
    ask: '支付宝的商户号是多少？',
    expect: { outcomes: ['answer', 'clarify'], saysAnyOf: NO_RECORD, neverSays: ['支付宝的商户号是 1234567'] },
  },
  {
    id: 'c10-unknown-status',
    category: 'C10 该拒答',
    memories: [
      {
        id: 'a',
        daysAgo: 3,
        origin: 'agent',
        scope: OPS,
        body: '工单「备份脚本」（ready）：每天备份数据库的脚本写好了。',
      },
    ],
    ask: '上次那个数据迁移跑完了吗？',
    expect: { outcomes: ['answer', 'clarify'], saysAnyOf: NO_RECORD },
  },
  {
    id: 'control-remember',
    category: '对照',
    ask: '记住：shop-api 的发布必须先过 staging。',
    expect: { outcomes: ['remember'] },
  },
  {
    id: 'control-route',
    category: '对照',
    ask: '给 ops-tools 写一个清理旧日志的脚本。',
    expect: { outcomes: ['ops-tools'] },
  },
]

const NOISE_TOPICS = [
  '登录页',
  '支付回调',
  '优惠券',
  '购物车',
  '发布脚本',
  '堡垒机',
  '备份脚本',
  '登录限流',
  'upload 接口',
  '报表导出',
  '订单列表',
]
const NOISE_WORK = [
  '日志格式调整好了',
  '错误提示改清楚了',
  '重复代码清理了',
  '文档补上了',
  '单测补全了',
  '超时提示文案改了',
  '端口配置挪到配置文件了',
]
const NOISE_RULES = ['改动要写变更说明', '改动要先发预览环境', '出错要打告警', '合并前要有人看过', '改完要更新文档']
const NOISE_DAYS = 90
const NOISE_DAY_STEP = 7
const NOISE_PINNED_EVERY = 20

/**
 * Records that share the questions' words without holding their answers, the way months of real work would: a store of three
 * records cannot show that retrieval finds the right one. Fixed rather than random, so that two runs compare, and free of
 * digits, so that no answer can be read off one by chance.
 */
export function noiseMemories(count: number, newerThanDaysAgo = 0): SeedMemory[] {
  return Array.from({ length: count }, (_, index) => {
    const project = PROJECTS[index % PROJECTS.length]?.id ?? ''
    const topic = NOISE_TOPICS[index % NOISE_TOPICS.length] ?? ''
    const work = NOISE_WORK[index % NOISE_WORK.length] ?? ''
    const pinned = index % NOISE_PINNED_EVERY === 0
    const rule = NOISE_RULES[(index / NOISE_PINNED_EVERY) % NOISE_RULES.length] ?? ''
    return {
      id: `noise-${index}`,
      daysAgo: newerThanDaysAgo + 1 + ((index * NOISE_DAY_STEP) % NOISE_DAYS),
      origin: pinned ? ('human' as const) : ('agent' as const),
      scope: `project:${project}`,
      ...(pinned
        ? { pinned, body: `记住：${project} 的${topic}${rule}。` }
        : { body: `工单「${topic}整理」（ready）：${project} 的${topic}${work}。` }),
    }
  })
}
