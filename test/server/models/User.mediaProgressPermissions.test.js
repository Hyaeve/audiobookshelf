const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')

describe('User media progress access permissions', () => {
  let sequelize
  let library
  let folder
  let user
  let originalSettings

  beforeEach(async () => {
    originalSettings = global.ServerSettings
    global.ServerSettings = { sortingPrefixes: [] }
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    sequelize.uppercaseFirst = (value) => value ? value[0].toUpperCase() + value.slice(1) : ''
    sinon.stub(Database, 'sequelize').value(sequelize)
    for (const level of ['error', 'warn', 'info', 'debug']) sinon.stub(Logger, level)
    await Database.buildModels()
    library = await Database.libraryModel.create({ name: 'Allowed library', mediaType: 'book' })
    folder = await Database.libraryFolderModel.create({ path: '/progress-test', libraryId: library.id })
    user = await Database.userModel.create({
      username: 'progress-reader',
      type: 'user',
      permissions: {
        ...Database.userModel.getDefaultPermissionsForUserType('user'),
        accessAllLibraries: false,
        librariesAccessible: [library.id],
        accessAllTags: false,
        itemTagsSelected: ['allowed'],
        accessExplicitContent: false
      }
    })
    user.mediaProgresses = []
  })

  afterEach(async () => {
    await sequelize.close()
    sinon.restore()
    global.ServerSettings = originalSettings
  })

  async function createMedia(mediaType, metadata = {}) {
    const media = await Database[mediaType === 'book' ? 'bookModel' : 'podcastModel'].create({
      title: 'Progress test', explicit: false, tags: ['allowed'], narrators: [], genres: [], audioFiles: [], chapters: [], ...metadata
    })
    const item = await Database.libraryItemModel.create({ mediaId: media.id, mediaType, libraryId: library.id, libraryFolderId: folder.id, libraryFiles: [] })
    const payload = { libraryItemId: item.id, currentTime: 15, duration: 60 }
    if (mediaType === 'podcast') {
      const episode = await Database.podcastEpisodeModel.create({ podcastId: media.id, title: 'Episode', chapters: [], extraData: {} })
      payload.episodeId = episode.id
    }
    return { item, payload }
  }

  for (const mediaType of ['book', 'podcast']) {
    it(`saves accessible ${mediaType} progress`, async () => {
      const { payload } = await createMedia(mediaType)
      const result = await user.createUpdateMediaProgressFromPayload(payload)
      expect(result.error).to.equal(undefined)
      expect(result.mediaProgress.currentTime).to.equal(15)
      expect(await Database.mediaProgressModel.count()).to.equal(1)
    })

    it(`rejects ${mediaType} progress after library permission is revoked`, async () => {
      const { payload } = await createMedia(mediaType)
      user.permissions = { ...user.permissions, librariesAccessible: [] }
      expect(await user.createUpdateMediaProgressFromPayload(payload)).to.include({ statusCode: 403 })
      expect(await Database.mediaProgressModel.count()).to.equal(0)
    })

    it(`rejects ${mediaType} progress with restricted tags`, async () => {
      const { payload } = await createMedia(mediaType, { tags: ['private'] })
      expect(await user.createUpdateMediaProgressFromPayload(payload)).to.include({ statusCode: 403 })
      expect(await Database.mediaProgressModel.count()).to.equal(0)
    })

    it(`rejects explicit ${mediaType} progress`, async () => {
      const { payload } = await createMedia(mediaType, { explicit: true })
      expect(await user.createUpdateMediaProgressFromPayload(payload)).to.include({ statusCode: 403 })
      expect(await Database.mediaProgressModel.count()).to.equal(0)
    })
  }

  it('rejects an episode belonging to a different library item', async () => {
    const first = await createMedia('podcast')
    const second = await createMedia('podcast')
    const result = await user.createUpdateMediaProgressFromPayload({ ...first.payload, libraryItemId: second.item.id })
    expect(result).to.include({ statusCode: 400, error: 'Episode does not belong to library item' })
    expect(await Database.mediaProgressModel.count()).to.equal(0)
  })
})
