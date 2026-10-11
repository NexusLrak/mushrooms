# 蘑菇图鉴

一个可以按标签筛选的蘑菇图鉴网页，收录 104 种常见的食用菌、野生菌和毒菌。纯静态页面，没有依赖，下载后双击 `index.html` 即可使用。

> ⚠️ **本图鉴仅供认识和学习，不能作为采食依据。**
> 许多剧毒蘑菇与可食种类外观几乎相同，照片和文字描述不足以鉴定。标签为人工整理、未经专业审核，可能有错。不认识的野生菌一律不要吃。

## 功能

- 七类标签筛选：毒性、颜色、形状、区域、生境、季节、特征
- 同类标签之间为“或”，不同类之间为“且”；每个标签旁显示选中后的结果数
- 搜索中文名、别名、学名和描述
- 详情页含鉴别要点、百科摘要、原条目链接，每种最多 5 张可左右滑动的图片，逐张署名
- 详情页列出相似蘑菇并可直接跳转：优先显示人工整理的易混淆种（标“易混”），不足时按形状、颜色、生境相近程度补齐
- 地址栏带 `#m=amanita-muscaria` 这样的参数可以直接打开某个蘑菇
- 筛选状态保存在地址栏，可收藏或分享

## 文件说明

| 路径 | 作用 |
|---|---|
| `index.html` `style.css` `app.js` | 页面 |
| `data/mushrooms.js` | 页面读取的数据，由脚本生成，不要手改 |
| `images/` | 详情页大图（WebP，长边不超过 960 像素） |
| `images/thumb/` | 首页卡片用的缩略图 |
| `data/species.json` | 物种与标签的源文件，增改内容改这里 |
| `scripts/fetch.mjs` | 读取 `species.json`，补全百科摘要和图片，生成 `mushrooms.js` 与 `CREDITS.md` |
| `package.json` | 只声明抓取脚本用到的图片处理库 |

只展示的话需要前四行，不用安装任何东西；后面几行用于更新数据。

## 增改内容

需要 Node.js 20 或以上。首次使用先运行一次 `npm install`，安装把图片转成 WebP 用的 [sharp](https://sharp.pixelplumbing.com/)。

1. 编辑 `data/species.json`
2. 运行 `node scripts/fetch.mjs`

已有条目不会重新联网，只有新增的物种才会抓取。`node scripts/fetch.mjs --force` 会全部重新处理，为遵守维基百科和 iNaturalist 的访问频率限制，大约需要 15 分钟；下载过的原图缓存在 `scripts/.cache/`，不会重复下载。

一个条目的写法：

```json
{
  "latin": "Amanita muscaria",
  "zh": "毒蝇鹅膏",
  "alias": ["毒蝇伞", "蛤蟆菌"],
  "colors": ["红", "白"],
  "shape": "伞形",
  "regions": ["欧洲", "北美", "东北", "西北"],
  "tox": "有毒",
  "habitat": ["针叶林", "混交林"],
  "season": ["夏", "秋"],
  "traits": ["菌根", "致幻", "有菌环", "有菌托"],
  "note": "鉴别要点……"
}
```

`tox` 取 `可食用`、`慎食`、`不可食`、`有毒`、`剧毒` 之一。其余标签可以自由添加新的值，会自动出现在筛选栏。

可选字段：

| 字段 | 用途 |
|---|---|
| `"wiki": "金针菇"` | 指定中文维基条目标题，用于自动匹配不到或匹配错的情况 |
| `"lookalikes": ["Morchella esculenta"]` | 易混淆种的学名列表。写在任意一方即可，页面会双向显示 |
| `"imageFrom": "inaturalist"` | 不用维基的主图（例如主图是分布地图时），只从 iNaturalist 取图 |
| `"image": "custom/xx.jpg"` | 把自备图片排在第一张（路径相对项目根目录，不要放在 `images/` 里）。请同时填写 `"credit": {"author": "", "license": "", "url": ""}`，并确认你有权使用该图片 |

## 数据来源与许可

- **百科摘要**来自[中文维基百科](https://zh.wikipedia.org/)，以 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans) 许可使用，各条目的原文链接见详情页。
- **图片**来自[维基共享资源](https://commons.wikimedia.org/)和 [iNaturalist](https://www.inaturalist.org/)，版权归各自作者所有，按各自的许可使用，经过缩小并转换为 WebP 格式，逐张署名见 [CREDITS.md](CREDITS.md)。每种的第一张是维基百科条目的主图，其余来自 iNaturalist 的物种相册，未经逐张人工筛选。其中多数图片为“非商业性使用”许可（CC BY-NC），**不能直接商用**。
- **标签和鉴别要点**为本项目整理。
