# 安装 · dsh-lumen

本文覆盖安装、验证、更新、卸载和故障排查。前置：DSH Desktop 或 DSH Web 已装好，Node ≥ 18。

---

## 一、先选一种来源

DSH 的插件安装入口统一接受 `<来源>`，`<来源>` 有四种形态，按你的场景挑：

| 来源 | `<来源>` | 适合 |
| --- | --- | --- |
| GitHub 仓库地址 | `https://github.com/lhr040306/dsh-lumen` | 普通用户（推荐） |
| GitHub 固定版本 | `github:lhr040306/dsh-lumen#v1.3.1`（或 `#<commit>`） | 需要可复现的版本 |
| 本地目录 | 仓库**根目录**的绝对路径 | 自己改代码（开发） |
| npm 包 | `dsh-lumen` | **尚未发布**，发布后才可用 |

**包根就是仓库根** —— `package.json`、`cordis.patch.yml`、`lib/` 都在仓库根上，所以 GitHub 地址和本地目录指向仓库根时都能直接装。

> [!IMPORTANT]
> 插件还没发布到 npm。在安装入口填 `dsh-lumen` 会被当成 **npm 包名**去查仓库，查不到就报「未找到相关插件」——这不是网络问题，改填上面的 GitHub 地址或本地目录路径即可。

**安装源（镜像源）只对 npm 包名生效。** GitHub 地址和本地目录都不经过安装源，需要这台机器自己能访问 `github.com`（或给它配代理）。

CLI 等价写法是 `dsh plugin --profile <profile> add <来源>`；`desktop` profile 由 Electron 应用独占管理，CLI 会硬拒（见[第八节](#八故障排查)），桌面端请走客户端自带的插件管理入口。

---

## 二、从 GitHub 安装

**会写入** —— 改动 DSH profile 的 `package.json` 依赖、把它写进 `dsh.profile.bundles`，并触发一次 pnpm 安装。它**不会**动你本地的源码副本。

图形入口：打开 DSH 的**插件安装入口**（设置 → 插件 → 安装），在输入框里填：

```text
https://github.com/lhr040306/dsh-lumen
```

CLI 等价写法：

```sh
dsh plugin --profile web add github:lhr040306/dsh-lumen
```

钉一个版本可以得到可复现的版本（`#` 后面可以是本仓库的标签 `v1.3.1`，也可以是任意 commit sha）：

```sh
dsh plugin --profile web add github:lhr040306/dsh-lumen#v1.3.1
dsh plugin --profile web add github:lhr040306/dsh-lumen#<commit>
```

> GitHub 安装要求这台机器能解析并访问 `github.com`。装不通时先在浏览器里打开一次仓库地址确认网络，再回来看[第八节](#八故障排查)。

**为什么这条路比一般插件慢。** 一般插件是 npm 包，安装时下载的是发布者 `files` 白名单里的那些文件，走 registry 的 CDN，并且按 integrity 进本地 store 缓存。`github:` 依赖不是这样：它下载的是 **codeload 打的整仓 tarball**，没有白名单可讲，`tests/`、`preview/`、`scripts/`、`src/`、`docs/` 全在里面；`package.json` 的 `files` 对它**不生效**。`.gitattributes` 的 `export-ignore` 也不生效——GitHub 的 archive 不从你的 `.gitattributes` 生成，这一点是实测的（`twbs/bootstrap` 的 `site/` 明明标了 `export-ignore`，codeload 的包里 496 条 `site/` 条目一条不少）。

因此这条路上能做的只有**真减体积**（当前整仓 2.06 MB，其中媒体 1.24 MB 已经压过一轮，见 `SPLASH-SPEC.md` §9.6 与 `WALLPAPER-SPEC.md` §3.2.1），以及**别每次重装都重下**：锁文件钉到 commit 之后，pnpm 命中 store 就不再走网络。

装完**重启 DSH**，然后看[第五节](#五验证)。

---

## 三、从本地目录安装

**会写入** —— 同上一节，改动 profile 配置并装依赖。它**不会**动你的源码目录。

先把仓库放到一个你不会随手删掉的位置，然后安装入口填**仓库根目录的绝对路径**，或执行下面这一块。

```sh
cd /仓库根目录的绝对路径
dsh plugin --profile web add "$(pwd)"
```

Windows PowerShell：

```powershell
cd F:\develop\dsh-lumen
dsh plugin --profile web add (Get-Location).Path
```

把第一行的路径换成你实际的仓库位置。用 `$(pwd)` / `(Get-Location).Path` 是为了避免手抄绝对路径出错（Windows 上尤其容易把反斜杠抄坏）。

装完**重启 DSH**，然后看[第五节](#五验证)。

---

## 四、从 npm 安装（发布后）

插件**尚未发布到 npm**。等它发布出去（或你自己 `npm publish` 之后），才可以只填包名。

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

## 五、验证

**只读** —— 打印该 profile 的最终 loader 配置，不写任何文件。

```sh
dsh --profile web --dump-config | grep -A2 lumen
```

Windows PowerShell：

```powershell
dsh --profile web --dump-config | Select-String -Context 0,2 lumen
```

期望看到这样的条目：

```
- id: lumen
  name: dsh-lumen
```

只要这两行出现，宿主半边就已经进了 loader 树，浏览器半边会由 `dsh-client-modules` 按包内的 `dsh.client` 声明自动拾取。

**桌面端（`desktop` profile）不能走 CLI** —— 在文件系统上核对这两处即可：

**只读**

```powershell
Get-Content "$HOME\.dsh\profiles\desktop\package.json" | Select-String dsh-lumen
Test-Path "$HOME\.dsh\profiles\desktop\node_modules\dsh-lumen\cordis.patch.yml"
```

第一处应能在依赖或 `dsh.profile.bundles` 里看到 `dsh-lumen`，第二处应为 `True`。

**只读** —— 看状态文件是否已经落地（首次触发写入前不存在是正常的）。

```sh
ls -l "$HOME/.dsh/lumen.json"
```

Windows PowerShell：

```powershell
Get-Item "$HOME\.dsh\lumen.json"
```

重启 DSH，打开 **设置 → 壁纸**。面板左侧应出现一项「壁纸 / Wallpaper」。如果只有壁纸生效、面板没出现，见[第八节](#八故障排查)。

---

## 六、更新

**会写入** —— 覆盖 profile 里的依赖声明。

```sh
dsh plugin --profile web update dsh-lumen
```

重启后生效。从 GitHub 安装的，`update` 会重新解析默认分支的最新提交；从本地目录安装的，更新就是更新那个源码目录本身，重启 DSH 即可（link 类依赖直接读源码目录）。

如果 `update` 报"已是最新"但界面仍是旧版，先读 profile 里声明的**范围**。写成 `^1.0.0` 时按 semver 永远到不了 2.x。这种情况用显式 `add` 重写依赖：

**会写入**

```sh
dsh plugin --profile web add dsh-lumen@<目标版本>
```

（GitHub 与本地目录来源同理，把 `<来源>` 换成原来的地址或路径重跑一次 `add`。）

---

## 七、卸载

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

Windows PowerShell：

```powershell
Remove-Item "$HOME\.dsh\lumen.json" -ErrorAction SilentlyContinue
```

浏览器里残留的快速种子（`dsh-lumen:` 前缀的 `localStorage` 键）会随 origin 变更自然失效，不影响重装后的行为——重装后宿主侧文件是权威副本。

---

## 八、故障排查

### 安装入口报「未找到相关插件」

**这不是网络问题**，是来源类型判错了：输入框里的 `dsh-lumen` 被当成 **npm 包名**去查注册表，而这个包还没发布，注册表 404。

改填 **GitHub 仓库地址**（`https://github.com/lhr040306/dsh-lumen`）或**本地仓库根目录的绝对路径**。安装源（镜像源）下拉只影响 npm 包名那一类来源，换镜像源解决不了这个问题。

### 安装入口报网络/主机错误

GitHub 地址和 `.tgz` 直链**不经过安装源**，需要这台机器能直接访问 `github.com`。先在浏览器里打开一次仓库地址：打不开就先解决网络或代理，或者改用**本地目录**安装。

### 装完没有 loader 条目，日志里有 `warning: <name> declares no dsh.bundle`

DSH 只把**声明了 `dsh.bundle` 的包**挂进 profile 层，出现这条警告说明装上来的东西不是本插件。最常见的成因是**装到了一个没有 `package.json` 的目录**——本仓库的 `package.json` 就在仓库根，所以指向仓库根即可；如果仓库以后被改成把包放在子目录里，就要把来源改成那个子目录，或改用本地目录安装指向真正的包根。

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

这是环境既有的构建脚本审批策略。link 类依赖通常已经生效，直接用第五节的 `--dump-config` 确认 loader 条目是否出现即可，不必强行批准构建脚本。

### `dsh: installation rejected: Plugin ... is incompatible with dsh <运行时>` 紧跟 `dsh: restored package.json, pnpm-lock.yaml, and node_modules.`

DSH 已经自动回滚，环境是干净的。先怀疑**静默降级**（见第四节），用显式版本号重装，而不是认定插件与该宿主不兼容。

---

## 九、不使用插件，只看效果

如果你只是想评估一下再决定，不需要安装。在仓库根目录里：

**会启动一个本地服务** —— 监听 `127.0.0.1:4173`（被占则向后顺延至多 12 个端口），只写 `preview/.state/lumen.json`，**不会**碰 `$DSH_HOME/lumen.json`。

```sh
npm run preview
```

打开终端打印的地址即可。Ctrl+C 停止。这是一个零依赖的本地 Node 脚本（`scripts/serve.cjs`），不需要买服务器、不联外网。它读的是仓库里的源码，所以要先有仓库的一份克隆。
