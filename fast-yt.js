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
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 1000, freeSocketTimeout: 120000 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 1000, freeSocketTimeout: 120000 }),
};

async function verificarRepo() {
    try {
        const jsonPath = path.join(process.cwd(), 'package.json');
        const contenido = await fs.readFile(jsonPath, 'utf-8');
        const packageJson = JSON.parse(contenido);
        return packageJson.repository?.url.includes('Shiroko') || packageJson.repository?.url.includes('Nezuko');
    } catch { return false }
}

function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', bright: '\x1b[1m', fg: { cyan: '\x1b[36m', red: '\x1b[31m' } }
    if (isError) return `${codes.fg.red}${codes.bright}[ERROR]${codes.reset} ${text}`
    return `${codes.fg.cyan}${codes.bright}[SISTEMA]${codes.reset} ${text}`
}

const CONFIG = {
    POLLING_INTERVAL: 350,
    SAVETUBE_RETRY: 200,
    GLOBAL_TIMEOUT: 45000
}

async function getBufferDirect(url) {
    if (!url) return null;
    try {
        const res = await axios.get(url, { 
            responseType: 'arraybuffer', 
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            ...fastAgent 
        });
        return Buffer.from(res.data);
    } catch { return null; }
}

async function ytdlp_engine(url, isAudio) {
    try {
        const format = isAudio ? 'bestaudio/best' : '18/best';
        const { stdout } = await execPromise(`yt-dlp --no-warnings -g -f "${format}" "${url}"`);
        const link = stdout.trim().split('\n')[0];
        const buffer = await getBufferDirect(link);
        if (buffer) return { buffer, winner: 'YT-DLP' };
        throw 1;
    } catch { throw new Error() }
}

const savetube = {
    api: 'https://media.savetube.me/api',
    download: async (url, type) => {
        const id = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/)[1];
        const { data: { cdn } } = await axios.get(`${savetube.api}/random-cdn`, { ...fastAgent });
        const info = await axios.post(`https://${cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { ...fastAgent });
        const secretKey = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex');
        const encryptedData = Buffer.from(info.data.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', secretKey, encryptedData.slice(0, 16));
        const decrypted = JSON.parse(Buffer.concat([decipher.update(encryptedData.slice(16)), decipher.final()]).toString());
        const dl = await axios.post(`https://${cdn}/api/download`, { id, downloadType: type, quality: type === 'audio' ? '128' : '360', key: decrypted.key }, { ...fastAgent });
        const buffer = await getBufferDirect(dl.data.data.downloadUrl);
        if (buffer) return { buffer, title: decrypted.title, winner: 'Savetube' };
        throw 1;
    }
}

async function y2down_engine(url, format) {
    const init = await (await fetch(`https://p.savenow.to/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(url)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`, { agent: fastAgent.httpsAgent })).json();
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, CONFIG.POLLING_INTERVAL));
        const pd = await (await fetch(`https://p.savenow.to/api/progress?id=${init.id}`, { agent: fastAgent.httpsAgent })).json();
        if (pd.download_url) {
            const buffer = await getBufferDirect(pd.download_url);
            if (buffer) return { buffer, winner: 'Y2Down' };
        }
    }
    throw new Error();
}

async function raceWithFallback(url, isAudio, title) {
    if (!(await verificarRepo())) return null;
    const type = isAudio ? 'audio' : 'video';
    const format = isAudio ? 'mp3' : '360';

    const engines = [
        ytdlp_engine(url, isAudio),
        savetube.download(url, type),
        y2down_engine(url, format)
    ];

    try {
        const winner = await Promise.any(engines);
        console.log(colorize(`Ganador Velocidad: ${winner.winner}`));
        return { download: winner.buffer, title: winner.title || title, winner: winner.winner, isBuffer: true };
    } catch {
        try {
            const info = await ytdl.getInfo(url);
            const stream = ytdl(url, { filter: isAudio ? "audioonly" : "audioandvideo", quality: isAudio ? 140 : 18 });
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return { download: Buffer.concat(chunks), title: info.videoDetails.title, winner: 'YTDL-Core-Final', isBuffer: true };
        } catch { return null; }
    }
}

async function getBufferFromUrl(url) {
    if (Buffer.isBuffer(url)) return url;
    return await getBufferDirect(url);
}

const cleanFileName = (n) => n.replace(/[<>:"/\\|?*]/g, "").substring(0, 50);

async function ytSearch(query) {
    const r = await yts(query);
    return r.videos.map(v => ({ title: v.title, duration: v.timestamp, url: v.url }));
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize, ytSearch, verificarRepo };
