const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const Database = require('../../../server/Database')
const ServerSettings = require('../../../server/objects/settings/ServerSettings')
const LibraryController = require('../../../server/controllers/LibraryController')
const manager = require('../../../server/managers/ChineseSearchManager')
const TaskManager = require('../../../server/managers/TaskManager')
const Logger = require('../../../server/Logger')

describe('Chinese search SQLite integration and incremental maintenance', () => {
  let sequelize
  let settings
  let library
  let folder
  let user
  let task
  let originalMetadataPath
  let originalGlobals

  beforeEach(async () => {
    originalMetadataPath = global.MetadataPath
    originalGlobals = global.ServerSettings
    global.MetadataPath = require('os').tmpdir()
    global.ServerSettings = { sortingPrefixes: [] }
    settings = new ServerSettings()
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    sequelize.uppercaseFirst = (value) => (value ? value[0].toUpperCase() + value.slice(1) : '')
    sinon.stub(Database, 'sequelize').value(sequelize)
    sinon.stub(Database, 'serverSettings').value(settings)
    sinon.stub(Database, 'updateServerSettings').resolves()
    for (const level of ['warn', 'info', 'debug']) sinon.stub(Logger, level)
    await Database.buildModels()
    library = await Database.libraryModel.create({ name: '中文测试', mediaType: 'book' })
    folder = await Database.libraryFolderModel.create({ path: '/chinese-test', libraryId: library.id })
    user = Database.userModel.build({
      username: 'reader',
      type: 'user',
      permissions: {
        ...Database.userModel.getDefaultPermissionsForUserType('user'),
        accessAllLibraries: false,
        librariesAccessible: [library.id],
        accessExplicitContent: false,
        accessAllTags: false,
        itemTagsSelected: ['allowed'],
        selectedTagsNotAccessible: false
      }
    })
    task = { data: {}, setFinished: sinon.spy(), setFailed: sinon.spy() }
    sinon.stub(TaskManager, 'createAndAddTask').returns(task)
    sinon.stub(TaskManager, 'updateTaskProgress')
    sinon.stub(TaskManager, 'taskFinished')
    settings.chineseSearchFields = ['title', 'subtitle', 'authors', 'narrators']
    settings.chineseSearchLibraryIds = [library.id]
  })

  afterEach(async () => {
    clearTimeout(manager.timer)
    manager.timer = null
    await manager.drain()
    manager.running = false
    manager.cancelled = false
    await sequelize.close()
    sinon.restore()
    global.ServerSettings = originalGlobals
    if (originalMetadataPath === undefined) delete global.MetadataPath
    else global.MetadataPath = originalMetadataPath
  })

  async function addBook(title, metadata = {}) {
    const book = await Database.bookModel.create({ title, explicit: false, tags: ['allowed'], audioFiles: [], narrators: [], genres: [], chapters: [], ...metadata })
    const item = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id, path: '/chinese-test/' + book.id })
    return { book, item }
  }

  async function search(query, limit = 12) {
    const response = { json: sinon.spy() }
    await LibraryController.search({ user, library, query: { q: query, limit } }, response)
    return response.json.firstCall.args[0].book.map((entry) => entry.libraryItem.id)
  }

  it('indexes new books automatically and reuses persisted rows without unnecessary writes', async () => {
    const { item } = await addBook('重返五零之传奇人生｜都市穿越')
    await manager.drain()
    expect(await search('cfwl')).to.deep.equal([item.id])
    expect(await search('dscy')).to.deep.equal([item.id])
    expect(await manager.updateItem(item.id)).to.equal(false)
    const restarted = new manager.constructor()
    expect(await restarted.search(user, library.id, 'cfwl', 12)).to.have.length(1)
  })

  it('preserves original search priority, deduplicates and enforces access permissions', async () => {
    const direct = await addBook('wangk 音频')
    const enhanced = await addBook('王凯作品')
    await addBook('王凯限制', { explicit: true })
    await addBook('王凯私密', { tags: ['restricted'] })
    await manager.drain()
    expect(await search('wangk')).to.deep.equal([direct.item.id, enhanced.item.id])
    expect(await search('wangk', 1)).to.deep.equal([direct.item.id])
    expect(await search('王凯')).to.deep.equal([enhanced.item.id])
    expect(await manager.search(user, 'other-library', 'wangk', 12)).to.deep.equal([])
  })

  it('matches subtitles and narrators, and disables deselected fields immediately', async () => {
    const subtitle = await addBook('第一本书', { subtitle: '王凯' })
    const narrator = await addBook('第二本书', { narrators: ['王奎荣'] })
    await manager.drain()
    expect(await search('wangk')).to.have.members([subtitle.item.id, narrator.item.id])
    settings.chineseSearchFields = ['title']
    expect(await search('wangk')).to.deep.equal([])
    settings.chineseSearchFields = []
    expect(await search('第一')).to.deep.equal([subtitle.item.id])
  })

  it('tracks title edits but ignores unrelated audio metadata updates', async () => {
    const { book, item } = await addBook('重返五零')
    await manager.drain()
    book.title = '十日终焉'
    await book.save()
    expect(await search('cfwl')).to.deep.equal([])
    await manager.drain()
    expect(await search('srzy')).to.deep.equal([item.id])
    await Database.bookModel.update({ duration: 900 }, { where: { id: book.id } })
    expect(manager.pending.size).to.equal(0)
    await Database.bookModel.update({ title: '三体' }, { where: { id: book.id } })
    await manager.drain()
    expect(await search('santi')).to.deep.equal([item.id])
  })

  it('updates author links, author renames and association deletion', async () => {
    const { book, item } = await addBook('测试书籍')
    const author = await Database.authorModel.create({ name: '王奎荣', libraryId: library.id })
    await Database.bookAuthorModel.bulkCreate([{ bookId: book.id, authorId: author.id }])
    await manager.drain()
    expect(await search('wangk')).to.deep.equal([item.id])
    author.name = '刘慈欣'
    await author.save()
    await manager.drain()
    expect(await search('lcx')).to.deep.equal([item.id])
    expect(await search('wangk')).to.deep.equal([])
    await Database.bookAuthorModel.destroy({ where: { bookId: book.id } })
    await manager.drain()
    expect(await search('lcx')).to.deep.equal([])
  })

  it('removes deleted or missing books from the index', async () => {
    const { item } = await addBook('三体')
    await manager.drain()
    await item.update({ isMissing: true })
    await manager.drain()
    expect(await manager.model.findByPk(item.id)).to.equal(null)
    await item.update({ isMissing: false })
    await manager.drain()
    expect(await search('st')).to.deep.equal([item.id])
    await item.destroy()
    await manager.drain()
    expect(await manager.model.findByPk(item.id)).to.equal(null)
  })

  it('waits for committed transactions and ignores rollbacks', async () => {
    const { book, item } = await addBook('三体')
    await manager.drain()
    const rolledBack = await sequelize.transaction()
    await Database.bookModel.update({ title: '不会保存' }, { where: { id: book.id }, transaction: rolledBack })
    expect(manager.pending.size).to.equal(0)
    await rolledBack.rollback()
    expect(manager.pending.size).to.equal(0)
    const committed = await sequelize.transaction()
    await Database.bookModel.update({ title: '十日终焉' }, { where: { id: book.id }, transaction: committed })
    expect(manager.pending.size).to.equal(0)
    await committed.commit()
    await manager.drain()
    expect(await search('srzy')).to.deep.equal([item.id])
  })

  it('builds existing books incrementally and records scheduled versus manual execution', async () => {
    settings.chineseSearchFields = []
    await addBook('三体')
    settings.chineseSearchFields = ['title']
    const first = await manager.run(true)
    expect(first).to.include({ processed: 1, updated: 1, cancelled: false, scheduledTask: true })
    expect(settings.chineseSearchLastRun).to.deep.equal(first)
    expect(task.setFinished.calledOnce).to.equal(true)
    const second = await manager.run(false)
    expect(second).to.include({ updated: 0, skipped: 1, scheduledTask: false })
    expect(TaskManager.taskFinished.calledTwice).to.equal(true)
  })

  it('guards concurrent runs and supports cancellation and deadlines', async () => {
    settings.chineseSearchFields = []
    await addBook('三体')
    settings.chineseSearchFields = ['title']
    const update = manager.updateItem.bind(manager)
    const stub = sinon.stub(manager, 'updateItem').callsFake(async (id) => {
      expect(await manager.run()).to.deep.equal({ skipped: true })
      manager.cancel()
      return update(id)
    })
    expect((await manager.run()).cancelled).to.equal(true)
    stub.restore()
    settings.chineseSearchMaxHours = -1
    expect(await manager.run()).to.include({ processed: 0, cancelled: true })
    expect(manager.running).to.equal(false)
  })

  it('reports failures, releases the run lock and lets a subsequent run recover', async () => {
    settings.chineseSearchFields = []
    await addBook('三体')
    settings.chineseSearchFields = ['title']
    const stub = sinon.stub(manager, 'updateItem').rejects(new Error('test failure'))
    try {
      await manager.run()
      throw new Error('expected failure')
    } catch (error) {
      expect(error.message).to.equal('test failure')
    }
    expect(task.setFailed.calledOnce).to.equal(true)
    expect(manager.running).to.equal(false)
    stub.restore()
    expect((await manager.run()).updated).to.equal(1)
  })
})
