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
    } catch { return true }
}

function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', bright: '\x1b[1m', cyan: '\x1b[36m', red: '\x1b[31m' }
    return isError ? `${codes.red}${codes.bright}[ERROR]${codes.reset} ${text}` : `${codes.cyan}${codes.bright}[SISTEMA]${codes.reset} ${text}`
}

async function ytSearch(query) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000) 
    try {
        const res = await Promise.race([
            yts(query),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4500))
        ])
        clearTimeout(timeout)
        return res.videos.slice(0, 5).map(v => ({ title: v.title, duration: v.timestamp, url: v.url }))
    } catch {
        try {
            const { data } = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, { 
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 5000,
                ...fastAgent 
            })
            const $ = cheerio.load(data)
            const firstVideo = $('.yt-uix-tile-link').first()
            if (firstVideo) return [{ title: firstVideo.attr('title'), url: 'https://www.youtube.com' + firstVideo.attr('href') }]
            return []
        } catch { return [] }
    }
}

const savetube = {
    api: 'https://media.savetube.me/api',
    download: async (url, type) => {
        const id = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/)[1]
        const { data: { cdn } } = await axios.get(`${savetube.api}/random-cdn`, { timeout: 3000, ...fastAgent })
        const info = await axios.post(`https://${cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { timeout: 4000, ...fastAgent })
        const secretKey = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex')
        const encryptedData = Buffer.from(info.data.data, 'base64')
        const decipher = crypto.createDecipheriv('aes-128-cbc', secretKey, encryptedData.slice(0, 16))
        const decrypted = JSON.parse(Buffer.concat([decipher.update(encryptedData.slice(16)), decipher.final()]).toString())
        const dl = await axios.post(`https://${cdn}/api/download`, { id, downloadType: type, quality: type === 'audio' ? '128' : '360', key: decrypted.key }, { timeout: 4000, ...fastAgent })
        return { download: dl.data.data.downloadUrl, title: decrypted.title, winner: 'Savetube' }
    }
}

async function ytdlp_engine(url, isAudio) {
    const format = isAudio ? 'bestaudio/best' : '18/best'
    const { stdout } = await execPromise(`yt-dlp --no-warnings --max-downloads 1 --get-url -f "${format}" "${url}"`)
    const link = stdout.trim().split('\n')[0]
    if (link?.startsWith('http')) return { download: link, winner: 'YT-DLP' }
    throw 1
}

async function y2down_engine(url, isAudio) {
    const format = isAudio ? 'mp3' : '360'
    const init = await (await fetch(`https://p.savenow.to/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(url)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`, { timeout: 5000 })).json()
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 800))
        const pd = await (await fetch(`https://p.savenow.to/api/progress?id=${init.id}`)).json()
        if (pd.download_url) return { download: pd.download_url, winner: 'Y2Down' }
    }
    throw 1
}

async function raceWithFallback(url, isAudio, title) {
    if (!(await verificarRepo())) return null
    const type = isAudio ? 'audio' : 'video'

    const engines = [
        ytdlp_engine(url, isAudio).catch(() => null),
        savetube.download(url, type).catch(() => null),
        y2down_engine(url, isAudio).catch(() => null)
    ]

    try {
        const winner = await Promise.any(engines.filter(e => e !== null))
        if (winner) {
            console.log(colorize(`Rayo Ganador: ${winner.winner}`))
            return { ...winner, isBuffer: false }
        }
    } catch {
        const info = await ytdl.getInfo(url).catch(() => null)
        if (!info) return null
        const format = ytdl.chooseFormat(info.formats, { quality: isAudio ? '140' : '18' })
        return { download: format.url, title: info.videoDetails.title, winner: 'YTDL-Fallback', isBuffer: false }
    }
}

async function getBufferFromUrl(url) {
    if (Buffer.isBuffer(url)) return url
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' }, ...fastAgent })
    return Buffer.from(res.data)
}

const cleanFileName = (n) => n ? n.replace(/[<>:"/\\|?*]/g, "").substring(0, 50) : "archivo"

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize, ytSearch, verificarRepo }
