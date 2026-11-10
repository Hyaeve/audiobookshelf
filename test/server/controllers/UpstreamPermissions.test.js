const { expect } = require('chai')
const sinon = require('sinon')
const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const SessionController = require('../../../server/controllers/SessionController')
const CollectionController = require('../../../server/controllers/CollectionController')
const MeController = require('../../../server/controllers/MeController')

describe('Upstream controller permission boundaries', () => {
  beforeEach(() => sinon.stub(Logger, 'error'))
  afterEach(() => sinon.restore())

  for (const account of [
    { name: 'another reader', id: 'reader', admin: false, status: 403 },
    { name: 'the session owner', id: 'owner', admin: false },
    { name: 'an administrator', id: 'admin', admin: true }
  ]) {
    it(`checks historical session access for ${account.name}`, async () => {
      const session = { userId: 'owner' }
      sinon.stub(Database, 'getPlaybackSession').resolves(session)
      const request = { params: { id: 'session' }, method: 'GET', user: { id: account.id, username: account.id, isAdminOrUp: account.admin } }
      const response = { sendStatus: sinon.spy() }
      const next = sinon.spy()
      await SessionController.middleware(request, response, next)
      if (account.status) {
        expect(response.sendStatus.calledOnceWithExactly(account.status)).to.equal(true)
        expect(next.called).to.equal(false)
      } else {
        expect(next.calledOnce).to.equal(true)
        expect(request.playbackSession).to.equal(session)
      }
    })
  }

  for (const filtered of [false, true]) {
    it(`uses user-filtered collection results without broadcasting${filtered ? ' when no books are visible' : ''}`, async () => {
      const user = { id: 'reader' }
      const visible = filtered ? null : { id: 'collection', books: [{ id: 'allowed-book' }] }
      const collection = {
        name: 'Old name',
        description: '',
        update: sinon.stub().resolves(),
        getOldJsonExpanded: sinon.stub().resolves(visible)
      }
      const broadcast = sinon.stub(SocketAuthority, 'emitter')
      const targeted = sinon.stub(SocketAuthority, 'clientEmitter')
      const response = { json: sinon.spy() }
      await CollectionController.update({ user, collection, body: { name: 'New name' } }, response)
      expect(collection.getOldJsonExpanded.calledOnceWithExactly(user)).to.equal(true)
      expect(broadcast.called).to.equal(false)
      expect(response.json.calledOnceWithExactly(visible)).to.equal(true)
      expect(targeted.called).to.equal(!filtered)
      if (!filtered) expect(targeted.calledOnceWithExactly(user.id, 'collection_updated', visible)).to.equal(true)
    })
  }

  it('omits inaccessible books from the combined in-progress response', async () => {
    const items = ['allowed', 'private'].map((id) => ({ id, toOldJSONMinified: () => ({ id }) }))
    sinon.stub(Database, 'libraryItemModel').get(() => ({ findAllExpandedWhere: sinon.stub().resolves(items) }))
    const user = {
      checkCanAccessLibraryItem: (item) => item.id === 'allowed',
      mediaProgresses: items.map((item) => ({
        isFinished: false,
        currentTime: 15,
        extraData: { libraryItemId: item.id },
        getOldMediaProgress: () => ({ libraryItemId: item.id, lastUpdate: 1 })
      }))
    }
    const response = { json: sinon.spy() }
    await MeController.getAllLibraryItemsInProgress({ user, query: {} }, response)
    expect(response.json.firstCall.args[0].libraryItems.map((item) => item.id)).to.deep.equal(['allowed'])
  })
})
