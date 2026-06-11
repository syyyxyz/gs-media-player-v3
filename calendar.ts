// @ts-nocheck
import { App, Astal, Gdk, Gtk } from "astal/gtk3"
import { Box, Label, Button, Window } from "astal/gtk3/widget"
import { Variable, bind, GLib } from "astal"

// 🎨 r/unixporn 顶级高定：单层极简液态白霜玻璃样式表
export const calendarStyle = `
.calendar-window {
    background-color: transparent;
}

/* 🌟 核心布局：避开顶部 Waybar (54px)，靠左悬浮 */
.calendar-layout-box {
    padding-top: 54px; 
    padding-left: 16px;
    padding-bottom: 16px;
}

/* 🌟 极致纯净的单层液态白霜面板：修长比例 (Long & Tall) */
.calendar-interior {
    background-color: rgba(255, 255, 255, 0.12); /* ★ 恢复白灰色的液态玻璃底色 */
    border: 1px solid rgba(255, 255, 255, 0.2); /* 突出透明玻璃边缘的高光截面 */
    border-top: 1px solid rgba(255, 255, 255, 0.35); /* 顶部光源高光增强立体感 */
    border-radius: 40px;  /* 整体超大圆角 */
    padding: 56px 40px; /* ★ 满足要求：整体尺寸再造大，拓宽内边距 */
    min-width: 420px;  /* ★ 大幅加大，营造极其宽敞大气的日历排版 */
    /* box-shadow removed for GTK3 compatibility */
}

/* ====================================================
   📅 现代修长日历：液态悬浮
==================================================== */
/* ★ GTK3 终极杀招：清理日历自带的一切顽固底色/边框 */
.pro-calendar,
.pro-calendar header,
.pro-calendar button {
    background-color: transparent;
    background-image: none;
    border: none;
    box-shadow: none;
}

/* ★ 数字显示核心：直接给 calendar 赋颜色，恢复数字正体！ */
.pro-calendar {
    color: #ffffff; /* 所有数字强制纯白 */
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 20px; /* ★ 连同日历数字整体放大 */
    font-style: normal; /* ★ 恢复正体，不再倾斜 */
    padding: 10px; /* 拉大日期网格内部间距 */
}

/* 🌟 日历表头 (年月)：浪漫紫丁香 */
.pro-calendar header {
    padding-bottom: 26px; /* 表头距离数字拉大 */
    color: #bb9af7; 
}
.pro-calendar header label {
    color: #bb9af7;
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 32px; /* ★ 单独把表头等比例放大 */
    font-weight: 800;
    /* text-shadow removed for GTK3 compatibility */
}

/* 左右切换小箭头 */
.pro-calendar button { 
    color: #bb9af7; 
    min-width: 32px;
    min-height: 32px;
}
.pro-calendar button:hover { 
    background-color: rgba(187, 154, 247, 0.2); 
    border-radius: 50%;
}

/* ★ 选中日期的方框高亮：用标准的 :selected，剔除之前引发幽灵蓝色横幅背景的错误深层类名 */
.pro-calendar:selected {
    background-color: rgba(122, 162, 247, 0.35); /* 半透东京蓝块 */
    color: #ffffff; /* 选中的字依然保持最高反差白 */
    border: 1px solid #7aa2f7; /* 高亮的方框边缘发光感 */
    border-radius: 6px; /* 微圆角方框，呈现科技感悬浮 */
    font-weight: 900;
}

/* 系统没被点中时的当天(Today)默认高亮标签 */
.pro-calendar.highlight {
    color: #f7768e; /* 洋红点亮当天数字 */
    font-weight: 900;
}

.glass-divider {
    min-height: 2px;
    background-color: rgba(122, 162, 247, 0.5); /* 更加融合的夜蓝，微光不刺眼 */
    margin: 32px 10px 24px 10px; 
    border-radius: 2px;
}

/* ====================================================
   🌍 时钟模块：深色半透明极客胶囊
==================================================== */
button.active-city-btn {
    background-color: rgba(0, 0, 0, 0.5); /* 增加一点底色浓度，避免半透明造成的抗锯齿发糊 */
    background-image: none;
    border: 1px solid rgba(255, 255, 255, 0.05); /* 微弱高光边缘 */
    border-top: 1px solid rgba(255, 255, 255, 0.15); /* 顶部光源增强质感 */
    border-radius: 32px; /* 略微收缩胶囊边角 */
    padding: 12px 10px; /* ★ 胶囊收身，不要太喧宾夺主 */
    /* transition removed for GTK3 compatibility */
}
button.active-city-btn:hover { 
    background-color: rgba(0, 0, 0, 0.7); 
    border-color: rgba(142, 202, 230, 0.4); 
}
.active-city-row { padding: 16px 20px; } /* ★ 减小时钟胶囊内部的过度留白 */

/* 城市与时间：现代科技青 / 等宽字体 / ★ 减小字号，避免文字过大出戏 */
.active-city-name { color: #8ecae6; font-size: 19px; font-weight: 500; font-family: 'Adwaita Sans', 'Noto Sans', 'DejaVu Sans', sans-serif; } /* ★ 当前城市名稍微放大一点 */
.active-city-time { color: #8ecae6; font-size: 21px; font-weight: 500; font-family: 'Noto Sans Mono', monospace; } /* ★ 当前时间稍微放大一点 */
.arrow-icon { color: #8ecae6; font-size: 16px; margin-left: 10px; }

/* 城市列表 */
.dropdown-box { padding-top: 20px; /* ★ 下拉框与胶囊拉出纵向间隙 */ }
button.dropdown-btn {
    background-color: rgba(0, 0, 0, 0.25); background-image: none;
    border-radius: 18px; margin-bottom: 8px; border: none; padding: 0;
}
button.dropdown-btn:hover { background-color: rgba(0, 0, 0, 0.4); }
.dropdown-row { padding: 20px 24px; }
.dropdown-city-name { color: rgba(192, 202, 245, 0.82); font-size: 18px; font-weight: 500; font-family: 'Adwaita Sans', 'Noto Sans', 'DejaVu Sans', sans-serif; }
.dropdown-city-time { color: rgba(192, 202, 245, 0.82); font-size: 18px; font-weight: 500; font-family: 'Noto Sans Mono', monospace; }
`

const CITIES = [
    { name: "Tokyo", tz: "Asia/Tokyo" },
    { name: "London", tz: "Europe/London" },
    { name: "New York", tz: "America/New_York" },
    { name: "Paris", tz: "Europe/Paris" },
    { name: "Sydney", tz: "Australia/Sydney" }
]

const activeCityName = Variable("Tokyo")
const isDropdownExpanded = Variable(false)
const clockTick = Variable(0)

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    clockTick.set(Date.now())
    return true
})

const getTime = (tz: string) => {
    const dt = GLib.DateTime.new_now(GLib.TimeZone.new(tz))
    return dt ? dt.format("%H:%M") : ""
}

function buildCalendarMenu() {
    const cal = new Gtk.Calendar()
    cal.visible = true
    cal.get_style_context().add_class("pro-calendar")

    // 构建后立刻将 cal 暴露以便重置
    Object.assign(globalThis, { globalCalInstance: cal });

    const divider = new Box({})
    divider.get_style_context().add_class("glass-divider")

    const activeCityLbl = new Label({ label: bind(activeCityName), xalign: 0, hexpand: true })
    activeCityLbl.get_style_context().add_class("active-city-name")
    
    const activeTimeLbl = new Label({
        label: bind(clockTick).as(() => {
            const city = CITIES.find(c => c.name === activeCityName.get())
            return city ? getTime(city.tz) : ""
        }),
        xalign: 1
    })
    activeTimeLbl.get_style_context().add_class("active-city-time")

    const arrowLbl = new Label({ label: bind(isDropdownExpanded).as(exp => exp ? " ▲" : " ▼") })
    arrowLbl.get_style_context().add_class("arrow-icon")

    const rightSideBox = new Box({ children: [activeTimeLbl, arrowLbl] })
    const activeRow = new Box({ children: [activeCityLbl, rightSideBox] })
    activeRow.get_style_context().add_class("active-city-row")

    const activeBtn = new Button({
        child: activeRow,
        onClicked: () => isDropdownExpanded.set(!isDropdownExpanded.get())
    })
    activeBtn.get_style_context().add_class("active-city-btn")

    const dropdownBox = new Box({
        vertical: true,
        visible: bind(isDropdownExpanded),
        children: bind(activeCityName).as(active => {
            return CITIES.filter(c => c.name !== active).map(city => {
                const nameLbl = new Label({ label: city.name, xalign: 0, hexpand: true })
                nameLbl.get_style_context().add_class("dropdown-city-name")
                
                const timeLbl = new Label({ label: bind(clockTick).as(() => getTime(city.tz)), xalign: 1 })
                timeLbl.get_style_context().add_class("dropdown-city-time")
                
                const row = new Box({ children: [nameLbl, timeLbl] })
                row.get_style_context().add_class("dropdown-row")
                
                const btn = new Button({
                    child: row,
                    onClicked: () => {
                        activeCityName.set(city.name)
                        isDropdownExpanded.set(false)
                    }
                })
                btn.get_style_context().add_class("dropdown-btn")
                return btn
            })
        })
    })
    dropdownBox.get_style_context().add_class("dropdown-box")

    // 🌟 紧凑核心：valign 设为 START！组件有多高就缩到多高，绝不往下强行延伸出空白！
    const mainBox = new Box({ 
        vertical: true, 
        valign: Gtk.Align.START,
        children: [cal, divider, activeBtn, dropdownBox] 
    })
    mainBox.get_style_context().add_class("calendar-interior")
    return mainBox
}

// 🌟 取消全屏覆盖与 GTK 内置动画的冲突：使用 Hyprland 动画
export function CalendarWindow() {
    const layoutBox = new Box({
        valign: Gtk.Align.START,
        halign: Gtk.Align.START, // 必须死死钉在边缘
        child: buildCalendarMenu()
    })
    layoutBox.get_style_context().add_class("calendar-layout-box")

    // 既然要用 Hyprland 的 layerrule animation，就不需要 GTK Revealer 包装了，直接把 layoutBox 丢进窗口！
    // ★ 我们只在 AGS 这端做 Window 锚点的定位锚死。
    const win = new Window({
        name: "calendar-menu",
        namespace: "calendar-menu",
        // ★ 核心：不能全屏右边和底边，如果全屏了 Hyprland 就不知道往哪边 slide 了。必须只锚定 TOP 和 LEFT
        anchor: Astal.WindowAnchor.TOP | Astal.WindowAnchor.LEFT,
        layer: Astal.Layer.TOP,
        keymode: Astal.Keymode.ON_DEMAND,
        exclusivity: Astal.Exclusivity.IGNORE,
        visible: false,
        onKeyPressEvent: (self, event) => {
            const [_, keyval] = event.get_keyval()
            if (keyval === Gdk.KEY_Escape) {
                // 直接隐藏，Hyprland 的 slide left 会自动接管退场动画
                win.hide()
                isDropdownExpanded.set(false)
            }
        }
    })
    win.get_style_context().add_class("calendar-window")

    win.connect("notify::visible", (self) => { 
        if (self.visible) { 
            // ★ 打开日历时强制重置到当前真实的年月与日期，避免上次滑动日历的残留！
            const calInst = (globalThis as any).globalCalInstance;
            if (calInst) {
                const now = new Date()
                calInst.year = now.getFullYear()
                calInst.month = now.getMonth()
                calInst.day = now.getDate()
            }
        }
    })

    win.add(layoutBox)
    return win
}
