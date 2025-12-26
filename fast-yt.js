import fetch from "node-fetch"
import yts from "yt-search"
import axios from "axios"
import crypto from "crypto"
import cheerio from "cheerio"
import ytdl from "ytdl-core"
import { promises as fs } from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { exec } from 'child_process'
import { promisify } from 'util'

const execPromise = promisify(exec)

const fastAgent = {
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 1000, freeSocketTimeout: 60000 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 1000, freeSocketTimeout: 60000 }),
}

async function verificarRepo() {
    try {
        const jsonPath = path.join(process.cwd(), 'package.json')
        const contenido = await fs.readFile(jsonPath, 'utf-8')
        const packageJson = JSON.parse(contenido)
        return packageJson.repository?.url.includes('Shiroko') || packageJson.repository?.url.includes('Nezuko')
    } catch { return false }
}

function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', bright: '\x1b[1m', cyan: '\x1b[36m', red: '\x1b[31m' }
    return isError ? `${codes.red}${codes.bright}[ERROR]${codes.reset} ${text}` : `${codes.cyan}${codes.bright}[SISTEMA]${codes.reset} ${text}`
}

const savetube = {
    api: 'https://media.savetube.me/api',
    download: async (url, type) => {
        const id = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/)[1]
        const { data: { cdn } } = await axios.get(`${savetube.api}/random-cdn`, { ...fastAgent })
        const info = await axios.post(`https://${cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { ...fastAgent })
        const secretKey = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex')
        const encryptedData = Buffer.from(info.data.data, 'base64')
        const decipher = crypto.createDecipheriv('aes-128-cbc', secretKey, encryptedData.slice(0, 16))
        const decrypted = JSON.parse(Buffer.concat([decipher.update(encryptedData.slice(16)), decipher.final()]).toString())
        const dl = await axios.post(`https://${cdn}/api/download`, { id, downloadType: type, quality: type === 'audio' ? '128' : '360', key: decrypted.key }, { ...fastAgent })
        if (dl.data.data.downloadUrl) return { download: dl.data.data.downloadUrl, title: decrypted.title, winner: 'Savetube' }
        throw 1
    }
}

async function ytdlp_engine(url, isAudio) {
    try {
        const format = isAudio ? 'bestaudio/best' : '18/best'
        const { stdout } = await execPromise(`yt-dlp --no-warnings -g -f "${format}" "${url}"`)
        const link = stdout.trim().split('\n')[0]
        if (link && link.startsWith('http')) return { download: link, winner: 'YT-DLP' }
        throw 1
    } catch { throw 1 }
}

async function ytmp3_gg_engine(url) {
    const res = await axios.post('https://hub.y2mp3.co/', { url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128" }, { ...fastAgent })
    if (res.data.url) return { download: res.data.url, winner: 'Ytmp3.gg' }
    throw 1
}

async function raceWithFallback(url, isAudio, title) {
    if (!(await verificarRepo())) return null
    const type = isAudio ? 'audio' : 'video'

    const engines = [
        ytdlp_engine(url, isAudio),
        savetube.download(url, type).catch(() => null),
    ]
    if (isAudio) engines.push(ytmp3_gg_engine(url).catch(() => null))

    try {
        const winner = await Promise.any(engines.filter(e => e !== null))
        if (winner && winner.download) {
            console.log(colorize(`Rayo Ganador: ${winner.winner}`))
            return { ...winner, isBuffer: false }
        }
    } catch {
        const info = await ytdl.getInfo(url)
        const format = ytdl.chooseFormat(info.formats, { quality: isAudio ? '140' : '18' })
        return { download: format.url, title: info.videoDetails.title, winner: 'YTDL-Fallback', isBuffer: false }
    }
}

async function getBufferFromUrl(url) {
    if (Buffer.isBuffer(url)) return url
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' }, ...fastAgent })
    return Buffer.from(res.data)
}

const cleanFileName = (n) => n.replace(/[<>:"/\\|?*]/g, "").substring(0, 50)

async function ytSearch(query) {
    const r = await yts(query)
    return r.videos.map(v => ({ title: v.title, duration: v.timestamp, url: v.url }))
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize, ytSearch, verificarRepo }
