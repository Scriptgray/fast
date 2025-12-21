import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"
import { wrapper } from 'axios-cookiejar-support'
import { CookieJar } from 'tough-cookie'
import https from 'https'

const jar = new CookieJar()
const client = wrapper(axios.create({ 
    jar, 
    withCredentials: true,
    httpsAgent: new https.Agent({ 
        keepAlive: true, 
        maxSockets: 100, // Maximiza conexiones simultáneas
        rejectUnauthorized: false 
    })
}))

const CONFIG = {
    V_QUALITY: '360', 
    A_BITRATE: '128',
    TIMEOUT: 10000 
}

// Headers rápidos para evitar bloqueos
const getFastHeaders = () => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
})

const savetube = {
    api: 'https://media.savetube.me/api',
    youtube: (url) => url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/)?.[1],
    
    async download(url, type) {
        const id = this.youtube(url)
        if (!id) return null
        
        try {
            // Obtener CDN directamente con timeout rápido
            const { data: { cdn } } = await client.get(`${this.api}/random-cdn`, { headers: getFastHeaders(), timeout: 5000 })
            
            // Obtener info del video
            const { data: { data: encrypted } } = await client.post(`https://${cdn}${this.api}/v2/info`, { 
                url: `https://www.youtube.com/watch?v=${id}` 
            }, { headers: getFastHeaders() })
            
            // Desencriptación optimizada
            const secret = 'C5D58EF67A7584E4A29F6C35BBC4EB12'
            const buffer = Buffer.from(encrypted, 'base64')
            const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secret, 'hex'), buffer.slice(0, 16))
            const dec = Buffer.concat([decipher.update(buffer.slice(16)), decipher.final()])
            const { key, title } = JSON.parse(dec.toString())

            // Pedir el link de descarga
            const { data: { data: res } } = await client.post(`https://${cdn}${this.api}/download`, {
                id,
                downloadType: type,
                quality: type === 'audio' ? CONFIG.A_BITRATE : CONFIG.V_QUALITY,
                key
            }, { headers: getFastHeaders() })

            return { download: res.downloadUrl, title }
        } catch (e) { return null }
    }
}

async function raceWithFallback(url, isAudio, title) {
    // Intentar Savetube (es el más estable para archivos completos)
    const res = await savetube.download(url, isAudio ? 'audio' : 'video')
    
    if (res?.download) {
        return { 
            download: res.download, 
            title: res.title || title, 
            winner: 'Savetube' 
        }
    }

    // Fallback rápido si el anterior falla
    try {
        if (isAudio) {
            const { data } = await axios.post('https://hub.y2mp3.co/', {
                url, downloadMode: "audio", audioFormat: "mp3", audioBitrate: CONFIG.A_BITRATE
            }, { headers: getFastHeaders(), timeout: 8000 })
            if (data.url) return { download: data.url, title, winner: 'Y2MP3' }
        }
    } catch (e) { }

    return null
}

async function getBufferFromUrl(url) {
    // Usamos un fetch con stream para no saturar la RAM y que sea más rápido
    const response = await fetch(url, { 
        headers: { 'User-Agent': 'Mozilla/5.0' },
        compress: true 
    })
    if (!response.ok) throw new Error(`Falló descarga: ${response.statusText}`)
    return Buffer.from(await response.arrayBuffer())
}

function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', cyan: '\x1b[36m', red: '\x1b[31m' }
    return `${isError ? codes.red : codes.cyan}${text}${codes.reset}`
}

function cleanFileName(n) { 
    return n.replace(/[<>:"/\\|?*]/g, "").substring(0, 50) 
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize }
