import { Astal } from "astal/gtk3"
export const Config = {
    //  皮肤与色彩总线
    theme: {
        // 背景色 (支持标准的 rgba 玻璃质感)
        playerBg: "rgba(26, 27, 38, 0.45)",
        playlistBg: "rgba(26, 27, 38, 0.45)",
        
        // 全局激活/高亮的主题色 (按钮悬浮、进度条、列表选中)
        accentColor: "#7aa2f7", 
        
        // 纯文本的基础色
        textColor: "#c0caf5",
        
        //  歌词专属独立色彩 (对应为 Cairo 引擎所需的 0~1 浮点 RGB 值)
        textColorRgb: { r: 0.752, g: 0.792, b: 0.960 },      // 未选中歌词的底色 (对应 #c0caf5)
        lyricActiveRowRgb: { r: 0.752, g: 0.792, b: 0.960 }, // 当前正在唱的整行底色 (对应 #c0caf5)
        lyricFillColorRgb: { r: 0.478, g: 0.635, b: 0.968 }, // 默认的卡拉OK高亮染色 (对应 #7aa2f7)

        //  特定歌曲的专属定制颜色字典 (只要歌名包含前面的字，就会自动应用后面的颜色)
        customSongColors: {
            "世末歌者": { r: 0.647, g: 0.259, b: 0.259 }, // 暗红色
        } as Record<string, { r: number, g: number, b: number }>
    },


    // 字体家族配置
    fonts: {
        normal: "sans-serif",
        chinese: "STXingkai, FZXingKai-Z04, Xingkai SC, STKaiti, Kaiti, sans-serif",
    },

    //空间布局与视网膜字号 (完全可自定义长宽高度)
    sizes: {
        // 主播放器配置
        playerWidth: 360,     // 播放器面板宽度
        lyricHeight: 320,     // 歌词滚动区域的高度
        lyricNormalSize: 15,  // 英文/普通歌词基础字号
        lyricChineseSize: 19, // 中文行楷基础字号 (行楷字偏小，建议比普通字大4px)
        
        // 播放列表配置
        playlistWidth: 240,   // 播放列表抽屉的宽度
        playlistHeight: 480,  // 播放列表抽屉的高度
        playlistTitleSize: 15,// 列表歌名字号
        playlistArtistSize: 13,// 列表歌手字号
    },
    //播放器位置
    positions: {
        playlistAnchor: Astal.WindowAnchor.TOP | Astal.WindowAnchor.RIGHT,
        playlistMarginTop: 187,
        playlistMarginRight: 10,
    }

};