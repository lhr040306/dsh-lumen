<div align="center">

<img src="icon.svg" width="112" height="112" alt="dsh-lumen">

# dsh-lumen · 流转壁纸

**给 DeepSeek Harness（DSH）的壁纸调度器**

12 套纯程序化生成的弥散光壁纸 &nbsp;·&nbsp; 本地图片 / 图片地址 / 渐变<br>
按间隔 · 整点 · 每日 · 每次会话自动换图，带交叉淡入

[![license](https://img.shields.io/badge/license-MIT-534AB7)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2018-3B6D11)](package.json)
[![tests](https://img.shields.io/badge/tests-343%20passing-0F6E56)](tests)
[![plugin](https://img.shields.io/badge/DSH-plugin-534AB7)](package.json)
[![github](https://img.shields.io/badge/GitHub-lhr040306%2Fdsh--lumen-534AB7?logo=github&logoColor=white)](https://github.com/lhr040306/dsh-lumen)

[功能](#功能速览) &nbsp;·&nbsp; [安装](#安装) &nbsp;·&nbsp; [壁纸](#12-套内置壁纸) &nbsp;·&nbsp; [开发](#本地开发) &nbsp;·&nbsp; [文档](#文档索引)

</div>

---

> `dsh-lumen` 的目标不是"换一张好看的图"，而是回答两个问题：**现在显示什么**，以及 **下一次什么时候变、变成什么**。
>
> 零图片素材、零运行时依赖，内置壁纸**完全离线**生成。

---

## 它和常见的换肤插件有什么不同

| | 常见做法 | dsh-lumen |
| :-- | :-- | :-- |
| **壁纸从哪来** | 打包图片素材，或让用户自己传 | 12 套**参数化配方**，运行时用 CSS 渐变算出来。不打包任何图片，可选集也不随体积增长 |
| **什么时候换** | 装上就一直是一张 | **调度器**：4 种触发方式 × 3 种顺序策略，落在可预测的钟点上 |
| **文字还看得清吗** | 交给用户调透明度 | 洗色层透明度对着 **WCAG AA 对比度求解**，且永远不比用户设的更透明 |

一句话：这是一个**壁纸调度器**，壁纸的生成方式只是它的素材来源之一。

---

## 功能速览

| 模块 | 内容 |
| :-- | :-- |
| **壁纸来源** | 12 套内置配方（深色 7 / 浅色 5）· 本地图片（可多选、可拖拽）· 图片地址 · 双色标渐变 |
| **轮播调度器** | 4 种触发方式 × 3 种顺序策略 · 间隔模式**锚定网格**，不随刷新重置 · 洗牌走完一轮前不重复 · 有损追赶 |
| **开屏** | 一个素材两处去处 · 图片开屏走纯 CSS **首帧上色** · 视频静音自动播放 · 四个出口全部有界 |
| **可读性下限** | alpha 对着 WCAG 2.1 AA 求解 · 面板**显示实际生效值**而非偷偷改掉 · 本地图片**实测亮度**驱动 |
| **工程** | 中英双语 149 条键完全对称 · 两层持久化跨重启生效 · 插件入口**从不抛异常** · 343 项单元测试 |

<details>
<summary>展开每一项的细节</summary>

**壁纸来源**

- 12 套内置配方（深色 7 套、浅色 5 套），全部由参数实时生成，无图片素材；每套配方可换种子，同一风格的另一种构图
- 本地图片：**可多选，也可直接把文件拖到那一行**；等比缩放压缩后本地保存，原图不上传
- 图片地址（仅 `http` / `https`）、双色标线性渐变

**轮播调度器**

- 4 种触发方式：`按间隔` / `整点` / `每日` / `每次会话`；3 种顺序策略：`顺序` / `洗牌` / `随机`
- 间隔模式**锚定网格**，不随刷新页面重置；洗牌模式走完一轮之前不重复
- 显示"下一次更换"的倒计时与后续 5 个触发时刻；可随时暂停 / 继续
- **有损追赶**：睡过五个触发点只换一次，不在用户眼前闪五张图

**开屏**

- 一个素材，两处去处：设为壁纸 / 设为开屏 / 两个都要
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
- 343 项单元测试，调度部分是纯函数，边界情况（睡过触发点、时钟回拨、夏令时、两张图的洗牌列表）都能当普通单测来测

</details>

---

## 12 套内置壁纸

全部为程序化配方，`complexity` 是"画面有多花"的估计值（0–1），驱动自动弱化。

| 配方 | 名称 | 中文名 | 取向 | complexity | 标签 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `drift` | Drift | 弥散 | 深 | 0.30 | calm, glow |
| `aurora` | Aurora | 极光 | 深 | 0.42 | cool, band |
| `starfield` | Starfield | 星野 | 深 | 0.55 | night, point |
| `abyss` | Abyss | 深海 | 深 | 0.34 | deep, cool |
| `ember` | Ember | 暮霭 | 深 | 0.44 | warm, dusk |
| `mono` | Mono | 墨韵 | 深 | 0.18 | minimal, neutral |
| `lumen` | Halo | 光晕 | 深 | 0.36 | focus, glow |
| `ivory` | Ivory | 象牙 | 浅 | 0.22 | warm, paper |
| `mist` | Mist | 晨雾 | 浅 | 0.20 | cool, calm |
| `dune` | Dune | 沙丘 | 浅 | 0.30 | warm, band |
| `glacier` | Glacier | 冰川 | 浅 | 0.34 | cool, facet |
| `paper` | Paper | 纸纹 | 浅 | 0.14 | paper, neutral |

每个配方都有一个 **seed**：同一配方换一个种子就是同一风格的另一种构图（面板上的「摇一摇」，也可以复制种子分享给别人）。

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

装完**重启 DSH**，然后打开 **设置 → 壁纸**。

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
| `npm test` | 18 个测试文件、343 项 |

**会写文件** —— 重新生成 `lib/` 与 `locale/`：

```sh
npm run build
```

<details>
<summary>展开完整目录树</summary>

```
dsh-lumen/（仓库根 = 包根）
├── lib/                     构建产物
│   ├── index.js             宿主半边：状态文件 + /lumen/api 与 /lumen/splash 路由 + 启动遮罩与守卫
│   ├── client.js            浏览器半边（由 src/ 的 16 个模块拼成）
│   └── types/               手写类型声明
├── src/                     浏览器半边的源码（16 个模块）
│   ├── index.cjs            装配缝：store + engine + splash + panel + 宿主服务
│   ├── state.cjs            状态模型：一个形状、一个归一化器、一份序列化
│   ├── scheduler.cjs        轮播调度器（纯函数）
│   ├── wallpapers.cjs       12 套配方与渲染
│   ├── engine.cjs           渲染引擎：DOM 层叠、洗色、token 覆盖
│   ├── splash.cjs           开屏的浏览器半边
│   ├── store.cjs            两层持久化
│   ├── color.cjs            WCAG 对比度求解、亮度估计、像素亮度分位
│   ├── oklab.cjs            Oklab/OKLCH 感知色彩空间、色域映射
│   ├── image.cjs            本地图片解码 / 缩放 / 压缩 / 亮度实测
│   ├── rng.cjs              mulberry32 + FNV-1a 种子化随机
│   ├── react-bridge.cjs     把无框架面板挂进 React 设置区
│   ├── i18n.cjs             双语字典与查找（149 条）
│   └── ui/                  面板、DOM 构造器、样式
├── preview/                 浏览器可交互预览（工具，不属于发布产物）
├── scripts/                 build / typecheck / serve
├── tests/                   18 个测试文件、343 项
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
| [`docs/PACKAGE.md`](docs/PACKAGE.md) | 包的完整说明：功能、12 套配方、调度器、可读性下限、持久化、隐私与安全、兼容性 |
| [`docs/INSTALL.md`](docs/INSTALL.md) | 安装、更新、卸载、验证、故障排查 |
| [`docs/INNOVATION.md`](docs/INNOVATION.md) | 在哪些地方做了不同的技术选择，以及为什么 |
| [`docs/WALLPAPER-SPEC.md`](docs/WALLPAPER-SPEC.md) | 配方参数、状态字段、调度常量、存储格式的完整规格 |
| [`docs/SPLASH-SPEC.md`](docs/SPLASH-SPEC.md) | 开屏协议：媒体存储、三条路由、启动遮罩与兜底守卫 |

---

## 隐私与安全

<details>
<summary>展开</summary>

- **插件自身不发任何网络请求。** 内置壁纸本地算出；`图片地址` 由浏览器直接加载，插件不代理、不上报、不探测可达性。
- **壁纸不读磁盘。** 本地图片走浏览器 `File` API 读入（点选和拖拽同一条路径），缩放压缩后存本地，原图不会被复制到别处。
- **开屏会写自己的媒体目录。** 媒体字节落在 `$DSH_HOME/lumen-media/`，**文件名由宿主生成**，状态里只留文件名——既不是路径，也不是字节。
- **宿主路由是围栏，不是鉴权。** `/lumen/api` 与 `/lumen/splash` 要求回环地址的 `Host` + 同源浏览器标记（DNS rebinding / 跨站防御），并叠加宿主提供的会话鉴权层。
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
