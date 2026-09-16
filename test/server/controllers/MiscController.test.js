const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const fs = require('../../../server/libs/fsExtra')
const MiscController = require('../../../server/controllers/MiscController')
const ServerSettings = require('../../../server/objects/settings/ServerSettings')

const scheduledSettings = [
  {
    name: 'Chinese search enhancement',
    hook: 'updateChineseSearchCron',
    payload: {
      chineseSearchCronExpression: '0 6 * * *',
      chineseSearchLibraryIds: ['book-library'],
      chineseSearchMaxHours: 1.5,
      chineseSearchFields: ['title', 'authors']
    }
  },
  {
    name: 'library scanning',
    hook: 'updateScheduledLibraryScanCron',
    payload: {
      scheduledLibraryScanCronExpression: '0 1 * * *',
      scheduledLibraryScanLibraryIds: ['book-library', 'podcast-library'],
      scheduledLibraryScanMaxHours: 2.5
    }
  },
  {
    name: 'book matching',
    hook: 'updateAiBookMatchCron',
    payload: {
      aiBookMatchCronExpression: '0 2 * * *',
      aiBookMatchGlobal: true,
      aiBookMatchOnScan: true,
      aiBookMatchLibraryIds: ['book-library'],
      aiBookMatchMaxHours: 3.5,
      aiBookMatchOverrideFields: ['title', 'authors'],
      aiBookMatchApiUrl: 'https://example.invalid/v1',
      aiBookMatchApiKey: 'test-api-key',
      aiBookMatchModel: 'test-model',
      aiBookMatchConfidence: 0.8
    }
  },
  {
    name: 'book metadata completion',
    hook: 'updateBookMetadataCompletionCron',
    payload: {
      bookMetadataCompletionCronExpression: '0 3 * * *',
      bookMetadataCompletionLibraryIds: ['book-library'],
      bookMetadataCompletionMaxHours: 4.5,
      bookMetadataCompletionFields: ['title', 'coverPath']
    }
  },
  {
    name: 'media pre-read',
    hook: 'updateStrmMetadataCron',
    payload: {
      strmMetadataCompletionCronExpression: '0 4 * * *',
      strmMetadataCompletionLibraryIds: ['book-library'],
      strmMetadataCompletionMaxHours: 5.5,
      strmMetadataCompletionQps: 2.0,
      strmMetadataCompletionBatchSize: 3000
    }
  },
  {
    name: 'missing item cleanup',
    hook: 'updateMissingItemsCleanupCron',
    payload: {
      missingItemsCleanupCronExpression: '0 5 * * *',
      missingItemsCleanupLibraryIds: ['book-library', 'podcast-library']
    }
  }
]

describe('MiscController settings and upstream compatibility', () => {
  let originalMetadataPath
  let settings
  let savedSettings
  let context
  let response
  let libraryModel

  beforeEach(() => {
    originalMetadataPath = global.MetadataPath
    global.MetadataPath = os.tmpdir()
    settings = new ServerSettings()
    savedSettings = null
    sinon.stub(Database, 'serverSettings').value(settings)
    sinon.stub(Database, 'updateServerSettings').callsFake(async () => {
      savedSettings = JSON.parse(JSON.stringify(settings.toJSON()))
    })
    libraryModel = {
      findAll: sinon.stub().resolves([
        { id: 'book-library', mediaType: 'book' },
        { id: 'podcast-library', mediaType: 'podcast' }
      ]),
      findByIdWithFolders: sinon.stub()
    }
    sinon.stub(Database, 'libraryModel').get(() => libraryModel)
    for (const level of ['info', 'warn', 'error', 'debug']) sinon.stub(Logger, level)
    context = {
      cronManager: Object.fromEntries(scheduledSettings.map((task) => [task.hook, sinon.spy()])),
      backupManager: { updateCronSchedule: sinon.spy() },
      auth: { useAuthStrategy: sinon.spy(), unuseAuthStrategy: sinon.spy() }
    }
    response = {
      setHeader: sinon.spy(),
      json: sinon.spy(),
      sendStatus: sinon.spy(),
      status: sinon.stub().returnsThis(),
      send: sinon.spy()
    }
  })

  afterEach(() => {
    sinon.restore()
    if (originalMetadataPath === undefined) delete global.MetadataPath
    else global.MetadataPath = originalMetadataPath
  })

  function update(payload, isAdminOrUp = true) {
    const request = { user: { username: 'test-user', isAdminOrUp }, body: payload }
    return MiscController.updateServerSettings.call(context, request, response)
  }

  for (const task of scheduledSettings) {
    it(`persists and reloads all ${task.name} settings and refreshes its schedule`, async () => {
      const payload = JSON.parse(JSON.stringify(task.payload))
      await update(payload)

      expect(Database.updateServerSettings.calledOnce).to.equal(true)
      const reloaded = new ServerSettings(savedSettings)
      for (const [key, value] of Object.entries(task.payload)) {
        expect(ServerSettings.patchableSettingsKeys.has(key), key).to.equal(true)
        expect(settings[key], key).to.deep.equal(value)
        expect(reloaded[key], key).to.deep.equal(value)
      }
      expect(context.cronManager[task.hook].calledOnce).to.equal(true)
      for (const otherTask of scheduledSettings.filter((candidate) => candidate !== task)) {
        expect(context.cronManager[otherTask.hook].called).to.equal(false)
      }
      const browserSettings = response.json.firstCall.args[0].serverSettings
      expect(browserSettings).not.to.have.property('aiBookMatchApiKey')
      expect(browserSettings).not.to.have.property('tokenSecret')
      if (task.name === 'book matching') expect(browserSettings.aiBookMatchApiConfigured).to.equal(true)
    })

    it(`clears the ${task.name} cron without disabling other schedules`, async () => {
      const cronKey = Object.keys(task.payload).find((key) => key.endsWith('CronExpression'))
      settings[cronKey] = task.payload[cronKey]
      await update({ [cronKey]: '   ' })
      expect(settings[cronKey]).to.equal(null)
      expect(new ServerSettings(savedSettings)[cronKey]).to.equal(null)
      expect(context.cronManager[task.hook].calledOnce).to.equal(true)
      for (const otherTask of scheduledSettings.filter((candidate) => candidate !== task)) {
        expect(context.cronManager[otherTask.hook].called).to.equal(false)
      }
    })
  }

  it('keeps all 28 custom configuration fields in the model whitelist', () => {
    const keys = scheduledSettings.flatMap((task) => Object.keys(task.payload))
    expect(keys).to.have.length(28)
    expect(keys.every((key) => ServerSettings.patchableSettingsKeys.has(key))).to.equal(true)
  })

  it('persists false switches and empty metadata selections', async () => {
    settings.aiBookMatchGlobal = true
    settings.aiBookMatchOnScan = true
    await update({ aiBookMatchGlobal: false, aiBookMatchOnScan: false, aiBookMatchOverrideFields: [], bookMetadataCompletionFields: [] })
    const reloaded = new ServerSettings(savedSettings)
    expect(reloaded.aiBookMatchGlobal).to.equal(false)
    expect(reloaded.aiBookMatchOnScan).to.equal(false)
    expect(reloaded.aiBookMatchOverrideFields).to.deep.equal([])
    expect(reloaded.bookMetadataCompletionFields).to.deep.equal([])
  })

  it('normalizes metadata field order and numeric form input', async () => {
    await update({ aiBookMatchOverrideFields: ['coverPath', 'title', 'title'], bookMetadataCompletionFields: ['coverPath', 'title'], strmMetadataCompletionQps: '0.3', scheduledLibraryScanMaxHours: '2.5' })
    expect(savedSettings.aiBookMatchOverrideFields).to.deep.equal(['title', 'coverPath'])
    expect(savedSettings.bookMetadataCompletionFields).to.deep.equal(['title', 'coverPath'])
    expect(savedSettings.strmMetadataCompletionQps).to.equal(0.3)
    expect(savedSettings.scheduledLibraryScanMaxHours).to.equal(2.5)
  })

  it('filters runtime, internal, authentication and unknown fields before updating the model', async () => {
    const blocked = {
      tokenSecret: 'do-not-write',
      backupPath: '/do-not-write',
      authActiveAuthMethods: [],
      authLoginCustomMessage: '<p>do-not-write</p>',
      sortingPrefixes: ['do-not-write'],
      strmMetadataCompletionLastRun: { finishedAt: 1 },
      missingItemsCleanupLastRun: { finishedAt: 1 },
      bookMetadataCompletionLastRun: { finishedAt: 1 },
      aiBookMatchLastRun: { finishedAt: 1 },
      scheduledLibraryScanLastRun: { finishedAt: 1 },
      chineseSearchLastRun: { finishedAt: 1 },
      unknownSetting: true
    }
    const original = settings.toJSON()
    const modelUpdate = sinon.spy(settings, 'update')
    await update({ ...blocked, language: 'zh-cn' })
    expect(modelUpdate.firstCall.args[0]).to.deep.equal({ language: 'zh-cn' })
    expect(settings.language).to.equal('zh-cn')
    for (const key of Object.keys(blocked)) expect(settings[key], key).to.deep.equal(original[key])
  })

  it('also enforces the whitelist when the settings model is called directly', () => {
    const original = settings.toJSON()
    const result = settings.update(JSON.parse('{"tokenSecret":"changed","scheduledLibraryScanLastRun":{},"authActiveAuthMethods":[],"__proto__":{"polluted":true},"constructor":null,"unknownSetting":true}'))
    expect(result).to.equal(false)
    expect(settings.toJSON()).to.deep.equal(original)
    expect(Object.getPrototypeOf(settings)).to.equal(ServerSettings.prototype)
    expect(settings.constructor).to.equal(ServerSettings)
    expect(settings.polluted).to.equal(undefined)
  })

  it('does not persist or refresh schedules when the payload has no permitted fields', async () => {
    await update({ aiBookMatchLastRun: { finishedAt: 1 }, unknownSetting: true })
    expect(Database.updateServerSettings.called).to.equal(false)
    expect(Object.values(context.cronManager).some((hook) => hook.called)).to.equal(false)
  })

  it('still saves upstream settings and refreshes the backup schedule', async () => {
    await update({ backupSchedule: '0 0 * * *', language: 'zh-cn', allowedOrigins: ['https://example.invalid'] })
    expect(savedSettings.backupSchedule).to.equal('0 0 * * *')
    expect(savedSettings.language).to.equal('zh-cn')
    expect(context.backupManager.updateCronSchedule.calledOnce).to.equal(true)
  })

  it('rejects non-admin settings updates', async () => {
    await update({ aiBookMatchOnScan: true }, false)
    expect(response.sendStatus.calledOnceWithExactly(403)).to.equal(true)
    expect(Database.updateServerSettings.called).to.equal(false)
    expect(settings.aiBookMatchOnScan).to.equal(false)
  })

  const invalidPayloads = [
    { metadataProxyUrl: 123 },
    { metadataProxyUrl: 'socks5://localhost:1080' },
    { metadataProxyUrl: 'http://localhost:7890/path' },
    { metadataProxyUrl: 'http://localhost:7890?token=secret' },
    { chineseSearchCronExpression: 'invalid cron' },
    { chineseSearchFields: ['description'] },
    { chineseSearchFields: 'title' },
    { chineseSearchLibraryIds: ['podcast-library'] },
    { chineseSearchLibraryIds: ['unknown-library'] },
    { chineseSearchLibraryIds: 'book-library' },
    { chineseSearchMaxHours: 0.25 },
    { chineseSearchMaxHours: 'invalid' },
    { aiBookMatchCronExpression: 'invalid cron' },
    { strmMetadataCompletionQps: 0 },
    { strmMetadataCompletionQps: 10.1 },
    { strmMetadataCompletionQps: 2.05 },
    { strmMetadataCompletionBatchSize: 501 },
    { strmMetadataCompletionMaxHours: 0.25 },
    { scheduledLibraryScanMaxHours: 0.25 },
    { aiBookMatchMaxHours: 0.25 },
    { bookMetadataCompletionMaxHours: 0.25 },
    { aiBookMatchGlobal: 'true' },
    { aiBookMatchOnScan: 1 },
    { aiBookMatchConfidence: 1.1 },
    { aiBookMatchApiKey: 123 },
    { aiBookMatchOverrideFields: ['unknown'] },
    { bookMetadataCompletionFields: ['unknown'] },
    { scheduledLibraryScanLibraryIds: ['unknown-library'] },
    { missingItemsCleanupLibraryIds: ['unknown-library'] },
    { aiBookMatchLibraryIds: ['podcast-library'] },
    { bookMetadataCompletionLibraryIds: ['podcast-library'] },
    { strmMetadataCompletionLibraryIds: ['podcast-library'] }
  ]
  for (const payload of invalidPayloads) {
    it(`keeps validation for ${JSON.stringify(payload)}`, async () => {
      await update({ ...payload })
      expect(response.status.calledWith(400)).to.equal(true)
      expect(Database.updateServerSettings.called).to.equal(false)
      expect(Object.values(context.cronManager).some((hook) => hook.called)).to.equal(false)
    })
  }

  it('persists proxy settings without exposing credentials in browser settings', async () => {
    await update({ metadataProxyUrl: '  http://user:secret@localhost:7890  ' })
    expect(savedSettings.metadataProxyUrl).to.equal('http://user:secret@localhost:7890/')
    expect(new ServerSettings(savedSettings).metadataProxyUrl).to.equal(savedSettings.metadataProxyUrl)
    const browser = response.json.firstCall.args[0].serverSettings
    expect(browser).not.to.have.property('metadataProxyUrl')
    expect(browser.metadataProxyConfigured).to.equal(true)
    expect(JSON.stringify(browser)).not.to.include('secret@localhost')
    response.json.resetHistory()
    await update({ metadataProxyUrl: '  ' })
    expect(savedSettings.metadataProxyUrl).to.equal(null)
    expect(response.json.firstCall.args[0].serverSettings.metadataProxyConfigured).to.equal(false)
  })

  it('protects proxy address reads and writes with administrator permission', async () => {
    settings.metadataProxyUrl = 'http://user:secret@localhost:7890/'
    await MiscController.getMetadataProxySettings({ user: { isAdminOrUp: false } }, response)
    expect(response.sendStatus.calledOnceWithExactly(403)).to.equal(true)
    expect(response.json.called).to.equal(false)
    await MiscController.getMetadataProxySettings({ user: { isAdminOrUp: true } }, response)
    expect(response.json.firstCall.args[0].metadataProxyUrl).to.equal(settings.metadataProxyUrl)
    expect(response.setHeader.calledWith('Cache-Control', 'no-store')).to.equal(true)
    await update({ metadataProxyUrl: 'http://other:7890' }, false)
    expect(Database.updateServerSettings.called).to.equal(false)
    expect(settings.metadataProxyUrl).to.equal('http://user:secret@localhost:7890/')
  })

  it('defaults Chinese search to disabled and persists an empty field selection', async () => {
    expect(settings.chineseSearchFields).to.deep.equal([])
    expect(settings.chineseSearchLibraryIds).to.deep.equal([])
    expect(settings.chineseSearchCronExpression).to.equal(null)
    settings.chineseSearchFields = ['title']
    await update({ chineseSearchFields: [] })
    expect(new ServerSettings(savedSettings).chineseSearchFields).to.deep.equal([])
  })

  it('restricts Chinese search run and stop to administrators', async () => {
    for (const method of ['runChineseSearch', 'stopChineseSearch']) {
      response.sendStatus.resetHistory()
      await MiscController[method].call(context, { user: { isAdminOrUp: false } }, response)
      expect(response.sendStatus.calledOnceWithExactly(403)).to.equal(true)
    }
  })

  it('rejects starting Chinese search without fields or libraries', async () => {
    await MiscController.runChineseSearch.call(context, { user: { isAdminOrUp: true } }, response)
    expect(response.status.calledWith(400)).to.equal(true)
  })

  it('sanitizes custom login HTML through the dedicated authentication endpoint', async () => {
    await MiscController.updateAuthSettings.call(context, { user: { isAdminOrUp: true }, body: { authLoginCustomMessage: '<p>Hello <strong>reader</strong><script>alert(1)</script><img src=x onerror=alert(1)></p>' } }, response)
    expect(settings.authLoginCustomMessage).to.equal('<p>Hello <strong>reader</strong></p>')
    expect(savedSettings.authLoginCustomMessage).to.equal(settings.authLoginCustomMessage)
  })

  it('stores a sanitized empty custom login message as null', async () => {
    settings.authLoginCustomMessage = '<p>Previous</p>'
    await MiscController.updateAuthSettings.call(context, { user: { isAdminOrUp: true }, body: { authLoginCustomMessage: '<script>alert(1)</script>' } }, response)
    expect(savedSettings.authLoginCustomMessage).to.equal(null)
  })

  it('returns HTTP 500 when the upload directory cannot be created', async () => {
    libraryModel.findByIdWithFolders.resolves({ id: 'book-library', isPodcast: false, libraryFolders: [{ id: 'folder', path: os.tmpdir() }] })
    sinon.stub(fs, 'ensureDir').rejects(new Error('permission denied'))
    const move = sinon.stub().resolves()
    await MiscController.handleUpload(
      {
        user: { canUpload: true, checkCanAccessLibrary: () => true },
        body: { library: 'book-library', folder: 'folder', title: 'Test upload' },
        files: { audio: { name: 'chapter.mp3', mv: move } }
      },
      response
    )
    expect(response.sendStatus.calledOnceWithExactly(500)).to.equal(true)
    expect(move.called).to.equal(false)
  })
})
