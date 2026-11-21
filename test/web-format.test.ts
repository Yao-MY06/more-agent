import { describe, expect, it } from 'vitest'
// @ts-expect-error web/format.js is plain JavaScript without declarations
import { userStateText } from '../web/format.js'

describe('userStateText', () => {
  it('state 为 queued 时显示排队中', () => {
    expect(userStateText('queued')).toBe('排队中')
  })

  it('state 为 received 时显示等待判断', () => {
    expect(userStateText('received')).toBe('等待判断')
  })

  it('outcome 为 clarify 时显示需要澄清', () => {
    expect(userStateText('decided', 'clarify')).toBe('需要澄清')
  })

  it('outcome 为 answer 时显示 Leader 已直接回答', () => {
    expect(userStateText('decided', 'answer')).toBe('Leader 已直接回答')
  })

  it('outcome 为 remember 时显示已记下', () => {
    expect(userStateText('decided', 'remember')).toBe('已记下')
  })

  it('outcome 为 recall 时显示已查记忆', () => {
    expect(userStateText('decided', 'recall')).toBe('已查记忆')
  })

  it('outcome 为 attach 时显示已并入进行中的工单', () => {
    expect(userStateText('decided', 'attach')).toBe('已并入进行中的工单')
  })

  it('outcome 为 unavailable 时显示 Leader 暂时无法判断', () => {
    expect(userStateText('decided', 'unavailable')).toBe('Leader 暂时无法判断')
  })

  it('outcome 为 route 时显示已交给项目', () => {
    expect(userStateText('decided', 'route')).toBe('已交给项目')
  })

  it('outcome 为 accept 时显示已交给项目', () => {
    expect(userStateText('decided', 'accept')).toBe('已交给项目')
  })

  it('outcome 为 ignore 时显示 Leader 判定不需要回复', () => {
    expect(userStateText('decided', 'ignore')).toBe('Leader 判定不需要回复')
  })

  it('没有 outcome 时显示已判断', () => {
    expect(userStateText('decided')).toBe('已判断')
  })

  it('outcome 为空字符串时显示已判断', () => {
    expect(userStateText('decided', '')).toBe('已判断')
  })

  it('outcome 为项目名时显示已交给项目和项目名', () => {
    expect(userStateText('decided', 'demo-calc')).toBe('已交给项目：demo-calc')
  })

  it('outcome 为 constructor 时按项目名显示', () => {
    expect(userStateText('decided', 'constructor')).toBe('已交给项目：constructor')
  })

  it('outcome 为 __proto__ 时按项目名显示', () => {
    expect(userStateText('decided', '__proto__')).toBe('已交给项目：__proto__')
  })

  it('outcome 为中文项目名时显示已交给项目和项目名', () => {
    expect(userStateText('decided', '记账')).toBe('已交给项目：记账')
  })
})
