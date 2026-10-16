"use strict";
/**
 * Interface strings, Chinese-first with an English mirror.
 *
 * Kept as a flat table of `key -> [zh, en]` rather than two parallel files, so
 * a string can never exist in one language and be silently missing from the
 * other — the failure mode of a two-file dictionary is invisible until a user
 * switches language and sees a raw key.
 *
 * The panel renders through `t(key, params)`, and `ctx.locale` receives the
 * same table via `dictionaries()`, so the strings participate in the host's own
 * locale service when this plugin runs inside DSH.
 */

/** The locale namespace this plugin registers. */
const NS = "settings.lumen";

const TABLE = {
	"meta.title": ["Lumen · 流转壁纸", "Lumen · Wallpaper"],
	"meta.description": ["程序化壁纸 + 轮播调度：12 套生成式壁纸，按间隔 / 整点 / 每日自动更换", "Procedural wallpapers with a rotation scheduler: 12 generated designs, changing on an interval, the hour, or daily"],

	"section.label": ["壁纸", "Wallpaper"],

	"group.current": ["当前壁纸", "Current"],
	"group.builtin": ["内置壁纸", "Built-in"],
	"group.builtin.hint": ["全部由参数实时生成，无图片素材", "Generated from parameters — no image assets"],
	"group.custom": ["自定义", "Custom"],
	"group.splash": ["开屏", "Splash"],
	"group.splash.hint": ["启动时先盖住界面，外壳接管后再交出去", "Covers the interface while it starts, then hands it over"],
	"group.rotation": ["轮播调度", "Rotation"],
	"group.appearance": ["外观", "Appearance"],
	"group.status": ["状态", "Status"],

	"kind.recipe": ["生成式", "Generated"],
	"kind.image": ["本地图片", "Local image"],
	"kind.url": ["图片地址", "Image URL"],
	"kind.gradient": ["渐变", "Gradient"],

	"hero.shake": ["摇一摇", "Shake"],
	"hero.shake.hint": ["用同一个配方换一个随机种子", "New random seed, same recipe"],
	"hero.copySeed": ["复制种子", "Copy seed"],
	"hero.copied": ["已复制", "Copied"],
	"hero.add": ["加入播放列表", "Add to playlist"],
	"hero.seed": ["种子", "Seed"],

	"custom.local": ["本地图片", "Local image"],
	"custom.local.hint": ["拖入或选择，可多选；自动缩放压缩后保存，长边最多 2560px", "Drop or choose — multiple allowed. Auto-resized and compressed, long edge up to 2560px"],
	"custom.choose": ["选择文件…", "Choose file…"],
	"custom.url": ["图片地址", "Image URL"],
	"custom.url.hint": ["仅支持 http / https", "http / https only"],
	"custom.url.placeholder": ["https://…/wallpaper.jpg", "https://…/wallpaper.jpg"],
	"custom.apply": ["应用", "Apply"],
	"custom.gradient": ["渐变", "Gradient"],
	"custom.gradient.hint": ["两个色标的线性渐变", "A two-stop linear gradient"],
	"custom.from": ["起", "From"],
	"custom.to": ["止", "To"],
	"custom.angle": ["角度", "Angle"],

	"splash.local": ["开屏素材", "Splash media"],
	"splash.local.hint": ["图片直接铺满；视频按视频播放。一个素材，传完再选去处", "A picture is painted full-bleed; a clip plays. One file — you choose where it goes afterwards"],
	"splash.choose": ["选择文件…", "Choose file…"],
	"splash.clear": ["清除", "Clear"],
	"splash.apply.wallpaper": ["设为壁纸", "Set as wallpaper"],
	"splash.apply.splash": ["设为开屏", "Set as splash"],
	"splash.apply.both": ["全部", "Both"],
	"splash.staged": ["已选择 {name} · {kb}KB，应用到：", "{name} · {kb}KB — apply to:"],
	"splash.oneAtATime": ["开屏一次只接受一个文件", "A splash takes one file at a time"],
	"splash.uploading": ["正在上传开屏素材…", "Uploading the splash…"],
	"splash.clearing": ["正在清除开屏…", "Clearing the splash…"],
	"splash.stored": ["已设为开屏（{kb}KB）。开屏在文档生成时就已经写进页面了，所以重新加载后才会看到它", "Set as the splash ({kb}KB). The cover is written into the document as it is generated, so a reload is what will show it"],
	"splash.storedBoth": ["已设为壁纸并设为开屏（{kb}KB）。重新加载后才能看到开屏", "Set as both the wallpaper and the splash ({kb}KB). A reload is what will show the splash"],
	"splash.wallpaperFailed": ["已设为开屏（{kb}KB），但壁纸那半边没成。开屏重新加载后可见", "The splash is set ({kb}KB), but the wallpaper half did not take. The splash shows on reload"],
	"splash.cleared": ["开屏已清除，素材已删除", "Splash cleared, and its file removed"],
	"splash.nothingToClear": ["本来就没有设置开屏", "There was no splash to clear"],
	"splash.unknown": ["宿主通道不可用，读不到开屏状态", "The host route is unavailable, so the splash state cannot be read"],
	"splash.none": ["未设置", "Not set"],
	"splash.current.image": ["图片开屏", "Picture splash"],
	"splash.current.video": ["视频开屏", "Clip splash"],
	"splash.skip": ["跳过", "Skip"],
	"splash.error.noHost": ["宿主通道不可用，开屏只能靠宿主文件", "No host route — a splash needs the host's own file"],
	"splash.error.unsupported": ["只支持 PNG / JPEG / WebP / GIF / AVIF 图片，以及 MP4 / WebM / OGG 视频", "PNG / JPEG / WebP / GIF / AVIF pictures and MP4 / WebM / OGG clips only"],
	"splash.error.tooLarge": ["素材太大，宿主拒绝了这次上传", "That file is too large — the host refused the upload"],
	"splash.error.network": ["上传没能完成，检查网络或重试", "The upload did not complete — check the connection and retry"],
	"splash.error.failed": ["开屏操作失败", "The splash operation failed"],

	"rotation.enable": ["启用轮播", "Enable rotation"],
	"rotation.enable.hint": ["在播放列表里按调度自动更换", "Walk the playlist on a schedule"],
	"rotation.playlist": ["播放列表", "Playlist"],
	"rotation.add": ["添加当前壁纸", "Add current"],
	"rotation.empty": ["播放列表还是空的 —— 先添加几张壁纸", "The playlist is empty — add a few wallpapers first"],
	"rotation.trigger": ["触发方式", "Trigger"],
	"rotation.interval": ["间隔", "Interval"],
	"rotation.mode.interval": ["按间隔", "Interval"],
	"rotation.mode.hourly": ["整点", "Hourly"],
	"rotation.mode.daily": ["每日", "Daily"],
	"rotation.mode.session": ["每次会话", "Per session"],
	"rotation.hourly.hint": ["每到这些分钟更换", "Change at these minutes"],
	"rotation.daily.at": ["更换时刻", "Change at"],
	"rotation.session.hint": ["每次回到这个页面时更换", "Change each time you return to the page"],
	"rotation.order": ["次序", "Order"],
	"rotation.order.sequential": ["顺序", "Sequential"],
	"rotation.order.shuffle": ["洗牌", "Shuffle"],
	"rotation.order.random": ["随机", "Random"],
	"rotation.order.hint.shuffle": ["走完一轮才会重复", "No repeats until the list is exhausted"],
	"rotation.order.hint.random": ["可能与上一张不同即可", "Any entry except the previous one"],
	"rotation.transition": ["过渡", "Transition"],
	"rotation.next": ["下一个", "Next"],
	"rotation.pause": ["暂停", "Pause"],
	"rotation.resume": ["继续", "Resume"],
	"rotation.paused": ["已暂停", "Paused"],
	"rotation.upcoming": ["接下来", "Upcoming"],
	"rotation.countdown": ["距下次", "Next in"],
	"rotation.session.noClock": ["由页面可见性驱动，无固定时刻", "Driven by page visibility — no fixed time"],
	"rotation.missed": ["机器休眠期间错过了 {n} 次，已跳过（只补一次）", "Missed {n} while asleep — skipped, advanced once"],

	"appearance.opacity": ["遮罩不透明度", "Wash opacity"],
	"appearance.opacity.hint": ["面板越透，壁纸越明显，文字越难读", "A thinner wash shows more wallpaper and less text contrast"],
	"appearance.raised": ["已自动提升到 {n}% 以保证文字可读", "Raised to {n}% to keep text readable"],
	"appearance.blur": ["模糊", "Blur"],
	"appearance.fit": ["填充", "Fit"],
	"appearance.fit.cover": ["铺满", "Cover"],
	"appearance.fit.contain": ["完整", "Contain"],
	"appearance.fit.blur": ["完整+羽化", "Contain + bleed"],
	"appearance.grain": ["颗粒", "Grain"],
	"appearance.hue": ["色相偏移", "Hue shift"],
	"appearance.softness": ["柔和度", "Softness"],
	"appearance.autoDim": ["自动弱化", "Auto-dim"],
	"appearance.autoDim.hint": ["画面越复杂，遮罩越厚", "Busier pictures get a heavier wash"],
	"appearance.readability": ["可读性守护", "Readability floor"],
	"appearance.readability.hint": ["按 WCAG AA 反解遮罩下限，文字永不失守", "Solves the wash floor for WCAG AA so text cannot fail"],
	"appearance.position": ["位置", "Position"],
	"appearance.position.hint": ["照片主体在画面里的位置，可避开左侧栏", "Where the subject sits — move it clear of the sidebar"],
	// The tuning knobs do not all reach the same set of pictures: hue and
	// softness are inputs to the recipe generator, while grain is a layer drawn
	// over whatever is showing (at half strength for a photograph, which already
	// has its own texture). The hint has to say so, or the slider reads as broken
	// on a custom photo.
	"appearance.tuning.hint": ["色相与柔和度作用于生成式壁纸；颗粒对所有壁纸生效（照片为半量）", "Hue and softness apply to generated wallpapers; grain applies to all (half strength on photos)"],

	// The nine cells of the position grid carry no visible text — the grid says
	// it. These are the accessible names, so they still belong in the dictionary.
	"position.center": ["居中", "Center"],
	"position.top": ["上", "Top"],
	"position.bottom": ["下", "Bottom"],
	"position.left": ["左", "Left"],
	"position.right": ["右", "Right"],
	"position.tl": ["左上", "Top left"],
	"position.tr": ["右上", "Top right"],
	"position.bl": ["左下", "Bottom left"],
	"position.br": ["右下", "Bottom right"],

	"status.section": ["运行状态", "Runtime"],
	"status.storage": ["持久化", "Persistence"],
	"status.storage.host": ["宿主文件", "Host file"],
	"status.storage.local": ["仅浏览器", "Browser only"],
	"status.reason": ["降级原因", "Degraded because"],
	"status.dom": ["背景层", "Backdrop"],
	"status.motion": ["减弱动效", "Reduced motion"],
	"status.regime": ["模式", "Mode"],
	"status.regime.fixed": ["固定单张", "Fixed"],
	"status.on": ["已启用", "on"],
	"status.off": ["未启用", "off"],
	"status.noStorage": ["localStorage 不可用 —— 刷新后设置会丢失", "localStorage unavailable — nothing will survive a reload"],
	"status.diagnostics": ["诊断快照写在 window.__DSH_LUMEN__", "Diagnostics live on window.__DSH_LUMEN__"],

	"common.none": ["无", "none"],
	"duration.seconds": ["{n} 秒", "{n}s"],
	"duration.minutes": ["{m} 分 {s} 秒", "{m}m {s}s"],
	"duration.hours": ["{h} 小时 {m} 分", "{h}h {m}m"],

	"custom.image.processing": ["正在处理图片…", "Processing image…"],
	"custom.image.stored": ["已保存 {w}×{h} · {kb}KB", "Stored {w}×{h} · {kb}KB"],
	"custom.importing": ["正在处理第 {i}/{n} 张…", "Processing {i} of {n}…"],
	"custom.imported": ["已导入 {n} 张 —— 第一张为当前壁纸，其余已加入播放列表", "Imported {n} — the first is on screen, the rest are in the playlist"],
	"custom.importCapped": ["已导入 {n} 张，播放列表已满（上限 {cap}）", "Imported {n}; the playlist is full ({cap} limit)"],
	"custom.importPartial": ["成功 {ok} 张，失败 {failed} 张", "{ok} imported, {failed} failed"],

	"rotation.full": ["播放列表已满（{n}）", "Playlist is full ({n})"],
	"rotation.unstorable": ["该条目无法保存", "This entry cannot be stored"],
	"rotation.due": ["即将更换", "due now"],

	"error.notImage": ["这不是一个图片文件", "That is not an image file"],
	"error.tooLarge": ["图片太大了（上限 32MB）", "That image is too large (32MB limit)"],
	"error.decode": ["图片解码失败，可能已损坏", "Could not decode that image"],
	"error.stillTooLarge": ["压缩后仍然过大，换一张试试", "Still too large after compression — try another"],
	"error.noCanvas": ["当前环境不支持图片处理", "Image processing is unavailable here"],
	"error.urlInvalid": ["地址无效，只支持 http / https", "Invalid address — http / https only"],
	"error.gradientInvalid": ["渐变参数无效", "Invalid gradient"]
};

/**
 * Build a translator for one language tag.
 * @param {string} [language] "zh" | "en"; anything else falls back to English.
 */
function createTranslator(language) {
	const lang = typeof language === "string" && language.toLowerCase().indexOf("zh") === 0 ? 0 : 1;
	return function translate(key, params) {
		const entry = TABLE[key];
		let text = entry === undefined ? key : entry[lang] || entry[1];
		if (params && typeof params === "object") {
			for (const [name, value] of Object.entries(params)) {
				text = text.split(`{${name}}`).join(String(value));
			}
		}
		return text;
	};
}

/** The `{zh: {...}, en: {...}}` shape `ctx.locale.register` expects. */
function dictionaries() {
	const zh = {};
	const en = {};
	for (const [key, pair] of Object.entries(TABLE)) {
		zh[key] = pair[0];
		en[key] = pair[1];
	}
	return { zh, en };
}

/** All keys, for the docs test that keeps the two languages in step. */
function keys() {
	return Object.keys(TABLE);
}

module.exports = { NS, TABLE, createTranslator, dictionaries, keys };
