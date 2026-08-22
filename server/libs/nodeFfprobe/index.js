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

      proc.stdout.setEncoding('utf8')
      proc.stderr.setEncoding('utf8')

      proc.stdout.on('data', (data) => probeData.push(data))
      proc.on('error', reject)
      proc.on('close', (code) => {
        try {
          const result = JSON.parse(probeData.join(''))
          if (code !== 0 && result.error) resolve(result)
          else resolve(result)
        } catch (error) {
          reject(error)
        }
      })

      if (isBuffer) {
        proc.stdin.on('error', reject)
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