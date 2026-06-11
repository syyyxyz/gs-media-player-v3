import { App, Astal, Gdk, Gtk } from "astal/gtk3"
import { Box, Label, Window, EventBox, Overlay } from "astal/gtk3/widget"

import Playlist, * as playlistMod from "./playlist"
import { CalendarWindow, calendarStyle } from "./calendar"
import { buildPlayerCard, playerStyle } from "./player"
import * as wifi from "./wifi"

const wifiAny: any = wifi

// 动态提取样式：如果 playlist.ts 有 export 则提取，如果没有则安全回退，绝不报错
const playlistStyle = (playlistMod as any).playlistStyle || "";

// 🎨 全局样式组装：
const globalStyle = `
window { background-color: transparent; }
` + calendarStyle + playerStyle + wifiAny.wifiStyle + playlistStyle

App.start({
    instanceName: "ags",
    css: globalStyle,
    requestHandler(request, res) {
        const app = App as any
        const win = app.get_window ? app.get_window(request) : app.getWindow ? app.getWindow(request) : null
        if (win) {
            win.visible = !win.visible
            return res("window toggled") 
        }
        return res("unknown request")
    },
    main() {
        // App.start already injected CSS. Avoid calling App.apply_css here
        // because it may reset style providers and override the system theme.
        console.error("app: main() started (CSS provided by App.start)")

        // --- 🎵 1. 多媒体部件 ---
        let card: any = null
        try { card = buildPlayerCard(); console.error("app: buildPlayerCard succeeded") } catch(e) { console.error("app: buildPlayerCard failed:", e) }
        const interior = new Box({ vertical: true, className: "player-interior", children: [card] });
        // player interior created; styles are provided by App.start(css)
        
        const w1: any = new Window({ 
            name: "desktop-player", 
            namespace: "desktop-player", //  严谨声明命名空间防暴毙！
            anchor: Astal.WindowAnchor.TOP | Astal.WindowAnchor.RIGHT, 
            layer: Astal.Layer.BOTTOM, 
            marginTop: 150, marginRight: 260, 
            child: interior 
        })
        try { (App as any).add_window ? (App as any).add_window(w1) : (App as any).addWindow?.(w1); console.debug("app: added window desktop-player") } catch(e) { console.error("app: addWindow desktop-player failed:", e) }
        try {
            // Diagnostics: check whether the interior widget actually has the class applied
            const sc: any = (interior as any).get_style_context ? (interior as any).get_style_context() : null
            const hasClass = sc && typeof sc.has_class === 'function' ? sc.has_class('player-interior') : (sc ? 'no-has_class-method' : 'no-style-context')
            console.error('app: interior style-context check ->', hasClass)
        } catch(err) { console.error('app: interior style-context check failed', err) }

        try {
            // More diagnostics: list known style providers if API exists
            if (Gtk.StyleContext && typeof Gtk.StyleContext.list_providers === 'function') {
                const providers = Gtk.StyleContext.list_providers()
                console.error('app: style providers count ->', providers ? providers.length : 0)
            } else {
                console.error('app: Gtk.StyleContext.list_providers not available')
            }
        } catch (e) { console.error('app: style providers diagnostic failed', e) }

        try { console.error('app: App.start css length ->', typeof(globalStyle) === 'string' ? globalStyle.length : 0, 'chars') } catch(e) {}

        // --- 🛜 2. Wi-Fi 菜单部件 ---
        const wifiMenu = wifiAny.buildWifiMenu()
        let w2: any = null
        const clickOutside = new EventBox({ expand: true, onButtonPressEvent: () => { w2?.hide?.() } })
        const overlay = new Overlay({ child: clickOutside, overlays: [new Box({ valign: Gtk.Align.START, halign: Gtk.Align.END, css: "margin-top: 40px; margin-right: 60px;", child: wifiMenu })] })
        
        w2 = new Window({ 
            name: "wifi-menu", 
            namespace: "wifi-menu", //  供 Hyprland blur 动画捕获
            anchor: Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT, 
            layer: Astal.Layer.TOP, 
            keymode: Astal.Keymode.ON_DEMAND, 
            exclusivity: Astal.Exclusivity.IGNORE, 
            visible: false, 
            child: overlay, 
            onKeyPressEvent: (self: any, event: any) => { const [_, keyval] = event.get_keyval(); if (keyval === Gdk.KEY_Escape) { self.visible = false } } 
        })
        w2.connect("notify::visible", (self: any) => { if (self.visible) { self.grab_focus() } })
        try { (App as any).add_window ? (App as any).add_window(w2) : (App as any).addWindow?.(w2); console.debug("app: added window wifi-menu") } catch(e) { console.error("app: addWindow wifi-menu failed:", e) }

        // --- 📅 3. 日历部件 ---
        try {
            (App as any).add_window ? (App as any).add_window(CalendarWindow()) : (App as any).addWindow?.(CalendarWindow())
            console.debug("app: added window calendar-menu")
        } catch(e) {
            console.error("日历模块加载失败:", e)
        }

        // --- 🎵 4. 播放列表挂载 ---
        // 🌟 核心修复 2：正确将 Playlist 实例托管给 GTK App 内存，终结无故闪退与段错误！
        try {
            const playlistWin = Playlist();
            if (playlistWin) {
                (App as any).add_window ? (App as any).add_window(playlistWin) : (App as any).addWindow?.(playlistWin);
                console.debug("app: added window playlist")
            }
        } catch(e) {
            console.error("播放列表加载失败:", e)
        }
    }
})