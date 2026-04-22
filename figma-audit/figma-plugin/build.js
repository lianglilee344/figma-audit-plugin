/**
 * build.js — 插件构建脚本
 *
 * 打包内容：
 *   1. library_fingerprints.json（指纹，备用）
 *   2. detection_rules.json（本地规则）
 *   3. ../reports/*.json（AI 审计结果，按 fileId 索引）← 核心
 *   4. ui.template.html（内联进 code.js）
 *
 * 用法：
 *   cd figma-plugin && node build.js
 *
 * 每次运行审计脚本后重新 build，设计师 Relaunch 插件即可看到最新结果。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 读取 config.json（可选）──────────────────────────────────────────────
let projectConfig = {};
try {
  projectConfig = JSON.parse(readFileSync(resolve(__dirname, '..', 'config.json'), 'utf-8'));
} catch (e) {}
const FINGERPRINT_URL = (projectConfig.fingerprintUrl || '').trim();

// ─── 读取 library-config.json（可选，不存在则用硬编码默认值）─────────────
let LIBRARY_CONFIG = null;
try {
  const libCfgPath = resolve(__dirname, '..', 'library-config.json');
  if (existsSync(libCfgPath)) {
    LIBRARY_CONFIG = JSON.parse(readFileSync(libCfgPath, 'utf-8'));
  }
} catch (e) {
  console.warn('⚠️  library-config.json 读取失败，使用内置默认文案。', e.message);
}

// 从 library-config.json 合并或回退到硬编码值
function lcMsg(key, fallback) {
  return (LIBRARY_CONFIG && LIBRARY_CONFIG.messages && LIBRARY_CONFIG.messages[key] != null)
    ? LIBRARY_CONFIG.messages[key] : fallback;
}
function lcThreshold(key, fallback) {
  return (LIBRARY_CONFIG && LIBRARY_CONFIG.thresholds && LIBRARY_CONFIG.thresholds[key] != null)
    ? LIBRARY_CONFIG.thresholds[key] : fallback;
}
function lcTextStyleRules(fallback) {
  return (LIBRARY_CONFIG && Array.isArray(LIBRARY_CONFIG.textStyleRules) && LIBRARY_CONFIG.textStyleRules.length > 0)
    ? LIBRARY_CONFIG.textStyleRules : fallback;
}
function lcExemptions(key, fallback) {
  return (LIBRARY_CONFIG && LIBRARY_CONFIG.exemptions && Array.isArray(LIBRARY_CONFIG.exemptions[key]))
    ? LIBRARY_CONFIG.exemptions[key] : fallback;
}

// ─── 1. 指纹库（保留所有变体 + 视觉维度） ─────────────────────────────────
const raw  = readFileSync(resolve(__dirname, '..', 'library_fingerprints.json'), 'utf-8');
const data = JSON.parse(raw);
const registry = data.components_registry || {};

// 类别分桶统计
const catCounts = {};
const variants = [];
for (const entry of Object.values(registry)) {
  const groupName = entry.componentSetName || entry.name;
  const cat = entry.category || 'generic';
  catCounts[cat] = (catCounts[cat] || 0) + 1;

  // 硬排除
  if (cat === 'exclude') continue;
  // 纯装饰/无尺寸的跳过
  if (!entry.width || !entry.height) continue;
  // 太小的 icon 级组件跳过
  if (entry.width < 16 && entry.height < 16) continue;

  variants.push({
    g: groupName,                              // 组名
    n: entry.name || '',                       // 变体名
    cat,                                       // 类别标签
    w: entry.width, h: entry.height,
    ar: entry.aspectRatio ?? null,
    cr: entry.cornerRadius ?? null,
    crR: entry.cornerRatio ?? null,            // 圆角/min(w,h)
    hF: entry.hasFill ? 1 : 0,
    hS: entry.hasStroke ? 1 : 0,
    hG: entry.hasGradient ? 1 : 0,
    hSh: entry.hasShadow ? 1 : 0,
    col: entry.dominantColor || null,          // red/blue/gray/...
    ft: entry.fillType || null,                // SOLID / GRADIENT_* / null
    sw: entry.strokeWeight ?? null,
    lm: entry.layoutMode || null,              // HORIZONTAL / VERTICAL / null
    lc: entry.layerCount ?? 0,
    cs: entry.childSigStr || '',               // T1-I1 等
    cTxt: entry.childSig?.text ?? 0,
    cIcn: entry.childSig?.icon ?? 0,
    cImg: entry.childSig?.image ?? 0,
    cIns: entry.childSig?.instance ?? 0,
    pT: entry.paddingTop ?? null, pB: entry.paddingBottom ?? null,
    pL: entry.paddingLeft ?? null, pR: entry.paddingRight ?? null,
    sp: entry.itemSpacing ?? null,
    fs: entry.firstText?.fontSize ?? null,
    fw: entry.firstText?.fontWeight ?? null,
  });
}

// 颜色样式列表（去重，与 match.js 一致：仅用非 S: 键，避免重复）
const styleFills = [];
const seenFillName = {};
for (const [k, v] of Object.entries(data.styles_registry || {})) {
  if (String(k).indexOf('S:') === 0) continue;
  if (!v || v.styleType !== 'FILL' || !v.color || v.color.r == null) continue;
  const nm = v.name || '';
  if (seenFillName[nm]) continue;
  seenFillName[nm] = 1;
  styleFills.push({
    name: nm,
    r: v.color.r,
    g: v.color.g,
    b: v.color.b,
    a: v.color.a != null ? v.color.a : 1,
  });
}

// 所有库组件的全局 key 集合（供插件校验 mainComponent.key）
const libraryComponentKeys = [];
for (const entry of Object.values(registry)) {
  if (entry.key) libraryComponentKeys.push(entry.key);
}

const slim = {
  variants,
  styleFills,
  libraryComponentKeys,          // 用于精确判断 INSTANCE 是否来自本库
  generated_at: data.generated_at || new Date().toISOString(),

  // ─── 远端可调参数（修改后上传 fingerprints_slim.json 即可生效，无需重新发布插件）
  // 完整 config schema 见 docs/remote-config.md
  config: {
    schemaVersion: 2,

    // ─── 豁免规则（从 library-config.json 读取，运行时注入插件）────────
    exemptions: {
      couponPatterns:  lcExemptions('couponPatterns',  ['券', 'coupon', 'red.?pack', '红包', '优惠', '满减', '折扣', '立减']),
      systemPatterns:  lcExemptions('systemPatterns',  ['状态栏', 'status.?bar', '键盘', 'keyboard', '灵动岛', 'home.?indicator', 'safe.?area']),
      checkoutLexicon: lcExemptions('checkoutLexicon', ['结算', '购物车', '合计', '立即购买']),
      promoLexicon:    lcExemptions('promoLexicon',    ['满', '减', '折', '省', '特价', '秒杀', '限时']),
    },

    // ─── 功能总开关（任何一项置 false 即禁用该检测）─────────────────────
    features: {
      checkComponent: true,    // 组件匹配建议
      checkNonLibrary: true,   // 非规范组件（非库 INSTANCE）
      checkIcon: true,         // 手绘图标检测
      checkTextStyle: true,    // 文字样式绑定
      checkColorStyle: true,   // 颜色样式绑定
      checkMargin: true,       // 栅格边距建议
      checkLayout: true,       // 布局清洁度建议
    },

    // ─── 置信度 / 阈值（优先读 library-config.json）──────────────────
    thresholds: {
      match:       lcThreshold('match',       55),
      confHigh:    lcThreshold('confHigh',    75),
      confMid:     lcThreshold('confMid',     62),
      nonLibMatch: lcThreshold('nonLibMatch', 82),
    },

    // ─── 节点跳过规则 ──────────────────────────────────────────────────
    skipRules: {
      namePrefixes: ['_'],                          // 以这些字符开头的节点跳过
      annotationPatterns: [                         // 节点名含这些关键词（不区分大小写）则跳过
        '文档信息', '设计说明', '标注', '备注', '注释', '说明卡',
        'annotation', 'notes', 'redline', '走查',
      ],
    },

    // ─── 遍历参数 ──────────────────────────────────────────────────────
    traversal: {
      maxDepth: 12,                                  // 候选池收集最大深度
      fullscreenMin: [360, 600],                     // 宽高同时 ≥ 视为整页，不做组件匹配
      minSize: 12,                                   // 尺寸小于此值视为过小，跳过
      maxVisibleDescendants: 12,                     // 可见后代数超过此数 → 判定为复杂图形
    },

    // ─── Logo / 应用图标豁免规则 ───────────────────────────────────────
    logoRules: {
      vectorTypes: ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON'],
      baseTypes: ['RECTANGLE', 'ELLIPSE'],
      forbiddenTypes: ['TEXT', 'INSTANCE'],
      minVectors: 3,
      maxDepth: 6,
    },

    // ─── 手绘图标检测 ──────────────────────────────────────────────────
    iconRules: {
      sizeRange: [14, 32],                           // [min, max] px
      aspectRange: [0.4, 2.5],                       // 宽高比范围
      minPrimitives: 2,                              // 多图层图标最少几何图形数
      defaultNameMaxSize: 56,                        // 单图层默认命名时的尺寸上限
      mergedVectorMinSegments: 10,                   // VECTOR 合并路径最少段数
      mergedVectorMinVertices: 14,                   // VECTOR 合并路径最少顶点数
      colorChannelTolerance: 0.08,                   // SOLID fill 视为"灰阶"的通道差阈值
      whiteThreshold: 0.95,                          // r/g/b 均 > 此值视为纯白
    },

    // ─── 非库组件检测 ──────────────────────────────────────────────────
    nonLibraryRules: {
      maxHeight: 300,                                // INSTANCE 高度超过此值 → 跳过
      skipDetached: true,                            // Detached 实例直接跳过（无法判断来源）
    },

    // ─── 文字样式规则（优先读 library-config.json）─────────────────────
    textStyleRules: lcTextStyleRules([
      { fontFamilyContains: ['pingfang sc'], maxFontSize: 32,   score: 90, messageKey: 'textStyleHigh', mixedMessageKey: 'textStyleHighMixed' },
      { fontFamilyContains: ['pingfang sc'], maxFontSize: null, score: 72, messageKey: 'textStyleMid',  mixedMessageKey: 'textStyleMidMixed'  },
    ]),

    // ─── 颜色样式检测 ──────────────────────────────────────────────────
    colorRules: {
      exactDeltaRGB: 5,
      exactDeltaAlpha: 0.03,
      nearDeltaRGB: 20,
      nearDeltaAlpha: 0.05,
      exactScore: 95,
      nearScore: 75,
      rawScore: 50,
      minArea: 6,                                    // 几何填充色最小面积（宽×高）
      suggestMaxCount: 3,                            // 最多显示几个一级名称建议
    },

    // ─── 栅格 / 布局检测 ───────────────────────────────────────────────
    layoutRules: {
      screenWidthRange: [320, 430],                  // 屏幕 Frame 的宽度范围
      screenMinHeight: 400,
      validMargins: [0, 8, 12, 16, 20],
      marginMaxGap: 22,
      layoutMaxDepth: 16,                            // 布局清洁度检测递归深度
    },

    // ─── 用户可见文案（优先读 library-config.json，回退到内置值）───────
    messages: {
      nonLibraryLocal:       lcMsg('nonLibraryLocal',       '使用了本地组件（非共享库）。请替换为规范组件'),
      nonLibraryRemote:      lcMsg('nonLibraryRemote',      '使用了其他组件库的组件。请替换为规范组件'),
      iconPrimitive:         lcMsg('iconPrimitive',         '检测到手绘矢量图标（约 {n} 个几何图层），未使用 Icon 组件'),
      iconPrimitiveSuggest:  lcMsg('iconPrimitiveSuggest',  '请用资源库中的图标组件（Instance）整体替换，删除 Vector/Union 等碎图层'),
      iconMerged:            lcMsg('iconMerged',            '检测到疑似手绘图标（{hint}），未使用 Icon 组件'),
      iconMergedSuggest:     lcMsg('iconMergedSuggest',     '请用资源库图标组件（Instance）替换'),
      iconHintComplex:       lcMsg('iconHintComplex',       '单图层但路径复杂（多为合并路径）'),
      iconHintDefault:       lcMsg('iconHintDefault',       '单图层且为默认矢量命名'),
      textStyleHigh:         lcMsg('textStyleHigh',         '{size}px 文字必须绑定设计系统字体样式（未绑定 Text Style）'),
      textStyleHighMixed:    lcMsg('textStyleHighMixed',    '{size}px 文字存在混合样式（部分字符未绑定 Text Style）'),
      textStyleHighSuggest:  lcMsg('textStyleHighSuggest',  '请在右侧文本属性面板选择对应的字体样式'),
      textStyleMid:          lcMsg('textStyleMid',          '文字未绑定全局 Text Style'),
      textStyleMidMixed:     lcMsg('textStyleMidMixed',     '文字存在混合样式（部分字符未绑定 Text Style）'),
      textStyleMidSuggest:   lcMsg('textStyleMidSuggest',   '请在文本属性中选择设计系统文字样式'),
      colorExact:            lcMsg('colorExact',            '填充使用裸色，但与样式库颜色一致，请改为颜色样式'),
      colorNear:             lcMsg('colorNear',             '填充使用裸色，与样式库某颜色接近，建议使用颜色样式'),
      colorRaw:              lcMsg('colorRaw',              '背景/容器使用自定义裸色（未命中样式库），请确认是否符合规范'),
      marginInvalid:         lcMsg('marginInvalid',         '{side}边距 {actual}px 不符合栅格规范（应为 {valid}）'),
      marginSideLeft:        lcMsg('marginSideLeft',        '左'),
      marginSideRight:       lcMsg('marginSideRight',       '右'),
      layoutEmpty:           lcMsg('layoutEmpty',           '空 {type}（无可见子元素），建议删除或确认是否遗留'),
      layoutRedundant:       lcMsg('layoutRedundant',       'Frame 只包含一个 {childType} 且自身无视觉属性（无填充/描边/阴影/圆角），建议合并或删除上层容器'),
    },

    // ─── UI 侧文案（优先读 library-config.json）──────────────────────
    uiMessages: {
      title:              lcMsg('pluginTitle',        '组件规范走查'),
      btnScan:            lcMsg('btnScan',            '扫描'),
      btnScanning:        lcMsg('btnScanning',        '扫描中...'),
      btnRescan:          lcMsg('btnRescan',          '重新扫描'),
      scanningPlaceholder:lcMsg('scanningPlaceholder','正在扫描...'),
      emptyLayout:        lcMsg('emptyLayout',        '未发现布局问题'),
      emptyNone:          lcMsg('emptyNone',          '未发现问题'),
      labelNonCompliant:  lcMsg('labelNonCompliant',  '非规范组件'),
      labelStandard:      lcMsg('labelStandard',      '规范'),
      labelSuggest:       lcMsg('labelSuggest',       '建议'),
      locateBtn:          lcMsg('locateBtn',          '定位 ↗'),
    },
  },
};

// ─── 2. 检测规则 ──────────────────────────────────────────────────────────
let rulesData = { rules: [] };
try {
  rulesData = JSON.parse(readFileSync(resolve(__dirname, 'detection_rules.json'), 'utf-8'));
} catch (e) {}

// ─── 3. 构建 code.js ──────────────────────────────────────────────────────
const UI_TEMPLATE   = resolve(__dirname, 'ui.template.html');
const CODE_TEMPLATE = resolve(__dirname, 'code.template.js');
const CODE_OUT      = resolve(__dirname, 'code.js');

let uiHtml = readFileSync(UI_TEMPLATE, 'utf-8');
uiHtml = uiHtml.replace('/* RULES_INJECT */', `var DETECTION_RULES_DATA = ${JSON.stringify(rulesData)};`);
uiHtml = uiHtml.replace('/* AUDIT_INJECT */', '');
// 注入远端指纹 URL（空字符串表示仅用内嵌数据）
uiHtml = uiHtml.replace('/* FINGERPRINT_URL_INJECT */', FINGERPRINT_URL);

const codeTemplate = readFileSync(CODE_TEMPLATE, 'utf-8');
const injected = codeTemplate
  .replace('/* FINGERPRINTS_INJECT */', `const FINGERPRINTS_DATA = ${JSON.stringify(slim)};`)
  .replace('__html__', `/* @inline-ui */ ${JSON.stringify(uiHtml)}`);

writeFileSync(CODE_OUT, injected, 'utf-8');

// ─── 同时输出 ui-dev.html（本地预览用，含 Mock 演示数据）─────────────────
const MOCK_SCRIPT = `
<!-- ══════════ 本地预览 Mock 模式（非 Figma 环境自动激活）══════════ -->
<script>
(function () {
  if (window.parent !== window) return;
  window.addEventListener('load', function () {
    // 模拟 init，跳过远端加载（直接设空指纹库）
    window.dispatchEvent(new MessageEvent('message', {
      data: { pluginMessage: { type: 'init', fingerprints: { variants: [], config: {} }, pageName: 'Mock 页面' } }
    }));

    setTimeout(function () {
      var scope = document.getElementById('scopeEl') || document.querySelector('[id$="cope"]');

      // ── Tab1: 组件匹配 ──────────────────────────────────────────────
      ALL = [
        { id:'n1', name:'自定义圆形按钮', breadcrumb:['猜你喜欢卡','操作区','自定义圆形按钮'], size:'80×36',
          suggestion:'主按钮 / Primary-MD', score:92, kind:'component-match' },
        { id:'n2', name:'标签容器',       breadcrumb:['猜你喜欢卡','标签区','标签容器'],       size:'48×20',
          suggestion:'标签 / 默认-SM',    score:74, kind:'component-match' },
        { id:'n3', name:'Vector 图形',    breadcrumb:['猜你喜欢卡','图标区','Vector'],         size:'20×20',
          suggestion:'图标 / heart-filled', score:85, kind:'icon-primitive',
          detail:'手绘矢量图形，建议替换为图标组件' },
        { id:'n4', name:'旧版徽章',       breadcrumb:['猜你喜欢卡','旧版徽章'],               size:'32×16',
          suggestion:'徽章 / 红色-SM',   score:68, kind:'non-library-instance',
          detail:'使用了非当前规范组件库的实例' },
      ];

      // ── Tab2: 文字 / 颜色样式 ───────────────────────────────────────
      STYLE_ALL = [
        { id:'s1', name:'商品标题', kind:'text-style',
          detail:'字号14px、行高22px，未绑定样式，建议使用"正文/Body-MD-粗体"',
          suggest:'正文/Body-MD-粗体', score:88, breadcrumb:['猜你喜欢卡','内容区','商品标题'] },
        { id:'s2', name:'价格文本', kind:'fill-color',
          detail:'颜色 #FF3B30 未绑定颜色样式，建议使用"语义/错误色"',
          suggest:'语义/错误色', score:82, breadcrumb:['猜你喜欢卡','价格区','价格文本'] },
        { id:'s3', name:'副标题',   kind:'text-style',
          detail:'字号12px、灰色，建议使用"辅助/Caption-MD"样式',
          suggest:'辅助/Caption-MD', score:71, breadcrumb:['猜你喜欢卡','内容区','副标题'] },
      ];

      // ── Tab3: 布局建议 ───────────────────────────────────────────────
      LAYOUT_HINTS = [
        { id:'l1', name:'空容器',   kind:'layout-hint', subkind:'empty',
          detail:'该容器无任何子元素，可以考虑删除',
          breadcrumb:['猜你喜欢卡','空容器'], size:'320×0' },
        { id:'l2', name:'外层包裹', kind:'layout-hint', subkind:'redundant-wrap',
          detail:'只有一个子元素且无样式，建议去掉这层无意义嵌套',
          breadcrumb:['猜你喜欢卡','外层包裹'], size:'200×48' },
        { id:'l3', name:'卡片容器', kind:'margin-hint',
          detail:'左右边距不一致（左16px, 右24px），建议统一为16px',
          breadcrumb:['猜你喜欢卡','卡片容器'], size:'375×120' },
      ];

      // ── 显示统计 & 渲染 ──────────────────────────────────────────────
      var statsEl  = document.getElementById('statsEl')   || document.querySelector('.stats');
      var mainTabsEl = document.getElementById('mainTabs');
      var filtersEl  = document.getElementById('filtersEl') || document.querySelector('.filters');
      var scopeEl  = document.getElementById('scopeEl');
      if (statsEl)    statsEl.style.display    = 'block';
      if (mainTabsEl) mainTabsEl.style.display = 'flex';
      if (filtersEl)  filtersEl.style.display  = 'flex';
      if (scopeEl)    scopeEl.textContent = '已扫描：猜你喜欢AI导购卡（Mock 演示数据）';
      if (typeof updateGlobalStats === 'function') updateGlobalStats();
      if (typeof renderResults     === 'function') renderResults();

      var btnScan   = document.getElementById('btnScan');
      var statusBar = document.getElementById('statusBar');
      if (btnScan)   { btnScan.disabled = false; btnScan.textContent = '🔍 重新检查'; }
      if (statusBar) { statusBar.className = 'status-bar'; statusBar.textContent = '「猜你喜欢AI导购卡」检查完成 — 发现 7 个问题（Mock 演示）'; }
    }, 400);
  });
})();
</script>`;

const DEV_OUT = resolve(__dirname, 'ui-dev.html');
writeFileSync(DEV_OUT, uiHtml.replace('</body>', MOCK_SCRIPT + '\n</body>'), 'utf-8');

// ─── 同时输出 fingerprints_slim.json（供远端托管使用）────────────────────
const SLIM_OUT = resolve(__dirname, '..', 'fingerprints_slim.json');
writeFileSync(SLIM_OUT, JSON.stringify(slim), 'utf-8');

// ─── 自动更新 manifest.json 的 networkAccess ─────────────────────────────
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
const FONT_DOMAINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
if (FINGERPRINT_URL) {
  try {
    const urlObj = new URL(FINGERPRINT_URL);
    const origin = urlObj.origin;
    manifest.networkAccess = { allowedDomains: [origin, ...FONT_DOMAINS] };
  } catch (e) {
    manifest.networkAccess = { allowedDomains: [...FONT_DOMAINS] };
  }
} else {
  manifest.networkAccess = { allowedDomains: [...FONT_DOMAINS] };
}
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

const sizeKB = Math.round(Buffer.byteLength(injected) / 1024);
console.log('✅ 构建完成');
console.log(`   组件指纹：${slim.variants.length} 个变体`);
console.log(`   颜色样式：${slim.styleFills.length} 条（用于填充裸色检测）`);
console.log(`   库组件 key：${slim.libraryComponentKeys.length} 个（用于非库组件精确检测）`);
const catSummary = Object.entries(catCounts)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}:${v}`)
  .join('  ');
console.log(`   类别分布：${catSummary}`);
console.log(`   检测规则：${rulesData.rules.length} 条（保留备用）`);
console.log(`   code.js：${sizeKB} KB`);
console.log('');
console.log('');
if (FINGERPRINT_URL) {
  console.log(`   远端指纹 URL：${FINGERPRINT_URL}`);
  console.log('   已更新 manifest.json networkAccess');
} else {
  console.log('   远端指纹 URL：未配置（仅内嵌模式，在 config.json 设置 fingerprintUrl 启用）');
}
console.log(`   fingerprints_slim.json：已输出（${Math.round(Buffer.byteLength(JSON.stringify(slim)) / 1024)} KB，上传到托管地址后生效）`);
console.log('');
console.log('在 Figma 中 Relaunch 插件即可。');;
