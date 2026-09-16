const { createHash } = require('crypto')
const { Op } = require('sequelize')
const Logger = require('../Logger')
const { INDEX_VERSION, normalize, normalizeFields, extractFields, buildPayload, matchesPayload } = require('../utils/chineseSearch')

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve))
const fingerprintFor = (libraryId, values) =>
  createHash('sha256')
    .update(JSON.stringify([INDEX_VERSION, libraryId, values]))
    .digest('hex')

class ChineseSearchManager {
  constructor() {
    this.pending = new Set()
    this.timer = null
    this.drainPromise = null
    this.updates = new Map()
    this.running = false
    this.cancelled = false
  }

  get database() {
    return require('../Database')
  }

  get settings() {
    return this.database.serverSettings
  }

  get model() {
    return this.database.models.chineseSearchIndex
  }

  enabled(libraryId) {
    return normalizeFields(this.settings?.chineseSearchFields).length > 0 && (this.settings?.chineseSearchLibraryIds || []).includes(libraryId)
  }

  updateItem(id) {
    const previous = this.updates.get(id) || Promise.resolve()
    const update = previous.catch(() => {}).then(() => this.writeItem(id))
    this.updates.set(id, update)
    return update.finally(() => {
      if (this.updates.get(id) === update) this.updates.delete(id)
    })
  }

  async writeItem(id) {
    const base = await this.database.libraryItemModel.findByPk(id)
    if (!base || base.mediaType !== 'book' || base.isMissing || base.isInvalid || !this.enabled(base.libraryId)) {
      await this.model.destroy({ where: { libraryItemId: id } })
      return false
    }
    const item = await this.database.libraryItemModel.getExpandedById(id)
    if (!item?.media) return false
    const values = extractFields(item, this.settings.chineseSearchFields)
    const fingerprint = fingerprintFor(item.libraryId, values)
    const previous = await this.model.findByPk(id, { attributes: ['fingerprint'] })
    if (previous?.fingerprint === fingerprint) return false
    await this.model.upsert({ libraryItemId: id, libraryId: item.libraryId, fingerprint, payload: buildPayload(values) })
    return true
  }

  enqueue(id) {
    if (!id || !this.model || !normalizeFields(this.settings?.chineseSearchFields).length) return
    this.pending.add(id)
    if (!this.timer && !this.drainPromise) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.drain().catch((error) => Logger.error('[ChineseSearchManager] 增量索引失败', error))
      }, 100)
      this.timer.unref?.()
    }
  }

  drain() {
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = this.processQueue().finally(() => {
      this.drainPromise = null
    })
    return this.drainPromise
  }

  async processQueue() {
    while (this.pending.size) {
      const id = this.pending.values().next().value
      this.pending.delete(id)
      try {
        await this.updateItem(id)
      } catch (error) {
        Logger.warn(`[ChineseSearchManager] 索引更新失败，后续任务可修复：${error.message}`)
      }
      await yieldLoop()
    }
  }

  installHooks(sequelize) {
    for (const name of ['libraryItem', 'book', 'author', 'bookAuthor']) {
      const model = sequelize.models[name]
      const collect = async (records, options) => {
        if (!normalizeFields(this.settings?.chineseSearchFields).length) return []
        if (name === 'libraryItem') return records.map((record) => record.id)
        let bookIds = records.map((record) => (name === 'book' ? record.id : record.bookId)).filter(Boolean)
        if (name === 'author') {
          const links = await sequelize.models.bookAuthor.findAll({ where: { authorId: records.map((record) => record.id) }, attributes: ['bookId'], transaction: options.transaction })
          bookIds = links.map((link) => link.bookId)
        }
        if (!bookIds.length) return []
        const items = await sequelize.models.libraryItem.findAll({ where: { mediaId: bookIds, mediaType: 'book' }, attributes: ['id'], transaction: options.transaction })
        return items.map((item) => item.id)
      }
      const relevant = (keys) => {
        if (name === 'book') return normalizeFields(this.settings?.chineseSearchFields).some((field) => keys.includes(field))
        if (name === 'libraryItem') return ['libraryId', 'mediaId', 'mediaType', 'isMissing', 'isInvalid'].some((field) => keys.includes(field))
        return name === 'author' ? keys.includes('name') : true
      }
      const schedule = (ids, options) => {
        const enqueue = () => ids.forEach((id) => this.enqueue(id))
        if (options.transaction && !options.transaction.finished) options.transaction.afterCommit(enqueue)
        else enqueue()
      }
      const safe =
        (handler) =>
        async (...args) => {
          try {
            return await handler(...args)
          } catch (error) {
            Logger.warn(`[ChineseSearchManager] 索引监听失败，原始操作不受影响；请执行任务刷新：${error.message}`)
          }
        }
      model.addHook(
        'afterSave',
        'chineseSearch',
        safe(async (instance, options) => {
          if (relevant(instance.changed() || [])) schedule(await collect([instance], options), options)
        })
      )
      model.addHook(
        'afterBulkCreate',
        'chineseSearch',
        safe(async (instances, options) => schedule(await collect(instances, options), options))
      )
      model.addHook(
        'beforeDestroy',
        'chineseSearch',
        safe(async (instance, options) => {
          options.chineseSearchIds = await collect([instance], options)
        })
      )
      model.addHook(
        'afterDestroy',
        'chineseSearch',
        safe((instance, options) => schedule(options.chineseSearchIds || [], options))
      )
      for (const operation of ['Update', 'Destroy']) {
        model.addHook(
          `beforeBulk${operation}`,
          'chineseSearch',
          safe(async (options) => {
            if (!normalizeFields(this.settings?.chineseSearchFields).length || (operation === 'Update' && !relevant(Object.keys(options.attributes || {})))) return
            const instances = await model.findAll({ where: options.where, transaction: options.transaction })
            options.chineseSearchIds = await collect(instances, options)
          })
        )
        model.addHook(
          `afterBulk${operation}`,
          'chineseSearch',
          safe((options) => schedule(options.chineseSearchIds || [], options))
        )
      }
    }
  }

  async search(user, libraryId, query, limit, excludedIds = []) {
    if (!this.enabled(libraryId) || !limit || String(query).length > 256) return []
    query = normalize(query)
    if (!query || query.length > 128) return []
    const results = []
    const excluded = new Set(excludedIds)
    let cursor = ''
    while (results.length < limit && this.enabled(libraryId)) {
      const rows = await this.model.findAll({ where: { libraryId, libraryItemId: { [Op.gt]: cursor } }, order: [['libraryItemId', 'ASC']], limit: 200 })
      if (!rows.length) break
      cursor = rows[rows.length - 1].libraryItemId
      for (const row of rows) {
        if (excluded.has(row.libraryItemId) || !matchesPayload(row.payload, this.settings.chineseSearchFields, query)) continue
        const item = await this.database.libraryItemModel.getExpandedById(row.libraryItemId)
        if (!item?.media || item.libraryId !== libraryId || item.isMissing || item.isInvalid || !user.checkCanAccessLibraryItem(item)) continue
        const values = extractFields(item, this.settings.chineseSearchFields)
        if (fingerprintFor(libraryId, values) !== row.fingerprint) {
          this.enqueue(item.id)
          if (!matchesPayload(buildPayload(values), this.settings.chineseSearchFields, query)) continue
        }
        results.push({ libraryItem: item.toOldJSONExpanded() })
        if (results.length >= limit) break
      }
      await yieldLoop()
    }
    return this.enabled(libraryId) ? results : []
  }

  async run(scheduledTask = false) {
    if (this.running || !normalizeFields(this.settings?.chineseSearchFields).length || !this.settings.chineseSearchLibraryIds.length) return { skipped: true }
    this.running = true
    this.cancelled = false
    const TaskManager = require('./TaskManager')
    const startedAt = Date.now()
    const deadline = startedAt + this.settings.chineseSearchMaxHours * 3600000
    const libraryIds = [...this.settings.chineseSearchLibraryIds]
    const task = TaskManager.createAndAddTask('chinese-search', { text: '中文搜索增强' }, null, true, { scheduledTask, progress: 0, libraryIds })
    const result = { processed: 0, updated: 0, skipped: 0, cancelled: false }
    try {
      const total = await this.database.libraryItemModel.count({ where: { libraryId: libraryIds, mediaType: 'book' } })
      Logger.info(`[ChineseSearchManager] 中文搜索增强${scheduledTask ? '计划' : '手动'}任务开始，共 ${total} 本图书`)
      for (const libraryId of libraryIds) {
        let cursor = ''
        while (!this.cancelled && Date.now() < deadline && this.enabled(libraryId)) {
          const items = await this.database.libraryItemModel.findAll({ where: { libraryId, mediaType: 'book', id: { [Op.gt]: cursor } }, attributes: ['id'], order: [['id', 'ASC']], limit: 50 })
          if (!items.length) break
          cursor = items[items.length - 1].id
          for (const item of items) {
            if (this.cancelled || Date.now() >= deadline || !this.enabled(libraryId)) break
            const updated = await this.updateItem(item.id)
            result.processed += 1
            result[updated ? 'updated' : 'skipped'] += 1
          }
          TaskManager.updateTaskProgress(task, total ? Math.min(99, (result.processed / total) * 100) : 100, result)
          await yieldLoop()
        }
      }
      result.cancelled = this.cancelled || Date.now() >= deadline
      if (!result.cancelled) await this.database.sequelize.query('DELETE FROM chineseSearchIndices WHERE libraryItemId NOT IN (SELECT id FROM libraryItems)')
      const finishedAt = Date.now()
      const summary = { startedAt, finishedAt, durationMs: finishedAt - startedAt, scheduledTask, ...result }
      this.settings.chineseSearchLastRun = summary
      await this.database.updateServerSettings()
      task.data.result = summary
      task.setFinished(null, true)
      Logger.info(`[ChineseSearchManager] 中文搜索增强结束：${JSON.stringify(summary)}`)
      return summary
    } catch (error) {
      task.setFailed({ text: `中文搜索增强失败：${error.message}` })
      throw error
    } finally {
      TaskManager.taskFinished(task)
      this.running = false
    }
  }

  cancel() {
    this.cancelled = true
    return this.running
  }
}

module.exports = new ChineseSearchManager()
