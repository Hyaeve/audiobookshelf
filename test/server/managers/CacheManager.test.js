const { expect } = require('chai')
const sinon = require('sinon')

const CacheManager = require('../../../server/managers/CacheManager')
const Database = require('../../../server/Database')
const fs = require('../../../server/libs/fsExtra')

describe('CacheManager image format validation', () => {
  beforeEach(() => {
    sinon.stub(CacheManager, 'CoverCachePath').value('/metadata/cache/covers')
    sinon.stub(CacheManager, 'ImageCachePath').value('/metadata/cache/images')
    sinon.stub(fs, 'pathExists').resolves(false)
    sinon.stub(Database, 'libraryItemModel').get(() => ({ getCoverPath: async () => null }))
    sinon.stub(Database, 'authorModel').get(() => ({ findByPk: async () => null }))
  })

  afterEach(() => {
    sinon.restore()
  })

  for (const method of ['handleCoverCache', 'handleAuthorCache']) {
    for (const format of ['jpg', 'gif', 'svg', '../png', ['png']]) {
      it(`${method} rejects ${JSON.stringify(format)} before accessing files`, async () => {
        const response = { type: sinon.spy(), sendStatus: sinon.spy() }
        await CacheManager[method](response, 'item', { format })
        expect(response.sendStatus.calledOnceWithExactly(400)).to.equal(true)
        expect(response.type.called).to.equal(false)
        expect(fs.pathExists.called).to.equal(false)
      })
    }

    for (const format of ['webp', 'jpeg', 'png', undefined]) {
      it(`${method} allows ${format || 'the default format'}`, async () => {
        const response = { type: sinon.spy(), sendStatus: sinon.spy() }
        await CacheManager[method](response, 'item', { format })
        expect(response.type.calledOnceWithExactly(`image/${format || 'webp'}`)).to.equal(true)
        expect(fs.pathExists.calledOnce).to.equal(true)
        expect(response.sendStatus.calledOnceWithExactly(404)).to.equal(true)
      })
    }
  }
})
