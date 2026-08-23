//
// node-ffprobe modified for audiobookshelf
// SOURCE: https://github.com/ListenerApproved/node-ffprobe
//

const spawn = require('child_process').spawn

const probeArgs = ['-hide_banner', '-loglevel', 'fatal', '-show_error', '-show_format', '-show_streams', '-show_programs', '-show_chapters', '-show_private_data', '-print_format', 'json']

module.exports = (function () {
  function runProbe(input, isBuffer = false) {
    return new Promise((resolve, reject) => {
      const proc = spawn(module.exports.FFPROBE_PATH || 'ffprobe', [...probeArgs, isBuffer ? 'pipe:0' : input])
      const probeData = []
      const probeErrors = []

      proc.stdout.setEncoding('utf8')
      proc.stderr.setEncoding('utf8')

      proc.stdout.on('data', (data) => probeData.push(data))
      proc.stderr.on('data', (data) => probeErrors.push(data))
      proc.on('error', reject)
      proc.on('close', (code) => {
        try {
          const result = JSON.parse(probeData.join(''))
          resolve(result)
        } catch (error) {
          const stderr = probeErrors.join('').trim()
          reject(new Error(stderr || `ffprobe exited with code ${code} without valid JSON output`, { cause: error }))
        }
      })

      if (isBuffer) {
        // ffprobe may stop reading once it has enough data, causing a harmless EPIPE
        // while the remaining buffer is being written to stdin. The close handler
        // remains the source of truth because it parses ffprobe's complete output.
        proc.stdin.on('error', (error) => {
          if (error.code !== 'EPIPE') reject(error)
        })
        proc.stdin.end(input)
      }
    })
  }

  function doProbe(file) {
    return runProbe(file)
  }

  doProbe.probeBuffer = (buffer) => runProbe(buffer, true)
  return doProbe
})()