const { expect } = require('chai')
const sinon = require('sinon')
const Database = require('../../server/Database')

describe('Database root initialization transaction', () => {
  let transaction
  let userModel
  let hadRoot

  beforeEach(() => {
    hadRoot = Database.hasRootUser
    transaction = { commit: sinon.stub().resolves(), rollback: sinon.stub().resolves() }
    userModel = { count: sinon.stub().resolves(0), createRootUser: sinon.stub().resolves() }
    sinon.stub(Database, 'sequelize').value({ transaction: sinon.stub().resolves(transaction) })
    sinon.stub(Database, 'userModel').get(() => userModel)
    Database.hasRootUser = false
  })

  afterEach(() => {
    sinon.restore()
    Database.hasRootUser = hadRoot
  })

  it('creates the first root in the counted transaction and commits', async () => {
    const auth = {}
    expect(await Database.createRootUser('root', 'hash', auth)).to.equal(true)
    expect(userModel.count.calledOnceWithExactly({ where: { type: 'root' }, transaction })).to.equal(true)
    expect(userModel.createRootUser.calledOnceWithExactly('root', 'hash', auth, transaction)).to.equal(true)
    expect(transaction.commit.calledOnce).to.equal(true)
    expect(transaction.rollback.called).to.equal(false)
    expect(Database.hasRootUser).to.equal(true)
  })

  it('refuses a second root without calling user creation', async () => {
    userModel.count.resolves(1)
    expect(await Database.createRootUser('another-root', 'hash', {})).to.equal(false)
    expect(userModel.createRootUser.called).to.equal(false)
    expect(transaction.rollback.calledOnce).to.equal(true)
    expect(transaction.commit.called).to.equal(false)
  })

  it('rolls back a creation failure and preserves the root flag', async () => {
    const failure = new Error('database write failed')
    userModel.createRootUser.rejects(failure)
    try {
      await Database.createRootUser('root', 'hash', {})
      throw new Error('expected creation to fail')
    } catch (error) {
      expect(error).to.equal(failure)
    }
    expect(transaction.rollback.calledOnce).to.equal(true)
    expect(transaction.commit.called).to.equal(false)
    expect(Database.hasRootUser).to.equal(false)
  })
})
