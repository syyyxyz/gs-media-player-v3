// @ts-nocheck
import { Box, Label, Button, Entry, Scrollable } from "astal/gtk3/widget"
import { Variable, bind, execAsync, GLib } from "astal"

// 官方规定网络硬件模块从 gi 导入
import Network from "gi://AstalNetwork"

// 🎨 Wi‑Fi 样式（完美兼容 GTK3）
export const wifiStyle = `
.wifi-interior { background-color: rgba(26, 27, 38, 0.45); border-top: 1px solid rgba(255, 255, 255, 0.3); border-left: 1px solid rgba(255, 255, 255, 0.15); border-right: 1px solid rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.05); border-radius: 24px; padding: 15px; min-width: 340px; font-family: 'Adwaita Sans', 'Noto Sans', 'DejaVu Sans', sans-serif; font-size: 14px; font-weight: 400; }
.wifi-item { background: transparent; border: none; padding: 14px 14px; border-radius: 12px; margin-bottom: 4px; color: rgba(192, 202, 245, 0.8); }
.wifi-item:hover { background-color: rgba(255, 255, 255, 0.08); color: #bb9af7; }
.wifi-item.active { background-color: rgba(122, 162, 247, 0.12); border-left: 3px solid #7aa2f7; color: #7aa2f7; }
.wifi-expand { padding: 10px 14px; background-color: rgba(0, 0, 0, 0.2); border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; margin-bottom: 4px; margin-top: -8px; }
.wifi-pw-entry { background-color: rgba(255, 255, 255, 0.12); color: #ffffff; caret-color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.15); border-top: 1px solid rgba(255, 255, 255, 0.35); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
.wifi-pw-entry:focus { border-color: rgba(255, 255, 255, 0.4); background-color: rgba(255, 255, 255, 0.18); }
.wifi-pw-entry.error { border-color: rgba(247, 118, 142, 0.55); background-color: rgba(247, 118, 142, 0.12); color: #f7768e; }
.wifi-connect-btn, .wifi-disconnect-btn { background-image: none; background-color: rgba(122, 162, 247, 0.15); color: #7aa2f7; font-weight: 500; font-size: 14px; border-radius: 8px; padding: 8px; border: 1px solid rgba(122, 162, 247, 0.3); }
.wifi-connect-btn:hover { background-color: rgba(122, 162, 247, 0.35); color: #ffffff; }
.wifi-disconnect-btn { background-image: none; background-color: rgba(247, 118, 142, 0.15); color: #f7768e; border-color: rgba(247, 118, 142, 0.3); }
.wifi-icon { margin-right: 12px; font-size: 18px; }
.wifi-icon.excellent { color: #9ece6a; }
.wifi-icon.good { color: #e0af68; }
.wifi-icon.fair { color: #ff9e64; }
.wifi-icon.poor { color: #f7768e; }
.wifi-ssid { font-size: 15px; font-weight: 500; }
.wifi-percent { font-size: 15px; font-weight: 500; color: #bb9af7; margin-left: 10px; font-family: 'Noto Sans Mono', monospace; }
`

export interface WifiNetwork { ssid: string; active: boolean; signal: number; security: boolean }
const expandedSsid = Variable<string>("")
const network = Network.get_default()
const wifi = network?.get_wifi ? network.get_wifi() : network?.wifi

function buildWifiRows(nets: WifiNetwork[]) {
    return nets.map(net => {
        const iconStr = net.signal > 75 ? "󰤨" : net.signal > 50 ? "󰤥" : net.signal > 25 ? "󰤢" : "󰤯"
        const strengthClass = net.signal > 75 ? "excellent" : net.signal > 50 ? "good" : net.signal > 25 ? "fair" : "poor"
        const lockIcon = net.security ? "󰌾" : "󰤡"

        const iconLbl: any = new Label({ label: iconStr }); iconLbl.get_style_context().add_class("wifi-icon"); iconLbl.get_style_context().add_class(strengthClass)
        const ssidLbl: any = new Label({ label: net.ssid, xalign: 0, hexpand: true, ellipsize: 3 }); ssidLbl.get_style_context().add_class("wifi-ssid")
        const secLbl: any = new Label({ label: lockIcon }); secLbl.get_style_context().add_class("wifi-sec")
        const pLbl: any = new Label({ label: `${net.signal}%`, xalign: 1 }); pLbl.get_style_context().add_class("wifi-percent")
        const rowBox: any = new Box({ children: [iconLbl, ssidLbl, secLbl, pLbl] })

        const headerBtn: any = new Button({ child: rowBox, onClicked: () => expandedSsid.set(expandedSsid.get() === net.ssid ? "" : net.ssid) })
        headerBtn.get_style_context().add_class("wifi-item")
        if (net.active) headerBtn.get_style_context().add_class("active")

        const expandBox: any = new Box({ vertical: true, visible: bind(expandedSsid).as(ssid => ssid === net.ssid) })
        expandBox.get_style_context().add_class("wifi-expand")

        if (net.active) {
            const disconnectBtn: any = new Button({ label: "Disconnect", onClicked: () => { execAsync(`nmcli dev wifi disconnect`).catch(console.error); expandedSsid.set("") } })
            disconnectBtn.get_style_context().add_class("wifi-disconnect-btn")
            expandBox.add(disconnectBtn)
        } else {
            const isConnecting = Variable(false)
            const pwEntry: any = new Entry({ placeholderText: "Password...", visibility: false, visible: bind(isConnecting).as(c => net.security && !c) })
            pwEntry.get_style_context().add_class("wifi-pw-entry")
            
            const setPasswordError = (isError: boolean) => {
                pwEntry.placeholderText = isError ? "Password error" : "Password..."
                if (isError) pwEntry.get_style_context().add_class("error")
                else pwEntry.get_style_context().remove_class("error")
            }
            setPasswordError(false)
            
            const connectAction = () => {
                const pw = pwEntry.text || ""
                let cmd = `nmcli dev wifi connect "${net.ssid}"`
                if (pw && net.security) cmd += ` password "${pw}"`
                isConnecting.set(true); setPasswordError(false)
                execAsync(cmd).then(() => { 
                    isConnecting.set(false); expandedSsid.set(""); setPasswordError(false) 
                }).catch(() => {
                    isConnecting.set(false)
                    pwEntry.text = ""
                    setPasswordError(true)
                })
            }
            pwEntry.connect("activate", () => connectAction())
            pwEntry.connect("focus-in-event", () => { setPasswordError(false); return false })
            
            const connectBtn: any = new Button({ child: new Label({ label: bind(isConnecting).as(c => c ? "Connecting..." : "Connect") }), onClicked: connectAction })
            connectBtn.get_style_context().add_class("wifi-connect-btn")
            
            expandBox.add(pwEntry); expandBox.add(connectBtn)
        }

        return new Box({ vertical: true, children: [headerBtn, expandBox] })
    })
}

export function buildWifiMenu() {
    const list = new Box({ vertical: true, children: [] })
    
    // 原生高度约束，拒绝白屏
    const scroll: any = new Scrollable({ 
        child: list, 
        hscroll: "never", 
        vscroll: "automatic", 
        heightRequest: 330 
    })
    
    const container: any = new Box({ vertical: true, children: [scroll], className: "wifi-interior" })

    const refresh = () => {
        // 🍎 终极防腐：兼容所有可能版本的属性名获取
        const aps = (wifi?.get_access_points ? wifi.get_access_points() : (wifi?.accessPoints || wifi?.access_points)) || []
        const activeSsid = (wifi?.get_ssid ? wifi.get_ssid() : wifi?.ssid) || ""
        
        const bySsid = new Map<string, WifiNetwork>()
        for (const ap of aps) {
            const ssid = (ap?.get_ssid ? ap.get_ssid() : ap?.ssid) || ""
            if (!ssid) continue // 隐藏网络直接抛弃
            const candidate: WifiNetwork = {
                ssid,
                active: activeSsid !== "" && ssid === activeSsid,
                signal: (ap?.get_strength ? ap.get_strength() : ap?.strength) || 0,
                security: !!(ap?.get_requires_password ? ap.get_requires_password() : ap?.requires_password),
            }
            const prev = bySsid.get(ssid)
            if (!prev || candidate.active || candidate.signal > prev.signal) bySsid.set(ssid, candidate)
        }
        const nets: WifiNetwork[] = [...bySsid.values()]

        nets.sort((a, b) => (a.active === b.active ? b.signal - a.signal : a.active ? -1 : 1))
        list.children = buildWifiRows(nets)
    }

    if (wifi) {
        // 🍎 放弃不稳定的 bind，改用火力覆盖的 GObject notify 信号
        const signalIds: number[] = []
        const propsToWatch = ["access-points", "accessPoints", "ssid", "active-access-point", "enabled", "state"]
        
        propsToWatch.forEach(prop => {
            try {
                const id = wifi.connect(`notify::${prop}`, refresh)
                if (id) signalIds.push(id)
            } catch(e) {} // 悄悄吃掉报错，绝对不炸 UI
        })

        ;(container as any).connect?.("destroy", () => { 
            signalIds.forEach(id => { try { wifi.disconnect(id) } catch(e){} })
        })

        // 强行唤醒网卡扫描
        try { wifi.scan?.() } catch (e) { console.error("wifi.scan failed", e) }
        
        // 🍎 兜底操作：网卡扫描需要时间，1秒后强制拉取一次硬件刚刚扫出来的结果
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            try { refresh() } catch(e) {}
            return GLib.SOURCE_REMOVE
        })

        refresh()
    } else {
        list.children = [new Label({ label: "Wi‑Fi unavailable" })]
    }

    return container
}