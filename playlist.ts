import { Astal, Gdk, Gtk } from "astal/gtk3"
import { Box, Label, Button, Window, Scrollable } from "astal/gtk3/widget"
import { Variable, bind, execAsync, GLib } from "astal"

import { currentTitle, playerActionBus } from "./player"
import { Config } from "./Config"

export let playlistWindowInstance: any = null;
export const playlistStyle = ""; 

export const togglePlaylist = () => {
    if (playlistWindowInstance) playlistWindowInstance.visible = !playlistWindowInstance.visible;
};

const playlistCSS = `
#playlist-host, #playlist-host decoration { background-color: transparent; background-image: none; box-shadow: none; border: none; }

.playlist-interior { 
    background-color: ${Config.theme.playlistBg};
    border-top: 1px solid rgba(255, 255, 255, 0.3); border-left: 1px solid rgba(255, 255, 255, 0.15); border-right: 1px solid rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.05); border-radius: 24px; padding: 20px 16px 20px 20px;
}
.playlist-header { padding-bottom: 12px; }
.playlist-title { color: ${Config.theme.textColor}; font-family: '${Config.fonts.normal}', system-ui, sans-serif; font-size: 18px; font-weight: 800; letter-spacing: 2px; }

.playlist-close { color: alpha(${Config.theme.textColor}, 0.6); background-color: transparent; background-image: none; min-width: 32px; min-height: 32px; border-radius: 50%; border: none; font-size: 14px; font-weight: 900; transition: all 0.25s ease; }
.playlist-close:hover { color: ${Config.theme.accentColor}; background-color: alpha(${Config.theme.accentColor}, 0.15); background-image: none; }
.playlist-glass-divider { min-height: 1px; background-color: rgba(255, 255, 255, 0.08); margin: 0 4px 16px 4px; border-radius: 1px; }

#playlist-scroll, #playlist-scroll viewport, #playlist-scroll frame, #playlist-scroll > viewport, #playlist-scroll > viewport > frame { border: none; border-color: transparent; outline: none; box-shadow: none; background-color: transparent; background-image: none; padding: 0; }
#playlist-scroll scrollbar.vertical { background-color: transparent; background-image: none; border: none; min-width: 8px; }
#playlist-scroll scrollbar.vertical trough { background-color: transparent; background-image: none; border: none; }
#playlist-scroll scrollbar.vertical slider { min-width: 6px; min-height: 40px; border-radius: 6px; background-color: alpha(${Config.theme.textColor}, 0.3); border: none; margin: 2px; transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1); }
#playlist-scroll scrollbar.vertical slider:hover { min-width: 8px; background-color: alpha(${Config.theme.textColor}, 0.7); }
#playlist-scroll scrollbar.vertical slider:active, #playlist-scroll scrollbar.vertical slider:checked { background-color: ${Config.theme.accentColor}; box-shadow: 0 0 12px alpha(${Config.theme.accentColor}, 0.5); }

.playlist-list-box { padding: 0px 4px 0px 0px; }
.playlist-item { background-color: transparent; background-image: none; border: none; box-shadow: none; outline: none; border-radius: 16px; padding: 12px 6px; transition: background-color 0.3s ease, border-radius 0.3s ease; margin-bottom: 6px; }
.playlist-item:hover, .playlist-item:focus, .playlist-item:active { background-color: rgba(255, 255, 255, 0.05); background-image: none; border: none; box-shadow: none; outline: none; }
.playlist-item.active { background-color: alpha(${Config.theme.accentColor}, 0.15); background-image: none; border: none; box-shadow: none; outline: none; }

.playlist-item-title { color: ${Config.theme.textColor}; font-family: '${Config.fonts.normal}', system-ui, sans-serif; font-size: ${Config.sizes.playlistTitleSize}px; font-weight: bold; transition: color 0.3s ease; }
.playlist-item.active .playlist-item-title { color: ${Config.theme.accentColor}; }
.playlist-item-artist { color: alpha(${Config.theme.textColor}, 0.5); font-family: '${Config.fonts.normal}', system-ui, sans-serif; font-size: ${Config.sizes.playlistArtistSize}px; margin-top: 4px; }
.playlist-empty { color: alpha(${Config.theme.textColor}, 0.5); font-size: 14px; margin-top: 40px; }

.playlist-item-cover { min-width: 48px; min-height: 48px; border-radius: 10px; background-size: cover; background-position: center; background-color: rgba(255, 255, 255, 0.03); margin-right: 6px; transition: opacity 0.3s ease; }
.playlist-item:hover .playlist-item-cover { opacity: 0.85; }
`;
try {
    const provider = new Gtk.CssProvider(); provider.load_from_data(playlistCSS);
    Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_USER);
} catch (err) {}

// 核心数据与业务逻辑
export interface PlaylistItem { position: number; title: string; artist: string; coverArt: string; file: string; }

function getAbsoluteAudioPath(file: string): string {
    if (!file) return "";
    let absolutePath = file;
    if (file.startsWith("file://")) { try { absolutePath = GLib.filename_from_uri(file)[0] || file.replace("file://", ""); } catch(e) {} } 
    else if (!file.startsWith("/")) absolutePath = GLib.build_filenamev([GLib.get_home_dir(), "Music", file]);
    try { absolutePath = decodeURIComponent(absolutePath); } catch(e) {}
    return absolutePath;
}

function resolveLocalCover(absolutePath: string): string {
    if (!absolutePath) return "";
    const dir = absolutePath.replace(/\/[^/]*$/, "");
    const baseName = absolutePath.split("/").pop()?.replace(/\.[^/.]+$/, "") || "";
    const candidates = [`${dir}/${baseName}.png`, `${dir}/${baseName}.jpg`, `${dir}/cover.png`, `${dir}/cover.jpg`, `${dir}/folder.jpg`];
    for (const path of candidates) { try { if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path; } catch (e) {} }
    return "";
}

async function fetchMpdPlaylist(): Promise<PlaylistItem[]> {
    try {
        const output = await execAsync(`mpc -f '%title%;;;%artist%;;;%file%' playlist`).catch(() => "");
        if (!output.trim()) return [];

        return output.split(/\r?\n/).filter(Boolean).map((line, index) => {
            const parts = line.split(";;;");
            let title = parts[0]?.trim(); let artist = parts[1]?.trim();
            const absolutePath = getAbsoluteAudioPath(parts[2]?.trim() || "");

            if (!title || title.toLowerCase().includes("unknown")) title = absolutePath.split('/').pop()?.replace(/\.[^/.]+$/, "") || "Unknown Media";
            if (!artist || artist.toLowerCase().includes("unknown")) artist = "Unknown Artist";

            return { position: index + 1, title, artist, coverArt: resolveLocalCover(absolutePath), file: absolutePath };
        });
    } catch (error) { return []; }
}

function createPlaylistItem(item: PlaylistItem) {
    const coverBox = new Box({
        className: "playlist-item-cover",
        css: item.coverArt ? `background-image: url('file://${item.coverArt.replace(/'/g, "%27").replace(/"/g, "%22")}');` : `background-image: url('file:///usr/share/icons/Adwaita/scalable/mimetypes/audio-x-generic-symbolic.svg');`
    });
    const metaBox = new Box({ vertical: true, valign: Gtk.Align.CENTER, hexpand: true, children: [
        new Label({ className: "playlist-item-title", xalign: 0, hexpand: true, ellipsize: 3, label: item.title }),
        new Label({ className: "playlist-item-artist", xalign: 0, hexpand: true, ellipsize: 3, label: item.artist })
    ]});

    return new Button({
        className: bind(currentTitle).as(t => t === item.title ? "playlist-item active" : "playlist-item"),
        onClicked: () => {
            currentTitle.set(item.title);
            playerActionBus.set(`play|||${item.position}|||${item.title}|||${item.file}|||${item.artist}`);
        },
        child: new Box({ spacing: 12, children: [coverBox, metaBox] })
    });
}

function safeClearContainer(container: Gtk.Box) {
    container.get_children().forEach((ch: any) => { if (typeof ch.destroy === 'function') { try { ch.destroy(); } catch(e) {} } });
}

async function renderPlaylistItems(container: Gtk.Box) {
    safeClearContainer(container); 
    const playlist = await fetchMpdPlaylist();
    safeClearContainer(container); 

    if (playlist.length === 0) {
        container.add(new Label({ className: "playlist-empty", label: "暂无播放列表", xalign: 0.5, yalign: 0.5, vexpand: true }));
    } else {
        playlist.forEach(item => container.add(createPlaylistItem(item)));
    }
    container.show_all();
}

//  容器 UI 组装 (引入 Config 位置参数)
export default function Playlist() {
    const header = new Box({ className: "playlist-header", valign: Gtk.Align.CENTER, children: [
        new Label({ label: "PLAYLIST", className: "playlist-title", hexpand: true, xalign: 0, valign: Gtk.Align.CENTER }),
        new Button({ className: "playlist-close", child: new Label({ label: "✕" }), onClicked: togglePlaylist, valign: Gtk.Align.CENTER, setup: (btn: any) => btn.set_relief(Gtk.ReliefStyle.NONE) })
    ]});

    const listBox = new Box({ className: "playlist-list-box", vertical: true, vexpand: true, hexpand: true });
    const scrollContainer = new Scrollable({
        name: "playlist-scroll", className: "playlist-scroll", vexpand: true, hexpand: true,
        hscroll: Gtk.PolicyType.NEVER, vscroll: Gtk.PolicyType.ALWAYS, child: listBox, 
        setup: (sw: any) => { sw.set_shadow_type(Gtk.ShadowType.NONE); try { sw.set_property("overlay-scrolling", false); } catch (e) {} }
    });

    const win = new Window({
        name: "playlist-host", className: "playlist-host", namespace: "playlist",
        anchor: Config.positions.playlistAnchor, 
        marginTop: Config.positions.playlistMarginTop,
        marginRight: Config.positions.playlistMarginRight, 
        exclusivity: Astal.Exclusivity.IGNORE, keymode: Astal.Keymode.ON_DEMAND, visible: false, layer: Astal.Layer.TOP,
        child: new Box({ className: "playlist-interior", vertical: true, widthRequest: Config.sizes.playlistWidth, heightRequest: Config.sizes.playlistHeight, children: [header, new Box({ className: "playlist-glass-divider", hexpand: true }), scrollContainer] }),
        setup: (self: any) => {
            self.connect("key-press-event", (widget: any, event: any) => { if (event.get_keyval()[1] === Gdk.KEY_Escape) { togglePlaylist(); return true; } return false; });
            self.connect("notify::visible", () => { if (self.visible) renderPlaylistItems(listBox); });
        }
    });

    playlistWindowInstance = win; return win;
}



