const { expect } = require('chai')
const sinon = require('sinon')
const Database = require('../../../server/Database')
const CronManager = require('../../../server/managers/CronManager')
const manager = require('../../../server/managers/ChineseSearchManager')
const cron = require('../../../server/libs/nodeCron')

describe('Chinese search cron registration', () => {
  afterEach(() => sinon.restore())

  it('keeps blank cron disabled and safely replaces or clears a configured cron', async () => {
    const settings = { chineseSearchCronExpression: null }
    sinon.stub(Database, 'serverSettings').value(settings)
    const task = { stop: sinon.spy() }
    const schedule = sinon.stub(cron, 'schedule').returns(task)
    sinon.stub(manager, 'run').resolves()
    const scheduler = new CronManager()
    scheduler.updateChineseSearchCron()
    expect(schedule.called).to.equal(false)
    settings.chineseSearchCronExpression = '0 2 * * *'
    scheduler.updateChineseSearchCron()
    scheduler.updateChineseSearchCron()
    expect(schedule.calledOnce).to.equal(true)
    await schedule.firstCall.args[1]()
    expect(manager.run.calledOnceWithExactly(true)).to.equal(true)
    settings.chineseSearchCronExpression = '0 3 * * *'
    scheduler.updateChineseSearchCron()
    expect(task.stop.calledOnce).to.equal(true)
    settings.chineseSearchCronExpression = null
    scheduler.updateChineseSearchCron()
    expect(task.stop.calledTwice).to.equal(true)
    expect(scheduler.chineseSearchCron).to.equal(null)
  })
})
