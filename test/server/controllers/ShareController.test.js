const { expect } = require('chai')
const sinon = require('sinon')

const ShareController = require('../../../server/controllers/ShareController')
const ShareManager = require('../../../server/managers/ShareManager')

describe('ShareController missing share responses', () => {
  beforeEach(() => {
    sinon.stub(ShareManager, 'findBySlug').returns(null)
  })

  afterEach(() => {
    sinon.restore()
  })

  for (const method of ['getMediaItemShareCoverImage', 'getMediaItemShareAudioTrack', 'downloadMediaItemShare', 'updateMediaItemShareProgress']) {
    it(`${method} ends the response with HTTP 404`, async () => {
      const request = { params: { slug: 'missing', index: '0' }, cookies: { share_session_id: 'session' }, body: { currentTime: 1 } }
      const response = { status: sinon.stub().returnsThis(), sendStatus: sinon.spy() }
      await ShareController[method](request, response)
      expect(response.sendStatus.calledOnceWithExactly(404)).to.equal(true)
    })
  }
})
