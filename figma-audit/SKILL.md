# Figma 组件库走查插件 — 自动生成技能 (Skill)

## 目标

拿到任意内部 Figma 组件库的 **文件 ID** 和 **Access Token**，执行本 Skill，AI 将自动：

1. 从 Figma 提取组件指纹
2. 分析组件集命名规律
3. 生成 `library-config.json`（库特定配置）
4. 构建完整可用的走查插件（`code.js` + `manifest.json`）

---

## 必读：项目架构

```
figma-audit/
├── library-config.json          ← 【唯一需要定制的文件】库特定业务配置
├── library_fingerprints.json    ← sync_library.js 输出，组件视觉指纹数据库
├── sync_library.js              ← 从 Figma API 提取组件 DNA，读 library-config.json 的分类规则
├── config.json                  ← Figma Access Token + Library File Key（敏感，不提交 git）
├── figma-plugin/
│   ├── build.js                 ← 构建脚本，从 library-config.json 读取文案/阈值/豁免规则，生成 code.js
│   ├── code.template.js         ← 插件主逻辑（通用引擎，不改）
│   ├── ui.template.html         ← 插件 UI（通用，不改）
│   ├── code.js                  ← build.js 输出，上传 Figma 使用的最终文件
│   └── manifest.json            ← build.js 自动更新
└── SKILL.md                     ← 本文件
```

### 数据流

```
Figma API
    ↓  sync_library.js（读 library-config.json 的 classification.rules）
library_fingerprints.json
    ↓  build.js（读 library-config.json 的 messages/thresholds/exemptions）
code.js（内嵌指纹 + 配置）
    ↓  设计师在 Figma 中 Relaunch 插件
走查结果
```

---

## 分步操作指令

### Step 0：确认前提条件

在开始之前，向用户确认以下两项：

1. **Figma Access Token**：Personal Access Token，需要有 `File content` 读权限
2. **Library File Key**：组件库文件 URL 中 `/design/XXXX/` 的那段字符串

执行以下命令验证 `config.json` 是否已配置：

```bash
cat figma-audit/config.json
```

若文件不存在或字段为空，创建/更新它：

```json
{
  "figmaToken": "figd_YOUR_TOKEN_HERE",
  "libraryFileKey": "XXXXXXXXXXXXXXXXXX"
}
```

---

### Step 1：运行 sync_library.js 提取组件指纹

```bash
cd figma-audit
node sync_library.js
```

**预期输出**：
- 控制台打印 `✅ 完成！指纹文件已保存`，显示样式数和组件数
- 生成 `library_fingerprints.json`

**如果失败**：
- `401 Unauthorized`：Token 无效或权限不足
- `404 Not Found`：File Key 错误
- 其他网络错误：检查代理/VPN 设置

---

### Step 2：分析组件集命名，生成 classification.rules

读取刚生成的指纹文件，提取所有 `componentSetName`（或 `name`）的唯一值列表：

```bash
node -e "
const d = JSON.parse(require('fs').readFileSync('library_fingerprints.json','utf8'));
const names = [...new Set(Object.values(d.components_registry).map(c => c.componentSetName || c.name))];
names.sort().forEach(n => console.log(n));
" 2>/dev/null | head -100
```

**分析规则（AI 决策树）**：

拿到组件集名称列表后，按以下逻辑归类：

| 关键词特征 | 建议 category |
|---|---|
| 包含"底部导航"、"StatusBar"、"HomeIndicator"、纯数字px开头（如"12px/"）、"emoji"、"logo"、"插画"/"illustration"、"封面"、"空态"/"空页"/"EmptyState"、系统键盘 | `exclude` |
| 包含"倒计时" | `countdown` |
| 包含"评分" | `rating` |
| 包含"货币"/"金额"（且不含"输入"） | `currency` |
| 包含"输入" | `input` |
| 包含"开关"/"Switch" | `switch` |
| 包含"进度"/"Progress" | `progress` |
| 包含"导航"（不含"底部"） | `nav_top` |
| 包含"Tab栏"/"TabBar"/"一级Tab"/"二级Tab" | `tab` |
| 包含"Toast" | `toast` |
| 包含"弹窗"/"Dialog"/"Modal" | `dialog` |
| 包含"券"（排在 dialog 之后）| `coupon` |
| 包含"头像"/"Avatar" | `avatar` |
| 包含"悬浮提示"/"气泡菜单"/"Tooltip" | `tooltip` |
| 包含"按钮" | `button` |
| 包含"Tag"/"标签" | `tag` |
| 包含"卡片"/"Card" | `card` |
| 其余 | `generic`（defaultCategory） |

> **注意**：规则按顺序匹配，`exclude` 类排在最前以保证优先生效。同一组件集可能同时含多个关键词（如"气泡标签"），必须靠规则顺序决定最终类别。

---

### Step 3：识别豁免组件，生成 exemptions

同样基于组件集名称列表，识别以下两类特殊组件：

**couponPatterns**（颜色豁免组件）：
- 名称中含有优惠/促销相关词的组件，如：券、coupon、红包、优惠、满减、折扣、立减、积分、会员卡
- 这类组件颜色是业务定制色，不做颜色样式绑定检查

**systemPatterns**（完全豁免组件）：
- 名称中含有系统UI相关词的组件，如：状态栏、StatusBar、键盘、Keyboard、灵动岛、HomeIndicator、SafeArea、System
- 这类组件豁免所有走查项

**checkoutLexicon**（结算栏词表）：
- 该库设计稿中，结算/购物车相关的文案关键词
- 用于区分"结算条"（不做按钮匹配）和普通组件
- 默认：购买、下单、结算、去结算、凑单、合计、立即购买、购物车

**promoLexicon**（促销条词表）：
- 该库设计稿中，促销进度相关的文案关键词
- 用于识别凑单进度条类组件（不做按钮匹配）
- 默认：满、减、折、省、特价、秒杀、限时

---

### Step 4：填写 messages 和 thresholds

**messages**：根据库名（如"抖音商城设计语言 2.0"）填写：

```json
{
  "pluginTitle": "{库名} 组件规范走查",
  "nonLibraryLocal": "使用了本地组件（非共享库）。请替换为 {库名} 规范组件",
  "nonLibraryRemote": "使用了其他组件库的组件（非 {库名}）。请替换为规范组件",
  "iconPrimitiveSuggest": "请用资源库中的 ic_* 图标组件（Instance）整体替换，删除 Vector/Union 等碎图层",
  "textStyleHighSuggest": "请在右侧文本属性面板选择 {库名} 对应的字体样式"
}
```

其余 messages 字段用默认值即可（已有内置兜底）。

**thresholds**：默认值适合大多数库，通常不需要改：

```json
{
  "match": 55,
  "confHigh": 75,
  "confMid": 62,
  "nonLibMatch": 82
}
```

若该库组件数量少（<500 变体），可适当降低 `match` 到 45，提高召回率。

---

### Step 5：写出 library-config.json

把 Step 2～4 的分析结果写入 `figma-audit/library-config.json`。

文件完整结构参考：

```json
{
  "libraryName": "YOUR_LIBRARY_NAME",

  "classification": {
    "rules": [
      { "pattern": "底部导航",               "category": "exclude" },
      { "pattern": "status\\s*bar",           "category": "exclude", "flags": "i" },
      // ... 更多 exclude 规则 ...
      { "pattern": "按钮",                    "category": "button" },
      { "pattern": "tag|标签",                "category": "tag", "flags": "i" },
      { "pattern": "卡片|card",               "category": "card", "flags": "i" }
    ],
    "defaultCategory": "generic"
  },

  "exemptions": {
    "couponPatterns":  ["券", "coupon", "红包", "优惠"],
    "systemPatterns":  ["状态栏", "status.?bar", "键盘", "keyboard", "灵动岛"],
    "checkoutLexicon": ["结算", "购物车", "合计", "立即购买"],
    "promoLexicon":    ["满", "减", "折", "省", "特价", "秒杀"]
  },

  "messages": {
    "pluginTitle": "YOUR_LIBRARY_NAME 组件规范走查",
    "nonLibraryLocal": "使用了本地组件（非共享库）。请替换为 YOUR_LIBRARY_NAME 规范组件",
    "nonLibraryRemote": "使用了其他组件库的组件（非 YOUR_LIBRARY_NAME）。请替换为规范组件",
    "textStyleHighSuggest": "请在右侧文本属性面板选择 YOUR_LIBRARY_NAME 对应的字体样式"
  },

  "thresholds": {
    "match": 55,
    "confHigh": 75,
    "confMid": 62,
    "nonLibMatch": 82
  }
}
```

---

### Step 6：构建插件

```bash
cd figma-audit/figma-plugin
node build.js
```

**验证构建结果**：

1. 控制台输出 `✅ 构建完成`
2. 组件指纹数量合理（通常 300～5000 个变体；若 <100 说明分类规则过于激进，需检查 exclude 规则）
3. 类别分布中 `exclude` 比例通常在 20%～50%；若 >80% 说明规则过滤太多
4. `code.js` 大小通常 400KB～1.5MB

**常见问题**：

| 现象 | 原因 | 解决 |
|---|---|---|
| 变体数 <50 | classification.rules 中 exclude 规则太宽泛 | 缩窄 exclude pattern |
| 变体数 >5000 | exclude 规则不足，保留了大量装饰性/页面级组件 | 补充 exclude pattern |
| build 报错 "Cannot find library_fingerprints.json" | Step 1 未执行或失败 | 重新执行 `node sync_library.js` |

---

### Step 7：交付

构建成功后，告知用户：

1. **插件文件**：`figma-plugin/code.js` 已更新
2. **安装方式**：在 Figma Desktop 中，进入 Plugins → Development → Import plugin from manifest，选择 `figma-audit/figma-plugin/manifest.json`
3. **远端数据**（可选）：若配置了 `fingerprintUrl`，将 `fingerprints_slim.json` 上传到对应 URL，设计师无需重新安装插件即可获取最新指纹

---

## 注意事项

- `scoreMatch()` 权重体系和 `CATEGORY_VETO` 是通用引擎的一部分，**不在 library-config.json 中配置**，无需修改
- `config.json`（含 Token）**不提交 git**，已在 `.gitignore` 中排除
- 本 Skill 执行完后，后续每次更新组件库只需重新执行 `node sync_library.js` 和 `node build.js`，无需再次生成 `library-config.json`
- 若组件库有重大改版（组件集命名规律变化），需重新执行本 Skill 的 Step 2～5 更新分类规则
