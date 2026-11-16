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
	"meta.description": ["程序化壁纸 + 轮播调度：两张生成式壁纸与四张内置插画，按间隔 / 整点 / 每日自动更换", "Procedural wallpapers with a rotation scheduler: two generated designs plus four bundled illustrations, changing on an interval, the hour, or daily"],

	"section.label": ["壁纸", "Wallpaper"],

	"group.current": ["当前壁纸", "Current"],
	"group.builtin": ["内置壁纸", "Built-in"],
	"group.custom": ["自定义", "Custom"],
	"group.splash": ["开屏", "Splash"],
	"group.splash.hint": ["DSH 启动时先显示这张图或这段视频，界面就绪后自动让位", "Shown while DSH starts up, then steps aside once the interface is ready"],
	"group.rotation": ["轮播调度", "Rotation"],
	"group.appearance": ["外观", "Appearance"],
	"group.status": ["状态", "Status"],

	"section.wallpaper": ["壁纸", "Wallpaper"],
	"section.wallpaper.hint": ["换哪张图、隔多久换、字压在上面还清不清楚", "Which picture, how often it changes, and whether text stays readable on it"],
	"section.wallpaper.more": ["更多设置", "More"],
	"section.wallpaper.more.hint": ["轮播调度 · 外观", "Rotation · appearance"],
	"section.composer": ["消息栏", "Composer"],
	"section.composer.hint": ["输入框的蓝环和鲸鱼娘，可以关掉", "The rim and the whale girl on the input box — or switch them off"],
	"section.composer.rim": ["输入框四边是一圈 2.5px 的蓝色细环，鼠标移上去或者点进输入框时会亮起来。", "A 2.5px blue rim rings the input box; it brightens on hover and while the box holds focus."],
	"section.composer.mascot": ["左边挂着鲸鱼娘，点她一下收成一条尾巴，再点一下就回来了。", "The whale girl hangs on the left edge — click her once to fold her into a tail, again to bring her back."],
	"composer.enable": ["应用到输入框", "Apply to the composer"],
	"composer.enable.hint": ["关掉之后输入框完全恢复 DSH 原样", "Off leaves the input box exactly as DSH ships it"],
	"composer.off": ["已关闭：输入框恢复原样，壁纸和开屏不受影响。", "Off. The input box is back to stock; the wallpaper and splash are untouched."],

	"kind.recipe": ["生成式", "Generated"],
	"kind.photo": ["内置插画", "Bundled illustration"],
	"kind.image": ["本地图片", "Local image"],
	"kind.url": ["图片地址", "Image URL"],
	"kind.gradient": ["渐变", "Gradient"],

	"hero.shake": ["摇一摇", "Shake"],
	"hero.shake.hint": ["同一个配方，换一组随机参数", "Same recipe, a fresh set of random values"],
	"hero.copySeed": ["复制种子", "Copy seed"],
	"hero.copied": ["已复制", "Copied"],
	"hero.add": ["加入播放列表", "Add to playlist"],
	"hero.seed": ["种子", "Seed"],

	"custom.source": ["来源", "Source"],
	"custom.local": ["本地图片", "Local image"],
	"custom.local.hint": ["把图片拖到这一行，或点右边的按钮，可以一次选多张。会自动缩小并压缩后保存，长边不超过 2560 像素", "Drop pictures on this row, or use the button — several at once is fine. They are resized and compressed before saving, long edge up to 2560px"],
	"custom.choose": ["选择文件…", "Choose file…"],
	"custom.url": ["图片地址", "Image URL"],
	"custom.url.hint": ["填一个以 http:// 或 https:// 开头的图片链接，点应用才会生效", "An image address starting with http:// or https:// — nothing happens until you press apply"],
	"custom.url.placeholder": ["https://…/wallpaper.jpg", "https://…/wallpaper.jpg"],
	"custom.apply": ["应用", "Apply"],
	// What is applied, said twice: a crop of the thing itself sits above, and
	// these lines name it. "96KB" alone answered how big and nothing else.
	"custom.applied.image": ["已应用的本地图片 · {kb}KB", "Local image applied · {kb}KB"],
	"custom.applied.url": ["已应用的图片地址 · {host}", "Image URL applied · {host}"],

	"splash.local": ["开屏素材", "Splash media"],
	"splash.local.hint": ["图片会铺满整个屏幕，视频会完整播放一次。先选文件，再从下面选它用在哪", "A picture fills the screen; a clip plays through once. Pick the file first, then choose below where it goes"],
	"splash.choose": ["选择文件…", "Choose file…"],
	"splash.builtin": ["内置开屏", "Built-in"],
	"splash.off": ["关闭开屏", "Turn off"],
	"splash.builtin.note": [
		"插件自带一段内置开屏，装好就默认启用——想关掉点「关闭开屏」，想用自己的素材点「选择文件…」。开屏只在 DSH 启动时注入，改完要完全重启 DSH 才看得到",
		"This plugin ships a built-in splash and uses it by default — press Turn off to disable it, or Choose file… to use your own. A splash is injected when DSH starts, so a full restart is what shows a change"
	],
	"splash.apply.wallpaper": ["设为壁纸", "Set as wallpaper"],
	"splash.apply.splash": ["设为开屏", "Set as splash"],
	"splash.apply.both": ["全部", "Both"],
	"splash.staged": ["已选择 {name} · {kb}KB，应用到：", "{name} · {kb}KB — apply to:"],
	"splash.oneAtATime": ["开屏一次只接受一个文件", "A splash takes one file at a time"],
	"splash.uploading": ["正在上传开屏素材…", "Uploading the splash…"],
	"splash.clearing": ["正在清除开屏…", "Clearing the splash…"],
	"splash.stored": ["已设为开屏（{kb}KB）。开屏只在 DSH 启动时注入页面，所以要完全退出并重启 DSH 才能看到它", "Set as the splash ({kb}KB). A splash is injected when DSH starts, so a full restart of DSH is what will show it"],
	"splash.storedBoth": ["已设为壁纸并设为开屏（{kb}KB）。壁纸马上生效，开屏要完全重启 DSH 后可见", "Set as both the wallpaper and the splash ({kb}KB). The wallpaper is live now; the splash shows after a full restart of DSH"],
	"splash.wallpaperFailed": ["已设为开屏（{kb}KB），但壁纸那半边没成。开屏要完全重启 DSH 后可见", "The splash is set ({kb}KB), but the wallpaper half did not take. The splash shows after a full restart of DSH"],
	"splash.cleared": ["开屏已关闭，素材已删除", "Splash turned off, and its file removed"],
	"splash.nothingToClear": ["开屏本来就是关的", "The splash was already off"],
	"splash.switching": ["正在切回内置开屏…", "Switching back to the built-in splash…"],
	"splash.builtinSet": ["已切回内置开屏。重启 DSH 后可见", "Back to the built-in splash. Restart DSH to see it"],
	"splash.builtinSetHad": [
		"已切回内置开屏，原来那段素材已删除（想再用需要重新选一次文件）。重启 DSH 后可见",
		"Back to the built-in splash; the clip you had before has been removed, so using it again means choosing the file again. Restart DSH to see it"
	],
	"splash.unknown": ["宿主通道不可用，读不到开屏状态", "The host route is unavailable, so the splash state cannot be read"],
	"splash.none": ["未设置", "Not set"],
	"splash.off.state": ["已关闭（点「内置开屏」可以打开）", "Off — press Built-in to switch it back on"],
	"splash.current.image": ["图片开屏", "Picture splash"],
	"splash.current.video": ["视频开屏", "Clip splash"],
	"splash.current.builtin": ["内置开屏（默认）", "Built-in splash (default)"],
	"splash.skip": ["跳过", "Skip"],
	"splash.error.noHost": ["宿主通道不可用，开屏只能靠宿主文件", "No host route — a splash needs the host's own file"],
	"splash.error.unsupported": ["只支持 PNG / JPEG / WebP / GIF / AVIF 图片，以及 MP4 / WebM / OGG 视频", "PNG / JPEG / WebP / GIF / AVIF pictures and MP4 / WebM / OGG clips only"],
	"splash.error.tooLarge": ["素材太大，宿主拒绝了这次上传", "That file is too large — the host refused the upload"],
	"splash.error.network": ["上传没能完成，检查网络或重试", "The upload did not complete — check the connection and retry"],
	"splash.error.failed": ["开屏操作失败", "The splash operation failed"],

	"rotation.enable": ["启用轮播", "Enable rotation"],
	"rotation.enable.hint": ["按下面设定的时间，自动在播放列表里换壁纸", "Walks the playlist automatically, on the schedule set below"],
	"rotation.playlist": ["播放列表", "Playlist"],
	"rotation.add": ["添加当前壁纸", "Add current"],
	"rotation.empty": ["播放列表还是空的 —— 先添加几张壁纸", "The playlist is empty — add a few wallpapers first"],
	"rotation.seed": ["用内置壁纸填充", "Fill with built-ins"],
	"rotation.seeded": [
		"已加入 {n} 套内置壁纸并开始轮播；原来的壁纸还留着，关掉轮播就会回来",
		"Added {n} built-in wallpapers and started rotating. Your previous wallpaper is kept — turn rotation off to get it back"
	],
	"rotation.advanced": ["高级设置", "Advanced"],
	"rotation.trigger": ["触发方式", "Trigger"],
	"rotation.interval": ["间隔", "Interval"],
	"rotation.mode.interval": ["按间隔", "Interval"],	"rotation.mode.hourly": ["整点", "Hourly"],
	"rotation.mode.daily": ["每日", "Daily"],
	"rotation.mode.session": ["每次会话", "Per session"],
	"rotation.hourly.hint": ["每小时的这些分钟各换一次，可以多选", "A new one at each of these minutes past the hour — pick as many as you like"],
	"rotation.daily.at": ["更换时刻", "Change at"],
	"rotation.session.hint": ["每次切回 DSH 窗口时换一张，没有固定时刻", "A new one each time you come back to the DSH window — no fixed time"],
	"rotation.order": ["次序", "Order"],
	"rotation.order.sequential": ["顺序", "Sequential"],
	"rotation.order.shuffle": ["洗牌", "Shuffle"],
	"rotation.order.random": ["随机", "Random"],
	"rotation.order.hint.shuffle": ["一轮之内不重复，全部轮完才重新开始", "No repeats until every entry has been shown"],
	"rotation.order.hint.random": ["随便挑一张，只是不会连着两次都是同一张", "Picked at random — only never the same one twice in a row"],
	"rotation.transition": ["过渡", "Transition"],
	"rotation.next": ["下一个", "Next"],
	"rotation.pause": ["暂停", "Pause"],
	"rotation.resume": ["继续", "Resume"],
	"rotation.paused": ["已暂停", "Paused"],
	"rotation.upcoming": ["接下来", "Upcoming"],
	"rotation.countdown": ["距下次", "Next in"],
	"rotation.session.noClock": ["没有固定时刻，只在切回窗口时触发", "No fixed time — triggered when you return to the window"],
	"rotation.missed": ["休眠期间错过了 {n} 次，已经跳过，只补换一次", "Missed {n} while asleep — skipped, caught up once"],

	"appearance.opacity": ["壁纸可见度", "Wallpaper visibility"],
	"appearance.opacity.hint": ["往右拉壁纸更清楚，往左拉界面更好读；拉到正文都要看不清时，守护会把遮罩抬回来", "Right shows more wallpaper, left makes the interface easier to read — if body text would stop being readable, the floor below lifts the wash back up"],
	"appearance.raised": ["为保证文字可读，遮罩已自动加厚：壁纸可见约 {n}%", "Thickened to keep text readable: about {n}% of the wallpaper shows"],
	"appearance.blur": ["模糊", "Blur"],
	"appearance.fit": ["填充", "Fit"],
	"appearance.fit.cover": ["铺满", "Cover"],
	"appearance.fit.contain": ["完整", "Contain"],
	"appearance.fit.blur": ["完整+羽化", "Contain + bleed"],
	"appearance.grain": ["颗粒", "Grain"],
	"appearance.hue": ["色相偏移", "Hue shift"],
	"appearance.softness": ["柔和度", "Softness"],
	"appearance.autoDim": ["自动弱化", "Auto-dim"],
	"appearance.autoDim.hint": ["画面越花，遮罩自动加厚一点，好让文字跳出来", "Busier pictures get a slightly heavier wash so text stands out"],
	"appearance.readability": ["可读性守护", "Readability floor"],
	"appearance.readability.hint": ["按 WCAG AA 标准算出遮罩最少要盖多厚，并把弱化的副文本（时间戳、用量、图标）加深到够读；它只动文字，不替你换壁纸", "Solves the thinnest wash that keeps text at WCAG AA contrast, and deepens the quiet text (timestamps, usage, icons) until it reads too — it never swaps your wallpaper to get there"],
	"appearance.position": ["位置", "Position"],
	"appearance.position.hint": ["照片比屏幕宽的时候会被裁掉一部分，点哪一边就留下照片的哪一边", "A photo wider than the screen gets cropped — pick which side of it to keep"],
	// The tuning knobs do not all reach the same set of pictures: hue and
	// softness are inputs to the recipe generator, while grain is a layer drawn
	// over whatever is showing (at half strength for a photograph, which already
	// has its own texture). The hint has to say so, or the slider reads as broken
	// on a custom photo.
	"appearance.tuning.hint": ["色相和柔和度只作用于「弥散」和「晨雾」这两张生成式壁纸，内置插画不受影响；颗粒对所有壁纸都生效，用在插画上只有一半力度", "Hue and softness only affect the two generated wallpapers, Drift and Mist — the bundled illustrations ignore them. Grain applies to everything, at half strength on illustrations"],

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
	"status.wash": ["画布透明", "Translucent canvas"],
	"status.washBlocked": ["界面这一层没有变透明，壁纸被整块挡住，所以看起来像没生效。主题通道不可用的时候会出现这一行", "The interface never became translucent, so it is covering the wallpaper outright. This line appears when the theme channel is unavailable"],
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
	"toast.applied": ["已应用：{name}", "Applied: {name}"],
	"rotation.unstorable": ["该条目无法保存", "This entry cannot be stored"],
	"rotation.due": ["即将更换", "due now"],

	"error.notImage": ["这不是一个图片文件", "That is not an image file"],
	"error.tooLarge": ["图片太大了（上限 32MB）", "That image is too large (32MB limit)"],
	"error.decode": ["图片解码失败，可能已损坏", "Could not decode that image"],
	"error.stillTooLarge": ["压缩后仍然过大，换一张试试", "Still too large after compression — try another"],
	"error.noCanvas": ["当前环境不支持图片处理", "Image processing is unavailable here"],
	"error.urlInvalid": ["地址无效，只支持 http / https", "Invalid address — http / https only"],
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
