/**
 * code.template.js — Figma 插件主线程模板
 * build.js 会把 FINGERPRINTS_DATA 注入后生成 code.js
 */

/* FINGERPRINTS_INJECT */

// ─── 远端可调参数（所有业务规则 / 文案 / 阈值全部来自云端 config）──────────────
// 默认值作为 fallback；UI 从远端拉取指纹成功后会发 'config' 消息深合并覆盖。
var CFG = {
  features: {
    checkComponent: true, checkNonLibrary: true, checkIcon: true,
    checkTextStyle: true, checkColorStyle: true, checkMargin: true, checkLayout: true,
  },
  thresholds: { match: 55, confHigh: 75, confMid: 62, nonLibMatch: 82 },
  skipRules: {
    namePrefixes: ['_'],
    annotationPatterns: ['文档信息', '设计说明', '标注', '备注', '注释', '说明卡', 'annotation', 'notes', 'redline', '走查'],
  },
  traversal: { maxDepth: 12, fullscreenMin: [360, 600], minSize: 12, maxVisibleDescendants: 12 },
  logoRules: {
    vectorTypes: ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON'],
    baseTypes: ['RECTANGLE', 'ELLIPSE'],
    forbiddenTypes: ['TEXT', 'INSTANCE'],
    minVectors: 3, maxDepth: 6,
  },
  iconRules: {
    sizeRange: [14, 32], aspectRange: [0.4, 2.5],
    minPrimitives: 2, defaultNameMaxSize: 56,
    mergedVectorMinSegments: 10, mergedVectorMinVertices: 14,
    colorChannelTolerance: 0.08, whiteThreshold: 0.95,
  },
  nonLibraryRules: { maxHeight: 300, skipDetached: true },
  textStyleRules: [
    { fontFamilyContains: ['pingfang sc'], maxFontSize: 32, score: 90,
      messageKey: 'textStyleHigh', mixedMessageKey: 'textStyleHighMixed' },
    { fontFamilyContains: ['pingfang sc'], maxFontSize: null, score: 72,
      messageKey: 'textStyleMid', mixedMessageKey: 'textStyleMidMixed' },
  ],
  colorRules: {
    exactDeltaRGB: 5, exactDeltaAlpha: 0.03, nearDeltaRGB: 20, nearDeltaAlpha: 0.05,
    exactScore: 95, nearScore: 75, rawScore: 50, minArea: 6, suggestMaxCount: 3,
  },
  layoutRules: {
    screenWidthRange: [320, 430], screenMinHeight: 400,
    validMargins: [0, 8, 12, 16, 20], marginMaxGap: 22, layoutMaxDepth: 16,
  },
  // ─── 豁免规则（由 build.js 从 library-config.json 注入，代码侧仅做兜底）
  exemptions: {
    couponPatterns:  ['券', 'coupon', 'red.?pack', '红包', '优惠', '满减', '折扣', '立减'],
    systemPatterns:  ['状态栏', 'status.?bar', '键盘', 'keyboard', '灵动岛', 'home.?indicator', 'safe.?area', 'system'],
    checkoutLexicon: ['结算', '购物车', '合计', '立即购买'],
    promoLexicon:    ['满', '减', '折', '省', '特价', '秒杀', '限时'],
  },
  messages: {
    nonLibraryLocal: '使用了本地组件（非共享库）。请替换为规范组件',
    nonLibraryRemote: '使用了其他组件库的组件。请替换为规范组件',
    iconPrimitive: '检测到手绘矢量图标（约 {n} 个几何图层），未使用 Icon 组件',
    iconPrimitiveSuggest: '请用资源库中的 ic_* 图标组件整体替换',
    iconMerged: '检测到疑似手绘图标（{hint}），未使用 Icon 组件',
    iconMergedSuggest: '请用资源库 ic_* 图标组件替换',
    iconHintComplex: '单图层但路径复杂',
    iconHintDefault: '单图层且为默认矢量命名',
    textStyleHigh: 'PingFang SC {size}px 文字必须绑定设计系统字体样式',
    textStyleHighMixed: 'PingFang SC {size}px 文字存在混合样式',
    textStyleHighSuggest: '请在文本属性面板选择字体样式',
    textStyleMid: 'PingFang SC 文字未绑定全局 Text Style',
    textStyleMidMixed: 'PingFang SC 文字存在混合样式',
    textStyleMidSuggest: '请在文本属性中选择文字样式',
    colorExact: '填充使用裸色，但与样式库颜色一致',
    colorNear: '填充使用裸色，与样式库某颜色接近',
    colorRaw: '背景/容器使用自定义裸色',
    marginInvalid: '{side}边距 {actual}px 不符合栅格规范（应为 {valid}）',
    marginSideLeft: '左', marginSideRight: '右',
    layoutEmpty: '空 {type}（无可见子元素）',
    layoutRedundant: 'Frame 只包含一个 {childType} 且自身无视觉属性',
  },
};

// ─── 深合并：把远端 c 的字段合并到 CFG（数组直接替换，对象递归合并）────
function deepMerge(target, src) {
  if (!src || typeof src !== 'object') return;
  for (var k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    var v = src[k];
    if (Array.isArray(v)) {
      target[k] = v.slice();
    } else if (v && typeof v === 'object' && !Array.isArray(target[k])
               && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

function loadCFG(c) { deepMerge(CFG, c); }

// ─── 文案模板：'{a} {b}'.replace({a:1,b:2}) → '1 2' ────────────────────────
function tpl(key, vars) {
  var s = (CFG.messages && CFG.messages[key]) || '';
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, function(_, k) {
    return vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '';
  });
}

// ─── 把字符串数组转成快查对象（['A','B'] → {A:1,B:1}）────────────────────
function arrToSet(arr) { var s = {}; for (var i = 0; i < (arr || []).length; i++) s[arr[i]] = 1; return s; }

loadCFG(FINGERPRINTS_DATA && FINGERPRINTS_DATA.config);

try {
  figma.showUI(__html__, { width: 440, height: 640, title: '组件规范自查' });
} catch (e) {
  figma.closePlugin('UI 加载失败: ' + String(e));
}

// ─── figma.mixed 安全访问 ────────────────────────────────────────────────
function safeArray(val) {
  if (!val || val === figma.mixed || typeof val === 'symbol') return [];
  if (!Array.isArray(val)) return [];
  return val;
}
function safeNum(val) {
  if (val === figma.mixed || typeof val === 'symbol') return null;
  return typeof val === 'number' ? val : null;
}
function safeStr(val) {
  if (val === figma.mixed || typeof val === 'symbol') return null;
  return typeof val === 'string' ? val : null;
}

// ─── 颜色量化（必须和 sync_library.js 一致）─────────────────────────────
function rgbToColorBucket(r, g, b) {
  var max = Math.max(r, g, b);
  var min = Math.min(r, g, b);
  var l = (max + min) / 2;
  var s = max === min ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min));
  if (l >= 0.95) return 'white';
  if (l <= 0.08) return 'black';
  if (s <= 0.12) return 'gray';
  var h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  if (h < 15 || h >= 345) return 'red';
  if (h < 45)  return 'orange';
  if (h < 70)  return 'yellow';
  if (h < 170) return 'green';
  if (h < 200) return 'cyan';
  if (h < 260) return 'blue';
  if (h < 300) return 'purple';
  return 'pink';
}

function extractDominantColor(node) {
  var fills = safeArray(node.fills);
  for (var i = 0; i < fills.length; i++) {
    var f = fills[i];
    if (f.visible === false) continue;
    if (f.type === 'SOLID' && f.color) {
      return rgbToColorBucket(f.color.r, f.color.g, f.color.b);
    }
    if (f.type && f.type.indexOf('GRADIENT') === 0 && f.gradientStops && f.gradientStops.length > 0) {
      var c = f.gradientStops[0].color;
      if (c) return rgbToColorBucket(c.r, c.g, c.b);
    }
  }
  return null;
}

// ─── 子节点签名 ──────────────────────────────────────────────────────────
function extractChildSignature(children) {
  var sig = { text: 0, vector: 0, image: 0, frame: 0, instance: 0, icon: 0 };
  var iconSize = 24;
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    if (c.type === 'TEXT') sig.text++;
    else if (c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION' || c.type === 'STAR' || c.type === 'POLYGON' || c.type === 'LINE') sig.vector++;
    else if (c.type === 'INSTANCE') sig.instance++;
    else if (c.type === 'FRAME' || c.type === 'GROUP' || c.type === 'COMPONENT') sig.frame++;

    var w = 0, h = 0;
    if (c.width != null && c.height != null) { w = c.width; h = c.height; }
    else if (c.absoluteBoundingBox) { w = c.absoluteBoundingBox.width; h = c.absoluteBoundingBox.height; }

    var fills = safeArray(c.fills);
    var hasImage = false;
    for (var j = 0; j < fills.length; j++) if (fills[j].type === 'IMAGE') { hasImage = true; break; }
    if (hasImage) sig.image++;

    if (w > 0 && w <= iconSize && h <= iconSize) {
      if (c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION') sig.icon++;
      else if (c.type === 'FRAME' && c.children) {
        for (var k = 0; k < c.children.length; k++) {
          if (c.children[k].type === 'VECTOR' || c.children[k].type === 'BOOLEAN_OPERATION') { sig.icon++; break; }
        }
      }
    }
  }
  return sig;
}

function childSigToString(sig) {
  var parts = [];
  if (sig.text) parts.push('T' + sig.text);
  if (sig.icon) parts.push('I' + sig.icon);
  if (sig.image) parts.push('M' + sig.image);
  if (sig.instance) parts.push('N' + sig.instance);
  if (sig.frame) parts.push('F' + sig.frame);
  if (sig.vector) parts.push('V' + sig.vector);
  return parts.join('-') || 'empty';
}

// ─── 把一个节点提取成跟指纹库同结构的 fingerprint ────────────────────────
//
// 额外输出（候选识别用）：
//   firstTextContent - 首个文本的 characters（最多 40 字）
//   hasDigit         - 文本中含数字或 ¥/%/: 等
//   isMultiTextRow   - 横排 ≥3 个同级 TEXT（Tab 栏特征）
//   isHeaderLike     - 宽≥320、高 40-100、左右各至少一个 icon/vector + 中间含 TEXT（顶部导航栏）
//   isSquareRound    - 近正方形 + 圆角比 ≥0.4 + 尺寸≤80（头像）

// 顶部导航条结构信号（extractFingerprint.isHeaderLike 与 isNavContainerStructural 共用）
//
// 导航栏三要素：左侧小图标 + 中间标题/搜索框 + 右侧可选控件
//   - 左侧：icon/INSTANCE，宽 ≤44px，在左 25% 以内
//   - 中间：TEXT 或含 TEXT 的 FRAME/GROUP，在 20%–80% 区间
//   - 右侧：icon/文字/小容器，在右 30%（可无）
//
// 关键区分：Tab bar 的直接子项在中间区域有 ≥2 个，而导航栏中间最多只有 1 个内容区。
// 用局部坐标（cp.x 相对父节点），不依赖 absoluteBoundingBox。
function topNavStructuralSignals(node, children) {
  var w = node.width || 0;
  var h = node.height || 0;
  var out = { hasLeftVec: false, hasRightVec: false, hasMidText: false, isTopBand: false };
  if (!w || !h || w < 320 || h < 36 || h > 100) return out;
  out.isTopBand = true;

  var hasSmallLeftIcon = false; // 宽≤44px 的左侧小图标（back/close）
  var midCount = 0;             // 中间区域的直接子项数（≥2 说明是 tab bar）

  for (var p = 0; p < children.length; p++) {
    var cp = children[p];
    if (cp.x == null) continue;
    var cw = cp.width || 0;
    var cx = cp.x + cw / 2; // 局部中心 x

    // ── 左侧控件：必须是小图标（≤44px），排除 tab bar 的宽子项
    if (cx < w * 0.25 && cw <= 44) {
      if (cp.type === 'VECTOR' || cp.type === 'BOOLEAN_OPERATION' ||
          cp.type === 'INSTANCE' || cp.type === 'FRAME' || cp.type === 'GROUP') {
        out.hasLeftVec = true;
        hasSmallLeftIcon = true;
      }
    }

    // ── 右侧控件：图标/文字/小容器，宽不超过 120px
    if (cx > w * 0.70) {
      if (cp.type === 'VECTOR' || cp.type === 'BOOLEAN_OPERATION' ||
          cp.type === 'INSTANCE' || cp.type === 'TEXT' ||
          ((cp.type === 'FRAME' || cp.type === 'GROUP') && cw <= 120)) {
        out.hasRightVec = true;
      }
    }

    // ── 中间内容：20%–80% 区间，计数 + 检测 TEXT
    if (cx >= w * 0.20 && cx < w * 0.80) {
      midCount++;
      if (cp.type === 'TEXT') {
        out.hasMidText = true;
      } else if (cp.type === 'FRAME' || cp.type === 'GROUP') {
        // 向下最多两层找 TEXT（标题嵌套在 FRAME 内的常见写法）
        var mk = cp.children || [];
        for (var mi = 0; mi < mk.length && !out.hasMidText; mi++) {
          if (mk[mi].type === 'TEXT') { out.hasMidText = true; break; }
          var mk2 = mk[mi].children || [];
          for (var mi2 = 0; mi2 < mk2.length; mi2++) {
            if (mk2[mi2].type === 'TEXT') { out.hasMidText = true; break; }
          }
        }
      }
    }
  }

  // Tab bar 误判保护：中间区域有 ≥2 个子项 → 多个等宽 tab 项，不是导航栏
  if (midCount >= 2) out.hasMidText = false;

  // 兜底：全宽 + 小返回图标 + 右侧有控件 + 中间子项≤1（标题在背景组件里的写法）
  if (w >= 360 && hasSmallLeftIcon && out.hasRightVec && midCount <= 1) {
    out.hasMidText = true;
  }

  return out;
}

function extractFingerprint(node, children) {
  var w = node.width != null ? node.width : null;
  var h = node.height != null ? node.height : null;

  var fills = safeArray(node.fills).filter(function(f){ return f.visible !== false; });
  var strokes = safeArray(node.strokes).filter(function(s){ return s.visible !== false; });
  var hasFill = fills.length > 0;
  var hasStroke = strokes.length > 0;
  var fillType = hasFill ? (fills[0].type || null) : null;
  var hasGradient = false;
  for (var i = 0; i < fills.length; i++) { if (fills[i].type && fills[i].type.indexOf('GRADIENT') === 0) { hasGradient = true; break; } }

  var effects = safeArray(node.effects).filter(function(e){ return e.visible !== false; });
  var hasShadow = false;
  for (var j = 0; j < effects.length; j++) { if (effects[j].type === 'DROP_SHADOW' || effects[j].type === 'INNER_SHADOW') { hasShadow = true; break; } }

  var cs = extractChildSignature(children);
  var csStr = childSigToString(cs);

  var cr = safeNum(node.cornerRadius);
  var crR = (cr != null && w && h) ? Math.round(cr / Math.min(w, h) * 100) / 100 : null;

  // 首个 TEXT + 内容
  var firstText = null;
  var firstTextContent = '';
  for (var i2 = 0; i2 < children.length; i2++) {
    if (children[i2].type === 'TEXT') {
      firstText = children[i2];
      var ch = firstText.characters;
      if (ch && typeof ch === 'string') firstTextContent = ch.slice(0, 40);
      break;
    }
  }
  // 未在直接子层找到文本时，深挖一层（含常见嵌套文本的结构，如按钮内 Frame>Text）
  if (!firstText) {
    for (var i3 = 0; i3 < children.length; i3++) {
      var ck = children[i3];
      if (ck.children) {
        for (var i4 = 0; i4 < ck.children.length; i4++) {
          var gc = ck.children[i4];
          if (gc.type === 'TEXT') {
            firstText = gc;
            var ch2 = gc.characters;
            if (ch2 && typeof ch2 === 'string') firstTextContent = ch2.slice(0, 40);
            break;
          }
        }
        if (firstText) break;
      }
    }
  }
  var hasDigit = /[\d\u00A5\u5143%\.:：]/.test(firstTextContent);

  // 底部结算/购物车栏文案（与「扁券条」区分，避免误匹配中插券条等）
  // 词表优先从 CFG.exemptions.checkoutLexicon（由 library-config.json 注入）读取
  var _checkoutWords = (CFG.exemptions && Array.isArray(CFG.exemptions.checkoutLexicon) && CFG.exemptions.checkoutLexicon.length > 0)
    ? CFG.exemptions.checkoutLexicon
    : ['购买', '下单', '结算', '去结算', '凑单', '合计', '立即买', '立即购买', '购物车', '小计', '明细', '已优惠', '优惠价'];
  var _checkoutRe;
  try { _checkoutRe = new RegExp(_checkoutWords.join('|'), 'u'); } catch(e) { _checkoutRe = /结算|购物车/u; }

  function textHasCheckoutBarLexicon(str) {
    if (!str || typeof str !== 'string') return false;
    return _checkoutRe.test(str);
  }
  function scanCheckoutLexicon(nodes, depth) {
    if (depth > 6) return false;
    for (var sx = 0; sx < nodes.length; sx++) {
      var sn = nodes[sx];
      if (!sn || sn.visible === false) continue;
      if (sn.type === 'TEXT') {
        var st = safeStr(sn.characters);
        if (st && textHasCheckoutBarLexicon(st)) return true;
      }
      if (sn.children && sn.children.length) {
        if (scanCheckoutLexicon([].slice.call(sn.children), depth + 1)) return true;
      }
    }
    return false;
  }
  var checkoutLex = textHasCheckoutBarLexicon(firstTextContent) || scanCheckoutLexicon(children, 0);

  // 营销/凑单进度横条（非按钮组件）：如「仅差N件」「N件起低至」全宽扁条
  // 词表优先从 CFG.exemptions.promoLexicon（由 library-config.json 注入）读取
  var _promoWords = (CFG.exemptions && Array.isArray(CFG.exemptions.promoLexicon) && CFG.exemptions.promoLexicon.length > 0)
    ? CFG.exemptions.promoLexicon
    : ['仅差', '低至', '件起', '元起', '再选', '还差', '满减', '多买', '件，', '起，', '元/件', '元1件', '件低至'];
  var _promoRe;
  try { _promoRe = new RegExp(_promoWords.join('|'), 'u'); } catch(e) { _promoRe = /满减|仅差/u; }

  function textHasPromoStripLexicon(str) {
    if (!str || typeof str !== 'string') return false;
    return _promoRe.test(str);
  }
  function scanPromoStripLexicon(nodes, depth) {
    if (depth > 6) return false;
    for (var px = 0; px < nodes.length; px++) {
      var pn = nodes[px];
      if (!pn || pn.visible === false) continue;
      if (pn.type === 'TEXT') {
        var pt = safeStr(pn.characters);
        if (pt && textHasPromoStripLexicon(pt)) return true;
      }
      if (pn.children && pn.children.length) {
        if (scanPromoStripLexicon([].slice.call(pn.children), depth + 1)) return true;
      }
    }
    return false;
  }
  var nmSelf = typeof node.name === 'string' ? node.name : '';
  var promoStripLex = /凑单进度|营销条|利益点|促销横|凑单bar|进度条/i.test(nmSelf) ||
      textHasPromoStripLexicon(firstTextContent) || scanPromoStripLexicon(children, 0);

  // isMultiTextRow：≥3 个同级 TEXT 子，且容器为 HORIZONTAL 或子项水平分布
  var isMultiTextRow = false;
  if (cs.text >= 3) {
    var layoutIsH = safeStr(node.layoutMode) === 'HORIZONTAL';
    if (layoutIsH) {
      isMultiTextRow = true;
    } else {
      // 无 autolayout 也看是否水平分布：子 TEXT 的 y 值相近
      var ys = [];
      for (var m = 0; m < children.length; m++) {
        var cm = children[m];
        if (cm.type === 'TEXT' && cm.y != null) ys.push(cm.y);
      }
      if (ys.length >= 3) {
        var minY = Math.min.apply(null, ys);
        var maxY = Math.max.apply(null, ys);
        if ((maxY - minY) <= 8) isMultiTextRow = true;
      }
    }
  }

  // isHeaderLike：宽≥320、高 40-100、左右各至少一个 icon/vector、中间含 TEXT（含嵌套标题）
  var navSig = topNavStructuralSignals(node, children);
  var isHeaderLike =
    !checkoutLex && navSig.isTopBand && navSig.hasLeftVec && navSig.hasRightVec && navSig.hasMidText;

  // isSquareRound：近方形 + 高圆角 + 尺寸≤80
  var isSquareRound = false;
  if (w && h && w <= 80 && h <= 80) {
    var dim = Math.max(w, h);
    var sqDiff = Math.abs(w - h) / dim;
    if (sqDiff <= 0.15 && crR != null && crR >= 0.4) isSquareRound = true;
  }

  return {
    w: w, h: h,
    ar: (w && h) ? Math.round(w / h * 100) / 100 : null,
    cr: cr,
    crR: crR,
    hF: hasFill ? 1 : 0,
    hS: hasStroke ? 1 : 0,
    hG: hasGradient ? 1 : 0,
    hSh: hasShadow ? 1 : 0,
    col: extractDominantColor(node),
    ft: fillType,
    sw: safeNum(node.strokeWeight),
    lm: safeStr(node.layoutMode),
    lc: children.length,
    cs: csStr,
    cTxt: cs.text, cIcn: cs.icon, cImg: cs.image, cIns: cs.instance,
    pT: safeNum(node.paddingTop), pB: safeNum(node.paddingBottom),
    pL: safeNum(node.paddingLeft), pR: safeNum(node.paddingRight),
    sp: safeNum(node.itemSpacing),
    fs: firstText ? safeNum(firstText.fontSize) : null,
    fw: firstText ? safeNum(firstText.fontWeight) : null,
    firstTextContent: firstTextContent,
    hasDigit: hasDigit,
    isMultiTextRow: isMultiTextRow,
    isHeaderLike: isHeaderLike,
    isSquareRound: isSquareRound,
    checkoutLex: checkoutLex ? 1 : 0,
    promoStripLex: promoStripLex ? 1 : 0,
  };
}

// ─── 遍历与候选节点筛选 ─────────────────────────────────────────────────
var STRUCTURAL_TYPES = { FRAME: 1, GROUP: 1, COMPONENT: 1, SECTION: 1 };
var ILLUSTRATION_TYPES = { VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, POLYGON: 1, LINE: 1 };

function isPureIllustration(children) {
  if (children.length === 0) return false;
  for (var i = 0; i < children.length; i++) {
    if (!ILLUSTRATION_TYPES[children[i].type]) return false;
  }
  return true;
}

function isAnnotationFrame(name) {
  var lower = (name || '').toLowerCase();
  var patterns = (CFG.skipRules && CFG.skipRules.annotationPatterns) || [];
  for (var i = 0; i < patterns.length; i++) {
    if (lower.indexOf(String(patterns[i]).toLowerCase()) >= 0) return true;
  }
  return false;
}

// 节点名以 CFG.skipRules.namePrefixes 里任何前缀开头 → 跳过
function hasSkipPrefix(name) {
  if (!name) return false;
  var prefixes = (CFG.skipRules && CFG.skipRules.namePrefixes) || [];
  for (var i = 0; i < prefixes.length; i++) {
    var p = String(prefixes[i]);
    if (p && name.indexOf(p) === 0) return true;
  }
  return false;
}

// 计算节点 node 在兄弟列表 nodes 中，尺寸/结构接近的兄弟数
// 用来区分"群居 tag"vs"单独出现的 button/tag 状结构"
function countSimilarSiblings(node, nodes) {
  var nw = node.width || 0, nh = node.height || 0;
  if (!nw || !nh) return 0;
  var count = 0;
  for (var i = 0; i < nodes.length; i++) {
    var sib = nodes[i];
    if (sib === node) continue;
    if (!STRUCTURAL_TYPES[sib.type] && sib.type !== 'INSTANCE') continue;
    var sw = sib.width || 0, sh = sib.height || 0;
    if (!sw || !sh) continue;
    var wDiff = Math.abs(nw - sw) / Math.max(nw, sw);
    var hDiff = Math.abs(nh - sh) / Math.max(nh, sh);
    if (wDiff <= 0.4 && hDiff <= 0.2) count++;
  }
  return count;
}

// 快速统计节点可见后代数（隐藏节点不计，超过 maxN 立即返回）
function countQuickDescendants(node, maxN) {
  // keep original signature
  if (!node.children) return 0;
  var cnt = 0;
  var stack = [].slice.call(node.children);
  while (stack.length > 0) {
    var cur = stack.pop();
    if (cur.visible === false) continue; // 隐藏节点及其子树不计入
    cnt++;
    if (cnt > maxN) return cnt;
    if (cur.children) stack = stack.concat([].slice.call(cur.children));
  }
  return cnt;
}

// 判断节点子树是否是 Logo / 应用图标结构：
// 条件：同一容器内有 3+ 个 Vector/BooleanOperation 叠在 Rectangle/Ellipse 上，且无文字/实例
// 递归穿透 Group/Frame/ClipPath 层
function hasLogoLikeContent(children, depth) {
  var rules = CFG.logoRules;
  if (depth > rules.maxDepth) return false;
  var vectorSet = arrToSet(rules.vectorTypes);
  var baseSet = arrToSet(rules.baseTypes);
  var forbidSet = arrToSet(rules.forbiddenTypes);
  var vectorCnt = 0, hasBase = false, hasForbidden = false;
  for (var _i = 0; _i < children.length; _i++) {
    var _c = children[_i];
    if (_c.visible === false) continue;
    if (forbidSet[_c.type]) { hasForbidden = true; continue; }
    if (vectorSet[_c.type]) vectorCnt++;
    if (baseSet[_c.type]) hasBase = true;
    if ((_c.type === 'GROUP' || _c.type === 'FRAME') && _c.children) {
      if (hasLogoLikeContent([].slice.call(_c.children), depth + 1)) return true;
    }
  }
  return vectorCnt >= rules.minVectors && hasBase && !hasForbidden;
}

// 判断节点子树是否只含文字（无视觉容器属性的纯文案层不应进入组件候选）
function isTextOnlySubtree(nodes, depth) {
  if (depth > 4) return false;
  for (var _i = 0; _i < nodes.length; _i++) {
    var _n = nodes[_i];
    if (_n.visible === false) continue;
    if (_n.type === 'TEXT') continue;
    if (_n.type === 'GROUP' || _n.type === 'FRAME') {
      var _sub = _n.children ? [].slice.call(_n.children) : [];
      if (_sub.length === 0) continue;
      if (!isTextOnlySubtree(_sub, depth + 1)) return false;
      continue;
    }
    return false; // 遇到非文字的可视节点
  }
  return true;
}

function traverse(nodes, breadcrumb, candidates, depth) {
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.type === 'INSTANCE') continue;                    // 已是组件实例
    if (isAnnotationFrame(node.name)) continue;
    if (node.visible === false) continue;
    if (!STRUCTURAL_TYPES[node.type]) continue;
    if (isOutsideFrameClip(node)) continue;                    // 画板外元素直接跳过，不做指纹匹配
    if (isSystemComponent(node.name, '')) continue;            // 系统级 Frame/Group 整体豁免

    var path = breadcrumb.concat([node.name]);
    var children = node.children ? [].slice.call(node.children) : [];

    if (children.length >= 1 && !hasSkipPrefix(node.name) && depth <= CFG.traversal.maxDepth) {
      var w = node.width || 0;
      var h = node.height || 0;
      var fsMin = CFG.traversal.fullscreenMin;
      var isFullscreen = w >= fsMin[0] && h >= fsMin[1];
      var isIllustration = isPureIllustration(children);
      var hasAnyFill = safeArray(node.fills).some(function(f){ return f.visible !== false; });
      var hasAnyStroke = safeArray(node.strokes).some(function(s){ return s.visible !== false; });
      var hasAnyShadow = safeArray(node.effects).some(function(e){
        return e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW');
      });
      var hasTextOrIcon = false;
      for (var j = 0; j < children.length; j++) {
        var c = children[j];
        if (c.type === 'TEXT' || c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION' || c.type === 'INSTANCE') { hasTextOrIcon = true; break; }
      }
      var tooSmall = w < CFG.traversal.minSize || h < CFG.traversal.minSize;

      // ─── 导航栏：自身加入候选池（匹配 nav_top 库组件），但跳过子树（避免内部元素乱报）
      if (!isFullscreen && !tooSmall && isNavContainerStructural(node, children)) {
        if (!isIllustration && (hasAnyFill || hasAnyStroke || hasAnyShadow || hasTextOrIcon)) {
          var navFp = extractFingerprint(node, children);
          navFp.sib = countSimilarSiblings(node, nodes);
          candidates.push({
            id: node.id,
            name: node.name,
            breadcrumb: path,
            size: Math.round(w) + '×' + Math.round(h),
            fp: navFp,
          });
        }
        continue; // 子树不再递归（tab 项 / 导航内图标不单独报）
      }
      // ─── 大内容模块：模块本身不入组件候选池，但必须继续扫子树（内部按钮/条等仍要走查）
      if (!isFullscreen && !tooSmall && isContentModuleStructural(node, children)) {
        if (children.length > 0) traverse(children, path, candidates, depth + 1);
        continue;
      }

      // Logo 检测：多个不规则图形叠在矩形/圆形上（App 图标、品牌 Logo 等）
      if (!isFullscreen && !tooSmall && hasLogoLikeContent(children, 0)) {
        continue; // 整棵子树都是 Logo，无需递归
      }

      if (!isFullscreen && !isIllustration &&
          (hasAnyFill || hasAnyStroke || hasAnyShadow || hasTextOrIcon) && !tooSmall) {
        var maxD = CFG.traversal.maxVisibleDescendants;
        if (countQuickDescendants(node, maxD) > maxD) {
          if (children.length > 0) traverse(children, path, candidates, depth + 1);
          continue;
        }
        // 无实质视觉填充（透明或白色）且子树只含文字 → 纯文案层，跳过
        var hasMeaningfulFill = safeArray(node.fills).some(function(f) {
          if (f.visible === false) return false;
          if (f.type === 'SOLID' && f.color) {
            var op = (f.opacity !== undefined ? f.opacity : 1);
            var ca = (f.color.a !== undefined ? f.color.a : 1);
            if (op < 0.05 || ca < 0.05) return false;
            // 纯白或近白视为无实质填充
            if (f.color.r > 0.95 && f.color.g > 0.95 && f.color.b > 0.95) return false;
            return true;
          }
          if (f.type === 'IMAGE') return false; // 图片背景不影响判断
          return true; // 渐变等视为有实质填充
        });
        if (!hasMeaningfulFill && !hasAnyStroke && !hasAnyShadow && isTextOnlySubtree(children, 0)) {
          if (children.length > 0) traverse(children, path, candidates, depth + 1);
          continue;
        }
        var fp = extractFingerprint(node, children);
        fp.sib = countSimilarSiblings(node, nodes);
        candidates.push({
          id: node.id,
          name: node.name,
          breadcrumb: path,
          size: Math.round(w) + '×' + Math.round(h),
          fp: fp,
        });
      }
    }

    if (children.length > 0) traverse(children, path, candidates, depth + 1);
  }
}

// 纯结构判定，不依赖 fingerprint（fill/stroke/shadow）——用于提前跳过底部/顶部导航子树
function isNavContainerStructural(node, children) {
  var w = node.width || 0;
  var h = node.height || 0;
  if (!w || !h) return false;

  // 顶部导航：宽≥320、高 36-100、左右各至少一个 icon/vector + 中间含 TEXT（与 isHeaderLike 同判据）
  var topSig = topNavStructuralSignals(node, children);
  if (topSig.isTopBand && topSig.hasLeftVec && topSig.hasRightVec && topSig.hasMidText) return true;

  // 底部导航：宽≥320、高 40-100、结构里含 ≥3 个 "icon + text 垂直堆叠" 的子项
  // （不限制总子数，因为实际设计里还会有背景矩形、Home Indicator、额外浮动按钮等）
  if (w >= 320 && h >= 40 && h <= 100) {
    var colLike = 0;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (!c.children) continue;
      var hasIcon = false, hasText = false;
      for (var k = 0; k < c.children.length; k++) {
        var g = c.children[k];
        if (g.type === 'TEXT') hasText = true;
        if (g.type === 'VECTOR' || g.type === 'BOOLEAN_OPERATION' || g.type === 'INSTANCE' ||
            (g.type === 'FRAME' && (g.width || 0) <= 40)) hasIcon = true;
      }
      if (hasIcon && hasText) colLike++;
    }
    if (colLike >= 3) return true;
  }

  return false;
}

// 判定"大内容模块"——页面中的业务区块，库里没有对应组件，整体 skip + 跳过子树
// 例：我的订单 / 我的权益 / 推荐商品位 / 功能入口区
function isContentModuleStructural(node, children) {
  var w = node.width || 0;
  var h = node.height || 0;
  if (w < 300 || children.length < 3) return false;
  // 直接子全是 FRAME/GROUP（没有 INSTANCE）
  var hasInstance = false;
  var frameChildren = 0;
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    if (c.type === 'INSTANCE') { hasInstance = true; break; }
    if (c.type === 'FRAME' || c.type === 'GROUP') frameChildren++;
  }
  if (hasInstance) return false;
  if (frameChildren < 2) return false;
  // 无强圆角（避免挡住 card 式组件）
  var cr = typeof node.cornerRadius === 'number' ? node.cornerRadius : 0;
  var crR = (w && h) ? cr / Math.min(w, h) : 0;
  if (crR >= 0.1) return false;
  return true;
}

// ─── 文字 / 填充颜色样式走查（与 match.js 逻辑对齐，零 API 成本）────────────────
var BACKGROUND_FOR_CUSTOM_COLOR = {
  FRAME: 1, RECTANGLE: 1, ELLIPSE: 1, GROUP: 1, COMPONENT: 1, SECTION: 1,
};

function pushSolidFillStyleViolation(node, path, out, styleFills, isTextNode) {
  if (!CFG.features.checkColorStyle) return;
  if (node.fills === figma.mixed || node.fillStyleId === figma.mixed) return;
  var fsid = safeStr(node.fillStyleId);
  if (fsid && fsid.length > 0) return;
  // Case: TEXT 节点的 fill 可能来自 textStyleId
  if (isTextNode) {
    var tsid = node.textStyleId;
    if (tsid && tsid !== figma.mixed && typeof tsid !== 'symbol'
        && typeof tsid === 'string' && tsid.length > 0) return;
  }
  // Case: Figma Variables/Tokens 绑定 —— boundVariables.fills 存在时颜色来自变量，不算裸色
  try {
    var bv = node.boundVariables;
    if (bv && bv.fills && Array.isArray(bv.fills) && bv.fills.length > 0) return;
    // strokeStyleId / fills[n].boundVariables 兼容性检查
    var fills0 = safeArray(node.fills);
    for (var _bvi = 0; _bvi < fills0.length; _bvi++) {
      var _f = fills0[_bvi];
      if (_f && _f.boundVariables && (_f.boundVariables.color || _f.boundVariables.opacity)) return;
    }
  } catch(e) {}
  // Case: 节点在库组件实例内部，且自身颜色是组件定义色（fillStyleId 为空是因为被组件默认值覆盖）
  // 通过向上遍历 parent 链判断：若最近的 INSTANCE 祖先来自组件库，则豁免
  try {
    var _cur = node.parent;
    while (_cur && _cur.type !== 'PAGE') {
      if (_cur.type === 'INSTANCE') {
        var _mc = null;
        try { _mc = _cur.mainComponent; } catch(e) {}
        var _libKeys = getLibKeySet();
        var _hasKeys = Object.keys(_libKeys).length > 0;
        var _fromLib = _mc && _hasKeys ? !!_libKeys[_mc.key] : (_mc && _mc.remote === true);
        if (_fromLib) return;
        break;
      }
      _cur = _cur.parent;
    }
  } catch(e) {}
  var rules = CFG.colorRules;
  var fills = safeArray(node.fills);
  for (var i = 0; i < fills.length; i++) {
    var f = fills[i];
    if (f.visible === false) continue;
    if (f.type !== 'SOLID' || !f.color) continue;
    var a = f.color.a !== undefined ? f.color.a : 1;
    if (a < 0.04) return;
    var r = Math.round(f.color.r * 255), g = Math.round(f.color.g * 255), b = Math.round(f.color.b * 255);
    var exact = [], near = [];
    for (var j = 0; j < styleFills.length; j++) {
      var s = styleFills[j];
      var dr = Math.abs(r - s.r), dg = Math.abs(g - s.g), db = Math.abs(b - s.b);
      var da = Math.abs(a - (s.a !== undefined ? s.a : 1));
      if (dr <= rules.exactDeltaRGB && dg <= rules.exactDeltaRGB && db <= rules.exactDeltaRGB && da <= rules.exactDeltaAlpha) exact.push(s.name);
      else if (dr <= rules.nearDeltaRGB && dg <= rules.nearDeltaRGB && db <= rules.nearDeltaRGB && da <= rules.nearDeltaAlpha) near.push(s.name);
    }
    function firstLevel(nm) { var s = nm.indexOf('/'); return s > 0 ? nm.slice(0, s).trim() : nm; }
    function toFirstLevelUniq(arr) {
      var seen = {}, result = [], maxN = rules.suggestMaxCount;
      for (var _i = 0; _i < arr.length; _i++) {
        var k = firstLevel(arr[_i]);
        if (!seen[k]) { seen[k] = 1; result.push(k); }
        if (result.length >= maxN) break;
      }
      return result.join('、');
    }
    if (exact.length > 0) {
      out.push({
        kind: 'fill-color', id: node.id, name: node.name, breadcrumb: path, score: rules.exactScore,
        detail: tpl('colorExact'), suggest: toFirstLevelUniq(exact),
      });
    } else if (near.length > 0) {
      out.push({
        kind: 'fill-color', id: node.id, name: node.name, breadcrumb: path, score: rules.nearScore,
        detail: tpl('colorNear'), suggest: toFirstLevelUniq(near),
      });
    } else if (!isTextNode && BACKGROUND_FOR_CUSTOM_COLOR[node.type]) {
      out.push({
        kind: 'fill-color', id: node.id, name: node.name, breadcrumb: path, score: rules.rawScore,
        detail: tpl('colorRaw'), suggest: '',
      });
    }
    return;
  }
}

var STYLE_GEOMETRY_TYPES = {
  FRAME: 1, RECTANGLE: 1, ELLIPSE: 1, COMPONENT: 1, GROUP: 1, SECTION: 1,
  VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, POLYGON: 1, LINE: 1,
};

// 规则驱动：按顺序匹配 CFG.textStyleRules 中第一条满足条件的规则
function matchFirstTextRule(fontFamLow, fontSize) {
  var rules = CFG.textStyleRules || [];
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    var fams = r.fontFamilyContains || [];
    var famOk = false;
    for (var k = 0; k < fams.length; k++) {
      if (fontFamLow.indexOf(String(fams[k]).toLowerCase()) >= 0) { famOk = true; break; }
    }
    if (!famOk) continue;
    var maxSize = r.maxFontSize;
    if (maxSize != null && (fontSize == null || fontSize > maxSize)) continue;
    return r;
  }
  return null;
}

function checkTextStyleNode(node, path, out, styleFills) {
  if (!CFG.features.checkTextStyle) { pushSolidFillStyleViolation(node, path, out, styleFills, true); return; }
  var ch = safeStr(node.characters);
  var hasChars = ch && ch.replace(/\s/g, '').length > 0;
  if (!hasChars) return;

  var fontFam = (node.fontName && node.fontName !== figma.mixed && typeof node.fontName === 'object')
    ? (node.fontName.family || '') : '';
  var fontFamLow = fontFam.toLowerCase();
  var fontSize = (node.fontSize !== figma.mixed && typeof node.fontSize === 'number')
    ? node.fontSize : null;

  var isMixedStyle = (node.textStyleId === figma.mixed || typeof node.textStyleId === 'symbol');
  var tsid = isMixedStyle ? null : safeStr(node.textStyleId);
  var hasNoStyle = !isMixedStyle && (!tsid || tsid.length === 0);

  if (hasNoStyle || isMixedStyle) {
    var rule = matchFirstTextRule(fontFamLow, fontSize);
    if (rule) {
      var msgKey = isMixedStyle && rule.mixedMessageKey ? rule.mixedMessageKey : rule.messageKey;
      var suggestKey = msgKey + 'Suggest';
      // fallback: suggestKey not found → 用 messageKey+'Suggest'
      var suggestMsg = tpl(suggestKey) || tpl(rule.messageKey + 'Suggest');
      out.push({
        kind: 'text-style', id: node.id, name: node.name, breadcrumb: path,
        score: rule.score || 72,
        detail: tpl(msgKey, { size: fontSize != null ? Math.round(fontSize) : '' }),
        suggest: suggestMsg,
      });
    }
  }

  pushSolidFillStyleViolation(node, path, out, styleFills, true);
}

// 判断节点名是否属于券/红包/优惠等组件 —— 这类组件颜色是业务定制色，豁免颜色检查
// pattern 优先从 CFG.exemptions.couponPatterns（由 library-config.json 注入）读取
function isCouponComponent(name) {
  if (!name || typeof name !== 'string') return false;
  var patterns = (CFG.exemptions && Array.isArray(CFG.exemptions.couponPatterns) && CFG.exemptions.couponPatterns.length > 0)
    ? CFG.exemptions.couponPatterns
    : ['券', 'coupon', 'red.?pack', '红包', '优惠', '满减', '折扣', '立减'];
  try { return new RegExp(patterns.join('|'), 'i').test(name); } catch(e) { return false; }
}

function collectStyleViolations(nodes, breadcrumb, out, depth, parentFrame) {
  if (depth > 15 || out.length >= 450) return;
  var styleFills = (FINGERPRINTS_DATA && FINGERPRINTS_DATA.styleFills) ? FINGERPRINTS_DATA.styleFills : [];
  var libKeys = getLibKeySet();
  var hasKeyList = Object.keys(libKeys).length > 0;

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.visible === false) continue;
    if (isOutsideFrameClip(node)) continue;

    if (node.type === 'INSTANCE') {
      var mc = null;
      try { mc = node.mainComponent; } catch(e) {}
      var fromLibrary = mc && hasKeyList ? !!libKeys[mc.key] : (mc && mc.remote === true);
      // 券/红包类组件 & 系统级组件整体豁免颜色检查
      var nm2 = typeof node.name === 'string' ? node.name : '';
      var mcName = mc && mc.name ? mc.name : '';
      if (isCouponComponent(nm2) || isCouponComponent(mcName)) continue;
      if (isSystemComponent(nm2, mcName)) continue;
      if (!fromLibrary && node.children) {
        var path2 = breadcrumb.concat([nm2 || '#']);
        collectStyleViolations([].slice.call(node.children), path2, out, depth + 1, node);
      }
      continue;
    }

    var nm = typeof node.name === 'string' ? node.name : '';
    if (hasSkipPrefix(nm)) {
      if (node.children) collectStyleViolations([].slice.call(node.children), breadcrumb, out, depth + 1, node);
      continue;
    }
    if (isAnnotationFrame(nm)) continue;

    var path = breadcrumb.concat([nm || '#']);

    if (node.type === 'TEXT') {
      checkTextStyleNode(node, path, out, styleFills);
    } else if (STYLE_GEOMETRY_TYPES[node.type]) {
      var w = node.width || 0, h = node.height || 0;
      if (w * h >= CFG.colorRules.minArea) pushSolidFillStyleViolation(node, path, out, styleFills, false);
    }

    if (node.children) {
      collectStyleViolations([].slice.call(node.children), path, out, depth + 1, node);
    }
  }
}

// ─── 手绘图标检测（Vector/Union/Ellipse 碎图层，未使用 ic_* 组件）────────────────
var PRIMITIVE_GEOM_TYPES = {
  VECTOR: 1, BOOLEAN_OPERATION: 1, ELLIPSE: 1, STAR: 1, POLYGON: 1, LINE: 1, RECTANGLE: 1,
};
var ICON_CONTAINER_TYPES = { FRAME: 1, GROUP: 1, COMPONENT: 1, SECTION: 1 };

// 拿节点自身的矩形（不含后代溢出）。
// 注意：absoluteBoundingBox 是节点 + 所有后代的 union，会被溢出子元素扩大，所以不能用它
// 这里用 absoluteTransform 拿绝对坐标 + 节点自身 width/height
function getNodeSelfRect(n) {
  var at = n.absoluteTransform;
  if (!at) return null;
  var x = at[0] && at[0][2] != null ? at[0][2] : 0;
  var y = at[1] && at[1][2] != null ? at[1][2] : 0;
  var w = n.width || 0, h = n.height || 0;
  if (!w || !h) return null;
  return { x: x, y: y, width: w, height: h };
}

function rectCompletelyOutside(inner, outer) {
  return (inner.x + inner.width <= outer.x ||
          inner.x >= outer.x + outer.width ||
          inner.y + inner.height <= outer.y ||
          inner.y >= outer.y + outer.height);
}

// 判断节点是否在可视范围之外。两级检查：
// 1. 硬裁剪：最近的 clipsContent=true 的 FRAME 祖先
// 2. 画板软边界：和画板自身的声明矩形比较
//    原理：HUG 画板 width/height 只基于流内子元素，绝对定位溢出的后代不扩展声明尺寸,
//    这个矩形就是画板真正的视觉轮廓
function isOutsideFrameClip(node) {
  var nrect = getNodeSelfRect(node);
  if (!nrect) return false;

  // 1. 硬裁剪
  var cur = node;
  while (cur.parent) {
    var p = cur.parent;
    if (p.type === 'PAGE') break;
    if (p.type === 'FRAME' && p.clipsContent) {
      var crect = getNodeSelfRect(p);
      if (crect && rectCompletelyOutside(nrect, crect)) return true;
      break;
    }
    cur = p;
  }

  // 2. 画板软边界
  cur = node;
  var artboard = null;
  while (cur.parent) {
    if (cur.parent.type === 'PAGE') {
      if (cur.type === 'FRAME') artboard = cur;
      break;
    }
    cur = cur.parent;
  }
  if (!artboard || artboard === node) return false;
  var arect = getNodeSelfRect(artboard);
  if (!arect) return false;
  return rectCompletelyOutside(nrect, arect);
}

// 检查一组兄弟节点中是否有互相重叠的包围盒（重叠 → 复杂插画/Logo，不是原子图标）
function hasSiblingBBoxOverlap(nodes) {
  var rects = [];
  for (var i = 0; i < nodes.length; i++) {
    var c = nodes[i];
    if (c.visible === false) continue;
    var cx = c.x != null ? c.x : 0;
    var cy = c.y != null ? c.y : 0;
    var cw = c.width || 0, ch = c.height || 0;
    if (!cw || !ch) continue;
    rects.push([cx, cy, cx + cw, cy + ch]);
  }
  for (var a = 0; a < rects.length; a++) {
    for (var b = a + 1; b < rects.length; b++) {
      var r1 = rects[a], r2 = rects[b];
      if (r1[0] < r2[2] && r1[2] > r2[0] && r1[1] < r2[3] && r1[3] > r2[1]) return true;
    }
  }
  return false;
}

function nodeHasVisibleImageFill(node) {
  var fills = safeArray(node.fills);
  for (var i = 0; i < fills.length; i++) {
    if (fills[i].visible !== false && fills[i].type === 'IMAGE') return true;
  }
  return false;
}

// 判断节点是否有彩色或渐变填充（有则豁免手绘图标检测）
function nodeHasColorOrGradientFill(node) {
  var fills = safeArray(node.fills);
  var tol = CFG.iconRules.colorChannelTolerance;
  for (var i = 0; i < fills.length; i++) {
    var f = fills[i];
    if (f.visible === false) continue;
    if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL' ||
        f.type === 'GRADIENT_ANGULAR' || f.type === 'GRADIENT_DIAMOND') return true;
    if (f.type === 'SOLID' && f.color) {
      var r = f.color.r || 0, g = f.color.g || 0, b = f.color.b || 0;
      if (Math.abs(r - g) > tol || Math.abs(g - b) > tol || Math.abs(r - b) > tol) return true;
    }
  }
  return false;
}

// 统计子树内几何叶子数；若含 INSTANCE / 可见文字 / 图片填充 / 彩色渐变则视为非「纯手绘图标」
function summarizePrimitiveIconSubtree(node, depth) {
  if (depth > 14) return { bad: true };
  if (node.visible === false) return {};
  if (node.type === 'INSTANCE') return { hasInstance: true };
  if (node.type === 'TEXT') {
    var ch = safeStr(node.characters);
    return { hasText: !!(ch && ch.replace(/\s/g, '').length > 0) };
  }
  if (PRIMITIVE_GEOM_TYPES[node.type]) {
    if (nodeHasVisibleImageFill(node)) return { hasRaster: true };
    if (nodeHasColorOrGradientFill(node)) return { hasColor: true };
    return { primitives: 1 };
  }
  if (ICON_CONTAINER_TYPES[node.type]) {
    if (nodeHasVisibleImageFill(node)) return { hasRaster: true };
    if (nodeHasColorOrGradientFill(node)) return { hasColor: true };
    if (!node.children) return {};
    var p = 0, hasText = false, hasInst = false, hasRaster = false, hasColor = false;
    for (var i = 0; i < node.children.length; i++) {
      var s = summarizePrimitiveIconSubtree(node.children[i], depth + 1);
      if (s.bad) return { bad: true };
      if (s.hasInstance) hasInst = true;
      if (s.hasText) hasText = true;
      if (s.hasRaster) hasRaster = true;
      if (s.hasColor) hasColor = true;
      p += s.primitives || 0;
    }
    return { primitives: p, hasText: hasText, hasInstance: hasInst, hasRaster: hasRaster, hasColor: hasColor };
  }
  return {};
}

function tryPrimitiveIconViolation(node, path) {
  if (!ICON_CONTAINER_TYPES[node.type]) return null;
  var rules = CFG.iconRules;
  var w = node.width || 0, h = node.height || 0;
  if (w < rules.sizeRange[0] || h < rules.sizeRange[0] ||
      w > rules.sizeRange[1] || h > rules.sizeRange[1]) return null;
  var ar = w / Math.max(h, 0.01);
  if (ar < rules.aspectRange[0] || ar > rules.aspectRange[1]) return null;
  var s = summarizePrimitiveIconSubtree(node, 0);
  if (s.bad || s.hasInstance || s.hasText || s.hasRaster || s.hasColor) return null;
  var n = s.primitives || 0;
  if (n < rules.minPrimitives) return null;
  return {
    id: node.id,
    name: node.name,
    breadcrumb: path,
    size: Math.round(w) + '×' + Math.round(h),
    score: 68,
    kind: 'icon-primitive',
    detail: tpl('iconPrimitive', { n: n }),
    suggest: tpl('iconPrimitiveSuggest'),
  };
}

// Figma 默认几何图层命名（手画/未接组件时常见）
function isDefaultFigmaGeomName(nm) {
  if (!nm || typeof nm !== 'string') return false;
  if (/^vector\b/i.test(nm)) return true;
  if (/^union\b/i.test(nm)) return true;
  if (/^subtract\b/i.test(nm)) return true;
  if (/^intersect\b/i.test(nm)) return true;
  if (/^exclude\b/i.test(nm)) return true;
  if (/^ellipse\b/i.test(nm)) return true;
  if (/^rectangle\b/i.test(nm)) return true;
  if (/^polygon\b/i.test(nm)) return true;
  if (/^star\b/i.test(nm)) return true;
  if (/^line\b/i.test(nm)) return true;
  return false;
}

// 单图层合并路径：VECTOR 读 vectorNetwork；BOOLEAN/STAR/POLYGON 视为复合图形
function tryMergedVectorIconViolation(node, path, parentStructural) {
  var MERGED_TYPES = { VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, POLYGON: 1 };
  if (!MERGED_TYPES[node.type]) return null;
  // 父容器已是「多碎图层图标」时只报父级，避免与多子 Vector 重复
  if (parentStructural && ICON_CONTAINER_TYPES[parentStructural.type]) {
    var sp = summarizePrimitiveIconSubtree(parentStructural, 0);
    if (!sp.bad && !sp.hasInstance && !sp.hasText && !sp.hasRaster && (sp.primitives || 0) >= CFG.iconRules.minPrimitives) {
      return null;
    }
  }
  var rules = CFG.iconRules;
  var w = node.width || 0, h = node.height || 0;
  if (w < rules.sizeRange[0] || h < rules.sizeRange[0] ||
      w > rules.sizeRange[1] || h > rules.sizeRange[1]) return null;
  var ar = w / Math.max(h, 0.01);
  if (ar < rules.aspectRange[0] || ar > rules.aspectRange[1]) return null;
  if (nodeHasVisibleImageFill(node)) return null;
  if (nodeHasColorOrGradientFill(node)) return null;

  var nm = typeof node.name === 'string' ? node.name : '';
  var defaultName = isDefaultFigmaGeomName(nm);
  var complex = false;
  var segN = 0;
  var vertN = 0;

  if (node.type === 'VECTOR') {
    try {
      var vn = node.vectorNetwork;
      if (vn && vn.segments) segN = vn.segments.length;
      if (vn && vn.vertices) vertN = vn.vertices.length;
      if (segN >= rules.mergedVectorMinSegments || vertN >= rules.mergedVectorMinVertices) complex = true;
    } catch (e0) {}
  }
  if (node.type === 'BOOLEAN_OPERATION') {
    complex = true;
  }

  if (!complex && !defaultName) return null;
  if (!complex && defaultName && (w > rules.defaultNameMaxSize || h > rules.defaultNameMaxSize)) return null;

  var hint = complex ? tpl('iconHintComplex') : tpl('iconHintDefault');

  return {
    id: node.id,
    name: node.name,
    breadcrumb: path,
    size: Math.round(w) + '×' + Math.round(h),
    score: 65,
    kind: 'icon-primitive',
    detail: tpl('iconMerged', { hint: hint }),
    suggest: tpl('iconMergedSuggest'),
  };
}

function collectPrimitiveIconViolations(nodes, breadcrumb, out, depth, parentStructural) {
  if (depth > 16 || out.length >= 100) return;

  // Case 3: 当前节点是 BOOLEAN_OPERATION 的子形状（组成合并形状的部件），整层跳过
  if (parentStructural && parentStructural.type === 'BOOLEAN_OPERATION') return;

  // Case 1: 兄弟节点有包围盒重叠 → 复杂图形/Logo 上下文，当前层不做图标检测，但继续向下递归
  var siblingOverlap = hasSiblingBBoxOverlap(nodes);

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.visible === false) continue;
    if (node.type === 'INSTANCE') continue;

    // Case 2: 完全在父 Frame 裁剪区外 → 不可见，跳过
    if (isOutsideFrameClip(node)) continue;

    var nm = typeof node.name === 'string' ? node.name : '';
    if (hasSkipPrefix(nm)) {
      if (node.children) {
        collectPrimitiveIconViolations([].slice.call(node.children), breadcrumb, out, depth + 1, node);
      }
      continue;
    }
    if (isAnnotationFrame(nm)) continue;
    var path = breadcrumb.concat([nm || '#']);

    // Case 1: 有兄弟重叠时跳过本层图标检测（是复杂图形一部分）
    if (!siblingOverlap) {
      var hit = tryPrimitiveIconViolation(node, path);
      if (hit) { out.push(hit); continue; }
      var mv = tryMergedVectorIconViolation(node, path, parentStructural);
      if (mv) { out.push(mv); continue; }
    }

    // Case 3: 不递归进入 BOOLEAN_OPERATION 的子形状
    if (node.children && node.type !== 'BOOLEAN_OPERATION') {
      collectPrimitiveIconViolations([].slice.call(node.children), path, out, depth + 1, node);
    }
  }
}

// 同一簇内外层都命中时，只保留更内层（路径更长）
function dedupePrimitiveIconViolations(items) {
  function isStrictPrefix(shortA, longB) {
    if (longB.length <= shortA.length) return false;
    for (var i = 0; i < shortA.length; i++) {
      if (shortA[i] !== longB[i]) return false;
    }
    return true;
  }
  var sorted = items.slice().sort(function(a, b) { return b.breadcrumb.length - a.breadcrumb.length; });
  var res = [];
  for (var i = 0; i < sorted.length; i++) {
    var c = sorted[i];
    var skip = false;
    for (var j = 0; j < res.length; j++) {
      if (isStrictPrefix(c.breadcrumb, res[j].breadcrumb)) { skip = true; break; }
    }
    if (skip) continue;
    res.push(c);
  }
  return res;
}

// 判定是否是导航栏容器：顶部导航（isHeaderLike）或底部导航（宽≥320，高 49-96，
// 子项为多个图标+文字垂直组合）
function isNavContainer(node, children, fp) {
  if (fp.isHeaderLike) return true;
  var w = node.width || 0;
  var h = node.height || 0;
  if (w < 320 || h < 40 || h > 100) return false;
  // 底部导航：≥3 个子项，每个子项内部含 vector/icon + text（垂直堆叠）
  if (children.length < 3 || children.length > 6) return false;
  var colLike = 0;
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    if (!c.children) continue;
    var hasIcon = false, hasText = false;
    for (var k = 0; k < c.children.length; k++) {
      var g = c.children[k];
      if (g.type === 'TEXT') hasText = true;
      if (g.type === 'VECTOR' || g.type === 'BOOLEAN_OPERATION' || g.type === 'INSTANCE' ||
          (g.type === 'FRAME' && (g.width || 0) <= 40)) hasIcon = true;
    }
    if (hasIcon && hasText) colLike++;
  }
  return colLike >= 3;
}

// ─── 非库组件检测（INSTANCE 但主组件不来自指定组件库）──────────────────────
//
// 判断优先级：
//   1. mainComponent === null        → 已断开（Detached），一定不合规
//   2. mainComponent.key 在白名单    → 来自指定库，合规
//   3. mainComponent.key 不在白名单  → 来自其他库或本地组件，不合规
//
// 白名单来源：sync_library.js 从组件库文件抓取的所有 component key，
// 存于 FINGERPRINTS_DATA.libraryComponentKeys（数组），运行时转为 Set。
var _LIB_KEYS_SET = null;
function getLibKeySet() {
  if (_LIB_KEYS_SET) return _LIB_KEYS_SET;
  _LIB_KEYS_SET = {};
  var keys = (FINGERPRINTS_DATA && FINGERPRINTS_DATA.libraryComponentKeys) || [];
  for (var ki = 0; ki < keys.length; ki++) _LIB_KEYS_SET[keys[ki]] = 1;
  return _LIB_KEYS_SET;
}

// 判断是否为系统级组件（状态栏、导航栏、键盘、系统弹窗等），这类组件豁免走查
// pattern 优先从 CFG.exemptions.systemPatterns（由 library-config.json 注入）读取
function isSystemComponent(name, mcName) {
  var n = (name || '') + ' ' + (mcName || '');
  if (!n.trim()) return false;
  var patterns = (CFG.exemptions && Array.isArray(CFG.exemptions.systemPatterns) && CFG.exemptions.systemPatterns.length > 0)
    ? CFG.exemptions.systemPatterns
    : ['状态栏', 'status.?bar', '键盘', 'keyboard', '灵动岛', 'home.?indicator', 'safe.?area', 'system'];
  try { return new RegExp(patterns.join('|'), 'i').test(n); } catch(e) { return false; }
}

function collectNonLibraryInstances(nodes, breadcrumb, out, depth, parentFrame) {
  if (depth > 16 || out.length >= 300) return;
  var libKeys = getLibKeySet();
  var hasKeyList = Object.keys(libKeys).length > 0;

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.visible === false) continue;
    if (isOutsideFrameClip(node)) continue;
    var nm = typeof node.name === 'string' ? node.name : '';
    if (isAnnotationFrame(nm)) continue;
    var path = breadcrumb.concat([nm || '#']);

    if (node.type === 'INSTANCE') {
      var mc = null;
      try { mc = node.mainComponent; } catch(e) {}

      if (!mc) {
        if (CFG.nonLibraryRules.skipDetached) { continue; }
      }

      // 系统级组件整体豁免（状态栏、键盘、导航栏等不属于业务组件范畴）
      var mcName = mc && mc.name ? mc.name : '';
      if (isSystemComponent(nm, mcName)) { continue; }

      var fromOurLibrary = false;
      if (mc && hasKeyList) {
        fromOurLibrary = !!libKeys[mc.key];
      } else if (mc) {
        fromOurLibrary = mc.remote === true;
      }

      if (!fromOurLibrary) {
        var w = node.width || 0;
        var h = node.height || 0;

        if (h > CFG.nonLibraryRules.maxHeight) { continue; }

        var detail;
        if (mc && !mc.remote) {
          detail = tpl('nonLibraryLocal');
        } else {
          detail = tpl('nonLibraryRemote');
        }
        // 提取指纹发给 UI 端做二次评分：只有视觉上高度匹配库组件才真正上报
        var instChildren = node.children ? [].slice.call(node.children) : [];
        var instFp = extractFingerprint(node, instChildren);
        instFp.sib = 1;
        out.push({
          kind: 'non-library-instance',
          id: node.id,
          name: nm,
          breadcrumb: path,
          size: Math.round(w) + '×' + Math.round(h),
          score: 88,
          detail: detail,
          suggest: '',
          fp: instFp,
        });
      }
      // 不递归进入 INSTANCE 子树
      continue;
    }

    if (node.children) {
      collectNonLibraryInstances([].slice.call(node.children), path, out, depth + 1, node);
    }
  }
}

// ─── 栅格边距建议（走查建议，不计入问题总数）────────────────────────────────
// 只检查"屏幕级 Frame"（宽 320-430，高 ≥ 400）的直接可见子元素
// 如果子元素左/右边距 0 < gap ≤ 22 且不在 [8,12,16,20] 中，报建议
// VALID_MARGINS 在运行时从 CFG 动态生成（每次调用时重建，支持远端更新）
function getValidMarginsSet() {
  var s = {}, v = CFG.layoutRules.validMargins || [];
  for (var _i = 0; _i < v.length; _i++) s[v[_i]] = 1;
  return s;
}

function collectMarginSuggestions(nodes, breadcrumb, out) {
  if (!CFG.features.checkMargin) return;
  var lr = CFG.layoutRules;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.visible === false) continue;
    if (isOutsideFrameClip(node)) continue;
    var nm = typeof node.name === 'string' ? node.name : '';
    if (isAnnotationFrame(nm)) continue;

    var w = node.width || 0;
    var h = node.height || 0;
    var isScreen = (node.type === 'FRAME') &&
      w >= lr.screenWidthRange[0] && w <= lr.screenWidthRange[1] && h >= lr.screenMinHeight;

    if (isScreen && node.children) {
      var path = breadcrumb.concat([nm]);
      var children = [].slice.call(node.children);
      var validM = getValidMarginsSet();
      var maxGap = lr.marginMaxGap;
      var validStr = (lr.validMargins || []).join(' / ');
      for (var j = 0; j < children.length; j++) {
        var child = children[j];
        if (child.visible === false) continue;
        if (isOutsideFrameClip(child)) continue;
        var cw = child.width || 0;
        var cx = child.x != null ? child.x : 0;
        var childNm = typeof child.name === 'string' ? child.name : '#';
        var childPath = path.concat([childNm]);
        var childSize = Math.round(cw) + '×' + Math.round(child.height || 0);

        var leftGap = cx;
        var rightGap = w - (cx + cw);

        if (leftGap >= 0 && leftGap <= maxGap && !validM[Math.round(leftGap)]) {
          out.push({
            kind: 'margin-hint', id: child.id, name: childNm,
            breadcrumb: childPath, size: childSize,
            detail: tpl('marginInvalid', { side: tpl('marginSideLeft'), actual: Math.round(leftGap), valid: validStr }),
            side: 'left', actual: Math.round(leftGap),
          });
        }
        if (rightGap >= 0 && rightGap <= maxGap && !validM[Math.round(rightGap)]) {
          out.push({
            kind: 'margin-hint', id: child.id, name: childNm,
            breadcrumb: childPath, size: childSize,
            detail: tpl('marginInvalid', { side: tpl('marginSideRight'), actual: Math.round(rightGap), valid: validStr }),
            side: 'right', actual: Math.round(rightGap),
          });
        }
      }
    }

    if (node.children && node.type !== 'INSTANCE') {
      var np = breadcrumb.concat([nm || '#']);
      collectMarginSuggestions([].slice.call(node.children), np, out);
    }
  }
}

// ─── 布局清洁度建议（空容器 + 无意义嵌套）──────────────────────────────────
function collectLayoutSuggestions(nodes, breadcrumb, out, depth) {
  if (!CFG.features.checkLayout) return;
  if (depth > CFG.layoutRules.layoutMaxDepth || out.length >= 200) return;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.visible === false) continue;
    if (isOutsideFrameClip(node)) continue;
    var nm = typeof node.name === 'string' ? node.name : '';
    if (hasSkipPrefix(nm)) continue;
    if (isAnnotationFrame(nm)) continue;
    if (node.type !== 'FRAME' && node.type !== 'GROUP') {
      // 非容器：继续向下找
      if (node.children && node.type !== 'INSTANCE') {
        collectLayoutSuggestions([].slice.call(node.children), breadcrumb.concat([nm || '#']), out, depth + 1);
      }
      continue;
    }

    var path = breadcrumb.concat([nm || '#']);
    var children = node.children ? [].slice.call(node.children) : [];
    var visibleChildren = children.filter(function(c){ return c.visible !== false; });
    var hasHiddenChildren = children.length > visibleChildren.length;

    // 辅助：节点自身有视觉属性（填充/描边/阴影/圆角）
    var nodeHasFill = safeArray(node.fills).some(function(f){ return f.visible !== false; });
    var nodeHasStroke = safeArray(node.strokes).some(function(s){ return s.visible !== false; });
    var nodeHasShadow = safeArray(node.effects).some(function(e){
      return e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW');
    });
    var nodeCr = safeNum(node.cornerRadius);
    var nodeHasRadius = nodeCr !== null && nodeCr > 0;
    var nodeHasVisualProps = nodeHasFill || nodeHasStroke || nodeHasShadow || nodeHasRadius;

    // a. 空容器：无可见子节点
    // 豁免：① 自身带视觉属性（可能是有意保留的占位 Frame）
    //       ② 有隐藏子图层（设计师有意隐藏，容器本身有用途）
    if (visibleChildren.length === 0) {
      if (!nodeHasVisualProps && !hasHiddenChildren) {
        out.push({
          kind: 'layout-hint', subkind: 'empty',
          id: node.id, name: nm, breadcrumb: path,
          size: Math.round(node.width || 0) + '×' + Math.round(node.height || 0),
          detail: tpl('layoutEmpty', { type: node.type }),
        });
      }
      continue;
    }

    // b. 无意义嵌套：唯一可见子节点是容器，且自身无视觉属性
    // 豁免：① 有隐藏子图层（多子层场景，隐藏层是有意保留的备用状态）
    if (visibleChildren.length === 1 && !hasHiddenChildren) {
      var onlyChild = visibleChildren[0];
      var childIsContainer = (onlyChild.type === 'FRAME' || onlyChild.type === 'GROUP');
      if (childIsContainer && node.type === 'FRAME' && !nodeHasVisualProps) {
        out.push({
          kind: 'layout-hint', subkind: 'redundant-wrap',
          id: node.id, name: nm, breadcrumb: path,
          size: Math.round(node.width || 0) + '×' + Math.round(node.height || 0),
          detail: tpl('layoutRedundant', { childType: onlyChild.type }),
        });
      }
    }

    // 继续向下递归（不进 INSTANCE）
    collectLayoutSuggestions(visibleChildren, path, out, depth + 1);
  }
}

// ─── 消息处理 ────────────────────────────────────────────────────────────
figma.ui.onmessage = function(msg) {
  try {
    // UI 拉取到远端指纹后把 config 回传，覆盖插件端参数
    if (msg.type === 'config') {
      loadCFG(msg.config);
    }

    if (msg.type === 'ready') {
      figma.ui.postMessage({
        type: 'init',
        fingerprints: FINGERPRINTS_DATA,
        fileKey: figma.fileKey || '',
        pageName: figma.currentPage ? figma.currentPage.name : '',
      });
    }

    if (msg.type === 'scan') {
      var selection = figma.currentPage.selection;
      var roots;
      var scope;
      if (selection.length === 0) {
        // 扫全页
        roots = [].slice.call(figma.currentPage.children);
        scope = '当前页面（' + figma.currentPage.name + '）';
      } else {
        roots = [].slice.call(selection);
        scope = selection.map(function(n){ return n.name; }).join('、');
      }

      var candidates = [];
      var styleIssues = [];
      var rawIconIssues = [];
      var nonLibraryIssues = [];
      var marginSuggestions = [];
      var layoutSuggestions = [];
      var F = CFG.features;
      var fsMin = CFG.traversal.fullscreenMin;
      var minSize = CFG.traversal.minSize;
      for (var i = 0; i < roots.length; i++) {
        var r = roots[i];
        if (F.checkColorStyle || F.checkTextStyle) collectStyleViolations([r], [], styleIssues, 0, null);
        if (F.checkIcon) collectPrimitiveIconViolations([r], [], rawIconIssues, 0, null);
        if (F.checkNonLibrary) collectNonLibraryInstances([r], [], nonLibraryIssues, 0, null);
        if (F.checkMargin) collectMarginSuggestions([r], [], marginSuggestions);
        if (F.checkLayout) collectLayoutSuggestions([r], [], layoutSuggestions, 0);
        if (F.checkComponent && STRUCTURAL_TYPES[r.type]) {
          var rChildren = r.children ? [].slice.call(r.children) : [];
          var w = r.width || 0, h = r.height || 0;
          if (!(w >= fsMin[0] && h >= fsMin[1]) && (w >= minSize && h >= minSize)) {
            candidates.push({
              id: r.id,
              name: r.name,
              breadcrumb: [r.name],
              size: Math.round(w) + '×' + Math.round(h),
              fp: extractFingerprint(r, rChildren),
            });
          }
          traverse(rChildren, [r.name], candidates, 1);
        }
      }

      figma.ui.postMessage({
        type: 'scan-result',
        candidates: candidates,
        styleIssues: styleIssues,
        iconIssues: dedupePrimitiveIconViolations(rawIconIssues),
        nonLibraryIssues: nonLibraryIssues,
        marginSuggestions: marginSuggestions,
        layoutSuggestions: layoutSuggestions,
        scope: scope,
      });
    }

    if (msg.type === 'focus-node') {
      figma.getNodeByIdAsync(msg.nodeId).then(function(node) {
        if (node) {
          figma.currentPage.selection = [node];
          figma.viewport.scrollAndZoomIntoView([node]);
        }
      });
    }

    if (msg.type === 'close') figma.closePlugin();
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: '插件出错: ' + String(e) });
  }
};
