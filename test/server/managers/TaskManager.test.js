const assert = require('assert')
const sinon = require('sinon')
const TaskManager = require('../../../server/managers/TaskManager')
const SocketAuthority = require('../../../server/SocketAuthority')

describe('TaskManager current book activity', () => {
  beforeEach(() => sinon.stub(SocketAuthority, 'emitter'))
  afterEach(() => sinon.restore())

  it('updates the current book identity and keeps progress without exposing cover file paths', () => {
    const task = { id: 'task', action: 'book-metadata-completion', data: { progress: 25 } }
    TaskManager.updateTaskLibraryItem(task, { id: 'first', libraryId: 'library', mediaType: 'book', media: { title: 'First', coverPath: '/private/cover.jpg' } })
    assert.strictEqual(task.data.libraryItemId, 'first')
    assert.strictEqual(task.data.libraryItemTitle, 'First')
    assert.strictEqual(task.data.progress, 25)
    assert.strictEqual(task.data.mediaType, 'book')
    assert.strictEqual(typeof task.data.coverUpdatedAt, 'number')
    assert.strictEqual(task.data.coverPath, undefined)
    TaskManager.updateTaskLibraryItem(task, { id: 'second', libraryId: 'library', mediaType: 'book', media: { title: 'Second' } })
    assert.strictEqual(SocketAuthority.emitter.lastCall.args[1].data.libraryItemId, 'second')
    assert.strictEqual(task.data.libraryItemTitle, 'Second')
  })
})
