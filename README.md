<div align="center">

<img src="icon.svg" width="112" height="112" alt="dsh-lumen">

# dsh-lumen · 流转壁纸

**给 DeepSeek Harness（DSH）的壁纸调度器**

2 套程序化生成的弥散光壁纸 &nbsp;+&nbsp; 4 张随包内置插画 &nbsp;·&nbsp; 本地图片 / 图片地址 / 渐变<br>
按间隔 · 整点 · 每日 · 每次会话自动换图，带交叉淡入<br>
**自带一段开屏短片：装好即默认启用，可一键换成自己的素材或关掉**

[![license](https://img.shields.io/badge/license-MIT-534AB7)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2018-3B6D11)](package.json)
[![tests](https://img.shields.io/badge/tests-373%20passing-0F6E56)](tests)
[![plugin](https://img.shields.io/badge/DSH-plugin-534AB7)](package.json)
[![github](https://img.shields.io/badge/GitHub-lhr040306%2Fdsh--lumen-534AB7?logo=github&logoColor=white)](https://github.com/lhr040306/dsh-lumen)

[功能](#功能速览) &nbsp;·&nbsp; [安装](#安装) &nbsp;·&nbsp; [壁纸](#6-套内置壁纸) &nbsp;·&nbsp; [开发](#本地开发) &nbsp;·&nbsp; [文档](#文档索引)

</div>

---

> `dsh-lumen` 的目标不是"换一张好看的图"，而是回答两个问题：**现在显示什么**，以及 **下一次什么时候变、变成什么**。
>
> 壁纸分两类：两套**参数化配方**，运行时用 CSS 渐变**完全离线**算出来，没有图片素材；四张插画随包内置（`media/wallpapers/`，合计约 1.1 MB），由宿主半边按形状白名单送出。装好第一眼是那张「黄昏」。开屏另有一段随包短片（`media/splash.mp4`，2.0 MB），不想要可以一键关掉。

---

## 它和常见的换肤插件有什么不同

| | 常见做法 | dsh-lumen |
| :-- | :-- | :-- |
| **壁纸从哪来** | 打包一堆图片素材，或让用户自己传 | 两套**参数化配方**用 CSS 渐变算出来，可选集不随体积增长；另外四张插画随包内置，取舍见[壁纸规格](docs/WALLPAPER-SPEC.md)第三节 |
| **什么时候换** | 装上就一直是一张 | **调度器**：4 种触发方式 × 3 种顺序策略，落在可预测的钟点上 |
| **文字还看得清吗** | 交给用户调透明度 | 洗色层透明度对着 **WCAG AA 对比度求解**，且永远不比用户设的更透明 |

一句话：这是一个**壁纸调度器**，壁纸的生成方式只是它的素材来源之一。

---

## 功能速览

| 模块 | 内容 |
| :-- | :-- |
| **壁纸来源** | 2 套内置配方（深 1 / 浅 1）· 4 张内置插画 · 本地图片（可多选、可拖拽）· 图片地址 · 双色标渐变 |
| **轮播调度器** | 4 种触发方式 × 3 种顺序策略 · 间隔模式**锚定网格**，不随刷新重置 · 洗牌走完一轮前不重复 · 有损追赶 |
| **开屏** | **内置短片默认开启** · 一个素材两处去处 · 图片开屏走纯 CSS **首帧上色** · 视频静音自动播放 · 四个出口全部有界 |
| **可读性下限** | alpha 对着 WCAG 2.1 AA 求解 · 面板**显示实际生效值**而非偷偷改掉 · 本地图片**实测亮度**驱动 |
| **工程** | 中英双语 166 条键完全对称 · 两层持久化跨重启生效 · 插件入口**从不抛异常** · 373 项单元测试 |

<details>
<summary>展开每一项的细节</summary>

**壁纸来源**

- 2 套内置配方（弥散 / 晨雾），由参数实时生成，无图片素材；每套配方可换种子，同一风格的另一种构图
- 4 张内置插画（夜潮 / 星海 / 黄昏 / 深蓝），随包附带，装好即用；插画没有种子，所以面板上不给它「摇一摇」
- 本地图片：**可多选，也可直接把文件拖到那一行**；等比缩放压缩后本地保存，原图不上传
- 图片地址（仅 `http` / `https`）、双色标线性渐变

**轮播调度器**

- 4 种触发方式：`按间隔` / `整点` / `每日` / `每次会话`；3 种顺序策略：`顺序` / `洗牌` / `随机`
- 间隔模式**锚定网格**，不随刷新页面重置；洗牌模式走完一轮之前不重复
- 显示"下一次更换"的倒计时与后续 5 个触发时刻；可随时暂停 / 继续
- **有损追赶**：睡过五个触发点只换一次，不在用户眼前闪五张图

**开屏**

- **装好就有**：包内自带一段 4.5 秒开屏短片，`splash.source` 缺省即 `builtin`，不用任何设置
- 一个素材，两处去处：设为壁纸 / 设为开屏 / 两个都要；想换回内置的一段或彻底关掉，各是一个按钮
- 图片开屏走**纯 CSS**，由服务端随文档一起送达，所以它在**第一帧**就上色
- 视频开屏走浏览器半边，静音自动播放，四个出口全部有界（首帧 8 秒 / 总寿命 120 秒 / 解码失败 / 用户跳过）

**可读性下限**

- 洗色层 alpha 对着 **WCAG 2.1 AA（4.5:1）** 求解，实际生效值取"用户设定"与"求解最小值"中较大者
- 面板**把差异显示出来**，而不是偷偷改掉
- 本地图片在导入时**实测照片亮度**（取上四分位，非平均值）来驱动下限，而不是套一个常数

**工程细节**

- 中英双语，两套字典各 149 条键、完全对称
- 持久化跨 DSH 重启生效（宿主侧权威副本 + `localStorage` 快速种子）
- 插件入口**从不抛异常**——最坏情况是"壁纸不出现 + 控制台一行日志"，不会让 DSH 起不来
- 373 项单元测试，调度部分是纯函数，边界情况（睡过触发点、时钟回拨、夏令时、两张图的洗牌列表）都能当普通单测来测

</details>

---

## 6 套内置壁纸

前两套是**参数化配方**，`complexity` 是"画面有多花"的估计值（0–1），驱动自动弱化；后四套是**随包插画**，亮度是在图片文件上实测的，同样喂给可读性下限。

| 配方 | 名称 | 中文名 | 取向 | complexity | 类型 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `drift` | Drift | 弥散 | 深 | 0.30 | 生成式 |
| `mist` | Mist | 晨雾 | 浅 | 0.20 | 生成式 |
| `whale-point-half` | Night Tide | 夜潮 | 深 | 0.55 | 插画 |
| `whale-starlit` | Starlit | 星海 | 深 | 0.50 | 插画 |
| `whale-sunset` | Dusk | 黄昏 | 深 | 0.60 | 插画（**首次安装的默认**） |
| `whale-point-full` | Deep Blue | 深蓝 | 深 | 0.55 | 插画 |

前两套各有一个 **seed**：同一配方换一个种子就是同一风格的另一种构图（面板上的「摇一摇」）。插画是一张固定的图，换种子不会变，所以那四张不显示这个按钮。

旧版本里被退役的三套（`aurora` 极光、`starfield` 星野、`dune` 沙丘）如果还留在你的状态文件里，会按**意图**就地改写：极光 → 弥散、星野 → 星海、沙丘 → 晨雾，而不是三条一起塌到同一张。

---

## 安装

前置：**DSH Desktop 或 DSH Web**，Node ≥ 18。

**包根目录就是仓库根目录**（`package.json` 在仓库根上），所以下面两种来源都能直接装。插件尚未发布到 npm —— 别在安装入口填 `dsh-lumen`：那会被当成 npm 包名去查仓库，查不到就报「未找到相关插件」。

**方式一：GitHub 地址**（推荐）。在 DSH 的**插件安装入口**（设置 → 插件 → 安装）的输入框里填仓库地址：

```text
https://github.com/lhr040306/dsh-lumen
```

**方式二：本地目录**。先 `git clone` 到本机一个不会随手删掉的位置，安装入口填**仓库根目录的绝对路径**：

```text
F:\develop\dsh-lumen
```

两种来源等价的 CLI 写法：

```sh
dsh plugin --profile web add github:lhr040306/dsh-lumen
dsh plugin --profile web add /仓库根目录的绝对路径
```

要钉住版本，就在地址后面加标签或 commit（`https://github.com/lhr040306/dsh-lumen#v1.2.0`、`github:lhr040306/dsh-lumen#v1.2.0`、`...#<commit>`）。

装完**重启 DSH**，然后打开 **设置 → 壁纸**。

装好之后的第一眼就是**内置开屏**——一段随包自带的短片，不需要任何设置。不想要它就在 **设置 → 壁纸 → 开屏** 里点「关闭开屏」，想换成自己的素材点「选择文件…」。

> [!WARNING]
> 桌面端的 `desktop` profile 由 Electron 应用独占管理，CLI 会硬拒。只跑 Web 就装到 `web`；桌面端请走客户端自带的插件管理入口。
>
> GitHub 地址和本地目录**都不经过安装源（镜像源）**——安装源只对 npm 包名生效。GitHub 地址装不通时，先确认这台机器能访问 `github.com`（或给它配代理）。

装完没出现壁纸、控制台有 `[dsh-lumen]` 开头的日志，对照 [`docs/INSTALL.md`](docs/INSTALL.md) 的故障排查表逐条看。安装、更新、卸载、验证的完整说明也在那一份。

## 本地开发

以下命令都在**仓库根目录**执行（包根即仓库根）：

```sh
npm run verify
```

`verify` 等价于依次跑下面三项，全部**只读**：

| 命令 | 作用 |
| :-- | :-- |
| `npm run build:check` | 校验构建产物与源码一致（改了源码没重新生成会失败） |
| `npm run typecheck` | 静态检查每个源码文件、脚本、HTML 引用是否可解析 |
| `npm test` | 18 个测试文件、373 项 |

**会写文件** —— 重新生成 `lib/` 与 `locale/`：

```sh
npm run build
```

<details>
<summary>展开完整目录树</summary>

```
dsh-lumen/（仓库根 = 包根）
├── lib/                     构建产物
│   ├── index.js             宿主半边：状态文件 + /lumen/api、/lumen/splash、/lumen/wallpaper 路由 + 启动遮罩与守卫
│   ├── client.js            浏览器半边（由 src/ 的 16 个模块拼成）
│   └── types/               手写类型声明
├── src/                     浏览器半边的源码（16 个模块）
│   ├── index.cjs            装配缝：store + engine + splash + panel + 宿主服务
│   ├── state.cjs            状态模型：一个形状、一个归一化器、一份序列化
│   ├── scheduler.cjs        轮播调度器（纯函数）
│   ├── wallpapers.cjs       2 套配方 + 4 张插画，与统一渲染
│   ├── engine.cjs           渲染引擎：DOM 层叠、洗色、token 覆盖
│   ├── splash.cjs           开屏的浏览器半边
│   ├── store.cjs            两层持久化
│   ├── color.cjs            WCAG 对比度求解、亮度估计、像素亮度分位
│   ├── oklab.cjs            Oklab/OKLCH 感知色彩空间、色域映射
│   ├── image.cjs            本地图片解码 / 缩放 / 压缩 / 亮度实测
│   ├── rng.cjs              mulberry32 + FNV-1a 种子化随机
│   ├── react-bridge.cjs     把无框架面板挂进 React 设置区
│   ├── i18n.cjs             双语字典与查找（166 条）
│   └── ui/                  面板、DOM 构造器、样式
├── preview/                 浏览器可交互预览（工具，不属于发布产物）
├── scripts/                 build / typecheck / serve
├── tests/                   18 个测试文件、373 项
├── media/
│   ├── splash.mp4           随包内置的开屏短片（默认启用的就是它）
│   └── wallpapers/          四张内置插画，由 /lumen/wallpaper 送出
├── locale/                  zh.json / en.json（由源码生成）
├── docs/                    INSTALL / INNOVATION / SPLASH-SPEC / WALLPAPER-SPEC / PACKAGE
├── cordis.patch.yml         profile 补丁层：插入一个 loader 条目
└── package.json
```

</details>

双面插件：宿主半边通过 `cordis.patch.yml` 的 `insert` 条目注册（`id: lumen`），浏览器半边由 `dsh-client-modules` 按 `package.json` 里的 `dsh.client` 声明拾取，和官方 `ui-*` 包一样。

---

## 文档索引

| 文档 | 内容 |
| :-- | :-- |
| [`docs/PACKAGE.md`](docs/PACKAGE.md) | 包的完整说明：功能、6 套内置壁纸、调度器、可读性下限、持久化、隐私与安全、兼容性 |
| [`docs/INSTALL.md`](docs/INSTALL.md) | 安装、更新、卸载、验证、故障排查 |
| [`docs/INNOVATION.md`](docs/INNOVATION.md) | 在哪些地方做了不同的技术选择，以及为什么 |
| [`docs/WALLPAPER-SPEC.md`](docs/WALLPAPER-SPEC.md) | 配方参数、状态字段、调度常量、存储格式的完整规格 |
| [`docs/SPLASH-SPEC.md`](docs/SPLASH-SPEC.md) | 开屏协议：媒体存储、四条路由、内置短片、启动遮罩与兜底守卫 |

---

## 隐私与安全

<details>
<summary>展开</summary>

- **插件自身不发任何网络请求。** 两套生成式壁纸由参数实时算出；四张内置插画由宿主从包内读出、经本机路由 `/lumen/wallpaper` 送出，不出网也不解压到别处；`图片地址` 由浏览器直接加载，插件不代理、不上报、不探测可达性。
- **壁纸不读磁盘。** 本地图片走浏览器 `File` API 读入（点选和拖拽同一条路径），缩放压缩后存本地，原图不会被复制到别处。
- **开屏会写自己的媒体目录。** 媒体字节落在 `$DSH_HOME/lumen-media/`，**文件名由宿主生成**，状态里只留文件名——既不是路径，也不是字节。
- **内置开屏不出网、不写盘。** 那段短片就在包里（`media/splash.mp4`），直接由宿主从包内读出、经本机路由 `/lumen/splash/media` 播放，两份拷贝都不产生；状态里只有一个来源标记。
- **宿主路由是围栏，不是鉴权。** `/lumen/api`、`/lumen/splash` 与 `/lumen/wallpaper` 走同一道围栏，要求回环地址的 `Host` + 同源浏览器标记（DNS rebinding / 跨站防御），并叠加宿主提供的会话鉴权层。
- **重名也不冲突。** 所有 DOM 节点带 `data-dsh-lumen` 标记，样式表 id 为 `dsh-lumen-style`，存储键前缀 `dsh-lumen:`。

</details>

---

## 兼容性

- DSH Desktop 0.2.0-rc.2、Node 24.21.0 上实测通过
- `engines.node >= 18`，运行时不依赖任何第三方包（`react` 走宿主模块表，取不到时只跳过设置面板，壁纸照常工作）
- peer 范围覆盖 `@deepseek-ai/dsh-client-*` `>=0.1.0-rc.6 <0.3.0-0`

---

## 许可

MIT，见 [`LICENSE`](LICENSE)。

本项目是**第三方插件，非 DeepSeek 官方产品**。它遵循 DSH 社区的插件惯例。
