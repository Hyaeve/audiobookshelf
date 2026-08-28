const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')
const Database = require('../../../server/Database')
const AiBookMatchManager = require('../../../server/managers/AiBookMatchManager')
const BookFinder = require('../../../server/finders/BookFinder')
const Scanner = require('../../../server/scanner/Scanner')

describe('AiBookMatchManager', () => {
  beforeEach(() => {
    AiBookMatchManager.noteAiSuccess()
    // Retry backoff is not exercised in unit tests
    sinon.stub(AiBookMatchManager, 'wait').resolves()
  })

  afterEach(() => {
    sinon.restore()
    AiBookMatchManager.noteAiSuccess()
  })

  it('only treats books with title, description, and scan data as unmatched candidates', () => {
    const libraryItem = {
      media: {
        title: 'Folder title',
        description: 'Folder description',
        duration: 3600,
        audioFiles: [{ ino: '1', duration: 3600 }],
        chapters: [{ id: 0, start: 0, end: 3600 }]
      },
      libraryFiles: [{ ino: '1', metadata: { size: 1024 } }]
    }
    assert.strictEqual(AiBookMatchManager.isUnmatchedCandidate(libraryItem), true)
    assert.strictEqual(AiBookMatchManager.isAlreadyMatched(libraryItem), false)
  })

  it('excludes books with any external metadata from AI matching', () => {
    const externalFields = {
      subtitle: 'Subtitle',
      publishedYear: '2024',
      publishedDate: '2024-01-01',
      publisher: 'Publisher',
      isbn: '9780000000000',
      asin: 'B000000000',
      language: 'zh',
      authorName: 'Author',
      narrators: ['Narrator'],
      tags: ['Tag'],
      genres: ['Genre'],
      series: [{ name: 'Series' }],
      authors: [{ name: 'Author' }]
    }
    for (const [field, value] of Object.entries(externalFields)) {
      assert.strictEqual(AiBookMatchManager.isUnmatchedCandidate({ media: { title: 'Book', [field]: value } }), false, field)
    }
    assert.strictEqual(AiBookMatchManager.isUnmatchedCandidate({ media: { title: 'Book', coverPath: '/covers/book.jpg' } }), true)
  })

  it('allows failed AI matches to retry but excludes successful AI matches', () => {
    assert.strictEqual(AiBookMatchManager.isUnmatchedCandidate({ media: { title: 'Needs review' }, extraData: { aiBookMatch: { status: 'needs-review' } } }), true)
    assert.strictEqual(AiBookMatchManager.isUnmatchedCandidate({ media: { title: 'Unmatched' }, extraData: { aiBookMatch: { status: 'unmatched' } } }), true)
    assert.strictEqual(AiBookMatchManager.isUnmatchedCandidate({ media: { title: 'Matched by AI' }, extraData: { aiBookMatch: { status: 'matched-ai' } } }), false)
  })

  it('pre-filters a batch to unmatched candidates only', () => {
    const unmatched = { id: 'unmatched', media: { title: 'Folder title', description: 'Description' } }
    const matched = { id: 'matched', media: { title: 'Matched', publisher: 'Publisher' } }
    assert.deepStrictEqual(AiBookMatchManager.getUnmatchedCandidates([matched, unmatched]), [unmatched])
  })

  it('extracts a quoted title locally without changing it', () => {
    assert.strictEqual(AiBookMatchManager.extractLocalTitle('《天启之门》主播：白鲸剧场 1824集完'), '天启之门')
    assert.strictEqual(AiBookMatchManager.extractLocalTitle('没有书名号的名称'), '')
  })

  it('extracts the segment before the first separator when there is no quoted title', () => {
    assert.strictEqual(AiBookMatchManager.extractSeparatorTitle('橙红年代丨骁骑校丨主播paul'), '橙红年代')
    assert.strictEqual(AiBookMatchManager.extractSeparatorTitle('大道朝天.演播北冥有声.猫腻.2020'), '大道朝天')
    assert.strictEqual(AiBookMatchManager.extractSeparatorTitle('明朝那些事儿-当年明月'), '明朝那些事儿')
    assert.strictEqual(AiBookMatchManager.extractSeparatorTitle('没有分隔符号的名称'), '')
  })

  it('prefers the quoted rule over the separator rule', () => {
    assert.deepStrictEqual(AiBookMatchManager.extractLocalTitleWithRule('《天启之门》丨跳舞丨主播paul'), { title: '天启之门', rule: 'quoted' })
    assert.deepStrictEqual(AiBookMatchManager.extractLocalTitleWithRule('橙红年代丨骁骑校'), { title: '橙红年代', rule: 'separator' })
    assert.deepStrictEqual(AiBookMatchManager.extractLocalTitleWithRule('创造吧昆虫战斗卡'), { title: '', rule: null })
  })

  it('builds local attempts without calling AI and always ends with the full name', async () => {
    const postStub = sinon.stub(axios, 'post').rejects(new Error('AI must not be called'))
    const attempts = await AiBookMatchManager.buildMatchAttempts({ media: { title: '《天启之门》著：跳舞' } }, { aiBookMatchApiUrl: 'https://example.test/v1', aiBookMatchApiKey: 'secret', aiBookMatchModel: 'test-model' })
    assert.deepStrictEqual(
      attempts.map((attempt) => [attempt.rule, attempt.title, attempt.author]),
      [
        ['quoted', '天启之门', ''],
        ['full-name', '《天启之门》著：跳舞', '']
      ]
    )
    assert.strictEqual(postStub.called, false)
  })

  it('builds AI title+author and AI title attempts only when no local rule matches', async () => {
    sinon.stub(AiBookMatchManager, 'extractSearchMetadata').resolves({ title: '创造吧昆虫战斗卡', authors: ['保林叔叔'], narrators: ['paul'], author: '保林叔叔, paul' })
    const attempts = await AiBookMatchManager.buildMatchAttempts({ media: { title: '创造吧昆虫战斗卡 保林叔叔 主播paul' } }, { aiBookMatchApiUrl: 'https://example.test/v1', aiBookMatchApiKey: 'secret', aiBookMatchModel: 'test-model' })
    assert.deepStrictEqual(
      attempts.map((attempt) => [attempt.rule, attempt.title, attempt.author]),
      [
        ['ai-title-author', '创造吧昆虫战斗卡', '保林叔叔, paul'],
        ['ai-title', '创造吧昆虫战斗卡', ''],
        ['full-name', '创造吧昆虫战斗卡 保林叔叔 主播paul', '']
      ]
    )
  })

  it('falls back to the full name only when AI is not configured', async () => {
    const postStub = sinon.stub(axios, 'post').rejects(new Error('AI must not be called'))
    const attempts = await AiBookMatchManager.buildMatchAttempts({ media: { title: '创造吧昆虫战斗卡 保林叔叔' } }, {})
    assert.deepStrictEqual(
      attempts.map((attempt) => [attempt.rule, attempt.title]),
      [['full-name', '创造吧昆虫战斗卡 保林叔叔']]
    )
    assert.strictEqual(postStub.called, false)
  })

  it('keeps a locally confirmed title when AI extraction fails', async () => {
    const postStub = sinon.stub(axios, 'post').rejects(new Error('timeout'))
    const libraryItem = { media: { title: '《天启之门》主播：白鲸剧场 1824集完' } }
    const localTitle = AiBookMatchManager.extractLocalTitle(libraryItem.media.title)
    assert.strictEqual(localTitle, '天启之门')
    await assert.rejects(() => AiBookMatchManager.extractSearchMetadata(libraryItem, {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    }), /timeout/)
    assert.strictEqual(postStub.callCount, 3)
  })

  it('retries a 503 from the AI endpoint and succeeds on a later attempt', async () => {
    const error503 = new Error('Request failed with status code 503')
    error503.response = { status: 503, headers: {} }
    const postStub = sinon.stub(axios, 'post')
    postStub.onFirstCall().rejects(error503)
    postStub.onSecondCall().resolves({ data: { choices: [{ message: { content: JSON.stringify({ title: '恶魔法则', authors: ['跳舞'], narrators: ['一种侃侃'] }) } }] } })

    const metadata = await AiBookMatchManager.extractSearchMetadata({ media: { title: '恶魔法则_演播一种侃侃_跳舞_2023' } }, {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    })
    assert.strictEqual(metadata.title, '恶魔法则')
    assert.strictEqual(postStub.callCount, 2)
  })

  it('does not retry a 401 from the AI endpoint', async () => {
    const error401 = new Error('Request failed with status code 401')
    error401.response = { status: 401, headers: {} }
    const postStub = sinon.stub(axios, 'post').rejects(error401)
    await assert.rejects(() => AiBookMatchManager.extractSearchMetadata({ media: { title: '无分隔名称' } }, {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    }), /401/)
    assert.strictEqual(postStub.callCount, 1)
  })

  it('opens the AI circuit breaker after repeated failures and keeps matching locally', () => {
    const settings = { aiBookMatchApiUrl: 'https://example.test/v1', aiBookMatchApiKey: 'secret', aiBookMatchModel: 'test-model' }
    const error503 = new Error('Request failed with status code 503')
    error503.response = { status: 503, headers: {} }

    assert.strictEqual(AiBookMatchManager.isAiUsable(settings), true)
    AiBookMatchManager.noteAiFailure(error503, 'AI 书名提取')
    AiBookMatchManager.noteAiFailure(error503, 'AI 书名提取')
    assert.strictEqual(AiBookMatchManager.isAiUsable(settings), true)
    AiBookMatchManager.noteAiFailure(error503, 'AI 书名提取')
    assert.strictEqual(AiBookMatchManager.isAiUsable(settings), false)
    assert.strictEqual(AiBookMatchManager.isConfigured(settings), true)

    AiBookMatchManager.noteAiSuccess()
    assert.strictEqual(AiBookMatchManager.isAiUsable(settings), true)
  })

  it('falls back to the first provider candidate when the AI candidate decision fails', async () => {
    sinon.stub(Database, 'serverSettings').value({ aiBookMatchConfidence: 0.9, aiBookMatchApiUrl: 'https://example.test/v1', aiBookMatchApiKey: 'secret', aiBookMatchModel: 'test-model' })
    const error503 = new Error('Request failed with status code 503')
    error503.response = { status: 503, headers: {} }
    sinon.stub(BookFinder, 'search').resolves([{ title: '恶魔法则' }])
    const chooseStub = sinon.stub(AiBookMatchManager, 'chooseCandidate').rejects(error503)
    const applyStub = sinon.stub(Scanner, 'applyBookMatch').resolves({ updated: true })
    const auditStub = sinon.stub(AiBookMatchManager, 'saveAudit').resolves()

    const result = await AiBookMatchManager.matchLibraryItem({}, {
      isBook: true,
      media: { title: '恶魔法则.演播一种侃侃.跳舞.2023' }
    }, { provider: 'google' })

    assert.strictEqual(chooseStub.calledOnce, true)
    assert.strictEqual(applyStub.calledOnce, true)
    assert.strictEqual(result.status, 'matched')
    assert.strictEqual(result.rule, 'separator')
    assert.strictEqual(result.searchTitle, '恶魔法则')
    assert.strictEqual(auditStub.firstCall.args[1].status, 'matched-local')
    assert.strictEqual(auditStub.firstCall.args[1].source, 'local')
  })

  it('extracts title, authors, and narrators for search metadata', async () => {
    sinon.stub(axios, 'post').resolves({ data: { choices: [{ message: { content: JSON.stringify({ title: '橙红年代', authors: ['骁骑校'], narrators: ['paul'] }) } }] } })
    const metadata = await AiBookMatchManager.extractSearchMetadata({ media: { title: '橙红年代丨骁骑校丨主播paul' }, relPath: '不应被使用' }, {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    })
    assert.deepStrictEqual(metadata, { title: '橙红年代', authors: ['骁骑校'], narrators: ['paul'], author: '骁骑校, paul' })
    assert.strictEqual(JSON.parse(axios.post.firstCall.args[1].messages[1].content).unprocessedBookName, '橙红年代丨骁骑校丨主播paul')
  })

  it('deduplicates an author repeated as narrator', async () => {
    sinon.stub(axios, 'post').resolves({ data: { choices: [{ message: { content: JSON.stringify({ title: '大道朝天', authors: ['猫腻'], narrators: ['北冥有声', '猫腻'] }) } }] } })
    const metadata = await AiBookMatchManager.extractSearchMetadata({ media: { title: '大道朝天.演播北冥有声.猫腻.2020' } }, {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    })
    assert.strictEqual(metadata.author, '猫腻, 北冥有声')
  })

  it('accepts alternate AI metadata field names and fenced JSON', async () => {
    sinon.stub(axios, 'post').resolves({ data: { choices: [{ message: { content: '```json\n{"bookTitle":"创造吧！昆虫战斗卡","author":"保林叔叔","narrator":"主播paul"}\n```' } }] } })
    const metadata = await AiBookMatchManager.extractSearchMetadata({ media: { title: '创造吧！昆虫战斗卡' } }, {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    })
    assert.strictEqual(metadata.title, '创造吧！昆虫战斗卡')
    assert.strictEqual(metadata.author, '保林叔叔, 主播paul')
  })

  it('accepts a valid OpenAI-compatible candidate decision', async () => {
    sinon.stub(axios, 'post').resolves({ data: { choices: [{ message: { content: JSON.stringify({ candidateIndex: 1, confidence: 0.96, reason: 'title and author agree' }) } }] } })
    const decision = await AiBookMatchManager.chooseCandidate({ media: { title: 'Book', authorName: 'Author' } }, [{ title: 'Wrong' }, { title: 'Book' }], {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    })
    assert.deepStrictEqual(decision, { candidateIndex: 1, confidence: 0.96, reason: 'title and author agree' })
    assert.strictEqual(axios.post.firstCall.args[0], 'https://example.test/v1/chat/completions')
  })

  it('retries provider search without author when title and author return no results', async () => {
    sinon.stub(AiBookMatchManager, 'isConfigured').returns(true)
    sinon.stub(Database, 'serverSettings').value({ aiBookMatchConfidence: 0.9 })
    sinon.stub(AiBookMatchManager, 'extractSearchMetadata').resolves({ title: '天启之门', authors: ['跳舞'], narrators: [], author: '跳舞' })
    const searchStub = sinon.stub(BookFinder, 'search')
    searchStub.onFirstCall().resolves([])
    searchStub.onSecondCall().resolves([{ title: '天启之门' }])
    sinon.stub(AiBookMatchManager, 'chooseCandidate').resolves({ candidateIndex: 0, confidence: 0.95, reason: 'title agrees' })
    sinon.stub(Scanner, 'applyBookMatch').resolves({ updated: true })
    sinon.stub(AiBookMatchManager, 'saveAudit').resolves()

    const result = await AiBookMatchManager.matchLibraryItem({}, {
      isBook: true,
      media: { title: '天启之门 著 跳舞' }
    }, { provider: 'google' })

    assert.strictEqual(searchStub.firstCall.args[2], '天启之门')
    assert.strictEqual(searchStub.firstCall.args[3], '跳舞')
    assert.strictEqual(searchStub.secondCall.args[2], '天启之门')
    assert.strictEqual(searchStub.secondCall.args[3], null)
    assert.strictEqual(result.status, 'matched')
    assert.strictEqual(result.rule, 'ai-title')
    assert.strictEqual(result.searchAuthor, '')
  })

  it('falls back through separator and full name rules without AI', async () => {
    sinon.stub(AiBookMatchManager, 'isConfigured').returns(false)
    sinon.stub(Database, 'serverSettings').value({ aiBookMatchConfidence: 0.9 })
    const searchStub = sinon.stub(BookFinder, 'search')
    searchStub.onFirstCall().resolves([])
    searchStub.onSecondCall().resolves([{ title: '橙红年代丨骁骑校' }])
    const chooseStub = sinon.stub(AiBookMatchManager, 'chooseCandidate').rejects(new Error('AI must not be called'))
    const applyStub = sinon.stub(Scanner, 'applyBookMatch').resolves({ updated: true })
    sinon.stub(AiBookMatchManager, 'saveAudit').resolves()

    const result = await AiBookMatchManager.matchLibraryItem({}, {
      isBook: true,
      media: { title: '橙红年代丨骁骑校' }
    }, { provider: 'google' })

    assert.strictEqual(searchStub.firstCall.args[2], '橙红年代')
    assert.strictEqual(searchStub.secondCall.args[2], '橙红年代丨骁骑校')
    assert.strictEqual(chooseStub.called, false)
    assert.strictEqual(applyStub.calledOnce, true)
    assert.strictEqual(result.status, 'matched')
    assert.strictEqual(result.rule, 'full-name')
  })

  it('skips matched books unless global matching is enabled', async () => {
    const libraryItem = { isBook: true, media: { title: 'Matched book', isbn: '9780000000000' } }
    const skipped = await AiBookMatchManager.matchLibraryItem({}, libraryItem, { provider: 'google' })
    assert.strictEqual(skipped.status, 'skipped')

    sinon.stub(AiBookMatchManager, 'isConfigured').returns(true)
    sinon.stub(Database, 'serverSettings').value({ aiBookMatchConfidence: 0.9 })
    sinon.stub(AiBookMatchManager, 'extractSearchMetadata').resolves({ title: 'Matched book', authors: [], narrators: [], author: '' })
    sinon.stub(BookFinder, 'search').resolves([])
    sinon.stub(AiBookMatchManager, 'saveAudit').resolves()

    const globalResult = await AiBookMatchManager.matchLibraryItem({}, libraryItem, { provider: 'google' }, { globalMatch: true })
    assert.strictEqual(globalResult.status, 'unmatched')
  })

  it('rejects an AI decision that selects a candidate outside the provider result list', async () => {
    sinon.stub(axios, 'post').resolves({ data: { choices: [{ message: { content: JSON.stringify({ candidateIndex: 8, confidence: 0.99, reason: 'invalid' }) } }] } })
    await assert.rejects(() => AiBookMatchManager.chooseCandidate({ media: { title: 'Book' } }, [{ title: 'Only candidate' }], {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    }), /unknown candidate/)
  })
})
