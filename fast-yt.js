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

// Agentes de ultra-velocidad con maxSockets aumentados para evitar embotellamientos
const fastAgent = {
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 1000 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 1000 }),
};

// --- MOTOR DE BÚSQUEDA ANTI-CONGELAMIENTO ---
async function ytSearch(query) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 4000); // Máximo 4 segundos de búsqueda

    try {
        // Intentamos yt-search con timeout
        const searchPromise = yts({ query, signal: controller.signal });
        const results = await searchPromise;
        clearTimeout(id);
        return results.videos.slice(0, 5).map(v => ({
            title: v.title,
            duration: v.timestamp,
            url: v.url,
            thumbnail: v.thumbnail
        }));
    } catch {
        // Si falla o tarda, usamos el Scraper de respaldo (más rápido y directo)
        try {
            const { data } = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 3000,
                ...fastAgent
            });
            const $ = cheerio.load(data);
            const script = $("script").toArray().find(s => $(s).html().includes("var ytInitialData = "));
            const json = JSON.parse($(script).html().split("var ytInitialData = ")[1].split(";")[0]);
            const videos = json.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents;
            
            return videos.filter(v => v.videoRenderer).slice(0, 5).map(v => ({
                title: v.videoRenderer.title.runs[0].text,
                url: `https://www.youtube.com/watch?v=${v.videoRenderer.videoId}`,
                duration: v.videoRenderer.lengthText?.simpleText || "0:00"
            }));
        } catch { return []; }
    }
}

// --- SERVICIOS DE DESCARGA OPTIMIZADOS ---
const savetube = {
    api: 'https://media.savetube.me/api',
    download: async (url, type) => {
        const id = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/)[1];
        const { data: { cdn } } = await axios.get(`${savetube.api}/random-cdn`, { timeout: 2000, ...fastAgent });
        const info = await axios.post(`https://${cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { timeout: 3000, ...fastAgent });
        const secretKey = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex');
        const encryptedData = Buffer.from(info.data.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', secretKey, encryptedData.slice(0, 16));
        const decrypted = JSON.parse(Buffer.concat([decipher.update(encryptedData.slice(16)), decipher.final()]).toString());
        const dl = await axios.post(`https://${cdn}/api/download`, { id, downloadType: type, quality: type === 'audio' ? '128' : '360', key: decrypted.key }, { timeout: 3000, ...fastAgent });
        return { download: dl.data.data.downloadUrl, title: decrypted.title, winner: 'Savetube' };
    }
};

async function ytdlp_engine(url, isAudio) {
    try {
        const format = isAudio ? 'bestaudio/best' : '18/best';
        // Comando optimizado para extraer SOLO el URL sin procesar nada más
        const { stdout } = await execPromise(`yt-dlp --no-warnings --max-downloads 1 --get-url -f "${format}" "${url}"`, { timeout: 8000 });
        const link = stdout.trim().split('\n')[0];
        if (link?.startsWith('http')) return { download: link, winner: 'YT-DLP' };
    } catch { throw 1; }
}

async function y2down_engine(url, isAudio) {
    try {
        const format = isAudio ? 'mp3' : '360';
        const init = await axios.get(`https://p.savenow.to/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(url)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`, { timeout: 3000 });
        for (let i = 0; i < 8; i++) { // Max 8 intentos (milisegundos)
            await new Promise(r => setTimeout(r, 600));
            const pd = await axios.get(`https://p.savenow.to/api/progress?id=${init.data.id}`, { timeout: 2000 });
            if (pd.data.download_url) return { download: pd.data.download_url, winner: 'Y2Down' };
        }
    } catch { throw 1; }
}

// --- CARRERA SIN DELAY ---
async function raceWithFallback(url, isAudio, title) {
    const type = isAudio ? 'audio' : 'video';
    
    // Lanzamos todos los motores al mismo tiempo
    const engines = [
        ytdlp_engine(url, isAudio).catch(() => null),
        savetube.download(url, type).catch(() => null),
        y2down_engine(url, isAudio).catch(() => null)
    ];

    try {
        // Promise.any entrega la primera que responda BIEN
        const winner = await Promise.any(engines.filter(e => e !== null).map(p => p.then(res => res ? res : Promise.reject())));
        return { ...winner, isBuffer: false };
    } catch {
        // Fallback final ultra-seguro
        try {
            const info = await ytdl.getInfo(url);
            const format = ytdl.chooseFormat(info.formats, { quality: isAudio ? '140' : '18' });
            return { download: format.url, title: info.videoDetails.title, winner: 'Fallback-Final', isBuffer: false };
        } catch { return null; }
    }
}

async function getBufferFromUrl(url) {
    if (Buffer.isBuffer(url)) return url;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' }, ...fastAgent });
    return Buffer.from(res.data);
}

const cleanFileName = (n) => n ? n.replace(/[<>:"/\\|?*]/g, "").substring(0, 50) : "archivo";

export { raceWithFallback, cleanFileName, getBufferFromUrl, ytSearch };
