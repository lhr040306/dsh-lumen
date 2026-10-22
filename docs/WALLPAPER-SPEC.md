# 壁纸规格 · dsh-lumen

本文是 `dsh-lumen` 的参考规格：壁纸条目、6 套内置壁纸、微调参数、洗色与可读性下限、本地图片的亮度实测、轮播调度的全部常量、状态字段、以及持久化格式。

其中的数字都不是从注释里抄的，而是从 `src/` 里的导出常量与测试用的边界值读出来的。改动源码后请一并更新本文（`tests/state.test.cjs` 会断言持久化字段列表与状态自身字段列表完全一致，那是最容易漂移的一处）。

**版本**：`schema 1` · 插件 `1.2.1`

---

## 一、术语

| 术语 | 含义 |
| --- | --- |
| **配方（recipe）** | 一套参数化的程序化壁纸生成规则，如 `drift` |
| **壁纸条目（item）** | 播放列表或当前壁纸的一项，可能是一个配方、一张本地图、一个地址或一条渐变 |
| **种子（seed）** | 配方的变化选择器。`"default"` 表示该配方的规范渲染 |
| **微调（tuning）** | 三个全局旋钮：色相、柔度、颗粒 |
| **洗色（wash）** | 把主题画布色换成同色半透明版本的那一层，壁纸靠它透出来 |
| **可读性下限** | 为满足 WCAG AA 对比度而对洗色 alpha 施加的强制抬升 |
| **实测亮度（luminance）** | 一条目携带的相对亮度 0–1，只有本地图片在导入时真正测过；`null` 表示"未测量" |
| **位置（position）** | 主体在视口里的九点定位之一，写入 `background-position` |
| **轮播（rotation）** | 按调度在播放列表里自动前进 |

---

## 二、壁纸条目

### 2.1 形状

```ts
interface WallpaperItem {
	id: string;                // 形如 itm_<base36 时间戳>_<序号>
	kind: "recipe" | "image" | "url" | "gradient";
	ref: string;               // 含义随 kind 变化，见下表
	seed: string;              // 配方的变化选择器；非配方条目为 "default"
	luminance: number | null;  // 实测相对亮度 0–1；未测量为 null
}
```

### 2.2 `ref` 的含义

| `kind` | `ref` 是什么 | 约束 |
| --- | --- | --- |
| `recipe` | 配方 id，如 `drift`。未知 id 回退到 `drift` | 必须是 `RECIPE_IDS` 之一 |
| `image` | `data:image/...;base64,...` | ≤ **8388608** 字符（8 MiB）；必须是安全的 data image |
| `url` | `http` / `https` 地址 | 仅这两个协议 |
| `gradient` | 一条 CSS 线性渐变 | ≤ **600** 字符；通过 `isSafeGradient` 检查 |

`ref` 在写入前都会过一遍安全判定（`isSafeDataImage` / `isSafeWallpaperUrl` / `isSafeGradient` / `isSafeBackgroundImage`），非法的值会被拒绝而不是渲染。这是为了挡住从存储里被改过的值直接拼进 CSS。

### 2.3 `luminance` 的含义

只有**本地图片**会被实测（`image.sampleLuminance` 在导入时读一次 64×64 的采样），因此：

| 条目 | `luminance` |
| --- | --- |
| `image`，刚导入 | 实测值，保留 3 位小数 |
| `image`，导入失败或导入前的旧数据 | `null` |
| `url` | 始终 `null`（渲染路径同步，且跨域图片会污染 canvas） |
| `recipe` / `gradient` | 始终 `null`（亮度由 `estimateImageLuminance` 现算） |

`null` 与 `0` 的区别是**语义性的**，不能互相转换：`null` 表示"没测量，请回退"，引擎会退回中性常数 `NEUTRAL_LUMINANCE`（0.42）；而 `0` 表示"纯黑"，是可读性下限唯一取不到有效值的极端点。`normalizeLuminance` 因此**严格按类型判定**——`Number(null)` 是 `0`，宽松转换会把"未测量"静默变成"纯黑"，正好关掉保护。

`luminance` 存放在 JSON 文档里而不是和图片负载放一起：它只有几个字节，而放进 blob 键意味着图片字节一旦被清理，亮度也一起丢掉。

### 2.4 播放入口

- 播放列表最多 **24** 条（`MAX_PLAYLIST`）。
- 条目 id 全局唯一，用于给图片负载定位存储键。
- 一次导入 N 张图：第 1 张进 `single`，其余 N−1 张依次进播放列表；超出上限的部分被丢弃并**明确报数**，不静默吞掉。

---

## 三、内置壁纸

6 套：2 套生成式配方（1 深 1 浅）+ 4 张随包插画。`scheme` 是设计取向，配方在另一套主题下同样能渲染——它只影响配方自身的取色倾向。

| id | 中文 | English | 类型 | scheme | softness 默认 | grain 默认 | complexity | tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `drift` | 弥散 | Drift | 生成式 | dark | 0.62 | 0.22 | 0.30 | calm, glow |
| `mist` | 晨雾 | Mist | 生成式 | light | 0.78 | 0.16 | 0.20 | cool, calm |
| `whale-point-half` | 夜潮 | Night Tide | 插画 | dark | 0.50 | 0.20 | 0.55 | photo, whale |
| `whale-starlit` | 星海 | Starlit | 插画 | dark | 0.50 | 0.20 | 0.50 | photo, whale |
| `whale-sunset` | 黄昏 | Dusk | 插画 | dark | 0.50 | 0.20 | 0.60 | photo, whale |
| `whale-point-full` | 深蓝 | Deep Blue | 插画 | dark | 0.50 | 0.20 | 0.55 | photo, whale |

**`complexity`（0–1）** 不是给用户看的标签，是**自动弱化的输入**：它估计画面有多"花"，越高则洗色抬升越多。取值和实际观感对应：

- `mist` 0.20 —— 大片柔和薄雾，几乎不需要保护
- `drift` 0.30 —— 四团弥散光斑加暗角
- `whale-sunset` 0.60 —— 最花，也是最亮的一张（画面里有一整片晚霞）

**`softness` / `grain` 默认值** 是每个配方单独标定的（`defaultSoftnessFor` / `defaultGrainFor`），不是全局常数。例如 `drift` 的 softness 默认 0.62（光斑要足够散），而 `mist` 的 grain 只有 0.16（浅色薄雾加颗粒会显脏）。

### 3.1 为什么插画也是"配方"

插画在数据模型里就是一个 `recipe` 条目——`ref` 是 id，没有新的 `kind`。面板的 chip 行、播放列表、轮播调度、洗色求解与持久化全都已经工作在"一个等于内置 id 的 `ref`"上，因此加一种素材不需要它们任何一处改动。差别只在 `build()` 内部：

```js
build() { return { layers: ['url("/lumen/wallpaper/whale-sunset.webp")'], base: {r,g,b} }; }
```

也就是说插画是**恰好只有一层 `url()` 的配方**。由此带来三条明确的差异，都写在下面：

| 差异 | 生成式 | 插画 |
| --- | --- | --- |
| `seed` | 选择一种构图 | 无效果（一张图就是一张图），面板不给「摇一摇」 |
| `hue` / `softness` | 有效 | 无效果（颗粒仍然生效，且只有一半力度） |
| 亮度 | 由 `estimateImageLuminance` 从渐变栈估计 | 在图片文件上**实测**，写在配方的 `luminance` 上 |

### 3.2 插画的实测亮度

四个数字不是猜的：按 `image.sampleLuminance` 的同一套定义——64×64 面积平均、WCAG 相对亮度、**上四分位**——在随包的 WebP 上量出来：

| id | 文件 | 实测亮度（p75） | 平均色 `base` |
| --- | --- | --- | --- |
| `whale-point-half` | `whale-point-half.webp` | 0.132 | `rgb(78, 96, 133)` |
| `whale-starlit` | `whale-starlit.webp` | 0.085 | `rgb(39, 51, 78)` |
| `whale-sunset` | `whale-sunset.webp` | 0.245 | `rgb(126, 110, 130)` |
| `whale-point-full` | `whale-point-full.webp` | 0.133 | `rgb(82, 103, 150)` |

实测值取代了 `NEUTRAL_LUMINANCE`（0.42）这个中性常数——那是对**拿不到像素**的图片（远程地址）的兜底，而随包的图片自己带着像素，没有理由用常数凑。`base` 是图片自身的平均色，用作图片加载完成前的那一层底色，避免黑闪。

### 3.2.1 为什么是 WebP，而不是原图的 JPEG

插画原先以 JPEG（q88，1536×1024，合计 1.16 MB）随包。同一批画面换成 WebP q82 后是 **638 KB（-45%）**，1:1 裁剪对比看不出差别；亮度实测同步重跑过，四张的偏移都在 **0.007 以内**（偏暗），低于洗色求解的一个显示步，所以表里的数字没有重写。

这不是"顺手压一下"：这四张图占了整包体积的一半以上，而它们要跟着**每一次安装**下载一遍。取舍的边界是**不改分辨率**（1536 宽在 1920 屏上本来就是略微放大，再缩就真的糊了）和**不降到 q75 以下**（画面里那几片晚霞是最先出块的地方）。

宿主那条白名单 `^[a-z0-9-]+\.(jpg|jpeg|png|webp)$` 本来就允许 webp，所以这一改动没有触碰路由、MIME 表或校验逻辑——只有文件名和四个 `file:` 字段变了。

### 3.3 退役配方

`aurora`（极光）、`starfield`（星野）、`dune`（沙丘）已不再随包，但旧状态文件里可能还写着它们。`repairRecipeId` 按**意图**改写，而不是让它们一起塌到 `RECIPES[0]`：

| 退役 id | 改写为 | 理由 |
| --- | --- | --- |
| `aurora` | `drift` | 都是深色弥散光 |
| `starfield` | `whale-starlit` | 都表达"星空下的夜" |
| `dune` | `mist` | 都是浅色、安静的一面 |

完全不认识的 id 仍然落到 `RECIPES[0]`，与之前一致——条目仍然是"一张内置壁纸"。

### 3.4 首次安装的默认

`DEFAULT_STATE.single` 是 `whale-sunset`（黄昏）。只有**全新安装**会看到它：已经写过 `single` 的文档保留自己的选择，包括那些写着退役 id、随后被上面那张表改写的文档。默认值是一次第一印象，不是覆盖用户选择的策略。

---

## 四、配方渲染

### 4.1 接口

```js
renderRecipe({ recipeId, seed, tuning })
// → { backgroundImage, backgroundColor, scheme, complexity, recipeId, seed }
```

| 输出字段 | 含义 |
| --- | --- |
| `backgroundImage` | 一串 CSS 渐变，可直接做 `background-image`。典型长度 300–800 字符；插画是单层 `url("/lumen/wallpaper/<name>")` |
| `backgroundColor` | 兜底底色，形如 `rgb(4, 12, 23)`，在所有渐变之下；插画取自身平均色 |
| `scheme` | `dark` / `light`，来自配方 |
| `complexity` | 来自配方，供自动弱化使用 |
| `luminance` | 实测亮度；生成式为 `null`（由引擎估计），插画为文件上的测量值 |
| `photo` | 是否随包插画。为 `true` 时引擎把颗粒降到一半 |

未知的 `recipeId` 回退到 `drift`。**这个函数不抛异常**——任何输入都返回可渲染的值。

### 4.2 生成的词汇表

配方内部用四个 CSS 原语拼装：

| 原语 | 参数 | 用途 |
| --- | --- | --- |
| `radial` | `{ x, y, rx, ry, color, alpha, fade }` | 一个弥散光斑。位置与半径都是百分比，所以对任意视口比例都成立 |
| `linear` | `(angle, stops)` | 条带状渐变（`mist` 的底雾） |
| `vignette` | `(strength, inset)` | 四周压暗，把视线收到中间 |
| `halo` | `(strength, inset)` | 边缘提亮（`mist` 的空气感） |

颜色由 `tone(L, chroma, hue)` 产生——在 **Oklab / OKLCH** 感知空间里取色，而不是在 HSL 里。这一点有实际意义：HSL 里"同样的明暗变化"在感知上并不均匀，一套配方换色相后会一半偏亮一半偏暗；Oklab 的 `L` 是感知均匀的，所以配方换色相后亮度观感保持一致。超出 sRGB 色域时对色度做二分收敛（`oklab.cjs`）。

所有数值在拼接前都会被四舍五入到 **2 位小数**（`n()` 辅助函数），这是为了让产物字符串短、可缓存、且在测试里可做精确比对。

### 4.3 种子

`seed` 经 **FNV-1a** 字符串哈希后喂给 **mulberry32**，得到一个确定性的 `[0,1)` 随机流。同一个 `(recipeId, seed)` 永远给出同一串数值，因此：

- 同一张图可以在别人机器上被精确复现（「复制种子」功能就是分享这个）；
- 测试可以断言具体数值，而不必做模糊比较。

`"default"` 表示走配方的规范路径（不消耗随机流）。

`seed` 的归一化规则（`normalizeSeed`，上限 64 字符）：

| 输入 | 结果 |
| --- | --- |
| 非空字符串 | 去首尾空白，截断到 64 字符 |
| 数字 | 转成字符串，截断到 64 字符 |
| 空串 / 纯空白 / `null` / 其他类型 | `"default"` |

也就是说**任意非空字符串都是合法种子**（`"!!!"` 会原样保留），只有"空"才落到规范渲染。

---

## 五、微调（Tuning）

三个全局旋钮，作用于**所有配方**，不是单个条目：

| 字段 | 范围 | 中性值 | 含义 |
| --- | --- | --- | --- |
| `hue` | −180 … 180 | `0` | 色相旋转（度） |
| `softness` | 0 … 1 | `0.5` | 光斑的弥散程度 |
| `grain` | 0 … 1 | `0.35` | 胶片颗粒强度 |

中性值集合是 `NEUTRAL_TUNING = { hue: 0, softness: 0.5, grain: 0.35 }`。

注意 `softness` / `grain` 的**中性值**和每个配方的**默认值**是两回事：选中一个配方时，滑块的默认位置取该配方的标定值（第三节的表），而中性值用于"用户没有偏好时"的兜底与归一化落点。

---

## 六、洗色（Wash）

### 6.1 字段

| 字段 | 范围 | 默认 | 含义 |
| --- | --- | --- | --- |
| `opacity` | 0.20 … 0.98 | 0.82 | 用户**要求**的不透明度 |
| `blur` | 0 … 60 | 0 | 模糊半径（px） |
| `fit` | `cover` \| `contain` \| `blur` | `cover` | 填充方式 |
| `position` | 见 6.7，共 9 个值 | `center` | 主体在视口里的位置 |
| `autoDim` | boolean | `true` | 依 `complexity` 自动抬升 |
| `readability` | boolean | `true` | 启用 WCAG AA 下限求解 |

`washTouched`（状态字段，非洗色字段）记录用户**是否曾经手动调过**洗色。它存在的意义是：默认值将来可以改进，但已经调过的人不该被覆盖。

### 6.2 生效值

实际渲染用的 alpha **不一定等于** `opacity`：

```
effectiveAlpha = max(opacity, autoDim 抬升, readability 求解下限)
```

三条路径都可能抬升，从未有任一条会降低。用户设的值是**下界**，不是目标值。

### 6.3 可读性下限的算法

目标：`WCAG 2.1 AA`，即对比度 **≥ 4.5:1**（`CONTRAST_TARGET`）。

1. 把壁纸归约成一个**相对亮度相同的中性灰**。亮度估计本身是线性域的加权平均，所以它在通道空间的等效平坦色是其平方根：`255 × linearToSrgb(clamp(L, 0, 1))`。
2. 在**通道空间**（即 CSS `rgba()` 实际混合的那个空间）把该灰合成到画布色上。
3. 对 alpha 做**二分**，12 次迭代 → 精度约 0.1%。
4. 结果**向上取整**到 3 位小数。它是安全下限，向下舍入会交出一个达不到目标的 alpha。
5. 若在 `ceiling` 处仍达不到目标，返回 `ceiling`——宁可给出一个做不到的诚实数字，也不假装达得到。

二分成立的前提：合成色随 alpha 单调趋向画布色，而画布色与文字的对比度关于亮度是单峰的，所以**二分找到的第一个交点就是答案**。

### 6.4 亮度估计

`estimateImageLuminance` **自下而上按覆盖面积**合成，而不是数色标个数或取平均。

理由：一层覆盖 80% 画面的亮色，比八层各覆盖 5% 的亮色危险得多。按层数计权会把后者的分数算得远高于前者——正好算反。

估计**故意偏向高估亮度**：高估的代价是"洗色厚一点"，低估的代价是"用户看不清字"。代价不对称，处理方式就不该对称。

### 6.5 本地图片的亮度实测

上面的估计只适用于**能拿到画面描述**的壁纸：配方和渐变都是插件自己算出来的。**图片地址**拿不到——渲染路径是同步的，没有像素可看，跨域图片画进 canvas 还会污染画布、`getImageData` 直接抛错。所以远程图片只能沿用中性常数。

本地图片不必猜。`prepareImage` 在导入时手里已经握着解码后的位图，把它画进一张 **64×64**（`LUMINANCE_SAMPLE_EDGE`）的新画布读一遍像素，只多一次绘制。测量发生在**编码循环之前**，因为亮度是"用户挑的那张图"的属性，不是"我们恰好施加的那次缩放"的属性。

读数取**上四分位**（`DEFAULT_LUMINANCE_QUANTILE = 0.75`），nearest-rank 定义（`quantile`）：

| 画面 | 平均值 | 上四分位 | 该用哪个 |
| --- | --- | --- | --- |
| 半黑半白 | 0.5 | **1.0** | 上四分位——按 0.5 求解，白的那半照样读不了 |
| 纯中灰 128 | 0.216 | 0.216 | 一样——平坦画面上分位塌回平均值 |

nearest-rank 而非插值：返回的永远是**某个像素真正有过的亮度**，而不是两个采样点的平均值——后者不落在任何像素上。全透明像素（`a === 0`）跳过，通道读不成有限数的样本也跳过；一个样本都不剩时返回 `NEUTRAL_LUMINANCE`。

`sampleLuminance` 在任何失败路径上都返回 `null` 而不是猜一个值，`prepareImage` 把 `null` 原样放进结果的 `luminance` 字段。

**随包的四张插画也走这个定义**，只是测量发生在构建期而不是导入时：数值写在配方的 `luminance` 上（第三节 3.2 的表），引擎读到就直接用它，不再从 CSS 估计。于是"用户自己挑的图"和"包里带的图"在洗色求解里是可比的同一类数字，而远程地址仍然只有中性常数。

### 6.6 `fit` 三种模式

| 模式 | 行为 |
| --- | --- |
| `cover` | 铺满并裁切，不露底 |
| `contain` | 完整可见，极端宽高比下露出画布底色。**这是该模式的预期行为** |
| `blur` | 一张放大且模糊的同图铺底 + 一张 `contain` 的前景图，消除蒙版边 |

`blur` 模式会多出一层 `data-dsh-lumen="bleed"` 节点承载那张放大模糊的底图。

### 6.7 位置与 `fit` 的关系

`WASH_POSITIONS` 恰好是 CSS `background-position` 的九点网格，逐个都必须是合法声明（否则引擎会静默丢掉整条属性）：

| | 左 | 中 | 右 |
| --- | --- | --- | --- |
| **上** | `top left` | `top` | `top right` |
| **中** | `left` | `center` | `right` |
| **下** | `bottom left` | `bottom` | `bottom right` |

角落一律写作 `<垂直> <水平>`（`top left`），不写反序：`background-position` 对两个关键字是顺序无关的，但只有一种写法能被 `includes()` 精确匹配。

`position` 无条件写入两个图片槽的 `background-position`，不按 `fit` 分叉：

```
slot.style.backgroundPosition = wash.position
bleed.style.backgroundPosition = "center"   // 恒定
```

- `cover` / `blur` 下图片按视口比例铺满，位置**不产生视觉变化**。它照常写入，是为了让代码只有一条路径，而不是多一个只在 `contain` 下才出现的分支。
- `bleed` 层恒定居中：它存在的目的是遮住上层 `contain` 的蒙版边，一旦偏心，恰好会露出它本来要盖住的那条边。
- `position` **必须进渲染键**（`renderKey`）。它既不改变图片内容也不改变尺寸，`needsWork` 与 `needsCrossfade` 都不会因它变真；不进键的话这次改动会被短路判为"无事可做"，位置静默不生效，直到别的什么恰好动了。
- 未知值在 `normalizeWash` 里被修回 `center`，不是被拒绝——洗色子记录永远是一个完整可用的形状。

### 6.8 通窗口视图必须不透明

洗色把 `--dsw-alias-bg-base` 与 `--dsw-specific-sidebar-fill` 一起换成 `transparent`，这是壁纸可见的前提（见 §6.2 与文件头"透明表面 + 单层纱"）。普通面板透明是对的：它们背后就是壁纸。

**通窗口视图**是唯一的例外。账号菜单里的「查询用量」正是这样一个视图：一个 `body` 下的 `role="dialog"`，自己占满窗口、自己拥有窗口的拖拽行，底色取 `--dsw-alias-bg-base`。它背后不是壁纸，而是**应用本身**；底色一旦透明，它自己表头的返回按钮就画在侧栏品牌字标上，两层文字在同一坐标叠成一团。

所以这类表面拿回**不透明**的画布色：

| 名字 | 内容 | 谁写 | 谁读 |
| --- | --- | --- | --- |
| `--lumen-canvas` | 未洗色的画布色，恒为不透明 | 引擎 `applyWash` 写到 `:root` | 引擎样式表里那唯一一条规则 |

规则（选择器刻意不依赖宿主的哈希类名）：

```
body>[role="dialog"][aria-modal="true"]:has(>header[data-window-drag]){background-color:var(--lumen-canvas,var(--dsw-alias-bg-base))}
```

- `[role="dialog"][aria-modal="true"]` 是 DSH 的弹窗契约，`>header[data-window-drag]` 是"这个视图拥有窗口拖拽行"的结构证据，因此它必然通窗口。只有卡片的模态框没有这一行，继续保持透明，四周照常见到壁纸。
- `:has()` 在本项目支持的 Chromium 上都有；解析不了时整条规则被丢弃，行为回到加它之前。
- 变量写在 `:root` 而不是直接写在那类元素上：那个元素属于宿主，插件不拥有它，也不该去改它的 `style`。继承即可。
- `clearWash` 连同这个变量一起撤。洗色撤走时宿主令牌本身已经是不透明的，留一个旧值只会让通窗口视图在换主题后还画着上一个主题的画布色。

### 6.9 侧栏与主体之间的接缝

Windows 标题栏布局下，宿主自己那点分隔在洗色落地的一刻就没了：`[data-windows-titlebar] .BynINW_sidebarCol{border-right:none}` 撤掉了宿主的细线，而原本有区别的两个面——侧栏的 `--dsw-specific-sidebar-fill` 与主体的 `--dsw-alias-bg-base`——现在都是 `transparent`。剩下一张从边到边的完整照片：侧栏不再读作"面板"，整个窗口读作"一张图加一些字"。

所以侧栏拿回一点自己的底色，并补回宿主撤掉的那条细线：

| 名字 | 内容 | 谁写 | 谁读 |
| --- | --- | --- | --- |
| `--lumen-panel` | 侧栏填充色（`--dsw-specific-sidebar-fill`）的 34% 半透明 | 引擎 `publishPaint` 写到 `:root` | `CHROME_SEAM_CSS` |
| `--lumen-seam` | 正文色（`--dsw-alias-label-primary`）的 14%，作细线 | 同上 | 同上 |

```
html[data-windows-titlebar][data-dsh-lumen-active] [class*="sidebarCol"]{background-color:var(--lumen-panel);box-shadow:inset -1px 0 0 var(--lumen-seam);}
html[data-windows-titlebar][data-dsh-lumen-active] [class*="frame"]:before{background-color:var(--lumen-panel);}
```

- **只有一层。** 两个列背后的 frame 是透明的，所以这 34% 只落一次，不构成 §6.2 说的那种叠加。
- 颜色取的是侧栏与正文自己的值，不是画布色：浅色主题下侧栏变"奶白"、深色主题下变"更暗"，与 app 其它表面同一个方向。细线同理——正文色在浅色下是深的、深色下是浅的，插件不需要知道当前是哪套主题。
- 标题栏那 40px 也跟着上色：宿主布局里它和侧栏本来就是同一个填充，不上的话左边缘会在 y=40 处出现一道台阶。
- **macOS 有意排除。** `[data-platform=darwin]` 下宿主自己给了侧栏渐变与 `centerCol` 的 `border-left`，接缝本来就在，只有 Windows 的 chrome 缺这一条——这正是 `[data-windows-titlebar]` 标记的东西。
- 宿主的类名带构建哈希（`BynINW_sidebarCol`），所以选择器匹配**局部名**而不是哈希，并且只在本插件正在画图时（`data-dsh-lumen-active`）生效。宿主改名后这两条规则不再命中，画面回到加它们之前——这是唯一值得要的失败模式。
- 强度是 `PANEL_SCRIM`（34%）。太淡了看不出隔离（22% 在亮壁纸上仍读作一块发白的区域），太浓了就是一块板子压住照片（46% 已经把照片压成轮廓）；34% 加一条细线是两者之间的位置。



---

## 七、轮播调度

### 7.1 字段

```ts
interface Schedule {
	mode: "interval" | "hourly" | "daily" | "session";
	order: "sequential" | "shuffle" | "random";
	intervalMin: number;   // interval 模式：5 … 43200
	atMinutes: number[];   // hourly 模式：每小时的第 N 分钟，0 … 59，去重升序
	atTime: string;        // daily 模式：本地墙钟 "HH:MM"
	transitionMs: number;  // 交叉淡入，0 … 4000（0 = 瞬时）
	anchorAt: number;      // interval 模式的网格锚点（unix ms）
}
```

### 7.2 常量

| 常量 | 值 |
| --- | --- |
| `SCHEDULE_MODES` | `interval` · `hourly` · `daily` · `session` |
| `ORDER_MODES` | `sequential` · `shuffle` · `random` |
| `INTERVAL_MIN` / `INTERVAL_MAX` | 5 / 43200 分钟（5 分钟 … 30 天） |
| `TRANSITION_MIN` / `TRANSITION_MAX` | 0 / 4000 ms |
| `atMinutes` | 0 … 59，归一化时去重并升序 |
| `atTime` | `HH:MM`，经 `parseClock` / `formatClock` 往返 |

### 7.3 四种模式的下一次触发

| 模式 | `nextTriggerAt(schedule, now)` 的语义 |
| --- | --- |
| `interval` | `anchorAt + k × intervalMin`，取大于 `now` 的最小值。**网格锚定**，与刷新次数、上次触发时间无关 |
| `hourly` | 今天/明天中第一个满足"分钟 ∈ `atMinutes`"的时刻 |
| `daily` | 下一个 `atTime` 对应的本地墙钟时刻 |
| `session` | 与钟表无关。不由 `nextTriggerAt` 驱动，而是由可见性事件驱动 |

### 7.4 顺序策略

| 策略 | 行为 | `remaining` 队列 |
| --- | --- | --- |
| `sequential` | 下标 +1 循环 | 不使用 |
| `shuffle` | Fisher–Yates 洗出一轮，逐个出队，**走完一轮前不重复** | 使用 |
| `random` | 每步独立随机，由 `orderStep` 派生随机流 | 不使用 |

`orderRevision` 在顺序变化时自增，使旧洗牌队列作废——队列是用旧列表长度算的，列表增删后会指向不存在的下标。

### 7.5 追赶语义

`planResume(schedule, now, persistedNextAt)` 决定睡过一段之后怎么办，返回 `{ due, missed, nextAt }`：

- `session` 模式直接返回 `{ due: false, missed: 0, nextAt: 0 }`——它不由钟表驱动。
- 未武装（`persistedNextAt` 非有限值或 ≤ 0）时返回 `due: false`，只算出新的 `nextAt`。
- **尚未到期时保留持久化的那个时刻**（`nextAt: persistedNextAt`）——这样一次重新加载就不能把触发时间往后推。
- 已过期时 `missed` 按 `interval` 步长算出错过几轮，但采取的是**有损**策略：错过五个触发点只前进**一步**，不补播。补播会在用户眼前闪五张图、烧 CPU 去追一个只有最后一次才有意义的中间状态。

这一条是可断言的规则，不是定时器回调里的偶然行为——7 天跳变后 `missed > 100` 而游标**恰好前进 1**，见 `tests/preview.test.cjs`。

### 7.6 纯函数 API

调度模块全部是纯函数，浏览器半边只持有**一个**定时器：

| 函数 | 签名 |
| --- | --- |
| `normalizeSchedule` | `(unknown) → Schedule` |
| `nextTriggerAt` | `(schedule, now) → number` |
| `upcomingTriggers` | `(schedule, now, count) → number[]` |
| `planResume` | `(schedule, now, persistedNextAt) → { due, missed, nextAt }` |
| `stepCursor` | `(state) → state` |
| `reconcileCursor` | `(state) → state` |
| `orderRng` | `(state) → rng` |
| `parseClock` / `formatClock` | `"HH:MM" ↔ { h, m }` |

写成纯函数的理由很实际：调度器的难点全在边界情况（睡过触发点、时钟回拨、夏令时跳变、两张图的洗牌列表、播放列表清空），而**这些没有一个能通过 `setInterval` 诚实地测出来**。

---

## 八、状态

### 8.1 字段总表

持久化文档的字段列表是 `DOC_KEYS`，与 `State` 的字段列表**完全一致**（由 `tests/state.test.cjs` 断言，防止只在一侧加字段）。

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `mode` | `single` \| `rotation` | `single` | 单张 / 轮播 |
| `single` | `WallpaperItem` | `drift` | `single` 模式显示的那一张 |
| `playlist` | `WallpaperItem[]` | `[]` | 轮播序列，≤ 24 |
| `cursor` | number | `0` | 播放列表游标 |
| `remaining` | number[] | `[]` | 洗牌模式下剩余的队列 |
| `orderRevision` | number | `1` | 顺序变更计数，用于废弃旧队列 |
| `orderStep` | number | `0` | 单调递增，为 `random` 派生随机流 |
| `nextAt` | number | `0` | 下次触发的 unix ms；`0` 表示"未武装" |
| `paused` | boolean | `false` | 轮播暂停 |
| `wash` | `Wash` | 见第六节 | 洗色设置 |
| `tuning` | `Tuning` | `NEUTRAL_TUNING` | 三轴微调 |
| `schedule` | `Schedule` | 见下 | 调度配置 |
| `washTouched` | boolean | `false` | 用户是否曾手动调过洗色 |

调度默认值：

```json
{ "mode": "interval", "order": "sequential", "intervalMin": 30,
  "atMinutes": [0], "atTime": "07:30", "transitionMs": 1200, "anchorAt": 0 }
```

洗色默认值：

```json
{ "opacity": 0.82, "blur": 0, "fit": "cover", "position": "center",
  "autoDim": true, "readability": true }
```

### 8.2 归一化

所有到达状态模型的值都经过文本通道（磁盘 JSON、`localStorage`、或手工编辑），任何一个都可能是**过期的**（未来版本写入）、**截断的**或**有敌意的**（同源页面脚本写进同一份存储）。

所以归一化**只做一次**，在 `state.cjs` 里，而且每个字段是**钳进值域**而不是仅做类型检查：

> 读到一个透明度 `3.4`，这不是一个需要上报的错误，它是一个应当渲染为 `1.0` 的值。

`normalizeState` / `normalizeItem` / `normalizeWash` / `normalizeTuning` / `normalizeSchedule` / `normalizeHourlyMinutes` / `normalizeSeed` / `normalizeLuminance` 覆盖全部入口。**它们都不抛异常。**

`normalizeLuminance` 是唯一一个**按非数字即拒绝**而非钳值的归一化器：

| 输入 | 输出 | 理由 |
| --- | --- | --- |
| `0` … `1` 的有限数 | 保留，四舍五入到 3 位小数 | 真实测量 |
| 任何非 `number` | `null` | `Number(null)` 是 `0`，钳值会把"未测量"变成"纯黑" |
| `NaN` / `±Infinity` | `null` | 同样是"没有可用测量" |
| `< 0` / `> 1` | `null` | 真实测量不可能越界，越界说明数据被改过 |

这是"归一化一律钳值"这条规则的一个刻意例外，理由写在上面：对亮度来说，`0` 不是"很小"，而是"保护关闭"。把一个坏值钳到 `0` 会让可读性下限静默失效，而 `null` 会让它回退到中性常数——后者才是安全方向。

---

## 九、持久化格式

### 9.1 扁平字符串 map

`$DSH_HOME/lumen.json`（默认 `~/.dsh/lumen.json`）是一个**扁平 map，值一律是字符串**。

这不是风格偏好，是**跨版本共存的要求**：文件被所有解析到同一 `DSH_HOME` 的进程共享——Web profile 与桌面外壳可能同时在跑，甚至跑着不同版本的插件。若它是嵌套结构，旧版构建会把新版的嵌套对象读成 `"[object Object]"`，然后**把它当成一个偏好写回去**。扁平字符串 map 则退化成"一个不认识的键，忽略掉"。

### 9.2 键

| 键 | 值 |
| --- | --- |
| `schema` | 保留键，当前 `"1"`（`SCHEMA_KEY = "schema"`），客户端不允许写 |
| `mode` | `"single"` / `"rotation"` |
| `single` | 条目的 JSON |
| `playlist` | 条目数组的 JSON |
| `cursor` / `remaining` / `orderRevision` / `orderStep` / `nextAt` | 数字的字面量 |
| `paused` | `"true"` / `"false"` |
| `wash` / `tuning` / `schedule` | 对象的 JSON |
| `washTouched` | `"true"` / `"false"` |
| `blob:<id>` | 图片负载（data URL），每个条目一个键 |
| `splash.media` | 开屏媒体在 `$DSH_HOME/lumen-media/` 下的**文件名**。宿主生成、形状白名单校验，既不是路径也不是字节 |
| `dsh-lumen:schema-version` | **宿主保留键**，状态文件的 schema 版本（十进制整数字符串）。宿主在每次 `get` 之前剥掉它，浏览器既看不到也写不进去 |

浏览器种子里同一份 map 加前缀 `dsh-lumen:`（`SEED_PREFIX`，`SEED_VERSION = 1`）。

### 9.3 合并语义

`POST /lumen/api` 的 `set` 是**合并**而非替换：

| 补丁里的值 | 效果 |
| --- | --- |
| 字符串 | 设置该键 |
| `null` | 删除该键 |
| 键缺席 | 保持原值 |

插件因此只推送用户（或轮播引擎）**真正改动**的字段，并为消失的负载键推 `null`。这条很重要：一个曾被写入、现在已不存在的键**必须**删除，否则移除一条播放列表项会把它的图片字节永远留在磁盘上。

为什么不是整份文档替换：两个 DSH 窗口共享同一个 `$DSH_HOME/lumen.json`，只改了壁纸的那个窗口会把另一个窗口的洗色、微调和调度一起回滚掉。

### 9.4 接口

`/lumen/api`：

| 方法 | 语义 |
| --- | --- |
| `get` | 返回状态，**不含**保留键 |
| `ping` | 探活 |
| `set` | 合并一份补丁 |

`/lumen/splash`（同一套围栏，见 9.6）：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `POST` | `/lumen/splash/upload` | 把请求体当作媒体流写入 `lumen-media/`，并把 `splash.media` 指向它。`content-type` 必须在允许表内，否则 415 |
| `GET` / `HEAD` | `/lumen/splash/media` | 按 `Range` 流式送出当前媒体（200 / 206 / 304 / 416） |
| `POST` | `/lumen/splash/clear` | 忘记开屏并删除它的字节；重复调用返回 `cleared: false`，不是错误 |

`/lumen/wallpaper`（同一套围栏，见 9.6）：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` / `HEAD` | `/lumen/wallpaper/<name>.jpg` | 送出 `media/wallpapers/` 下的随包插画（200 / 304）。命中不了白名单一律 404，其他方法 405 |

**白名单是那个目录，不是一份副本。** 文件名在进程内读一次 `media/wallpapers/`、按 `^[a-z0-9-]+\.(jpg|jpeg|png|webp)$` 过滤成一张表；请求里的字符串只用来**查表**，不会被拼进任何路径。因此路径穿越在这里不是"被防住了"，而是**没有可以穿越的代码路径**。

`cache-control: no-cache` + `etag`（大小与 mtime 派生）而不是长 `max-age`：文件名不随画作更新而变，一个月的缓存会活过填满它的那个版本。校验成本是一次本地 `stat`。

### 9.5 上限

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `MAX_BODY_BYTES` | 24 MiB | 单次 JSON 请求体上限 |
| `MAX_STATE_BYTES` | 24 MiB | 整个状态文件上限，每次写入前校验 |
| `MAX_STATE_KEYS` | 64 | 键数量上限 |
| `MAX_IMAGE_CHARS` | 8388608 | 单个图片负载字符数 |
| `MAX_GRADIENT_CHARS` | 600 | 单条渐变字符串字符数 |
| `MAX_MEDIA_BYTES` | 512 MiB | 单次开屏媒体上传上限（媒体不进状态文件，所以与上面两个 24 MiB 无关） |

文件上限的意义是：客户端的一个 bug 若持续追加 blob 键，它会**在那一次写入上响亮地失败**，而不是把用户的家目录填满。

条目上的 `luminance` **不占新键**——它嵌在条目所在的 JSON 字段里（`single` / `playlist`），只有图片字节本身才各自占一个 blob 键。因此键数量与加入实测亮度之前完全一致：最坏情况 24 条播放列表 + 1 条 `single` = 25 个 blob 键，加 13 个 `DOC_KEYS` 与 schema 戳，仍在 `MAX_STATE_KEYS`（64）之内。`splash.media` 是第 14 个偏好键，仍在同一个上限内，因此**不抬 schema 版本**：新版写下的键，旧版读成"一个不认识的键，忽略掉"，这正是扁平字符串 map 要换来的性质。

### 9.6 路由围栏

三条路由前缀（`/lumen/api`、`/lumen/splash`、`/lumen/wallpaper`）过**同一道围栏，顺序固定三层**：

| 层 | 内容 | 缺失时 |
| --- | --- | --- |
| ① | 插件自己的校验器：`Host` 是回环地址（或 profile 里显式配置的可信 authority）**且**请求带同源浏览器标记 | 不可能缺失，恒定生效 |
| ② | 宿主提供的 `connection.requestRejection`：返回 `403`（宿主自己的 Host/Origin 围栏）、`401`（浏览器会话未通过）或 `undefined` | 退回①，并在**加载期**打一条告警 |
| ③ | 兜底语义 | —— |

两层语义上的刻意不对称：

- **②抛异常 = 拒绝，不是放行。** 检查者自己坏了就把门打开的围栏，不是围栏。
- **只有 `undefined` 放行。** 宿主自己的 `admit()` 也是拿 `void 0` 比较而非判 falsy，照抄这一点，可以让将来某个返回 `null` 的构建不至于在我们这边开门、在它那边关门。看不懂的返回值一律按拒绝处理。

②是**插件路由通往宿主浏览器鉴权的唯一桥梁**，所以只做①的围栏，即使和宿主在双方都看得见的每一处都一致，也严格弱于宿主的自有路由。

这是 **DNS rebinding / 跨站防御，不是鉴权**。写在这里是为了避免被误当成访问控制。

---

## 十、随机数

| 组件 | 实现 |
| --- | --- |
| 哈希 | **FNV-1a**（32 位），把 `seed` 字符串映成种子 |
| PRNG | **mulberry32**，返回 `[0,1)` |
| 洗牌 | **Fisher–Yates**，在 `rng.cjs` 的 `shuffled` 里 |

选 mulberry32 的理由是它小、快、无依赖，且**周期与分布对"挑一张壁纸"这个用途绰绰有余**——这里不需要密码学强度。它的确定性是功能的一部分：同一个种子必须永远给出同一张图。

---

## 十一、诊断快照

`window.__DSH_LUMEN__` 发布只读快照，供脚本与桌面工具读取：

| 字段 | 含义 |
| --- | --- |
| `plugin` / `build` / `schema` | `"dsh-lumen"` / `"1.2.1"` / `1` |
| `status` | `booting` · `ready` · `degraded` · `disposed` |
| `warnings` | `[dsh-lumen]` 前缀的告警行数组 |
| `health` | `{ hostAvailable, hostReason, lastError, hasStorage }` |
| `engine` | 引擎自省结果 |
| `mode` / `current` / `playlistLength` / `nextAt` | 当前状态摘要 |
| `publishedAt` | 快照时间 |

快照**只读**：改它不会影响插件状态。

---

## 十二、DOM 契约

引擎在页面上创建的节点，全部带 `data-dsh-lumen` 标记（`ACTIVE_ATTR`）：

| 标记 | 说明 |
| --- | --- |
| `root` | 根容器，`position: fixed; inset: 0; z-index: -1`，不接收指针事件 |
| `bleed` | 仅 `blur` 填充模式存在：放大且模糊的底图 |
| `slot-0` / `slot-1` | 交叉淡入的两个图层，任一时刻只有一个不透明 |
| `grain` | 颗粒层，`mix-blend-mode: overlay` |

样式表挂在 `dsh-lumen-style`（`STYLE_ID`）。

**两个槽位不常驻合成层。** 样式表里没有 `will-change: opacity`：那是一个让浏览器把元素单独提层的请求，而这两个元素是全屏的（一张视口大小的纹理按 RGBA 算是几十 MB），交叉淡入却只在换图时发生一次。改为在淡入开始前挂上、`transitionMs + 120ms` 之后撤掉（`armFadeHint` / `dropFadeHint`）；`instant` 渲染（启动首帧、主题切换、`prefers-reduced-motion`）根本不挂。首帧另有一条：**页面上还没有上一张图时，另一只槽位不写 `background-image`**——那次写只会让浏览器多栅格化一层同一张图片，而它此刻正被启动中的界面对着抢资源。

根节点的 `z-index: -1` 意味着它在应用**之前**绘制——所以它盖不住任何界面元素，也解释了为什么"画布必须半透明"是壁纸可见的前提（`--pg-bg` 那种预览工具条自己的底色只有在壁纸渲染失败时才会露出来）。

把它和开屏层放在一起看，这里有一处**刻意的两极**：壁纸取 `-1`（在文档之下），开屏取 `2147483647`（CSS 允许的最大值，在一切之上）。两者都不是随手填的数——壁纸要待在内容背后才叫壁纸，而开屏要盖住整个窗口、包括其它插件画在最上层的浮层（那个预算是公开的，见 [`SPLASH-SPEC.md`](SPLASH-SPEC.md) §6.6 与 §八）。而且这两个极端不会同时存在：开屏层在界面可用的那一刻就已经被移除了。

### 12.1 设置面板用到的类名

面板注入宿主自己的设置区，所以每个类都带 `lumen-` 前缀（`is-*` 状态修饰符只在复合选择器里出现）。导入与位置控制相关的部分：

| 类名 | 节点 | 说明 |
| --- | --- | --- |
| `lumen-file-input` | `<input type=file>` | `display:none`，由「选择文件」按钮间接触发；带 `multiple` |
| `lumen-row.is-drop` | 本地图片那一行 | 拖拽悬停高亮。用 `inset box-shadow` + 负外边距绘制，**不用真边框**——高亮时行会多出 2px 并回流，看起来像故障 |
| `lumen-grid9` | 位置控件的容器 | `role="group"`，`aria-label` 取自 `appearance.position` |
| `lumen-grid9-cell` | 9 个 `<button>` | 每格带 `data-value`（即 `WASH_POSITIONS` 之一）与 `aria-pressed`；选中格用 `::after` 画一个点，读作"主体锚在这里"而不是"按钮被按下" |

三处可访问性细节：九宫格没有可见文字（网格本身就是标签），所以九个位置各有一条**无障碍名称**词条（`position.*`，共 9 条）；按下状态同时写在 `aria-pressed` 上，只有 `is-on` 类对读屏软件不可见；拖拽高亮是纯装饰，不影响功能。

拖拽处理的 enter/leave 是**计数**而非开关切换：`dragleave` 在指针跨入子元素时也会触发，朴素的 enter-add / leave-remove 会让高亮在指针仍在目标内时闪烁。计数让它表达"指针还在这一片里"，也就是它看起来的意思。`dragover` 必须显式设 `dropEffect = "copy"`，否则浏览器报"不允许放置"，`drop` 根本不会触发。

---

## 十三、版本与兼容

- `schema` 当前为 `1`。归一化器接受未来版本的字段：不认识的键被忽略而不是报错，认识的键被钳进值域。
- 保留键 `schema` 由宿主维护，客户端 `set` 请求里携带它会被拒绝。
- 状态文件的扁平字符串结构是刻意的降级设计（见 9.1），跨插件版本读写安全。

**为什么加入 `wash.position` 与条目 `luminance` 没有抬 `schema` 版本。** 两者都是**纯增量**字段，且两侧都有定义良好的缺省：

| 缺省 | 结果 |
| --- | --- |
| 旧文档没有 `wash.position` | `normalizeWash` 补 `"center"`，与加这个字段之前的行为完全一致 |
| 旧文档的条目没有 `luminance` | `normalizeLuminance(undefined)` 是 `null`，引擎回退到中性常数——同样与之前一致 |

也就是说，一个由旧版本写下的文档被新版本读到，渲染结果与旧版本**逐像素相同**；反向（新文档被旧版本读）也只是丢掉这两个增量字段，`position` 退回居中、`luminance` 退回常数。同一条性质还让降级变得安全：卸载到旧版本不会让洗色或调度出问题。

**为什么删掉三套配方也没抬 `schema`。** `ref` 的含义没有变——它仍然是一个配方 id，缺省行为仍然是"不认识的 id 落到 `RECIPES[0]`"。`repairRecipeId` 只是把这个缺省做得更贴近原意（见 3.3）。旧版读新版文档时，`whale-*` 是它不认识的 id，于是显示 `drift`：不是崩溃，也不是空画布，而是一张仍然能看的壁纸。

---

相关文档：[README](../README.md) · [安装指引](INSTALL.md) · [创新点](INNOVATION.md)
