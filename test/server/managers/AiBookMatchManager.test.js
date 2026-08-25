const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')
const AiBookMatchManager = require('../../../server/managers/AiBookMatchManager')

describe('AiBookMatchManager', () => {
  afterEach(() => sinon.restore())

  it('recognizes books with an existing external identifier as already matched', () => {
    assert.strictEqual(AiBookMatchManager.isAlreadyMatched({ media: { isbn: '9780000000000' } }), true)
    assert.strictEqual(AiBookMatchManager.isAlreadyMatched({ media: { asin: 'B000000000' } }), true)
    assert.strictEqual(AiBookMatchManager.isAlreadyMatched({ media: { title: 'Unmatched book' } }), false)
  })

  it('does not treat books needing review as already matched', () => {
    assert.strictEqual(AiBookMatchManager.isAlreadyMatched({ media: { title: 'Needs review' }, extraData: { aiBookMatch: { status: 'needs-review' } } }), false)
    assert.strictEqual(AiBookMatchManager.isAlreadyMatched({ media: { title: 'Matched by AI' }, extraData: { aiBookMatch: { status: 'matched-ai' } } }), true)
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

  it('rejects an AI decision that selects a candidate outside the provider result list', async () => {
    sinon.stub(axios, 'post').resolves({ data: { choices: [{ message: { content: JSON.stringify({ candidateIndex: 8, confidence: 0.99, reason: 'invalid' }) } }] } })
    await assert.rejects(() => AiBookMatchManager.chooseCandidate({ media: { title: 'Book' } }, [{ title: 'Only candidate' }], {
      aiBookMatchApiUrl: 'https://example.test/v1',
      aiBookMatchApiKey: 'secret',
      aiBookMatchModel: 'test-model'
    }), /unknown candidate/)
  })
})
