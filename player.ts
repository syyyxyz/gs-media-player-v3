import { App, Astal, Gdk, Gtk } from "astal/gtk3"
import { Box, Label, Slider, Button, Scrollable } from "astal/gtk3/widget"
import { Variable, bind, execAsync, GLib } from "astal"

// 底层文字排版库继续用 gi 导入
// @ts-ignore
import Pango from "gi://Pango"
// @ts-ignore
import PangoCairo from "gi://PangoCairo"

import { togglePlaylist, playlistWindowInstance } from "./playlist"
import { Config } from "./Config"

export const playerActionBus = Variable("")
interface CurrentMediaObj {
    name?: string;
    identity?: string;
    play_back_status?: number | string;
    playbackStatus?: number | string;
    position?: number;
    length?: number;
    play_pause?: () => void;
    next?: () => void;
    previous?: () => void;
    set_position?: (pos: number) => void;
    disconnect?: (id: number) => void;
    [key: string]: any; 
}

export const hasPlayers = Variable(false)
export const currentTitle = Variable("No active media")
export interface PlayerState {
    title: string
    artist: string
    coverArt: string
    position: number
    length: number
    playing: boolean
    lyricQueryUrl: string
    lyricQueryId: string
    playerName: string 
}

function safeConnect(obj: any, signal: string, callback: any): number | null {
    if (!obj || typeof obj.connect !== 'function') return null
    try {
        const id = obj.connect(signal, callback)
        return id !== null ? id : null
    } catch (e) { return null }
}

class PlayerAdapter {
    private mpris: any = null;
    private currentPlayer: any = null;
    private allPlayerSignalIds = new Map<any, number[]>();
    private mgrSignalIds: number[] = [];
    private onUpdateCb: (() => void) | null = null;
    private pendingSync = false;
    private syncSourceId = 0;
    private cachedState: PlayerState | null = null;
    private mpdSnapshotCache: PlayerState | null = null;
    private mpdRefreshInFlight = false;
    private cliPlayers: any[] = [];
    private pollSourceId = 0;
    private isDestroyed = false;

    // 核心状态机
    private mpdDismissed: boolean = true; 
    private actionNonce: number = 0;
    private forcedFocusUntil: number = 0; 
    private mpdDismissedAt: number = 0;

    private requestSyncAllPlayers() {
        if (this.isDestroyed || this.pendingSync) return;
        this.pendingSync = true;
        if (this.syncSourceId > 0) { try { GLib.source_remove(this.syncSourceId) } catch(e) {} }
        this.syncSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this.pendingSync = false; this.syncSourceId = 0;
            if (!this.isDestroyed) this.syncAllPlayers();
            return GLib.SOURCE_REMOVE;
        });
    }

    private async refreshCliPlayers() {
        try {
            const output = await execAsync(`playerctl -a metadata --format '{{playerName}}|||{{status}}|||{{title}}|||{{artist}}|||{{mpris:artUrl}}'`).catch(() => "");
            const activeCliPlayers = [];
            for (const line of output.split(/\r?\n/).filter(Boolean)) {
                const parts = line.split("|||");
                const name = parts[0]?.trim();
                if (!name || name.includes("mpd")) continue; // MPD 由下方专门处理

                activeCliPlayers.push({
                    __isCli: true, name, identity: name,
                    playbackStatus: parts[1]?.trim().toLowerCase() || "stopped",
                    title: parts[2]?.trim() || "Unknown Media",
                    artist: parts[3]?.trim() || "Unknown Artist",
                    artUrl: parts[4]?.trim() || "",
                    play_pause: () => execAsync(`playerctl -p ${name} play-pause`).catch(() => {}),
                    next: () => execAsync(`playerctl -p ${name} next`).catch(() => {}),
                    previous: () => execAsync(`playerctl -p ${name} previous`).catch(() => {})
                });
            }
            this.cliPlayers = activeCliPlayers;
            this.requestSyncAllPlayers();
        } catch (e) {}
    }

    constructor() {
        ;(async () => {
            try {
                this.mpris = await (globalThis as any).Service.import("mpris");
                ["changed", "player-added", "player-closed", "player-changed"].forEach(sig => {
                    const id = safeConnect(this.mpris, sig, () => this.requestSyncAllPlayers());
                    if (id !== null) this.mgrSignalIds.push(id);
                });
            } catch (e) { this.mpris = null; }
            try { this.requestSyncAllPlayers() } catch(e) { }
        })();

        this.pollSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            if (this.isDestroyed) return GLib.SOURCE_REMOVE;
            try { this.refreshMpdSnapshot(); this.refreshCliPlayers(); } catch(e) {} 
            return GLib.SOURCE_CONTINUE;
        });

        playerActionBus.subscribe(val => {
            if (val.startsWith("dismiss")) {
                if (this.currentPlayer && !this.isMpdPlayer(this.currentPlayer)) return;
                if (this.mpdSnapshotCache) this.mpdSnapshotCache.playing = false; 
                execAsync("mpc pause").catch(() => {}); 
                this.mpdDismissed = true; this.mpdDismissedAt = Date.now(); this.forcedFocusUntil = 0; 
                this.currentPlayer = null; this.cachedState = null;
                if (this.onUpdateCb) this.onUpdateCb();
                this.requestSyncAllPlayers();

            } else if (val.startsWith("play|||")) {
                const parts = val.split("|||");
                const expectedPath = parts[3] ? this.resolveLocalAudioPath(parts[3]) : "OPTIMISTIC_LOCK";
                const currentNonce = ++this.actionNonce;
                
                this.mpdDismissed = false; 
                this.forcedFocusUntil = Date.now() + 2500;

                this.mpdSnapshotCache = {
                    title: parts[2] || "Unknown Media", artist: parts[4] || "Unknown Artist", 
                    coverArt: expectedPath !== "OPTIMISTIC_LOCK" ? this.resolveLocalCover(expectedPath) : "", 
                    position: 0, length: 0, playing: true, 
                    lyricQueryUrl: expectedPath, lyricQueryId: parts[3] || "OPTIMISTIC_LOCK", playerName: "mpd"
                } as any;
                this.cachedState = this.mpdSnapshotCache;
                this.evaluateBestPlayer();
                 
                execAsync(`mpc play ${parts[1]}`).then(() => {
                    if (currentNonce !== this.actionNonce) return;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                        if (!this.isDestroyed) this.refreshMpdSnapshot(); return GLib.SOURCE_REMOVE;
                    });
                }).catch(() => {});
            }
        });
    }

    bindUI(onUpdate: () => void) { this.onUpdateCb = onUpdate; this.requestSyncAllPlayers(); }
    
    private getPlayers() { 
        const arr = (this.mpris && this.mpris.players) ? [...this.mpris.players] : [];
        for (const cp of this.cliPlayers) { if (!arr.find(p => this.getPlayerName(p) === cp.name)) arr.push(cp); }
        return arr; 
    }
    
    private getPlayerName(p: any): string { return String(p?.name || p?.identity || "").toLowerCase(); }
    private isMpdPlayer(p: any): boolean { return p?.__isMpdVirtual || this.getPlayerName(p).includes("mpd"); }

    private getPlayerStatus(p: any): string {
        // 安全写法：只有明确记录了 playing: true 才是播放，其他所有未知/空状态统统视为 paused
        if (this.isMpdPlayer(p)) return this.mpdSnapshotCache?.playing ? "playing" : "paused";
        
        if (p?.__isCli) return p.playbackStatus;
        const str = String(p?.play_back_status ?? p?.playbackStatus).toLowerCase(); 
        return (str.includes("playing") || str === "0") ? "playing" : ((str.includes("paused") || str === "1") ? "paused" : "stopped");
    }

    private refreshMpdSnapshot() {
        if (this.isDestroyed || this.mpdRefreshInFlight) return;
        this.mpdRefreshInFlight = true;
        
        Promise.all([ execAsync("mpc status").catch(() => ""), execAsync("mpc -f '%file%;;;%title%;;;%artist%' current").catch(() => "") ])
        .then(([statusText, currentMeta]) => {
            this.mpdRefreshInFlight = false; if (this.isDestroyed) return;
            const statusLine = statusText.split(/\r?\n/).find(l => l.includes("[playing]") || l.includes("[paused]") || l.includes("[stopped]")) || "";
            if (!statusLine) return;

            const parts = currentMeta.split(";;;");
            const currentPath = this.resolveLocalAudioPath(parts[0]?.trim());
            let title = parts[1]?.trim(); let artist = parts[2]?.trim() || "Unknown Artist";
            
            if (!title || title.includes("/") || title.match(/\.(mp3|flac|m4a|wav|ogg|ape|aac|wma)$/i)) title = title?.split("/").pop()?.replace(/\.[^/.]+$/, "") || "Unknown Media";
            
            let position = 0, length = 0;
            const timeMatch = statusLine.match(/(\d+):(\d+)\/(\d+):(\d+)/);
            if (timeMatch) { position = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]); length = parseInt(timeMatch[3]) * 60 + parseInt(timeMatch[4]); }

            const snapshot = { title, artist, coverArt: this.resolveLocalCover(currentPath), position, length, playing: statusLine.includes("[playing]"), lyricQueryUrl: currentPath, lyricQueryId: parts[0]?.trim() || currentPath, playerName: "mpd" };

            if (Date.now() < this.forcedFocusUntil && this.mpdSnapshotCache) {
                if (snapshot.title === this.mpdSnapshotCache.title) {
                    Object.assign(this.mpdSnapshotCache, { playing: snapshot.playing, position: snapshot.position, length: snapshot.length });
                    this.forcedFocusUntil = 0; 
                } else return; 
            } else this.mpdSnapshotCache = snapshot;

            if (this.currentPlayer && this.isMpdPlayer(this.currentPlayer)) this.cachedState = this.mpdSnapshotCache;
            this.requestSyncAllPlayers();
        }).catch(() => { this.mpdRefreshInFlight = false; });
    }

    private resolveLocalAudioPath(raw: string): string {
        if (!raw) return "";
        if (raw.startsWith("file://")) { try { return GLib.filename_from_uri(raw)[0]; } catch (e) {} }
        return raw.startsWith("/") ? raw : GLib.build_filenamev([GLib.get_home_dir(), "Music", raw]);
    }

    private resolveLocalCover(audioPath: string): string {
        if (!audioPath) return "";
        const dir = audioPath.replace(/\/[^/]*$/, "");
        const baseName = audioPath.split("/").pop()?.replace(/\.[^/.]+$/, "") || "";
        const candidates = [`${dir}/${baseName}.png`, `${dir}/${baseName}.jpg`, `${dir}/cover.png`, `${dir}/cover.jpg`, `${dir}/folder.jpg`];
        for (const path of candidates) { try { if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path; } catch (e) {} }
        return "";
    }

    private pickActivePlayer() {
        const players = this.getPlayers();
        // 🚀 物理支架清理：无需专门构建 fallback 对象，只需要一个能被 isMpdPlayer 识别的极简 token
        const mpd = players.find(p => this.isMpdPlayer(p)) || { __isMpdVirtual: true };
        const mpdStatus = this.getPlayerStatus(mpd);

        let chrome = null;
        for (const p of players.filter(p => !this.isMpdPlayer(p))) {
            const status = this.getPlayerStatus(p);
            if (status === "playing") { chrome = p; break; }
            if (status === "paused" && !chrome) chrome = p;
        }
        const chromeStatus = chrome ? this.getPlayerStatus(chrome) : "stopped";

        if (Date.now() < this.forcedFocusUntil) return mpd;
        if (mpdStatus === "playing") { 
            if (Date.now() - this.mpdDismissedAt < 1500) return chrome || null; 
            this.mpdDismissed = false; return mpd; 
        }
        if (chromeStatus === "playing") return chrome; 
        if (mpdStatus === "paused" && !this.mpdDismissed) return mpd; 
        if (chromeStatus === "paused") return chrome;
        return !this.mpdDismissed ? mpd : chrome;
    }

    private syncAllPlayers() {
        const candidates = this.getPlayers();
        for (const [p, ids] of this.allPlayerSignalIds.entries()) {
            if (!candidates.includes(p)) {
                ids.forEach(id => { try { p.disconnect(id) } catch(e){} });
                this.allPlayerSignalIds.delete(p);
                if (this.currentPlayer === p) this.currentPlayer = null;
            }
        }
        candidates.forEach(p => {
            if (!p.__isCli && !p.__isMpdVirtual && !this.allPlayerSignalIds.has(p)) {
                const ids: number[] = [];
                ["closed", "changed", "playback-status-changed", "metadata-changed"].forEach(sig => {
                    const id = safeConnect(p, sig, () => this.requestSyncAllPlayers());
                    if (id !== null) ids.push(id);
                });
                this.allPlayerSignalIds.set(p, ids);
            }
        });
        this.evaluateBestPlayer();
    }

    private evaluateBestPlayer() {
        this.currentPlayer = this.pickActivePlayer();
        this.cachedState = this.buildSnapshotFromCurrentPlayer();
        if (this.onUpdateCb) this.onUpdateCb();
    }

    refreshSnapshot(): PlayerState | null { this.cachedState = this.buildSnapshotFromCurrentPlayer(); return this.cachedState; }

    private buildSnapshotFromCurrentPlayer(): PlayerState | null {
        try {
            const p = this.currentPlayer; if (!p) return null;
            if (this.isMpdPlayer(p)) return this.mpdSnapshotCache;

            const meta = p.__isCli ? { "xesam:title": p.title, "xesam:artist": p.artist, "mpris:artUrl": p.artUrl } : (p.metadata || p.Metadata || {});
            const title = meta["xesam:title"] || p.title || "Unknown Media";
            
            return { 
                title, 
                artist: meta["xesam:artist"] || p.artist || "Unknown Artist", 
                coverArt: meta["mpris:artUrl"] || p.artUrl || "", 
                position: p.position || 0, 
                length: p.length || 0, 
                playing: this.getPlayerStatus(p) === "playing", 
                lyricQueryUrl: "", lyricQueryId: "", 
                playerName: p.name || "Unknown" 
            };
        } catch (e) { return null }
    }

    getSnapshot(): PlayerState | null { return this.cachedState }
    getState(): PlayerState | null { return this.refreshSnapshot() }

    playPause() {
        const p = this.currentPlayer; 
        if (this.isMpdPlayer(p)) { execAsync("mpc toggle").catch(() => {}); return; }
        if (p?.__isCli) { p.play_pause(); return; }
        if (p && typeof p.play_pause === 'function') p.play_pause();
    }

    next() {
        const p = this.currentPlayer;
        if (this.cachedState) this.cachedState.position = 0;
        if (this.isMpdPlayer(p)) { execAsync(`mpc next`).then(() => this.refreshMpdSnapshot()).catch(() => {}); return; }
        if (p?.__isCli) { p.next(); return; }
        if (p && typeof p.next === 'function') p.next();
    }

    previous() {
        const p = this.currentPlayer;
        if (this.cachedState) this.cachedState.position = 0;
        if (this.isMpdPlayer(p)) { execAsync(`mpc prev`).then(() => this.refreshMpdSnapshot()).catch(() => {}); return; }
        if (p?.__isCli) { p.previous(); return; }
        if (p && typeof p.previous === 'function') p.previous();
    }

    seekToRatio(ratio: number) {
        const p = this.currentPlayer; if (!p) return;
        this.forcedFocusUntil = Date.now() + 2500;
        if (this.isMpdPlayer(p)) {
            const len = this.mpdSnapshotCache?.length || 0; if (len <= 0) return;
            const target = Math.max(0, Math.floor(ratio * len));
            if (this.mpdSnapshotCache) this.mpdSnapshotCache.position = target;
            if (this.cachedState) this.cachedState.position = target;
            execAsync(`mpc seek ${target}`).catch(() => {}); return;
        }
        const len = p.length || 0; if (len <= 0) return;
        const target = ratio * len;
        if (this.cachedState) this.cachedState.position = target;
        if (typeof p.set_position === 'function') { try { p.set_position(target) } catch(e) {} }
    }
    
    destroy() {
        this.isDestroyed = true;
        if (this.syncSourceId > 0) { try { GLib.source_remove(this.syncSourceId) } catch(e) {} }
        if (this.pollSourceId > 0) { try { GLib.source_remove(this.pollSourceId) } catch(e) {} }
        for (const [p, ids] of this.allPlayerSignalIds.entries()) { ids.forEach((id: number) => { try { p.disconnect(id) } catch(e){} }) }
        this.mgrSignalIds.forEach(id => { try { this.mpris.disconnect(id) } catch(e){} });
        this.currentPlayer = null;
    }
}
export const playerStyle = `
.cover { min-width: 82px; min-height: 82px; border-radius: 14px; background-size: cover; background-position: center; background-color: rgba(255, 255, 255, 0.03); margin-right: 20px; transition: opacity 0.4s ease, border-radius 0.4s ease; }
.cover.paused { opacity: 0.45; border-radius: 20px; }
.player-interior { background-color: ${Config.theme.playerBg}; border-top: 1px solid rgba(255, 255, 255, 0.3); border-left: 1px solid rgba(255, 255, 255, 0.15); border-right: 1px solid rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.05); border-radius: 24px; padding: 20px; min-width: ${Config.sizes.playerWidth}px; }
.upper-row { margin-bottom: 18px; }
.title { color: ${Config.theme.textColor}; font-size: 17px; font-weight: 800; }
.artist { color: alpha(${Config.theme.textColor}, 0.7); font-size: 13px; font-weight: 600; margin-bottom: 2px;}
.controls { -gtk-icon-transform: none; }
.controls button { color: alpha(${Config.theme.textColor}, 0.8); font-size: 32px; margin-right: 24px; padding: 0; background: transparent; border: none; box-shadow: none; transition: color 0.25s ease, text-shadow 0.25s ease; }
.controls button:hover { color: ${Config.theme.accentColor}; text-shadow: 0 0 14px alpha(${Config.theme.accentColor}, 0.75); }
.progress trough { min-height: 6px; background-color: rgba(255, 255, 255, 0.08); border-radius: 4px; }
.progress highlight { background-color: ${Config.theme.accentColor}; border-radius: 4px; }
.progress slider { min-height: 16px; min-width: 16px; background-color: #ffffff; border-radius: 50%; }
.progress:hover slider { opacity: 1; }
.dismiss-btn:hover { color: #f7768e; text-shadow: 0 0 8px rgba(247, 118, 142, 0.5); background-color: transparent; background-image: none; box-shadow: none; border: none; }
`

interface LyricSyllable {
    text: string;           
    startTime: number;      
    duration: number;       
    byteOffset: number;     
}

interface LyricLine { 
    plainText: string; 
    startTime: number; 
    duration: number;
    syllables: LyricSyllable[]; 
}

const CACHE_LIMIT = 10 
const lyricCache = new Map<string, LyricLine[]>()

function parseKrc(content: string): LyricLine[] {
    const lines: LyricLine[] = [];
    let isKrc = false;

    // 1. 优先尝试解析 KRC (带逐字毫秒时间的格式)
    const lineRegex = /\[(\d+),(\d+)\]([^\[]*)/g;
    const sylRegex = /<(\d+),(\d+),\d+>([^<]*)/g;
    
    let encoder: any = null;
    if (typeof TextEncoder !== 'undefined') encoder = new TextEncoder();

    let lineMatch;
    while ((lineMatch = lineRegex.exec(content)) !== null) {
        isKrc = true; // 只要匹配到一条，就证明内容是真 KRC
        const lineStartMs = parseInt(lineMatch[1], 10);
        const lineDurMs = parseInt(lineMatch[2], 10);
        const sylContent = lineMatch[3];

        let plainText = "";
        const syllables: LyricSyllable[] = [];
        let currentByteOffset = 0;

        let sylMatch;
        while ((sylMatch = sylRegex.exec(sylContent)) !== null) {
            const sylStartOffsetMs = parseInt(sylMatch[1], 10);
            const sylDurMs = parseInt(sylMatch[2], 10);
            const text = sylMatch[3];

            syllables.push({ text, startTime: (lineStartMs + sylStartOffsetMs) / 1000, duration: sylDurMs / 1000, byteOffset: currentByteOffset });
            plainText += text;
            if (encoder) currentByteOffset += encoder.encode(text).length;
            else currentByteOffset += unescape(encodeURIComponent(text)).length;
        }

        if (syllables.length > 0) {
            lines.push({ plainText, startTime: lineStartMs / 1000, duration: lineDurMs / 1000, syllables });
        } else if (plainText.trim() !== "") {
            lines.push({ plainText, startTime: lineStartMs / 1000, duration: lineDurMs / 1000, syllables: [{ text: plainText, startTime: lineStartMs / 1000, duration: lineDurMs / 1000, byteOffset: 0 }] });
        }
    }

    if (isKrc) return lines.sort((a, b) => a.startTime - b.startTime);

    // 2. 如果内容不是 KRC，则进入 LRC 解析模式（增强正则：支持 [1:23.4], [01:23] 等所有奇葩变体）
    const lrcTimeRegex = /\[(\d{1,}):(\d{2})(?:\.(\d+))?\]/g;
    const rawLines = content.split(/\r?\n/);
    
    for (const rawLine of rawLines) {
        const timeTags = [];
        let match;
        lrcTimeRegex.lastIndex = 0;
        while ((match = lrcTimeRegex.exec(rawLine)) !== null) {
            const min = parseInt(match[1], 10);
            const sec = parseInt(match[2], 10);
            const ms = match[3] ? parseInt(match[3].padEnd(3, '0').substring(0, 3), 10) : 0;
            timeTags.push(min * 60 + sec + ms / 1000);
        }
        
        if (timeTags.length > 0) {
            const text = rawLine.replace(/\[\d{1,}:\d{2}(?:\.\d+)?\]/g, "").trim();
            if (text) {
                for (const time of timeTags) {
                    lines.push({ 
                        plainText: text, startTime: time, duration: 0, 
                        syllables: [], 
                        isLrc: true // 核心标记：告诉渲染器这是普通 LRC
                    } as any);
                }
            }
        }
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < lines.length; i++) {
        lines[i].duration = (i < lines.length - 1) ? Math.max(0, lines[i+1].startTime - lines[i].startTime) : 5.0;
    }
    return lines;
}

function findLyricIndex(lines: LyricLine[], targetTime: number, lastIdx: number): number {
    if (lines.length === 0) return -1
    const lastTime = (lastIdx >= 0 && lastIdx < lines.length) ? lines[lastIdx].startTime : 0
    if (Math.abs(targetTime - lastTime) < 2.0) {
        let idx = lastIdx < 0 ? 0 : lastIdx
        while (idx + 1 < lines.length && targetTime >= lines[idx + 1].startTime) idx++
        while (idx > 0 && targetTime < lines[idx].startTime) idx--
        if (idx === 0 && targetTime < lines[0].startTime) return -1
        return idx
    }
    let l = 0, r = lines.length - 1, ans = -1
    while (l <= r) {
        const mid = (l + r) >> 1
        if (lines[mid].startTime <= targetTime) { ans = mid; l = mid + 1 } else r = mid - 1
    }
    return ans
}

// 完美防抖控制流 + 自动换行防重叠 Cairo 渲染引擎 (修复多行碰撞 Bug)
export function buildPlayerCard() {
    try {
        let isDestroyed = false 
        let isUserDragging = false
        let lastTrackId = ""
        let fetchToken = 0 
        let currentState: PlayerState | null = null
        let lastStateAt = 0
        let progressBasePosition = 0
        let progressBaseLength = 0
        let progressBasePlaying = false
        let lastUserSeekAt = 0
    
        const title = Variable("No active media")
        const artist = Variable("")
        const coverPath = Variable("")
        const isPlaying = Variable(false)
        const progress = Variable(0)
        const lyrics = Variable<LyricLine[]>([])
        const isMpdActive = Variable(true)
        // 播放模式状态：0=列表循环, 1=单曲循环, 2=随机
        const playMode = Variable(0);
        const modeIcons = ["󰒍", "󰑘", ""];
        const modeColors = ["rgba(192, 202, 245, 0.8)", "#7aa2f7", "#bb9af7"];

        const cyclePlayMode = () => {
            const nextMode = (playMode.get() + 1) % 3;
            playMode.set(nextMode);
            let cmd = "";
            if (nextMode === 0) {
                cmd = "mpc random off; mpc repeat on; mpc single off; playerctl loop Playlist; playerctl shuffle Off";
            } else if (nextMode === 1) {
                cmd = "mpc random off; mpc repeat on; mpc single on; playerctl loop Track; playerctl shuffle Off";
            } else if (nextMode === 2) {
                cmd = "mpc random on; mpc repeat on; mpc single off; playerctl loop Playlist; playerctl shuffle On";
            }
            execAsync(`bash -c "${cmd} &> /dev/null || true"`).catch(() => {});
        };
        
        const unsubs: Array<() => void> = []
        const adapter = new PlayerAdapter()

        const applyStateSnapshot = (state: PlayerState | null) => {
            const now = Date.now()
            if (!state) { 
                currentState = null;
                progressBasePlaying = false; 
                lastStateAt = now; 
                return; 
            }
            if (state.length && state.length > 100000) state.length /= 1000000;
            if (state.position && state.position > 100000) state.position /= 1000000;
            const effectiveLen = state.length || progressBaseLength;
            if (effectiveLen > 0 && state.position && state.position > effectiveLen + 5) state.position = progressBasePosition;
            else if (state.position && state.position > 86400) state.position = progressBasePosition;
            const isFirstLoad = !currentState;
            const isSameLogicalTrack = currentState && (currentState.lyricQueryId === state.lyricQueryId || currentState.title === state.title);
            const isGhostData = !state.title || state.title === "Unknown Media" || state.title === "Unknown Artist" || state.title === "No active media" || state.title.startsWith("http") || state.title.startsWith("file://");
            if (isFirstLoad || (!isSameLogicalTrack && !isGhostData)) {
                currentState = state; progressBasePosition = state.position || 0; progressBaseLength = state.length || 0; progressBasePlaying = !!state.playing; lastStateAt = now; return
            }
            if (currentState) {
                if (!isGhostData && state.title) { currentState.title = state.title; currentState.artist = state.artist }
                if (state.coverArt) currentState.coverArt = state.coverArt
                currentState.playing = state.playing
                currentState.length = state.length || currentState.length
                if (state.length > 0) progressBaseLength = state.length
            }
            if (!isUserDragging) {
                const elapsed = progressBasePlaying ? Math.max(0, (now - lastStateAt) / 1000) : 0
                const extrapolated = progressBasePosition + elapsed
                const incomingPos = state.position || 0
                const diff = extrapolated - incomingPos
                const timeSinceSeek = now - lastUserSeekAt
                if (incomingPos < 2.0 && extrapolated > 3.0 && timeSinceSeek > 2500) progressBasePosition = extrapolated
                else if (diff > 0 && diff < 1.5) progressBasePosition = extrapolated
                else {
                    if (timeSinceSeek < 3500) progressBasePosition = extrapolated 
                    else progressBasePosition = incomingPos  
                }
            }
            lastStateAt = now; progressBasePlaying = !!state.playing
        }

        const optimisticTogglePlayback = () => {
            const nextPlaying = !isPlaying.get()
            isPlaying.set(nextPlaying)
            if (currentState) {
                if (!nextPlaying && progressBasePlaying) {
                    const elapsed = Math.max(0, (Date.now() - lastStateAt) / 1000)
                    progressBasePosition += elapsed
                    currentState.position = progressBasePosition
                }
                const snap = adapter.getSnapshot()
                if (snap) { snap.position = progressBasePosition; snap.playing = nextPlaying }
                currentState.playing = nextPlaying; progressBasePlaying = nextPlaying; lastStateAt = Date.now()
            }
        }

        const syncMetadata = () => {
            if (isDestroyed) return
            let rawState = adapter.getSnapshot()
            if (!rawState) rawState = adapter.refreshSnapshot()
            applyStateSnapshot(rawState)
            const state = currentState
            if (!state) {
                if (hasPlayers.get() !== false) hasPlayers.set(false)
                if (title.get() !== "No active media") { title.set("No active media"); currentTitle.set("No active media"); }
                if (artist.get() !== "") artist.set("")
                if (coverPath.get() !== "") coverPath.set("")
                if (isPlaying.get() !== false) isPlaying.set(false)
                isMpdActive.set(false)
                lyrics.set([]); return
            }
            if (hasPlayers.get() !== true) hasPlayers.set(true)
            if (title.get() !== state.title) { title.set(state.title); currentTitle.set(state.title); } 
            if (artist.get() !== state.artist) artist.set(state.artist)
            if (coverPath.get() !== state.coverArt) coverPath.set(state.coverArt)
            if (isPlaying.get() !== state.playing) isPlaying.set(state.playing)
            //处于 "No active media" 时彻底隐藏 X 按钮
            isMpdActive.set(state.playerName.toLowerCase().includes("mpd") && state.title !== "No active media");
            const searchKey = [state.playerName, state.lyricQueryUrl || state.lyricQueryId || state.title || state.artist || ""].join("::")
            
            if (searchKey !== lastTrackId) {
                lastTrackId = searchKey
                const currentFetchId = ++fetchToken 
                if (lyricCache.has(searchKey)) { lyrics.set(lyricCache.get(searchKey)!); return }
                const buildLyricCandidates = (audioPath: string): string[] => {
                    if (!audioPath) return []
                    const normalized = audioPath.trim(); if (!normalized) return []
                    const dir = normalized.replace(/\/[^/]*$/, "")
                    const folderName = dir.split("/").filter(Boolean).pop() || ""
                    const sameNameLrc = normalized.replace(/\.[^/.]+$/, ".lrc")
                    //  覆盖所有大小写后缀，防侧漏
                    return [...new Set([
                        sameNameLrc, 
                        sameNameLrc.replace(/\.lrc$/i, ".LRC"),
                        sameNameLrc.replace(/\.lrc$/i, ".txt"),
                        `${dir}/歌词.lrc`, 
                        `${dir}/lyric.lrc`, 
                        `${dir}/lyrics.lrc`, 
                        folderName ? `${dir}/${folderName}.lrc` : ""
                    ].filter(Boolean))]
                }
                
                const tryCommitLyrics = (path: string): boolean => {
                    if (isDestroyed || currentFetchId !== fetchToken) return true
                    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return false
                    const [ok, content] = GLib.file_get_contents(path)
                    if (!ok) return false
                    let text = "";
                    try {
                        if (typeof TextDecoder !== 'undefined') text = new TextDecoder().decode(content as any);
                        else text = String(content);
                    } catch (e) {
                        try {
                            const ByteArray = (globalThis as any).imports.byteArray; text = ByteArray.toString(content);
                        } catch(e2) { text = String(content); }
                    }
                    
                    const parsed = parseKrc(text)
                    
                    //  核心修复：如果这个文件解析不出任何有效歌词时间轴，立刻返回 false！让外层循环继续找下一个文件！
                    if (parsed.length === 0) return false;
                    
                    if (lyricCache.size > CACHE_LIMIT) lyricCache.delete(lyricCache.keys().next().value!)
                    lyricCache.set(searchKey, parsed)
                    lyrics.set(parsed); return true
                }
                let matched = false
                if (state.lyricQueryUrl.startsWith("file://") || state.lyricQueryUrl.startsWith("/")) {
                    try {
                        const filename = state.lyricQueryUrl.startsWith("file://") ? GLib.filename_from_uri(state.lyricQueryUrl)[0] : state.lyricQueryUrl;
                        if (filename) { for (const candidate of buildLyricCandidates(filename)) { if (tryCommitLyrics(candidate)) { matched = true; break } } }
                    } catch(e) {}
                }
                if (!matched && state.playerName.toLowerCase().includes("mpd")) {
                    const songPath = state.lyricQueryUrl || ""
                    if (songPath) { for (const candidate of buildLyricCandidates(songPath)) { if (tryCommitLyrics(candidate)) { matched = true; break } } } 
                    else {
                        execAsync('mpc -f "%file%" current').then(mpcFile => {
                            if (isDestroyed || currentFetchId !== fetchToken) return 
                            mpcFile = mpcFile.trim()
                            if (mpcFile) {
                                const resolvedPath = mpcFile.startsWith("/") ? mpcFile : GLib.build_filenamev([GLib.get_home_dir(), "Music", mpcFile]);
                                let found = false
                                for (const candidate of buildLyricCandidates(resolvedPath)) { if (tryCommitLyrics(candidate)) { found = true; break } }
                                if (!found) lyrics.set([])
                            } else lyrics.set([])
                        }).catch(() => { if (!isDestroyed && currentFetchId === fetchToken) lyrics.set([]) })
                    }
                } else { if (!matched) lyrics.set([]) }
            }
        }
        adapter.bindUI(syncMetadata)
        const cover: any = new Box({ 
            className: "cover",
            widthRequest: 82,
            heightRequest: 82,
            valign: Gtk.Align.CENTER, 
            hexpand: false,
            vexpand: false
        })
        const DEFAULT_COVER = `background-image: url('file:///usr/share/icons/Adwaita/scalable/mimetypes/audio-x-generic-symbolic.svg');`
        unsubs.push(coverPath.subscribe(p => { 
            if (isDestroyed) return
            if (!p) { cover.css = DEFAULT_COVER; return }
            try {
                const uri = p.startsWith("file://") ? p : GLib.filename_to_uri(p, null)
                cover.css = `background-image: url('${uri.replace(/'/g, "%27").replace(/"/g, "%22")}'); background-size: cover; background-position: center;` 
            } catch(e) { cover.css = DEFAULT_COVER }
        }))
        unsubs.push(isPlaying.subscribe(p => {
            if (isDestroyed) return
            if (p) cover.get_style_context().remove_class("paused")
            else cover.get_style_context().add_class("paused")
        }))
        const titleLbl = new Label({ xalign: 0, maxWidthChars: 18, ellipsize: 3, label: bind(title), className: "title" })
        const artistLbl = new Label({ xalign: 0, maxWidthChars: 15, ellipsize: 3, label: bind(artist), className: "artist" })
        const mediaControlsEnabled = bind(title).as(t => t !== "No active media")
        const dismissBtn = new Button({ 
            className: "dismiss-btn", 
            visible: bind(isMpdActive),
            onClicked: () => {
                playerActionBus.set(`dismiss|||${Date.now()}`);
                // 按下 X 时，如果列表开着，连带关闭列表！
                if (playlistWindowInstance && playlistWindowInstance.visible) togglePlaylist();
            }, 
            child: new Label({ label: "✕" }), 
            valign: Gtk.Align.START,
            setup: (btn: any) => btn.set_relief(Gtk.ReliefStyle.NONE) 
        });
        // 用一个 Box 把歌名和 X 按钮放在同一行
        const titleBox = new Box({ children: [titleLbl, new Box({ hexpand: true }), dismissBtn] });
        const modeBtn = new Button({ 
            onClicked: cyclePlayMode,
            css: bind(playMode).as(m => `color: ${modeColors[m]}; font-size: 20px; margin-left: 8px; margin-right: 0px; transition: all 0.3s ease; text-shadow: ${m === 0 ? 'none' : `0 0 12px ${modeColors[m]}80`};`),
            child: new Label({ label: bind(playMode).as(m => modeIcons[m]) }) 
        });
        const playlistBtn = new Button({
            onClicked: togglePlaylist,
            css: `font-size: 20px; margin-right: 0px; margin-left: 0px;`, 
            child: new Label({ label: "󰎆" }) 
        });
        const controls = new Box({ 
            className: "controls", 
            children: [
                new Button({
                    sensitive: bind(title).as(t => t !== "No active media"),
                    onClicked: () => {
                        if (title.get() === "No active media" || isDestroyed) return
                        lastUserSeekAt = Date.now()
                        progressBasePosition = 0
                        adapter.previous()
                    },
                    child: new Label({ label: "󰒮" })
                }),
                new Button({
                    sensitive: bind(title).as(t => t !== "No active media"),
                    onClicked: () => {
                        if (title.get() === "No active media" || isDestroyed) return
                        lastUserSeekAt = Date.now()
                        optimisticTogglePlayback()
                        adapter.playPause()
                    },
                    child: new Label({ label: bind(isPlaying).as(p => p ? "󰏤" : "󰐊") })
                }),
                new Button({
                    sensitive: bind(title).as(t => t !== "No active media"),
                    onClicked: () => {
                        if (title.get() === "No active media" || isDestroyed) return
                        lastUserSeekAt = Date.now()
                        progressBasePosition = 0
                        adapter.next()
                    },
                    child: new Label({ label: "󰒭" })
                }),
                modeBtn,
                new Box({ hexpand: true }), 
                playlistBtn
            ] 
        });
        const meta = new Box({ vertical: true, className: "meta-container", children: [titleBox, artistLbl, controls] })
        const upperRow = new Box({ className: "upper-row", children: [cover, meta] })
        const slider: any = new Slider({ drawValue: false, value: bind(progress), className: "progress" })
        slider.connect("button-press-event", () => { isUserDragging = true; progress.set(Math.min(1, Math.max(0, slider.get_value()))); return false })
        slider.connect("value-changed", () => { if (isUserDragging) progress.set(Math.min(1, Math.max(0, slider.get_value()))) })
        slider.connect("button-release-event", () => {
            const ratio = Math.min(1, Math.max(0, slider.get_value()))
            const state = currentState
            const len = progressBaseLength || state?.length || 0
            const targetPosition = len > 0 ? ratio * len : 0
            isUserDragging = false
            progress.set(ratio)
            if (len > 0) { 
                progressBaseLength = len; 
                progressBasePosition = targetPosition; 
                progressBasePlaying = !!state?.playing; 
                lastStateAt = Date.now(); 
                lastUserSeekAt = Date.now(); 
                if (currentState) { currentState.position = targetPosition; currentState.length = len } 
                currentPlayPos = targetPosition;
                if (currentLyrics.length > 0) lyricArea.queue_draw();
            }
            if (!isDestroyed) adapter.seekToRatio(ratio)
            return false
        })
        const playerControlsBox = new Box({ vertical: true, children: [upperRow, slider] })

        let currentLyrics: LyricLine[] = [];
        let targetIdx = -1;
        let smoothY = 0;
        let currentPlayPos = 0; 
        let pangoLayout: any = null;
        let animTickId: number | null = null;
        const lyricArea = new Gtk.DrawingArea({ vexpand: true, hexpand: true, heightRequest: Config.sizes.lyricHeight, visible: true });
        const fontNormal = Pango.FontDescription.from_string(`${Config.fonts.normal} bold ${Config.sizes.lyricNormalSize}`);
        const fontChinese = Pango.FontDescription.from_string(`${Config.fonts.chinese} ${Config.sizes.lyricChineseSize}`);
        // 嗅探器：只要这行字符串里包含一个中文字符，就判定为中文歌词
        const isChinese = (str: string) => /[\u4e00-\u9fa5]/.test(str);

        let userLyricScrollTimeout = 0;
        let isDraggingLyricScroll = false;
        lyricArea.add_events(Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK);
        
        lyricArea.connect("scroll-event", (widget: any, event: any) => {
            if (currentLyrics.length === 0) return false;
            let delta = 0;
            const [hasDir, direction] = event.get_scroll_direction();
            if (hasDir) {
                if (direction === Gdk.ScrollDirection.UP) delta = -1;
                else if (direction === Gdk.ScrollDirection.DOWN) delta = 1;
            }
            if (delta !== 0) {
                smoothY += delta * 1.5;
                smoothY = Math.max(0, Math.min(smoothY, currentLyrics.length - 1));
                userLyricScrollTimeout = Date.now() + 4000;
                if (animTickId !== null) { lyricArea.remove_tick_callback(animTickId); animTickId = null; }
                lyricArea.queue_draw();
            }
            return true; 
        });

        lyricArea.connect("button-press-event", (widget: any, event: any) => {
            if (currentLyrics.length === 0) return false;
            const [, x, y] = event.get_coords();
            const width = widget.get_allocated_width();
            if (x >= width - 20) { 
                isDraggingLyricScroll = true;
                userLyricScrollTimeout = Date.now() + 4000;
                if (animTickId !== null) { lyricArea.remove_tick_callback(animTickId); animTickId = null; }
                const height = widget.get_allocated_height();
                smoothY = (y / height) * (currentLyrics.length - 1);
                smoothY = Math.max(0, Math.min(smoothY, currentLyrics.length - 1));
                lyricArea.queue_draw();
                return true; 
            }
            return false;
        });

        lyricArea.connect("motion-notify-event", (widget: any, event: any) => {
            if (!isDraggingLyricScroll || currentLyrics.length === 0) return false;
            const [, x, y] = event.get_coords();
            const height = widget.get_allocated_height();
            smoothY = (y / height) * (currentLyrics.length - 1);
            smoothY = Math.max(0, Math.min(smoothY, currentLyrics.length - 1));
            userLyricScrollTimeout = Date.now() + 4000;
            lyricArea.queue_draw();
            return true;
        });

        lyricArea.connect("button-release-event", () => {
            if (isDraggingLyricScroll) { isDraggingLyricScroll = false; userLyricScrollTimeout = Date.now() + 4000; return true; }
            return false;
        });

        const startAnimation = () => {
            if (animTickId !== null) return;
            animTickId = lyricArea.add_tick_callback(() => {
                if (targetIdx < 0 || currentLyrics.length === 0) { animTickId = null; return false; }
                const diff = targetIdx - smoothY;
                if (Math.abs(diff) > 0.05) { smoothY += diff * 0.35; lyricArea.queue_draw(); return true; } 
                else { if (smoothY !== targetIdx) { smoothY = targetIdx; lyricArea.queue_draw(); } animTickId = null; return false; }
            });
        };
  
        const computedHeights: number[] = new Array(currentLyrics.length);

        lyricArea.connect("draw", (widget: any, cr: any) => {
            const currentSongTitle = title.get() || "";
            let fillColor = Config.theme.lyricFillColorRgb;
            if (Config.theme.customSongColors) {
                for (const [key, color] of Object.entries(Config.theme.customSongColors)) {
                    if (currentSongTitle.includes(key)) { fillColor = color; break; }
                }
            }
            const width = widget.get_allocated_width(); const height = widget.get_allocated_height();
            if (width <= 0 || height <= 0) return true;
            if (!pangoLayout) {
                pangoLayout = widget.create_pango_layout("");
                pangoLayout.set_alignment(Pango.Alignment.CENTER);
                pangoLayout.set_wrap(Pango.WrapMode.WORD_CHAR);
                //设置折行内部的行间距系数（1.3倍行高），彻底拉开多行内部距离
                if (typeof pangoLayout.set_line_spacing === 'function') {
                    pangoLayout.set_line_spacing(1.3); 
                } else {
                    pangoLayout.set_spacing(6 * Pango.SCALE); 
                }
            }

            const centerY = height / 2; 
            //增加行距，修复碰撞 Bug[cite: 1]
            const baseLineHeight = 38; 
            const lyricPadding = -8; 
            const allowedWidth = Math.max(100, width - 50);
            pangoLayout.set_width(allowedWidth * Pango.SCALE);

            const setRgba = (r: number, g: number, b: number, a: number) => {
                if (typeof cr.setSourceRGBA === 'function') cr.setSourceRGBA(r, g, b, a);
                else cr.set_source_rgba(r, g, b, a);
            };
            const moveTo = (x: number, y: number) => {
                if (typeof cr.moveTo === 'function') cr.moveTo(x, y);
                else cr.move_to(x, y);
            };

            if (currentLyrics.length === 0) return true; // 既然没歌词都折叠了，直接跳过绘图即可
            const computedHeights: number[] = new Array(currentLyrics.length);
            const mid = Math.floor(smoothY);
            const scanStart = Math.max(0, mid - 8);
            const scanEnd = Math.min(currentLyrics.length - 1, mid + 8);
            for (let i = scanStart; i <= scanEnd; i++) {
                const text = currentLyrics[i].plainText;
                pangoLayout.set_font_description(isChinese(text) ? fontChinese : fontNormal);
                pangoLayout.set_text(text, -1);
                const logicalRect = pangoLayout.get_pixel_extents()[1];
                computedHeights[i] = logicalRect?.height || baseLineHeight;
            }

            const getScaledHeight = (idx: number, anchorY: number) => {
                const dist = Math.abs(idx - anchorY);
                const s = 1.0 + Math.max(0, (1.0 - dist) * 0.22); 
                return (computedHeights[idx] || baseLineHeight) * s;
            };

            //核心修正：基于物理间距排斥的 Y 轴计算[cite: 1]
            const getLineY = (index: number): number => {
                const intPart = Math.floor(smoothY);
                const fracPart = smoothY - intPart;
                let currentAnchorY = centerY;
                const centerHeight = getScaledHeight(intPart, smoothY);
                if (fracPart > 0 && intPart + 1 < currentLyrics.length) {
                    const nextHeight = getScaledHeight(intPart + 1, smoothY);
                    // 确保滑动中点两端的间距是动态合力的结果
                    currentAnchorY -= (centerHeight / 2 + lyricPadding + nextHeight / 2) * fracPart;
                }
                if (index === intPart) return currentAnchorY;
                if (index < intPart) {
                    let y = currentAnchorY - (centerHeight / 2 + lyricPadding);
                    for (let i = intPart - 1; i > index; i--) y -= (getScaledHeight(i, smoothY) + lyricPadding);
                    return y - getScaledHeight(index, smoothY) / 2;
                } else {
                    let y = currentAnchorY + (centerHeight / 2 + lyricPadding);
                    for (let i = intPart + 1; i < index; i++) y += (getScaledHeight(i, smoothY) + lyricPadding);
                    return y + getScaledHeight(index, smoothY) / 2;
                }
            };

            for (let i = scanStart; i <= scanEnd; i++) {
                const distance = Math.abs(i - smoothY);
                if (distance > 6) continue;
                const lineY = getLineY(i);
                let alpha = 1.0 - (distance * 0.18); if (alpha < 0) alpha = 0;
                let scale = 1.0 + Math.max(0, (1.0 - distance) * 0.22); 
                const text = currentLyrics[i].plainText;
                pangoLayout.set_font_description(isChinese(text) ? fontChinese : fontNormal);
                pangoLayout.set_text(text, -1);
                const itemHeight = computedHeights[i] || baseLineHeight;
                const extents = pangoLayout.get_pixel_extents()[1];
                const physicalTextWidth = extents?.width || allowedWidth;
                const safeMaxWidth = width - 30; 
                if (physicalTextWidth * scale > safeMaxWidth) scale = safeMaxWidth / physicalTextWidth; 
                cr.save();
                cr.translate(width / 2, lineY);
                cr.scale(scale, scale);
                moveTo(-allowedWidth / 2, -(itemHeight / 2));
                const isTarget = i === targetIdx;
                // 替换：底色使用配置
                if (isTarget) setRgba(Config.theme.lyricActiveRowRgb.r, Config.theme.lyricActiveRowRgb.g, Config.theme.lyricActiveRowRgb.b, Math.max(alpha, 0.15)); 
                else setRgba(Config.theme.textColorRgb.r, Config.theme.textColorRgb.g, Config.theme.textColorRgb.b, alpha * 0.5);
                PangoCairo.show_layout(cr, pangoLayout);
                if (isTarget && currentPlayPos >= currentLyrics[i].startTime) {
                    const line = currentLyrics[i];
                    cr.save();
                    if (typeof cr.newPath === 'function') cr.newPath(); else cr.new_path();
                    
                    // 核心修复：一旦识别为 LRC 格式，或者 KRC 这句已经唱完，直接拉满高亮整个矩形，不再走匀速动画！
                    if ((line as any).isLrc || currentPlayPos >= line.startTime + line.duration) {
                        cr.rectangle(-allowedWidth / 2, -itemHeight / 2 - 20, allowedWidth, itemHeight + 40);
                    } else if (line.syllables && line.syllables.length === 1) {
                        const sylProgress = (currentPlayPos - line.startTime) / line.duration;
                        cr.rectangle(-allowedWidth / 2, -itemHeight / 2 - 20, allowedWidth * sylProgress, itemHeight + 40);
                    } else if (line.syllables && line.syllables.length > 1) {
                        let activeSylIndex = line.syllables.length - 1; let sylProgress = 1;
                        for (let s = 0; s < line.syllables.length; s++) {
                            const syl = line.syllables[s];
                            if (currentPlayPos >= syl.startTime && currentPlayPos < syl.startTime + syl.duration) {
                                activeSylIndex = s; sylProgress = (currentPlayPos - syl.startTime) / syl.duration; break;
                            } else if (currentPlayPos < syl.startTime) { activeSylIndex = s > 0 ? s - 1 : 0; sylProgress = s > 0 ? 1 : 0; break; }
                        }
                        const activeSyl = line.syllables[activeSylIndex];
                        const posRect = pangoLayout.index_to_pos(activeSyl.byteOffset);
                        const xPos = posRect.x / Pango.SCALE;
                        const yPos = posRect.y / Pango.SCALE;
                        const sylHeight = posRect.height / Pango.SCALE;
                        let currentSylWidth = (activeSylIndex + 1 < line.syllables.length) ? (pangoLayout.index_to_pos(line.syllables[activeSylIndex + 1].byteOffset).x / Pango.SCALE - xPos) : (allowedWidth - xPos);
                        if (currentSylWidth < 0) currentSylWidth = allowedWidth - xPos;
                        const clipX = xPos + (currentSylWidth * sylProgress);
                        const baseX = -allowedWidth / 2; const baseY = -itemHeight / 2;
                        if (yPos > 10) cr.rectangle(baseX, baseY - 20, allowedWidth, yPos + 20);
                        cr.rectangle(baseX, baseY + yPos - 10, clipX, sylHeight + 20);
                    }
                    cr.clip();
                    setRgba(fillColor.r, fillColor.g, fillColor.b, Math.max(alpha, 0.15));
                    moveTo(-allowedWidth / 2, -(itemHeight / 2));
                    PangoCairo.show_layout(cr, pangoLayout);
                    cr.restore(); 
                }
                cr.restore(); 
            }
            if (currentLyrics.length > 0) {
                const handleHeight = Math.max(25, (height / currentLyrics.length) * 8); 
                const percent = smoothY / (currentLyrics.length - 1 || 1);
                const handleY = percent * (height - handleHeight);
                let rectWidth = 4; let rectX = width - 6;
                if (isDraggingLyricScroll) { setRgba(0.478, 0.635, 0.968, 0.85); rectWidth = 8; rectX = width - 10; } 
                else setRgba(1.0, 1.0, 1.0, 0.12);
                if (typeof cr.setLineCap === 'function') cr.setLineCap(1); else cr.set_line_cap(1);
                if (typeof cr.setLineWidth === 'function') cr.setLineWidth(rectWidth); else cr.set_line_width(rectWidth);
                const radius = rectWidth / 2; const centerX = rectX + radius;
                moveTo(centerX, handleY + radius);
                if (typeof cr.lineTo === 'function') cr.lineTo(centerX, handleY + handleHeight - radius); else cr.line_to(centerX, handleY + handleHeight - radius);
                cr.stroke();
            }
            return true;
        });

        unsubs.push(lyrics.subscribe(lines => {
            if (isDestroyed) return; currentLyrics = lines;
            if (lines.length === 0) { 
                targetIdx = -1; smoothY = 0; 
                lyricArea.visible = false; //如果没歌词，直接将整个歌词区域设为不可见，GTK 会自动把面板缩回去！
                return; 
            }
            lyricArea.visible = true; //如果有歌词，瞬间展开面板！
            
            const state = adapter.getSnapshot() || adapter.refreshSnapshot();
            const newTarget = findLyricIndex(lines, Math.max(0, state?.position ?? 0), -1);
            if (Math.abs(newTarget - smoothY) > 5) smoothY = newTarget;
            targetIdx = newTarget; startAnimation(); 
        }));

        let lastRenderedRatio = -1;
        const tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (isDestroyed) return GLib.SOURCE_REMOVE;
            const state = currentState; if (!state) return GLib.SOURCE_CONTINUE;
            let pos = 0; let forceDraw = false;
            if (isUserDragging) { pos = Math.min(1, Math.max(0, slider.get_value())) * progressBaseLength; forceDraw = true; } 
            else { if (!progressBasePlaying) pos = progressBasePosition; else { pos = Math.min(progressBaseLength > 0 ? progressBaseLength : 99999, progressBasePosition + Math.max(0, (Date.now() - lastStateAt) / 1000)); forceDraw = true; } }
            if (forceDraw || Math.abs(currentPlayPos - pos) > 0.01) { currentPlayPos = pos; if (currentLyrics.length > 0) lyricArea.queue_draw(); }
            if (currentLyrics.length > 0) {
                const newIdx = findLyricIndex(currentLyrics, pos, targetIdx);
                const isUserShieldActive = userLyricScrollTimeout !== 0 && Date.now() < userLyricScrollTimeout;
                if (newIdx !== targetIdx && newIdx !== -1) { targetIdx = newIdx; if (!isUserShieldActive) startAnimation(); } 
                else if (userLyricScrollTimeout !== 0 && Date.now() >= userLyricScrollTimeout) { userLyricScrollTimeout = 0; startAnimation(); }
            }
            if (progressBaseLength > 0 && !isUserDragging) {
                const ratio = Math.min(1, Math.max(0, pos / progressBaseLength));
                if (Math.abs(ratio - lastRenderedRatio) >= 0.001) { progress.set(ratio); lastRenderedRatio = ratio }
            }
            return GLib.SOURCE_CONTINUE;
        });

        const finalContainer: any = new Box({ vertical: true, children: [playerControlsBox, lyricArea] });
        finalContainer.connect("destroy", () => {
            isDestroyed = true; adapter.destroy(); GLib.source_remove(tickId);
            if (animTickId !== null) try { lyricArea.remove_tick_callback(animTickId); } catch(e) {}
            unsubs.forEach(u => u());
        });
        return finalContainer;
    } catch (e: any) { return new Box({ vertical: true, children: [ new Label({ label: "Player init error", xalign: 0.5 }) ] }); }
}



