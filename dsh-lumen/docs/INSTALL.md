# 安装 · dsh-lumen

本文覆盖安装、验证、更新、卸载和故障排查。前置：DSH Desktop 或 DSH Web 已装好，Node ≥ 18。

---

## 一、先选一种来源

DSH 的插件安装命令统一是 `dsh plugin --profile <profile> add <来源>`。`<来源>` 有三种常见形态，按你的场景挑：

| 来源 | 命令里的 `<来源>` | 适合 |
| --- | --- | --- |
| npm 包 | `dsh-lumen` | 普通用户（推荐） |
| GitHub 固定提交 | `github:<user>/<repo>#<commit>` | 需要可复现的版本 |
| 本地目录 | 该目录的绝对路径 | 自己改代码（开发） |

本仓库当前是**本地开发形态**，还没发布到 npm。所以要么用本地目录安装，要么先把它发布出去。

---

## 二、从本地目录安装

先把仓库放到一个你不会随手删掉的位置，然后执行下面这一块。

**会写入** —— 这条命令会改动 DSH profile 的 `package.json` 依赖、把它写进 `dsh.profile.bundles`，并触发一次 pnpm 安装。它**不会**动你的 `dsh-lumen/` 源码目录。

```sh
cd /path/to/dsh-lumen
dsh plugin --profile web add "$(pwd)"
```

把第一行的路径换成你实际的仓库位置。第二条命令用 `$(pwd)` 是为了避免手抄绝对路径出错（Windows 上尤其容易把反斜杠抄坏）。

装完**重启 DSH**，然后看[第四节](#四验证)。

---

## 三、从 npm 安装（发布后）

**会写入** —— 同上一节，改动 profile 配置并装依赖。

```sh
dsh plugin --profile web add dsh-lumen
```

### 如果被"冷静期"静默降级

pnpm 的 `minimumReleaseAge`（新版本冷静期）会把不带版本号的 `add` 解析成**上一个成熟版本**。症状是输出里只有 `+ dsh-lumen ^<旧版>` 和一行 `(<新版> is available)`，而那个旧包的 peer 范围可能覆盖不到你当前的 DSH 运行时。此时不要以为是"插件不支持这个宿主"，改用**显式版本号**重装即可（显式版本会让 pnpm 自动写进 profile 的 `pnpm-workspace.yaml` → `minimumReleaseAgeExclude`）。

先查实际最新版本号——**不要凭记忆写版本号**：

**只读**

```sh
npm view dsh-lumen version
```

拿到版本号后，用它替换下面命令里的 `<版本>` 再执行。

**会写入** —— 覆盖 profile 里的依赖声明并重装。

```sh
dsh plugin --profile web add dsh-lumen@<版本>
```

不要用 `dsh plugin allow-version` 给旧版本开豁免：那只是让一个 peer 范围本就不匹配的旧包强行装上，宿主换代之后仍然要出问题。

---

## 四、验证

**只读** —— 打印该 profile 的最终 loader 配置，不写任何文件。

```sh
dsh --profile web --dump-config | grep -A2 lumen
```

期望看到这样的条目：

```
- id: lumen
  name: dsh-lumen
```

只要这两行出现，宿主半边就已经进了 loader 树，浏览器半边会由 `dsh-client-modules` 按包内的 `dsh.client` 声明自动拾取。

**只读** —— 看状态文件是否已经落地（首次触发写入前不存在是正常的）。

```sh
ls -l "$HOME/.dsh/lumen.json"
```

重启 DSH，打开 **设置 → 壁纸**。面板左侧应出现一项「壁纸 / Wallpaper」。如果只有壁纸生效、面板没出现，见[第七节](#七故障排查)。

---

## 五、更新

**会写入** —— 覆盖 profile 里的依赖声明。

```sh
dsh plugin --profile web update dsh-lumen
```

重启后生效。

如果 `update` 报"已是最新"但界面仍是旧版，先读 profile 里声明的**范围**。写成 `^1.0.0` 时按 semver 永远到不了 2.x。这种情况用显式 `add` 重写依赖：

**会写入**

```sh
dsh plugin --profile web add dsh-lumen@<目标版本>
```

---

## 六、卸载

**会写入** —— 从 profile 移除依赖、loader 条目和已安装的文件。

```sh
dsh plugin --profile web remove dsh-lumen
```

重启后恢复默认外观。

卸载**不会**删除状态文件。如果你确定不再需要，可以自己删掉——注意这是一条删除命令，删了就找不回来了：

**会删除文件**

```sh
rm -f "$HOME/.dsh/lumen.json"
```

浏览器里残留的快速种子（`dsh-lumen:` 前缀的 `localStorage` 键）会随 origin 变更自然失效，不影响重装后的行为——重装后宿主侧文件是权威副本。

---

## 七、故障排查

### `profile "desktop" is managed exclusively by the Electron application`

**这是设计如此，不是 bug。** 官方桌面 profile 由 Electron 应用独占管理，CLI 会硬拒。不要在这里反复试错，也不要绕过它——桌面端插件应当走该客户端自己提供的插件管理入口。

判断你该用哪个 profile：

**只读**

```sh
ls "$HOME/.dsh/profiles"
```

只跑 Web 就装到 `web`；只有桌面端就用桌面端自带的插件管理界面。

### 装完壁纸没出现，控制台有 `[dsh-lumen]` 开头的日志

插件入口被刻意写成**从不抛异常**——一条抛出的 loader factory 会聚合到宿主层的 "entries did not activate"，连带整个 Web 外壳一起挂掉。所以失败的表现一定是"壁纸不出现 + 一行日志"，而不是 DSH 起不来。

对照日志内容：

| 日志 | 含义 | 处置 |
| --- | --- | --- |
| `react unavailable — the settings panel will not mount` | 宿主模块表里没有 `react` | 壁纸仍正常工作，只是没有设置面板。检查 DSH 版本 |
| `slots service unavailable — settings panel not registered` | 宿主没有 `slots` 服务 | 同上；面板无法挂载 |
| `locale registration failed` | 宿主 locale 注册失败 | 面板会退回内置字典，影响很小 |
| `boot failed — falling back to defaults` | 读持久化失败 | 插件已用默认值启动；检查 `$DSH_HOME/lumen.json` 是否可读 |
| `settings section registration failed` | 面板注册抛错 | 面板不出现，壁纸正常 |

### 状态读得到但每次重启都回到默认

说明宿主通道没通，插件退回了 `localStorage` 种子，而种子又随 origin 变更失效。在浏览器控制台里读诊断快照：

```js
window.__DSH_LUMEN__
```

看 `health.hostAvailable` 是不是 `false`，以及 `health.hostReason` 写的原因。常见原因是反向代理或非回环访问——`/lumen/api` 要求回环地址（或 profile 里显式配置的可信 authority）的 `Host` 头，这是 DNS rebinding 防御，不是鉴权。

### pnpm 报 `ERR_PNPM_IGNORED_BUILDS`

这是环境既有的构建脚本审批策略。link 类依赖通常已经生效，直接用第四节的 `--dump-config` 确认 loader 条目是否出现即可，不必强行批准构建脚本。

### `dsh: installation rejected: Plugin ... is incompatible with dsh <运行时>` 紧跟 `dsh: restored package.json, pnpm-lock.yaml, and node_modules.`

DSH 已经自动回滚，环境是干净的。先怀疑**静默降级**（见第三节），用显式版本号重装，而不是认定插件与该宿主不兼容。

---

## 八、不使用插件，只看效果

如果你只是想评估一下再决定，不需要安装。在仓库目录里：

**会启动一个本地服务** —— 监听 `127.0.0.1:4173`（被占则向后顺延至多 12 个端口），只写 `preview/.state/lumen.json`，**不会**碰 `$DSH_HOME/lumen.json`。

```sh
npm run preview
```

打开终端打印的地址即可。Ctrl+C 停止。这是一个零依赖的本地 Node 脚本，不需要买服务器、不联外网。

详见 [README 的预览一节](../README.md#浏览器可交互预览)。
