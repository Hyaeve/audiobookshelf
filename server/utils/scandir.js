const Path = require('path')
const { filePathToPOSIX } = require('./fileUtils')

const naturalPathCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const globals = require('./globals')
const LibraryFile = require('../objects/files/LibraryFile')
const parseNameString = require('./parsers/parseNameString')

/**
 * @typedef LibraryItemFilenameMetadata
 * @property {string} title
 * @property {string} subtitle Book mediaType only
 * @property {string} asin Book mediaType only
 * @property {string[]} authors Book mediaType only
 * @property {string[]} narrators Book mediaType only
 * @property {string} seriesName Book mediaType only
 * @property {string} seriesSequence Book mediaType only
 * @property {string} publishedYear Book mediaType only
 */

function isMediaFile(mediaType, ext, audiobooksOnly = false) {
  if (!ext) return false
  const extclean = ext.slice(1).toLowerCase()
  if (mediaType === 'podcast') return globals.SupportedAudioTypes.includes(extclean)
  else if (audiobooksOnly) return globals.SupportedAudioTypes.includes(extclean)
  return globals.SupportedAudioTypes.includes(extclean) || globals.SupportedEbookTypes.includes(extclean)
}

function isScannableNonMediaFile(ext) {
  if (!ext) return false
  const extclean = ext.slice(1).toLowerCase()
  return globals.TextFileTypes.includes(extclean) || globals.MetadataFileTypes.includes(extclean) || globals.SupportedImageTypes.includes(extclean)
}

function checkFilepathIsAudioFile(filepath) {
  const ext = Path.extname(filepath)
  if (!ext) return false
  const extclean = ext.slice(1).toLowerCase()
  return globals.SupportedAudioTypes.includes(extclean)
}
module.exports.checkFilepathIsAudioFile = checkFilepathIsAudioFile

/**
 * @param {string} mediaType
 * @param {import('./fileUtils').FilePathItem[]} fileItems
 * @param {boolean} audiobooksOnly
 * @param {boolean} [includeNonMediaFiles=false] - Used by the watcher to re-scan when covers/metadata files are added/removed
 * @returns {Record<string,string[]>} map of files grouped into potential libarary item dirs
 */
function groupFileItemsIntoLibraryItemDirs(mediaType, fileItems, audiobooksOnly, includeNonMediaFiles = false, topLevelBookAnchor = false) {
  // Step 1: Filter out non-book-media files in root dir (with depth of 0)
  const itemsFiltered = fileItems.filter((i) => {
    return i.deep > 0 || (mediaType === 'book' && isMediaFile(mediaType, i.extension, audiobooksOnly))
  })

  // Step 2: Separate media files and other files
  //     - Directories without a media file will not be included (unless includeNonMediaFiles is true)
  /** @type {import('./fileUtils').FilePathItem[]} */
  const mediaFileItems = []
  /** @type {import('./fileUtils').FilePathItem[]} */
  const otherFileItems = []
  itemsFiltered.forEach((item) => {
    if (isMediaFile(mediaType, item.extension, audiobooksOnly) || (includeNonMediaFiles && isScannableNonMediaFile(item.extension))) {
      mediaFileItems.push(item)
    } else {
      otherFileItems.push(item)
    }
  })

  // Step 3: Optionally group book media at the first directory below the
  // library root. The default preserves the upstream parent-directory grouping.
  const libraryItemGroup = {}
  mediaFileItems.forEach((item) => {
    const dirparts = item.reldirpath.split('/').filter((p) => !!p)

    if (mediaType === 'book' && topLevelBookAnchor && dirparts.length > 0) {
      const libraryItemPath = dirparts[0]
      const relativeFilePath = Path.posix.join(...dirparts.slice(1), item.name)
      if (!libraryItemGroup[libraryItemPath]) libraryItemGroup[libraryItemPath] = []
      libraryItemGroup[libraryItemPath].push(relativeFilePath)
      return
    }

    let _path = ''
    if (!dirparts.length) {
      // Media file in root
      libraryItemGroup[item.name] = item.name
    } else {
      // Preserve the original grouping behavior for non-book media.
      for (let i = 0; i < dirparts.length; i++) {
        const dirpart = dirparts[i]
        _path = Path.posix.join(_path, dirpart)
        const remaining = dirparts.slice(i + 1)

        if (libraryItemGroup[_path]) {
          const relpath = Path.posix.join(remaining.join('/'), item.name)
          libraryItemGroup[_path].push(relpath)
          return
        } else if (!remaining.length) {
          libraryItemGroup[_path] = [item.name]
          return
        } else if (remaining.length === 1 && /^(cd|dis[ck])\s*\d{1,3}$/i.test(remaining[0])) {
          libraryItemGroup[_path] = [Path.posix.join(remaining[0], item.name)]
          return
        }
      }
    }
  })

  // Step 4: Add other files to the same book boundary.
  otherFileItems.forEach((item) => {
    const dirparts = item.reldirpath.split('/').filter((p) => !!p)
    const libraryItemPath = mediaType === 'book' && topLevelBookAnchor ? dirparts[0] : null
    if (libraryItemPath && libraryItemGroup[libraryItemPath]) {
      libraryItemGroup[libraryItemPath].push(Path.posix.join(...dirparts.slice(1), item.name))
      return
    }

    let _path = ''
    for (let i = 0; i < dirparts.length; i++) {
      _path = Path.posix.join(_path, dirparts[i])
      if (libraryItemGroup[_path]) {
        libraryItemGroup[_path].push(Path.posix.join(dirparts.slice(i + 1).join('/'), item.name))
        return
      }
    }
  })

  // A top-level anchored book can contain several nested book folders. Keep
  // their files deterministic: compare the nested folder first and fall back
  // to the filename when no numeric sequence can be inferred from the folder.
  if (mediaType === 'book' && topLevelBookAnchor) {
    Object.keys(libraryItemGroup).forEach((libraryItemPath) => {
      const files = libraryItemGroup[libraryItemPath]
      // Only reorder the common anchored layout where every entry is one file
      // below an A1-level directory. More complex layouts keep the scanner's
      // established traversal order for covers and auxiliary files.
      if (Array.isArray(files) && files.length && files.every((file) => file.split('/').filter(Boolean).length === 2)) {
        files.sort((a, b) => naturalPathCollator.compare(a, b))
      }
    })
  }
  return libraryItemGroup
}
module.exports.groupFileItemsIntoLibraryItemDirs = groupFileItemsIntoLibraryItemDirs

/**
 * Get LibraryFile from filepath
 * @param {string} libraryItemPath
 * @param {string[]} files
 * @returns {import('../objects/files/LibraryFile')}
 */
function buildLibraryFile(libraryItemPath, files) {
  return Promise.all(
    files.map(async (file) => {
      const filePath = Path.posix.join(libraryItemPath, file)
      const newLibraryFile = new LibraryFile()
      await newLibraryFile.setDataFromPath(filePath, file)
      return newLibraryFile
    })
  )
}
module.exports.buildLibraryFile = buildLibraryFile

/**
 * Get details parsed from filenames
 *
 * @param {string} relPath
 * @param {boolean} parseSubtitle
 * @returns {LibraryItemFilenameMetadata}
 */
function getBookDataFromDir(relPath, parseSubtitle = false, topLevelBookAnchor = false) {
  const splitDir = relPath.split('/').filter((part) => !!part)

  let folder
  let series
  let author
  if (topLevelBookAnchor) {
    folder = splitDir.shift() || ''
    series = splitDir.length > 1 ? splitDir.shift() : null
    author = splitDir.length > 0 ? splitDir.shift() : null
  } else {
    folder = splitDir.pop() || ''
    series = splitDir.length > 1 ? splitDir.pop() : null
    author = splitDir.length > 0 ? splitDir.pop() : null
  }

  // Extract optional metadata markers from the first-level folder name.
  let asin
  ;[folder, asin] = getASIN(folder)
  let narrators
  ;[folder, narrators] = getNarrator(folder)
  let sequence
  ;[folder, sequence] = series ? getSequence(folder) : [folder, null]
  let publishedYear
  ;[folder, publishedYear] = getPublishedYear(folder)
  const [title, subtitle] = parseSubtitle ? getSubtitle(folder) : [folder, null]

  return {
    title,
    subtitle,
    asin,
    authors: parseNameString.parse(author)?.names || [],
    narrators: parseNameString.parse(narrators)?.names || [],
    seriesName: series,
    seriesSequence: sequence,
    publishedYear
  }
}
module.exports.getBookDataFromDir = getBookDataFromDir

/**
 * Extract narrator from folder name
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, narrator]
 */
function getNarrator(folder) {
  let pattern = /^(?<title>.*) \{(?<narrators>.*)\}$/
  let match = folder.match(pattern)
  return match ? [match.groups.title, match.groups.narrators] : [folder, null]
}

/**
 * Extract series sequence from folder name
 *
 * @example
 * 'Book 2 - Title - Subtitle'
 * 'Title - Subtitle - Vol 12'
 * 'Title - volume 9 - Subtitle'
 * 'Vol. 3 Title Here - Subtitle'
 * '1980 - Book 2 - Title'
 * 'Volume 12. Title - Subtitle'
 * '100 - Book Title'
 * '6. Title'
 * '0.5 - Book Title'
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, sequence]
 */
function getSequence(folder) {
  // Matches a valid volume string. Also matches a book whose title starts with a 1 to 3 digit number. Will handle that later.
  let pattern = /^(?<volumeLabel>vol\.? |volume |book )?(?<sequence>\d{0,3}(?:\.\d{1,2})?)(?<trailingDot>\.?)(?: (?<suffix>.*))?$/i

  let volumeNumber = null
  let parts = folder.split(' - ')
  for (let i = 0; i < parts.length; i++) {
    let match = parts[i].match(pattern)
    // This excludes '101 Dalmations' but includes '101. Dalmations'
    if (match && !(match.groups.suffix && !(match.groups.volumeLabel || match.groups.trailingDot))) {
      volumeNumber = isNaN(match.groups.sequence) ? match.groups.sequence : Number(match.groups.sequence).toString()
      parts[i] = match.groups.suffix
      if (!parts[i]) {
        parts.splice(i, 1)
      }
      break
    }
  }

  folder = parts.join(' - ')
  return [folder, volumeNumber]
}

/**
 * Extract published year from folder name
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, publishedYear]
 */
function getPublishedYear(folder) {
  var publishedYear = null

  pattern = /^ *\(?([0-9]{4})\)? * - *(.+)/ //Matches #### - title or (####) - title
  var match = folder.match(pattern)
  if (match) {
    publishedYear = match[1]
    folder = match[2]
  }

  return [folder, publishedYear]
}

/**
 * Extract subtitle from folder name
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, subtitle]
 */
function getSubtitle(folder) {
  // Subtitle is everything after " - "
  var splitTitle = folder.split(' - ')
  return [splitTitle.shift(), splitTitle.join(' - ')]
}

/**
 * Extract asin from folder name
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, asin]
 */
function getASIN(folder) {
  let asin = null

  let pattern = /(?: |^)\[([A-Z0-9]{10})](?= |$)/ // Matches "[B0015T963C]"
  const match = folder.match(pattern)
  if (match) {
    asin = match[1]
    folder = folder.replace(match[0], '')
  }
  return [folder.trim(), asin]
}

/**
 *
 * @param {string} relPath
 * @returns {LibraryItemFilenameMetadata}
 */
function getPodcastDataFromDir(relPath) {
  const splitDir = relPath.split('/')

  // Audio files will always be in the directory named for the title
  const title = splitDir.pop()
  return {
    title
  }
}

/**
 *
 * @param {string} libraryMediaType
 * @param {string} folderPath
 * @param {string} relPath
 * @returns {{ mediaMetadata: LibraryItemFilenameMetadata, relPath: string, path: string}}
 */
function getDataFromMediaDir(libraryMediaType, folderPath, relPath, topLevelBookAnchor = false) {
  relPath = filePathToPOSIX(relPath)
  let fullPath = Path.posix.join(folderPath, relPath)
  let mediaMetadata = null

  if (libraryMediaType === 'podcast') {
    mediaMetadata = getPodcastDataFromDir(relPath)
  } else {
    // book
    mediaMetadata = getBookDataFromDir(relPath, !!global.ServerSettings.scannerParseSubtitle, topLevelBookAnchor)
  }

  return {
    mediaMetadata,
    relPath,
    path: fullPath
  }
}
module.exports.getDataFromMediaDir = getDataFromMediaDir
