const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')
const Database = require('../../../server/Database')
const AiBookMatchManager = require('../../../server/managers/AiBookMatchManager')
const BookFinder = require('../../../server/finders/BookFinder')

describe('AiBookMatchManager', () => {
  afterEach(() => sinon.restore())

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

  it('keeps a locally confirmed title when AI extraction fails', async () => {
    sinon.stub(axios, 'post').rejects(new Error('timeout'))
    const libraryItem = { media: { title: '《天启之门》主播：白鲸剧场 1824集完' } }
    const localTitle = AiBookMatchManager.extractLocalTitle(libraryItem.media.title)
    assert.strictEqual(localTitle, '天启之门')
    await assert.rejects(() => AiBookMatchManager.extractSearchMetadata(libraryItem, {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    }), /timeout/)
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
    sinon.stub(AiBookMatchManager, 'chooseCandidate').resolves({ candidateIndex: null, confidence: 0.5, reason: 'review' })
    sinon.stub(AiBookMatchManager, 'saveAudit').resolves()

    const result = await AiBookMatchManager.matchLibraryItem({}, {
      isBook: true,
      media: { title: '《天启之门》著：跳舞' }
    }, { provider: 'google' })

    assert.strictEqual(searchStub.firstCall.args[2], '天启之门')
    assert.strictEqual(searchStub.firstCall.args[3], '跳舞')
    assert.strictEqual(searchStub.secondCall.args[2], '天启之门')
    assert.strictEqual(searchStub.secondCall.args[3], null)
    assert.strictEqual(result.searchAuthor, '')
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
