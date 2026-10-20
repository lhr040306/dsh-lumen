# 开屏规格 · dsh-lumen

这份文档描述**已经实现并测试过的**开屏协议：宿主半边的媒体存储、四条路由、随包内置的那段短片、启动遮罩与它的兜底守卫，以及浏览器半边（`src/splash.cjs`）如何接住视频。

两岸都在这里，因为它们是一条链路：宿主决定"页面里有一层黑"，浏览器确定"黑什么时候可以走"。所以这里写下的每一个形状，都是代码里此刻真实存在、并由 `tests/host.test.cjs` / `tests/cover.test.cjs` / `tests/splash.test.cjs` 钉住的形状；没有任何"计划中"的字段被写成"已实现"。

配套文档：壁纸侧见 [`WALLPAPER-SPEC.md`](WALLPAPER-SPEC.md)；设计取舍见 [`INNOVATION.md`](INNOVATION.md) §4.6 与 §6.4。

---

## 一、术语与边界

| | 壁纸 | 开屏 |
| --- | --- | --- |
| 存在位置 | app 之内 | app 之前 |
| 谁拥有画面 | 排在内容后面 | 独占整个窗口 |
| 持久化什么 | 压缩后的字节（data URL） | 只有一个**文件名** |
| 跟随主题 | 必须 | 不需要 |
| 可读性下限 | 强制求解 | 不适用 |
| 绘制时机 | 应用跑起来之后 | 应用存在之前 |

两者的要求**互为反面**，所以它们共享导入管道与持久化分层，但**不共享渲染器**。把它们做成一套机制会同时牺牲两者：开屏的职责是盖住 app，壁纸的职责是待在内容后面。

---

## 二、状态

### 2.1 `splash.media`

| 属性 | 值 |
| --- | --- |
| 键 | `splash.media` |
| 值 | 媒体文件名，如 `media-m9x2k1-3f7a01bc.png` |
| 缺省 | 键不存在 = 没有开屏 |
| 非法值 | 视同**没有开屏**（不是报错） |

### 2.2 为什么只存文件名，不存路径、不存字节

壁纸是几百字节的渐变字符串，20 秒视频是 **2 MB**——差三到四个数量级。状态文件是**扁平字符串 map，上限 24 MiB**，且被所有解析到同一 `DSH_HOME` 的进程共享。媒体字节放在里面会同时顶到单次请求体上限和整份文档上限。

但比"省空间"更重要的是：**服务哪个文件，由一段白名单形状拼出来，而不是由请求里的字符串拼出来**。见 §3.3。

### 2.3 值在读取时重新校验

写入时校验过一次不够：这份文件是**跨进程、跨版本共享**的，别的写入者可能已经改过它。所以每次读都按 §3.2 的形状重新校验，失败就当"没有开屏"处理——用户看到的是外壳自己的启动画面，而不是一块坏掉的遮罩。

### 2.4 与 schema 版本的关系

**不抬 schema 版本。** `splash.media` 是同一张扁平 map 上的第 14 个偏好键，仍在 `MAX_STATE_KEYS`（64）之内；旧版构建读到一个不认识的键会**忽略**它——这正是扁平字符串 map 要换来的性质。

⚠️ 但这条性质**只在读路径上成立**。写路径必须显式地也只删自己写的键形状，否则一次保存就会把别的写入者存的东西清掉。客户端那一侧的实现见 `src/store.cjs` 的 `buildPatch`；那里有一对互补的测试钉住这个语义。

### 2.5 `splash.source`：开屏从哪来

| 属性 | 值 |
| --- | --- |
| 键 | `splash.source` |
| 值 | `"builtin"` / `"custom"` / `"off"` |
| 缺省 | 键不存在 = 看 `splash.media`：有就用它，没有就用**内置短片** |
| 非法值 | 视同缺省（不是报错，也不是"关闭"） |

之所以不是"用 `splash.media` 的一个魔法值表示关闭"：那个字段的整条契约是"一个能通过 `MEDIA_NAME_SHAPE` 的文件名"，往里塞哨兵值就是把两种含义塞进一个形状检查里。

解析只有一个地方（`resolveSplash`），它把四种情形折叠成一个答案：

| `splash.source` | `splash.media` | 结果 |
| --- | --- | --- |
| `"builtin"` | 任意 | 包内短片 |
| `"custom"` | 合法名字 | 媒体目录里那个文件 |
| `"custom"` | 缺省 / 非法 | **没有开屏**（不偷偷回退到内置：用户自己的选择坏了，不等于他没选过） |
| `"off"` | 任意 | 没有开屏 |
| 缺省 | 合法名字 | 媒体目录里那个文件（1.0.x 的升级路径） |
| 缺省 | 缺省 / 非法 | 包内短片（全新安装） |

`"off"` 是**写死的一句话**，不是"删掉键就算关"：删键等于回到缺省，而缺省就是内置短片——那样「关闭开屏」按第二次就会自己打开。

---

## 三、媒体目录与命名

### 3.1 位置

`$DSH_HOME/lumen-media/`（默认 `~/.dsh/lumen-media/`），按需创建。

### 3.2 名字形状

```
media-<36 进制时间戳>-<8 位十六进制>.<扩展名>
```

白名单正则（`MEDIA_NAME_SHAPE`）：

```
^media-[0-9a-z]+-[0-9a-f]{8}\.(png|jpg|webp|gif|avif|mp4|webm|ogv)$
```

扩展名由**请求的 `content-type`** 经 §4.5 的允许表反查得到，文件名由宿主生成。**调用方提供的任何字符串都不会进入文件名。**

### 3.3 路径穿越为什么是"不存在"，而不是"被防住了"

没有一条代码路径会 `join` 请求里的内容。请求能提供的只有 `content-type`，它只被用作**查表的下标**；查不到就 415。读取时用同一个正则再校验一遍。

所以这不是"过滤得很干净"，而是构造上无从发生。

---

## 四、路由

### 4.1 前缀与围栏

`/lumen/splash`，与 `/lumen/api` 过**同一道三层围栏**（见 `WALLPAPER-SPEC.md` §9.6）。第二层 `connection.requestRejection` 缺失时退回第一层并在加载期告警。

401 与 403 在响应体里**可区分**：`error.code` 分别是 `"unauthorized"` 与 `"forbidden"`。

### 4.2 上传

`POST /lumen/splash/upload`，请求体即媒体字节。

| 情形 | 结果 |
| --- | --- |
| `content-type` 不在 §4.5 的允许表内 | `415`，**不创建目录、不写文件** |
| 成功 | `200`，`value = { media, kind, bytes }` |
| 请求体为空 | `400`，暂存文件被清除 |
| 超过 `MAX_MEDIA_BYTES` | `413`，暂存文件被清除 |
| 状态写入失败 | `413` + 原因，**新文件被删除**（不留无人引用的字节） |

写入顺序：先写 `<name>.part`，**落盘后才 rename**。连接中途断掉不会留下一个半截的片子给启动遮罩去服务。

替换语义：成功后**旧文件被删除**，但顺序是**先改状态、再删旧文件**——反过来一旦状态写入失败，就会留下一个指向已消失文件的偏好，用户看到的是一块坏掉的开屏。

### 4.3 媒体

`GET` / `HEAD /lumen/splash/media`。未配置时 `404`；非 GET/HEAD 时 `405`。

| `Range` | 结果 |
| --- | --- |
| 无 | `200`，整份实体 |
| `bytes=a-b`（`a ≤ b < size`） | `206` |
| `bytes=a-`（`a < size`） | `206`，到最后一字节 |
| `bytes=-n`（`n > 0`） | `206`，最后 n 个字节 |
| `bytes=-0` | `416` |
| `bytes=a-` 且 `a ≥ size` | `416` |
| `bytes=a-b` 且 `b < a` | `416` |
| 非 `bytes` 单位、多段、畸形 | **`200` 整份**（不是 416） |

最后一行是刻意的：多段请求在 HTTP 上是合法的，只是要用 multipart 应答，而开屏不需要这一层。对一个我们**不打算遵守**的请求，回整份实体永远是正确应答；416 只留给**语法合法、但我们确实没有那些字节**的请求。

响应头：

| 头 | 值 |
| --- | --- |
| `content-type` | 由扩展名反查 |
| `accept-ranges` | `bytes`（没有它浏览器根本不会尝试 Range） |
| `content-length` | 整份、或区间长度 |
| `content-range` | 仅 206：`bytes a-b/size`；仅 416：`bytes */size` |
| `etag` | `"<size 十六进制>-<文件名>"` |
| `cache-control` | `no-store` |

`no-store` 而不是版本化：开屏是**原地替换**的，一个被缓存的 206 会让客户端把新片子的头接到旧片子的尾上。

`If-None-Match` 命中 → `304`，在 Range 之前判定（与 RFC 一致）。

**为什么 Range 是必需品而不是优化**：否则浏览器要下完整个片子才出第一帧，而对一个 2 MB 的开屏来说，那正好就是开屏本来要填掉的那两秒。

### 4.4 清除

`POST /lumen/splash/clear`。先删状态键、再删文件（理由同 §4.2）。重复调用返回 `200` 且 `value.cleared = false`——**不是错误**。

### 4.5 允许的媒体类型

| `content-type` | 扩展名 |
| --- | --- |
| `image/png` | `png` |
| `image/jpeg` | `jpg` |
| `image/webp` | `webp` |
| `image/gif` | `gif` |
| `image/avif` | `avif` |
| `video/mp4` | `mp4` |
| `video/webm` | `webm` |
| `video/ogg` | `ogv` |

本机 Electron 自带的 `ffmpeg.dll` 是完整构建（h264 / hevc / vp9 / vp8 / av1 全部有符号），所以 H.264 mp4 与 VP9 webm 都能播。

**刻意不收 `video/quicktime`**：`.mov` 里通常是 H.264，但也经常是 ProRes。一个静默播不出来的开屏，比一个被明确拒绝的上传更糟。

### 4.6 暂存文件与孤儿清理

`<name>.part` 只在一次上传进行期间存在，所以**超过 `STAGING_STALE_MS`（1 小时）的 `.part` 就是一次死在半路的上传留下的**。

清理发生**在每次上传开始之前**——这之后清理会撞上本次调用即将写入的暂存文件。1 小时的窗口是并发下的安全边界：第二个上传不能删掉第一个正在写的暂存文件。

`discardMedia` 对 `ENOENT` 静默（文件本来就不在了），对**其他任何失败打一条告警**。单个孤儿文件是惰性的，但一个无声膨胀的目录是用户一年后才发现、且无从追溯成因的东西。

> 非 `.part` 的孤儿文件**不做自动回收**：另一个窗口可能刚写完文件、还没写完状态，此时回收会删掉一个即将被引用的文件。

### 4.7 切回内置

`POST /lumen/splash/builtin`，无请求体。成功 `200`，`value = { source: "builtin", kind: "video" }`；包内没有那段短片时 `404 no-builtin`。

语义是**替换**，与上传一致：先改状态、再删用户自己那份文件。开屏任何时刻只有一份，留一个"回不去也用不上"的文件只会变成 §4.6 里那种没人能追溯的孤儿。清掉之后连 `splash.media` 键一起删，所以状态里不会留下一个指向已消失文件的名字。

「关闭」不设单独路由：它就是 `clear`（§4.4），写 `splash.source = "off"`。

---

## 五、启动遮罩

### 5.1 注入的时机约束

通过宿主的 `webserver/index-inject` 事件注入：

```js
ctx.on("webserver/index-inject", (table) => { table.push(row); });
```

handler **必须同步注册**，且注册前不能 `await` 任何东西：那张 `table` 在宿主启动时收集并缓存，**没有刷新路径**——注册晚了就永远不参与。

handler 内部只做一件可能失败的事（读一次状态文件），整段包在 `try` 里：读不到就**不注入**，用户看到的是外壳自己的启动画面。

### 5.2 注入的行

| kind | 内容 |
| --- | --- |
| `style` | 遮罩 CSS，带标记 `dsh-lumen-splash-cover` |
| `script`（`placement: "head"`） | 兜底守卫 |

去重：`table` 里已经有一条含该标记的 `style` 行时**不再注入**——两条守卫就是两个赛跑的定时器。

### 5.3 遮罩规则

```css
/* dsh-lumen-splash-cover */
#root{visibility:hidden!important}
html,body{background-color:#000!important}   /* 图片开屏再追加 background-image */
```

图片开屏时追加：

```css
background-image:url("/lumen/splash/media");
background-position:center;background-size:cover;background-repeat:no-repeat!important
```

两处都必要：遮住 app（`#root`），并**强制底色变深**。外壳在浅色方案下给 `body` 刷白底，只盖住 app 会留下一片白，读起来像"界面出现了又消失"。

`readPreferences` 经 mtime+size 备忘（`splashNameForCover`）——这个 handler 跑在 **index 请求**上，也就是 app 自己的启动路径上，而状态文件上限 24 MiB；在那里现读一次等于把用户整份文档的同步解析塞在第一帧前面。本进程自己的写入会**直接清掉备忘**，所以备忘键只剩"另一个进程在同一时间戳刻度内写入长度完全相同的文档"这一种失效可能，后果是那一页用了一次旧遮罩——而守卫反正会撤掉它。

### 5.4 为什么不是 `[data-dsh-boot-spinner]`

上游常见做法里有一条 `[data-dsh-boot]:has([data-dsh-boot-spinner]){display:none!important}`。**本项目没有采用**：在本 build 的 `app.asar` 里 `dsh-boot-spinner` 出现 **0 次**，那条规则是死 CSS。

`#root` 里的启动层本来就是 `#root` 的后代，隐藏 `#root` 会一并隐藏它，所以**不需要**单独抑制。（`tests/host.test.cjs` 有一条断言专门钉住这个选择器不出现。）

### 5.5 守卫：两个有界时限、单向释放

每次加载**新建一段 inline script**，因此每次都 arm 一个**新定时器**。这是整个机制的安全属性所在：

- 用 CSS `animation-delay` 计时 → 会**跨 reload 累积**，最终变成一刷新就立刻撤罩；
- 用"自取消的选择器" → 会把界面**永久锁死**，而不是释放它。

守卫到点后**直接 `remove()` 承载遮罩的 `<style>` 元素**。元素没了，就没有任何东西可以在开屏卸载时被重新套上——**释放是单向的**。

守卫不是"等一个数字"，而是一台三态机：**等交接 → 观察 → 到点**。

1. `arm(COVER_DEADLINE_MS)`（10 秒）先上。它不是主路径，是地板：任何下文都没发生时的唯一出口。
2. `handedOver()` 判据是 `#root` 存在、**其内不再有 `[data-dsh-boot]`**、且 `childNodes.length > 0`。三者缺一不可——空容器不算交接完成，`BootHandoff` 渲染内核的那一个 commit 也不算。
3. 若首次判定时还没交接，则挂一个 `MutationObserver` 盯着 `document.documentElement`，交接发生的那一刻立即撤罩。
4. 支持 `MutationObserver` 缺失（老引擎）时退化为纯定时器，仍然有界。

`handedOver()` 的判据直接来自外壳自己的 `mountApp` / `BootHandoff`：内核存在期间它渲染 `[data-dsh-boot]`，交接后返回 `app()`。所以**"标记在，然后没了"就是"外壳接管了"**，而不是本项目编出来的信号。

为什么要兜底：遮罩由页面负责撤除，但"页面一定会撤"是个假设；假设错了的后果是最坏的一类——`#root` 被隐藏就是一块黑屏且无路可回，因为**外壳自己的失败报告也渲染在 `#root` 里**。

时限故意给得宽（`COVER_DEADLINE_MS = 10000`）：**早了是可见的闪一下，晚了只是把一块已经坏掉的黑屏缩短一点。**

守卫同时挂出 `globalThis.__DSH_LUMEN_SPLASH__ = { lift, keep }`：

| 方法 | 语义 |
| --- | --- |
| `lift()` | 立即撤罩，**并且就此结束**（幂等） |
| `keep()` | "还没好"，并**把时限延长到 `COVER_HELD_MS`（30 秒）** |

`keep()` **不是取消定时器**，这一条是刻意的：取消等于把"有界"这个性质交出去。谁调用 `keep()` 谁就欠一次 `lift()`，而如果它没还，30 秒后照样撤罩。视频半边调用的就是 `keep()`（见 §六.3）。

### 5.6 关闭 = 零注入

`splash.source = "off"` 时 `coverRows` 返回**空数组**，这个插件对文档一个字节都不贡献。

这条比"风险很小"强：**关掉开屏的用户，对这套代码的暴露面严格为零。**

⚠️ 这条曾经写成"未配置 = 零注入"，因为那时候没有出厂默认。现在默认是包内那段短片，于是"从未配置"和"什么都不要"不再是同一件事：前者是全新安装（有开屏），后者是 `"off"`（没有开屏）。保证本身没变，只是触发条件换了名字——`tests/host.test.cjs` 里那条用例也跟着从"no splash configured"改成了"switching the splash off"。

### 5.7 包内短片没装进来时

`builtinMediaPath()` 在进程内 `existsSync` 一次并把结果记下来。包不完整（`files` 少写了 `media`、被裁剪的镜像）时它是 `undefined`，于是 `resolveSplash` 在没有其他选择时返回 `null`——**没有开屏**，而不是"有一个遮罩、下面却没有片子"。这种情况下用户看到的是外壳自己的启动画面。

那条 `existsSync` 每个进程只跑一次，因为包目录在进程生命周期里是不变的；而它跑在 index 请求的注入路径上，这一点很重要（§5.3 的备忘就是为了同一个原因）。

---

## 六、图片走纯 CSS，视频走浏览器半边

### 6.1 图片：样式表就完整了

图片开屏在 §5.3 的样式表里就**完整了**。这份样式表和文档在同一次响应里送达，所以它**在第一帧上色**——早于任何客户端模块存在，也就无从"慢"或"失败"。这正是开屏的意义。

浏览器半边对图片**什么都不做**（相位 `guard-only`）：它探测到是图片就退出，不挂层、不碰 `keep`/`lift`。让一个播放器去管一张图片的生命周期，只会产生第二个意见去和守卫抢方向盘。

### 6.2 视频：四步

**CSS 播不了视频**，所以视频必须由 `src/splash.cjs` 接住，它只做四件事：

1. `HEAD /lumen/splash/media` 问宿主这一条是什么（不下载实体，只读 `content-type`）；
2. **在挂层之前**调用 `keep()`——守卫眼里的"好了"是外壳的 boot 交接，而"外壳起来了"不等于"有一帧在屏幕上"；
3. 挂一个不透明的全屏层并播放；
4. 拿到第一帧时 `lift()`，片子放完时**连同层一起**撤掉。

顺序（2 在（3）之前）是有意的：反过来的话，交接恰好落在两者之间就会在黑色播放中途把界面亮出来。

### 6.3 什么时候才 `lift`

**第一帧（`playing`），不是 boot 交接。** 层是不透明且在最上面的，交接一完成就撤罩只会把"一块黑"换成"低一层的另一块黑"，用户看到的是闪一下。

### 6.4 四个出口，全部有界

| 出口 | 触发 | 时限 |
| --- | --- | --- |
| 第一帧 | `playing` | `FIRST_FRAME_DEADLINE_MS`（8 秒）内必须到 |
| 总寿命 | 任何情况 | `PLAY_DEADLINE_MS`（120 秒） |
| 解码失败 | `error` | 立即 |
| 用户跳过 | 层上任意点击，或任意按键 | 立即 |

两个时限**互相独立**，这一点是实测出来的、不是设计出来的：早先的版本在 `playing` 里把两个定时器一起清掉了，于是"片子卡在中途"这一种情况**没有任何东西兜底**——卡住的解码器不发任何事件。现在 `playing` 只清第一帧时限（它回答了"能不能起来"），总寿命时限留到撤层为止（它回答的是"会不会结束"）。

**每次出口都同时做两件事**：撤层，并 `lift()`。开屏最不可恢复的结局是片子结束了但界面还盖着，所以撤层路径永远顺带撤罩。

### 6.5 跳过这一下，归开屏所有

层上任意点击就是跳过，而**面板常常就在层下面那一页**。在点击处理里把层撤掉不会让这次点击重新派发一次，但它会改变**同一个手势**脚下的地面：按在层上的手指可能在刚出现的面板上抬起，浏览器随即在这两点的最近公共祖先上产生一次 `click`；更直接的是第二下——不耐烦地再点一次，而「关闭开屏」恰好就在跳过提示的位置。

这不是假设，而是**实测到的**一次事故：短片从 6 秒换成 4.5 秒后，确认用的那一下点击落在了层已经消失之后，光标下的按钮正好是关闭开屏，于是 `splash.source` 被写成了 `off`。症状是"开屏就是不出现了"，而这恰好是**从外面最诊断不出来**的一类故障——和"插件根本没装"完全同形。

所以撤层之后 `CLICK_THROUGH_MS = 400` 内，`document` 上装一个**捕获阶段**监听，对 `pointerdown/pointerup/mousedown/mouseup/touchstart/touchend/click` 一律 `stopPropagation()` + `preventDefault()`：面板的监听是普通冒泡监听，被拦在目标之前的事件激活不了任何东西。

两个边界同时成立，缺一个都会变成新的 bug：

- **一个手势，不是一个宽限期**：第一声 `click` 一到就撤掉监听，之后的点击属于用户的下一个意图；
- **只在真的有手势时生效**：`ended` / `error` / 超时撤层不装它。片子自然放完时没有人的手指在里面，此时吃掉下一次点击比它防的那个 bug 更糟。

键盘同理：`Enter` / `Space` 会激活持有焦点的东西，而外壳的启动层可以持有焦点，所以跳过的按键要挡掉它的默认行为。

`dispose()` 和 `dismissClip()` 都会撤掉这个监听——一个留到模块消失之后的捕获监听会悄悄吃掉界面的第一下点击。

### 6.6 层为什么挂在 `document.body` 上

两条独立的理由，任何一条单独都够：

1. 遮罩的全部机制就是 `#root{visibility:hidden}`——挂进 `#root` 的东西会被它存在的意义本身藏起来；
2. 外壳会为它自己的浮层把 `#root` 置为 inert（`appRoot.inert = true`），那会连层的"点击跳过"一起废掉。

层序用 `LAYER_Z_INDEX = 2147483647`，即 CSS 能接受的最大值。**取最大值本身就是论证，不是随手填一个够大的数**：一个别的元素不得超过的值，才是唯一压不住的值。这个应用里其它插件的浮层普遍会用很大的数——既有的惯例是"当前弹出的那个东西占最上层"——所以低一档就会在开屏中途被别人的弹窗盖住，而且**只在别人恰好弹东西的那一刻**被盖住，属于最难复现的一类 bug。反向也成立：界面可用时这层**已经不存在**，所以它没有任何东西被永久压住。实测见 §八。

### 6.7 没有遮罩就不播

**不注入遮罩的页面，半边不播开屏。** 遮罩和开屏是文档生成时做的**同一个决定**；一个没遮罩的页面就是"这一页送达时还没有开屏"的页面。没有遮罩就没有那块黑让片子落上去，此时开屏只会变成"界面闪一下、然后被一个不会自己走的东西盖住"。面板在这种情况下说的是"重新加载后才会看到"，那句话是真的。

---

## 七、上限

| 常量 | 值 | 作用 | 在哪 |
| --- | --- | --- | --- |
| `MAX_MEDIA_BYTES` | 512 MiB | 单次上传上限 | 宿主 |
| `STAGING_STALE_MS` | 1 小时 | 暂存文件多久算遗弃 | 宿主 |
| `COVER_DEADLINE_MS` | 10000 ms | 守卫的兜底时限（无交接时） | 注入的守卫 |
| `COVER_HELD_MS` | 30000 ms | `keep()` 之后延长的时限 | 注入的守卫 |
| `FIRST_FRAME_DEADLINE_MS` | 8000 ms | 第一帧多久算没来 | 浏览器半边 |
| `PLAY_DEADLINE_MS` | 120000 ms | 片子的总寿命上限 | 浏览器半边 |
| `LAYER_Z_INDEX` | 2147483647 | 层的层叠序 | 浏览器半边 |

`MAX_MEDIA_BYTES` 远高于"一个开屏该有的体积"，也远低于"磁盘有多少就收多少"。宿主自己的浏览器传输默认值是 300 MiB，所以这个量级的请求体是常规请求而不是特例；这个上限是拦失控客户端的，不是替用户判断片子该多大。

三层时限的关系值得单独说一句：守卫的 10 秒 / 30 秒管的是**遮罩**，8 秒 / 120 秒管的是**层**。它们不互相替代——层没挂上时遮罩照走（图片路径就是这种），层挂上了而片子卡住时遮罩由层的出口撤掉。

---

## 八、运行时实测（层叠与僵尸层）

这一节记录的是**跑出来的结果**，不是推理。分歧在于 §5.5 说的那句话——"层叠序"这个数字只在它自己的层叠上下文里有效，而层是在一个十几个东西同时在写的文档里被挂上的。所以最后是让引擎自己回答的。

### 8.1 怎么测的

在真实 Chrome（148，headless=new）里打开 `preview/boot.html`（注入了遮罩与守卫的那个文档），用 `Page.addScriptToEvaluateOnNewDocument` 在任何页面脚本之前装一个观察者；层一出现就**在同一个观察者回调里同步**做三件事：

1. 在它旁边造四个同级对手层，层级从一个负数一路铺到最大值附近（`-1` / `20500` / `32000` / `2147483600`），覆盖这个应用里浮层实际会落到的整个范围。对手层**不设** `pointer-events:none`——命中的东西才会被算进 `elementFromPoint`，设了的话对手会自己从答案里掉出去，整个测试就变成自说自话；
2. 在三个点问 `document.elementsFromPoint`（正中、底部正中——提示条那一类浮层习惯出现的位置、左上角）；
3. 记下此刻遮罩是否还在。

### 8.2 结果：盖得住

三个点的顺序一致，从最上到最下：

```
video                                  ← 层里的片子
div[data-dsh-lumen-splash=clip]  z=2147483647
div[对手层 · 顶端提示那一档]      z=2147483600
div[对手层 · 遮罩那一档]          z=32000
div[对手层 · 悬浮窗那一档]        z=20500
body
div[对手层 · 壁纸位]              z=-1
html
```

层和它的片子压在对手层**全部**层级之上，包括最高的那一档；`-1` 的壁纸层落在 `body` 之下。

层本身的几何与不透明度：`rect = 0,0,1280,800`（视口 1280×800）、`opacity: 1`、`position: fixed`、`z-index: 2147483647`；`video` 也是 `0,0,1280,800`、`object-fit: cover`、`opacity: 1`。整条祖先链（层 → `body` → `html`）上 `filter` / `transform` / `isolation` / `contain` / `will-change` / `mix-blend-mode` **全是默认值**——也就是说层确实在根层叠上下文里，而不是被困在某个祖先的上下文里（被困住的话再大的 z-index 也没用）。

铺满与否另做了一次反向验证：层在时把 `background` 改成洋红、再把片子 `display:none`，截图**整幅纯洋红**；再把页面垫上一整块 `rgb(0,255,0)` 的通栏色板（`z-index:0`，在层之下）＋一块 `z-index:1` 的红板，截图里**一个绿像素、一个红像素都没有**。两个方向合起来说明：文档被完全遮住，且层自己是不透明的。

> 测的过程中出现过一次"似乎有页面文字透出来"。追下去是**渲染路径的产物**：带 `--disable-gpu` 的软件合成在截 `<video>` 时会把图层混进帧缓冲，去掉该参数（走 GPU 光栅化）后同一页面、同一位置**干净无残留**。绿板测试在同一轮里依然是零绿像素，所以结论不依赖这个解释。

### 8.3 结果：不留僵尸层

模拟用户点击跳过，1.5 秒后再问一次：

| 问题 | 结果 |
| --- | --- |
| `[data-dsh-lumen-splash]` 还有几个 | `0` |
| 遮罩 `<style>` 还有几份 | `0` |
| `#root` 的 `visibility` | `visible` |
| `[data-dsh-boot]` 还在吗 | 不在（交接已完成） |
| 正中命中谁 | `div.shell-thread` / `main.shell-main` / `div.shell` / `body` / `html` |
| 壁纸层 | 在，`z-index: -1` |

也就是说：片子一走，层和遮罩都消失，界面重新可点，而壁纸层照旧待在内容背后。**"盖住"和"赖着不走"是这个功能唯一有意义的两种失败模式，两边都测了。**

### 8.4 这次实测**没有**证明什么

诚实地说清楚边界，否则上面的结论会被读大：

- 页面是**预览的 shell 替身**，不是真实 Electron 外壳。外壳自己的 `mountApp` / `BootHandoff` 契约是从 `app.asar` 里读出来的，这里由替身复刻——但复核的对象是替身。
- 对手层是**按这个应用里浮层实际会用的 z-index 值造的同级层**，不是把别的插件真装进这一页。对"谁压谁"这个问题（两个同级元素、都在根层叠上下文、都挂在 `document.body`）这是公平的——这类插件的浮层确实是往 `document.body` 上挂；但它不等于跑一遍那些插件。
- 用的片子是现场用浏览器 `MediaRecorder` 录的一段 6 秒 WebM（本机没有 ffmpeg），不是真实用户素材。它证明的是"能播、会走"，不是"任何编码都能播"。

### 8.5 其余仍未验证的

**真实 Electron 外壳里的一次端到端**：本节的实测全部在预览里完成，尚未在 `F:\DeepSeek Harness` 里跑过一次真正的启动。

**平台差异**：全屏 `position:fixed` 层的层叠行为，在 macOS 的 WKWebView 与 Linux 的 WebKitGTK 上未测。所依赖的性质（层挂在 `document.body`、祖先链无层叠上下文制造者）在三者上一致，但没有实测。

**上传走浏览器 `File`，不走 OS 原生对话框。** 另一条常见做法是在 Windows 上用 PowerShell WinForms STA、macOS 上用 `osascript`、Linux 上用 `zenity` 去拿一个**绝对路径**，然后让宿主按路径读盘。本项目不走这条路：浏览器拿不到绝对路径，但已有的导入管道能把 `File` 的字节直接交上来。收益是跨平台零差异、砍掉三条平台分支，并且**「传完选择设为壁纸或开屏」天然就是同一次导入**。

---

## 九、内置开屏

### 9.1 为什么随包带一段片子

因为**默认值也是产品**。一个壁纸插件装完应该当场看见东西，而"看见"的最短路径不是在设置里找一张图，是启动那一下有一帧漂亮的画面。要求用户先准备素材，等于把第一次成功体验推迟到他恰好有空的时候。

代价必须写在同一段里，否则这段就成了宣传：包体积多 2.0 MB；README 里"零图片素材"的说法从这一版起限定为**壁纸**（壁纸仍然是零素材，开屏不是）。

### 9.2 它和上传的那一份，差别只有三处

| | 上传的 | 内置的 |
| --- | --- | --- |
| 位置 | `$DSH_HOME/lumen-media/media-<ts>-<hex>.<ext>` | 包内 `media/splash.mp4` |
| 名字来源 | 宿主生成 | 固定 tag `builtin.mp4`（**只用于反查 MIME 与 etag，不是磁盘上的文件名**） |
| 状态里有什么 | `splash.media` = 那个名字 | 没有名字，只有 `splash.source = "builtin"` |

其余**全部共用**：Range 与 416/304、etag、`no-store`、`accept-ranges`、HEAD、遮罩样式、守卫、浏览器半边的探测与播放。两条来源在 `resolveSplash` 之后变成同一个形状（`{source, file, tag}`），所以没有第二条服务路径可以长出第二种 bug。

包路径由 `new URL("../media/splash.mp4", import.meta.url)` 解析，而不是 `process.cwd()`：插件装在哪个目录、外壳从哪个目录启动，都不影响它。从 GitHub 装、从本地目录装、装进 profile 的 `plugins/` 下，都成立。

### 9.3 三种更省事但不采用的做法

**首次启动把包内文件复制到媒体目录。** 看起来最省事——之后什么都不用改。代价是：多一份 2.0 MB 副本；在**启动路径**上写盘（`DSH_HOME` 只读时静默失败，而那时用户已经在等开屏了）；「清除」删掉的是唯一一份，于是"下次启动别再复制一次"需要第二个标记键，而那个键一旦写坏，用户每次启动都得手动关一遍。

**把片子 base64 进状态文件。** 状态文件上限 24 MiB，而且每次写都整份重写。§2.2 已经为壁纸论证过同一条，2.0 MB 的常驻载荷只会更糟。

**让宿主提供媒体库服务。** 没有这样一条公开契约。为一个壁纸插件要求宿主具备媒体服务，会把可安装面砍掉一半——而这不值得，因为文件就在包里。

### 9.4 面板怎么知道正在用的是哪一份

`GET`/`HEAD /lumen/splash/media` 回一个 `x-lumen-splash-source` 头。面板的状态行因此是**宿主的回答**，不是面板里抄的一份常量——抄的那份会在"用户刚切回内置"和"另一个窗口刚上传"之间说假话。

面板上三个出口，语义各是一句话：`选择文件…`（→ `custom`）、`内置开屏`（→ `builtin`，替换语义，见 §4.7）、`关闭开屏`（→ `off`）。

### 9.5 默认开启的边界

默认开启不是"强加"，前提是另外几条同时成立：

- **可跳过**：任意点击或按键立刻结束（§6.4 的出口之一，早于这一版就有）
- **有界**：8 秒第一帧、120 秒总寿命、解码失败即撤、守卫 10/30 秒
- **关得掉**：`off` 之后 §5.6 的零注入
- **说得明白**：面板里有一句话写着"默认启用"——一个用户不知道自己有的功能，迟早会被当成入侵

少任何一条，默认开启都只是"作者喜欢"。

---

## 十、测试映射

### 10.1 宿主半边（`tests/host.test.cjs`）

| 契约 | 测试 |
| --- | --- |
| 关掉之后零注入（§5.6） | switching the splash off contributes no rows at all |
| 全新安装即有内置开屏（§9.1） | a fresh install is covered by the clip the package ships with |
| 名字坏了回退到内置而不是路径（§2.5） | an unreadable stored name falls back to the built-in clip, not to a path |
| 切回内置是替换（§4.7） | switching to the built-in clip replaces the user's own, like an upload does |
| 上传夺取来源 | an upload wins over the built-in clip |
| 图片开屏由样式表画 | an image cover paints the media itself… |
| 视频不假装 CSS 能播 | a video cover does not pretend CSS can play a clip |
| 不用 `dsh-boot-spinner` | the cover hides #root and forces the base colour dark |
| 去重不叠第二个守卫 | a second injection step does not stack a duplicate guard |
| 守卫的时限与桥 | the guard arms a bounded timer and publishes a release… |
| 名字形状白名单 | a stored name that is not our own shape is treated as no splash |
| Range 全部分支 | a satisfied / open-ended / suffix / past-the-end / unh honoured range… |
| 304 与 HEAD | an unchanged etag answers 304… / HEAD answers the same headers… |
| 上传与替换与清除 | an upload stores the bytes… / replacing… / clearing… |
| 类型与体积拒绝 | an unsupported media type is refused before anything is written / an empty upload… |
| 暂存文件清扫 | an abandoned staging file is swept on the next upload, a live one is spared |
| 遮罩备忘失效 | a cover memo is not trusted across this process's own write… |
| 客户端中断 | a client that hangs up mid-stream is handled, not thrown |
| 401 / 403 可区分 | a 401 and a 403 are distinguishable in the body… |
| 围栏覆盖两条前缀 | the splash routes sit behind the same fence |
| 两岸的媒体类型表一致 | the browser half offers exactly the media types the host accepts |

### 10.2 注入的守卫（`tests/cover.test.cjs`）

在 `vm` 里跑**真正被送进文档的那段脚本**，用一个手摇的定时器队列和手动泵动的观察者——这里每一个有意思的问题都是"在那一瞬间发生了什么"，所以不引入真实时钟。

| 契约 | 测试 |
| --- | --- |
| 有界且只 arm 一次 | the guard publishes a handle and stands exactly one bounded deadline |
| 只拆自己的样式表 | lifting removes our stylesheet and leaves everybody else's alone |
| 释放单向且幂等 | the release is one-way and idempotent |
| 交接判据（§5.5 第 2 条） | the cover stands while the boot kernel does, and lifts when the shell replaces it |
| 空容器不算交接 | an empty container is not a shell that has taken over, and one with content is |
| 从 document 上观察 | the handoff is watched for from the document, not from a container that may not exist yet |
| 到点是最后一道 | the deadline lifts the cover even if nothing else ever happens |
| 连容器都没有 | a document with no container at all yields the screen on the deadline |
| `keep` 延长而非取消 | keep postpones the deadline instead of cancelling it, and stays bounded |

### 10.3 浏览器半边（`tests/splash.test.cjs`）

| 契约 | 测试 |
| --- | --- |
| 探测只读类型与来源（§9.4） | probe reads the host's answer, and treats 404 as 'not set' rather than as a fault |
| 切回内置是一条 POST（§4.7） | switching back to the built-in clip is one POST, and its failure is reported |
| 探测问对路由、不带体 | probe asks the route the host owns, and asks it without a body |
| 上传按文件自己的类型 | upload sends the file's own bytes under the file's own type |
| 上传的错是宿主的错 | upload reports the host's own reason instead of guessing at one |
| 不支持的类型不上网 | upload refuses a type it was never going to be allowed to send |
| 清除的两种结果 | clear reports whether there was anything to remove |
| 无遮罩不播（§6.7） | with no injected cover, nothing is asked and nothing is mounted |
| 图片不归它管（§6.1） | a picture is left entirely to the guard, release included |
| 先 `keep` 再挂层（§6.2） | a clip suspends the guard before it mounts, and reveals on the first frame |
| 解码失败 | a clip that cannot decode takes the layer down and gives the interface back |
| 第一帧时限 | a frame that never arrives gives way on its own deadline |
| 总寿命与第一帧独立（§6.4） | a clip has a total lifetime, however well it plays |
| 点击与按键 | a click anywhere, or any key, ends the clip early |
| 跳过不外溢（§6.5） | the click that skipped the clip never reaches the interface underneath |
| 自然放完不吞点击（§6.5） | a clip that ends by itself leaves the next click alone |
| 拆除带走手势保护（§6.5） | teardown takes the gesture guard with it |
| 两者都没来时 | the last resort still runs if the first frame never comes and nothing else fires |
| 拆除 | dispose takes the layer down and stops listening |
| 幂等启动 | startCover runs once, however often it is called |
| 类型表自洽 | classify agrees with the table the module publishes |
| 层叠序（§八） | the clip layer takes the largest z-index CSS accepts, and sits in front of the wallpaper |

最后一条把 §8.2 的结论钉成了会失败的断言：它读 `engine.cjs` 里壁纸层真实的 `z-index`（不是 restate 一个 `-1`），再断言层的值就是 **CSS 最大值**——**这个断言本身就是"压得住一切"的证明**，不需要去量任何一个具体的对手层。反过来，去量某个对手层既更弱（量不到没想到的邻居）也更脆（那个邻居一改就失效）。所以这条测试里没有任何外部插件、任何绝对路径、任何"装了才跑、没装就跳过"的分支：它只依赖本仓库自己的两个文件。
