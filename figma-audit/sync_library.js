#!/usr/bin/env node
/**
 * sync_library.js — Figma 组件库样式指纹提取脚本
 *
 * 从组件库文件中提取：
 *   1. styles_registry  — 所有颜色/描边/文字样式的名称映射
 *   2. components_registry — 每个组件/变体的视觉 DNA（尺寸、圆角、样式关联、文字、渐变）
 *
 * 用法：
 *   node sync_library.js
 *   FIGMA_ACCESS_TOKEN=xxx LIBRARY_FILE_KEY=yyy node sync_library.js
 *   node sync_library.js --out my_fingerprints.json
 *
 * 配置优先级：环境变量 > config.json
 */

import { request } from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ─── 读取 library-config.json（可选，不存在则用内置默认规则）──────────────
let LIBRARY_CONFIG = null;
try {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), 'library-config.json');
  if (existsSync(configPath)) {
    LIBRARY_CONFIG = JSON.parse(readFileSync(configPath, 'utf-8'));
  }
} catch (e) {
  console.warn('⚠️  library-config.json 读取失败，使用内置分类规则。', e.message);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_BATCH = 50;   // 每批请求的节点数（避免 URL 过长）
const BATCH_DELAY = 200; // 批次间隔 ms（避免频率限制）

// ─── 配置加载 ────────────────────────────────────────────────────────────────

function loadConfig() {
  const argv = parseArgs(process.argv.slice(2));

  let config = {};
  try {
    const configPath = join(__dirname, 'config.json');
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    // config.json 不存在时忽略，依赖环境变量
  }

  const token = process.env.FIGMA_ACCESS_TOKEN || config.figma?.token;
  const fileKey = process.env.LIBRARY_FILE_KEY || config.figma?.libraryFileId;
  const outFile = argv.out || 'library_fingerprints.json';

  if (!token || token.includes('YOUR_')) {
    console.error('❌ 未找到 FIGMA_ACCESS_TOKEN，请设置环境变量或在 config.json 中配置 figma.token');
    process.exit(1);
  }
  if (!fileKey || fileKey.includes('YOUR_')) {
    console.error('❌ 未找到 LIBRARY_FILE_KEY，请设置环境变量或在 config.json 中配置 figma.libraryFileId');
    process.exit(1);
  }

  return { token, fileKey, outFile };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return args;
}

// ─── HTTP 工具 ───────────────────────────────────────────────────────────────

function figmaGet(path, token, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining, delay) => {
      const req = request(
        { hostname: 'api.figma.com', path: `/v1${path}`, method: 'GET', headers: { 'X-Figma-Token': token } },
        res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode === 429 || res.statusCode >= 500) {
              if (remaining > 0) {
                console.warn(`  [重试] HTTP ${res.statusCode}，${delay / 1000}s 后重试...`);
                setTimeout(() => attempt(remaining - 1, delay * 2), delay);
              } else {
                reject(new Error(`HTTP ${res.statusCode} after retries: ${path}`));
              }
              return;
            }
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode} on ${path}: ${data.slice(0, 200)}`));
              return;
            }
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error(`JSON parse error on ${path}: ${e.message}`)); }
          });
        }
      );
      req.on('error', err => {
        if (remaining > 0) {
          console.warn(`  [重试] 网络错误: ${err.message}，${delay / 1000}s 后重试...`);
          setTimeout(() => attempt(remaining - 1, delay * 2), delay);
        } else {
          reject(err);
        }
      });
      req.end();
    };
    attempt(retries, 1000);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 第一步：样式注册表 ───────────────────────────────────────────────────────

async function fetchStylesRegistry(token, fileKey) {
  console.log('[1/4] 拉取样式注册表...');
  const data = await figmaGet(`/files/${fileKey}/styles`, token);
  const styles = data.meta?.styles || [];

  const registry = {};
  // 保留原始样式列表供后续拉取颜色值
  const rawStyles = [];

  for (const s of styles) {
    const entry = {
      name: s.name,
      styleType: s.style_type, // FILL | STROKE | TEXT | EFFECT
      description: s.description || '',
    };
    // 双 key 索引：node_id 格式（库文件内引用）和 S:{key} 格式（跨文件引用）
    registry[s.node_id] = entry;
    if (s.key) {
      registry[`S:${s.key}`] = entry;
    }
    rawStyles.push({ node_id: s.node_id, key: s.key, style_type: s.style_type });
  }

  console.log(`  ✓ 找到 ${styles.length} 个样式（已建立双 key 索引）`);
  return { registry, rawStyles };
}

// ─── 补充步骤：批量拉取 FILL 样式节点的实际颜色值 ───────────────────────────

async function enrichFillStyleColors(token, fileKey, registry, rawStyles) {
  const fillStyles = rawStyles.filter(s => s.style_type === 'FILL');
  if (fillStyles.length === 0) {
    console.log('[2/4] 无 FILL 样式，跳过颜色提取');
    return;
  }

  console.log(`[2/4] 拉取 ${fillStyles.length} 个 FILL 样式的实际颜色值...`);

  const nodeIds = fillStyles.map(s => s.node_id);
  const batches = [];
  for (let i = 0; i < nodeIds.length; i += NODE_BATCH) {
    batches.push(nodeIds.slice(i, i + NODE_BATCH));
  }

  let successCount = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    process.stdout.write(`  第 ${i + 1}/${batches.length} 批颜色 (${batch.length} 个)... `);

    try {
      const ids = batch.map(id => encodeURIComponent(id)).join(',');
      const data = await figmaGet(`/files/${fileKey}/nodes?ids=${ids}`, token);
      const nodes = data.nodes || {};

      for (const [nodeId, nodeWrapper] of Object.entries(nodes)) {
        const node = nodeWrapper?.document;
        if (!node) continue;

        const color = extractFirstSolidColor(node);
        if (color) {
          // 更新双 key 索引里的两个条目（指向同一对象，直接修改即可）
          if (registry[nodeId]) registry[nodeId].color = color;
          // S:key 格式的条目与 node_id 条目指向同一对象，自动更新
          successCount++;
        }
      }
      console.log(`✓`);
    } catch (err) {
      console.warn(`✗ 失败: ${err.message}`);
    }

    if (i < batches.length - 1) await sleep(BATCH_DELAY);
  }

  console.log(`  ✓ 成功提取颜色: ${successCount}/${fillStyles.length} 个 FILL 样式`);
}

/**
 * 从样式节点提取第一个有效纯色填充
 * 只返回 SOLID 类型的颜色；IMAGE/渐变/无填充返回 null
 * 返回格式：{ r, g, b, a }，r/g/b 为 0-255 整数，a 为 0-1 小数
 */
function extractFirstSolidColor(node) {
  const fills = node.fills || [];
  for (const fill of fills) {
    if (fill.visible === false) continue;
    if (fill.type === 'SOLID' && fill.color) {
      const { r, g, b, a: colorA } = fill.color;
      // 最终 alpha = fill.color.a × fill.opacity（两者都可能影响透明度）
      const finalA = (colorA ?? 1) * (fill.opacity ?? 1);
      return {
        r: Math.round(r * 255),
        g: Math.round(g * 255),
        b: Math.round(b * 255),
        a: Math.round(finalA * 1000) / 1000,
      };
    }
    // IMAGE / 渐变 → 无法提取单色，返回 null
  }
  return null;
}

// ─── 第三步：组件和变体列表 ──────────────────────────────────────────────────

async function fetchComponentList(token, fileKey) {
  console.log('[3/4] 拉取组件和变体列表...');

  const [compData, setData] = await Promise.all([
    figmaGet(`/files/${fileKey}/components`, token),
    figmaGet(`/files/${fileKey}/component_sets`, token),
  ]);

  const components = compData.meta?.components || [];
  const componentSets = setData.meta?.component_sets || [];

  // 建立 componentSet nodeId → 名称的映射
  const setNameMap = new Map();
  for (const cs of componentSets) {
    setNameMap.set(cs.node_id, cs.name);
  }

  const entries = [];

  // 独立组件
  for (const comp of components) {
    entries.push({
      nodeId: comp.node_id,
      key: comp.key || null,          // 全局唯一组件 key（与 mainComponent.key 对应）
      name: comp.name,
      componentSetName: comp.containing_frame?.containingComponentSet?.name || null,
      isVariant: !!comp.containing_frame?.containingComponentSet,
      thumbnailUrl: comp.thumbnail_url || null,
      pageName: comp.containing_frame?.pageName || '',
    });
  }

  // ComponentSet 本身（变体容器）
  for (const cs of componentSets) {
    entries.push({
      nodeId: cs.node_id,
      key: cs.key || null,            // 全局唯一 key
      name: cs.name,
      componentSetName: cs.name,
      isVariant: false,
      isComponentSet: true,
      thumbnailUrl: cs.thumbnail_url || null,
      pageName: cs.containing_frame?.pageName || '',
    });
  }

  console.log(`  ✓ 独立组件: ${components.length}，变体组(ComponentSet): ${componentSets.length}`);
  return entries;
}

// ─── 第四步：批量拉取节点详情 ────────────────────────────────────────────────

async function fetchNodeDetails(token, fileKey, nodeIds) {
  const total = nodeIds.length;
  const batches = [];
  for (let i = 0; i < total; i += NODE_BATCH) {
    batches.push(nodeIds.slice(i, i + NODE_BATCH));
  }

  console.log(`[4/4] 批量拉取节点详情：${total} 个节点，共 ${batches.length} 批...`);

  const nodeMap = new Map();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    process.stdout.write(`  第 ${i + 1}/${batches.length} 批 (${batch.length} 个)... `);

    try {
      const ids = batch.map(id => encodeURIComponent(id)).join(',');
      const data = await figmaGet(`/files/${fileKey}/nodes?ids=${ids}`, token);

      const nodes = data.nodes || {};
      for (const [nodeId, nodeWrapper] of Object.entries(nodes)) {
        if (nodeWrapper?.document) {
          nodeMap.set(nodeId, nodeWrapper.document);
        }
      }
      console.log(`✓ 获取 ${Object.keys(nodes).length} 个`);
    } catch (err) {
      console.warn(`✗ 失败: ${err.message}`);
    }

    if (i < batches.length - 1) {
      await sleep(BATCH_DELAY);
    }
  }

  return nodeMap;
}

// ─── DNA 提取 ────────────────────────────────────────────────────────────────

// 颜色量化：RGB → HSL 色块名（red/orange/yellow/green/cyan/blue/purple/pink/gray/white/black）
function rgbToColorBucket(r, g, b) {
  // 输入 0-1
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2; // 亮度
  const s = max === min ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)); // 饱和度

  // 先判断灰阶
  if (l >= 0.95) return 'white';
  if (l <= 0.08) return 'black';
  if (s <= 0.12) return 'gray';

  // 有色：算色相
  let h;
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

// 把十六进制或 Figma 颜色对象转成色块
function colorObjToBucket(color) {
  if (!color) return null;
  const { r, g, b } = color;
  if (r == null) return null;
  return rgbToColorBucket(r, g, b);
}

// 提取主色（取第一个可见的 SOLID 填充或渐变的首个 stop）
function extractDominantColor(node) {
  const fills = node.fills || [];
  for (const f of fills) {
    if (f.visible === false) continue;
    if (f.type === 'SOLID') return colorObjToBucket(f.color);
    if (f.type && f.type.startsWith('GRADIENT') && f.gradientStops && f.gradientStops.length > 0) {
      return colorObjToBucket(f.gradientStops[0].color);
    }
  }
  return null;
}

// 计算子节点组成签名（类型分布）
function extractChildSignature(children) {
  const sig = { text: 0, vector: 0, image: 0, frame: 0, instance: 0, other: 0 };
  const iconSize = 24; // 小于此尺寸的 FRAME/VECTOR 视为 icon
  let iconCount = 0;

  for (const c of children) {
    if (c.type === 'TEXT') sig.text++;
    else if (c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION' || c.type === 'STAR' || c.type === 'POLYGON' || c.type === 'LINE') sig.vector++;
    else if (c.type === 'INSTANCE') sig.instance++;
    else if (c.type === 'FRAME' || c.type === 'GROUP' || c.type === 'COMPONENT') sig.frame++;
    else sig.other++;

    // icon 启发：小尺寸的 vector/frame
    const bbox = c.absoluteBoundingBox;
    if (bbox && bbox.width && bbox.width <= iconSize && bbox.height <= iconSize) {
      const fills = c.fills || [];
      const hasImage = fills.some(f => f.type === 'IMAGE');
      if (hasImage) sig.image++;
      if (c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION' ||
          (c.type === 'FRAME' && c.children && c.children.some(gc => gc.type === 'VECTOR'))) {
        iconCount++;
      }
    }

    // 图片检测（任意尺寸）
    const fills = c.fills || [];
    if (fills.some(f => f.type === 'IMAGE')) sig.image++;
  }
  return { ...sig, icon: iconCount };
}

// ─── 组件类别分类（两套系统共享）───────────────────────────────────────────
// 给每个组件按 groupName 映射一个 category，匹配器用它做相容性过滤。
// 根据 library-config.json 的 classification.rules 动态生成分类函数
// 若无配置则回退到内置规则（兜底，保持向后兼容）
function classifyComponent(groupName) {
  if (!groupName) return 'exclude';
  const n = String(groupName);

  // 优先使用 library-config.json 配置的规则
  if (LIBRARY_CONFIG && LIBRARY_CONFIG.classification && Array.isArray(LIBRARY_CONFIG.classification.rules)) {
    for (const rule of LIBRARY_CONFIG.classification.rules) {
      try {
        const flags = rule.flags || '';
        const re = new RegExp(rule.pattern, flags);
        if (re.test(n)) return rule.category;
      } catch (e) {
        console.warn(`⚠️  分类规则 pattern 无效: "${rule.pattern}"，已跳过`);
      }
    }
    return LIBRARY_CONFIG.classification.defaultCategory || 'generic';
  }

  // ─── 内置兜底规则（仅在无 library-config.json 时生效）────────────────
  const lo = n.toLowerCase();
  if (/底部导航/.test(n)) return 'exclude';
  if (/status\s*bar/i.test(n)) return 'exclude';
  if (/home\s*indicator/i.test(n)) return 'exclude';
  if (/^\d+px[\/\s]/.test(n)) return 'exclude';
  if (/emoji/i.test(n)) return 'exclude';
  if (/logo/i.test(n)) return 'exclude';
  if (/插画|illustration/i.test(n)) return 'exclude';
  if (/封面/.test(n)) return 'exclude';
  if (/\.图/.test(n)) return 'exclude';
  if (/空态|空页|空白页|empty\s*state/i.test(n)) return 'exclude';
  if (/^搜[前中后]$/.test(n) || /搜索页|搜索容器/.test(n)) return 'exclude';
  if (/系统键盘|keyboard/i.test(n)) return 'exclude';
  if (/^联想提示$/.test(n)) return 'exclude';
  if (/^频道通用$/.test(n)) return 'exclude';
  if (/倒计时/.test(n)) return 'countdown';
  if (/评分/.test(n)) return 'rating';
  if (/货币|金额/.test(n) && !/输入/.test(n)) return 'currency';
  if (/输入/.test(n)) return 'input';
  if (/开关|switch/i.test(n)) return 'switch';
  if (/进度|progress/i.test(n)) return 'progress';
  if (/导航/.test(n) && !/底部/.test(n)) return 'nav_top';
  if (/tab\s*栏|tab\s*bar/i.test(n) || /一级tab|二级tab/i.test(n)) return 'tab';
  if (/toast/i.test(n)) return 'toast';
  if (/弹窗|dialog|modal/i.test(n)) return 'dialog';
  if (/券/.test(n)) return 'coupon';
  if (/头像|avatar/i.test(n)) return 'avatar';
  if (/悬浮提示/.test(n) || /气泡菜单/.test(n) || /tooltip/i.test(n)) return 'tooltip';
  if (/按钮/.test(n)) return 'button';
  if (/tag/i.test(lo) || /标签/.test(n)) return 'tag';
  if (/卡片|card/i.test(lo)) return 'card';
  return 'generic';
}

// 子节点组成的简化字符串表示，便于比较
function childSigToString(sig) {
  const parts = [];
  if (sig.text) parts.push('T' + sig.text);
  if (sig.icon) parts.push('I' + sig.icon);
  if (sig.image) parts.push('M' + sig.image);
  if (sig.instance) parts.push('N' + sig.instance);
  if (sig.frame) parts.push('F' + sig.frame);
  if (sig.vector) parts.push('V' + sig.vector);
  return parts.join('-') || 'empty';
}

function extractDNA(node) {
  if (!node) return null;

  const bbox = node.absoluteBoundingBox || {};
  const children = node.children || [];

  // ─── 基础填充/描边 ───
  const fills = (node.fills || []).filter(f => f.visible !== false);
  const strokes = (node.strokes || []).filter(s => s.visible !== false);
  const hasFill = fills.length > 0;
  const hasStroke = strokes.length > 0;
  const fillType = hasFill ? (fills[0].type || null) : null;
  const hasGradient = fills.some(f => f.type && f.type.startsWith('GRADIENT'));
  const hasSolidFill = fills.some(f => f.type === 'SOLID');

  // ─── 渐变提取（保留原有）───
  const gradients = [];
  for (const fill of fills) {
    if (fill.type && fill.type.startsWith('GRADIENT')) {
      const gradientEntry = { type: fill.type };
      if (node.fillStyleId) gradientEntry.styleId = node.fillStyleId;
      else if (fill.gradientStops) {
        gradientEntry.stops = fill.gradientStops.map(stop => {
          const { r, g, b, a } = stop.color || {};
          return {
            position: Math.round((stop.position ?? 0) * 100) / 100,
            color: r != null ? `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},${Math.round((a??1)*100)/100})` : null,
          };
        });
      }
      gradients.push(gradientEntry);
    }
  }

  // ─── 主色 ───
  const dominantColor = extractDominantColor(node);

  // ─── 效果 ───
  const effects = (node.effects || []).filter(e => e.visible !== false);
  const hasShadow = effects.some(e => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW');

  // ─── 子节点组成 ───
  const childSig = extractChildSignature(children);
  const childSigStr = childSigToString(childSig);

  // ─── 首个 TEXT ───
  const firstTextNode = findFirstText(children);
  const firstText = firstTextNode
    ? {
        content: (firstTextNode.characters || '').slice(0, 60),
        fontSize: firstTextNode.style?.fontSize ?? null,
        fontWeight: firstTextNode.style?.fontWeight ?? null,
        fontFamily: firstTextNode.style?.fontFamily ?? null,
      }
    : null;

  const textStyleId = node.textStyleId || findStyleId(children, 'textStyleId');

  // ─── 衍生指标 ───
  const width = bbox.width != null ? Math.round(bbox.width * 100) / 100 : null;
  const height = bbox.height != null ? Math.round(bbox.height * 100) / 100 : null;
  const aspectRatio = (width && height) ? Math.round((width / height) * 100) / 100 : null;
  const cornerRadius = node.cornerRadius ?? null;
  // 圆角比例：cornerRadius / min(w,h)，用于识别胶囊形（>=0.45）
  const cornerRatio = (cornerRadius != null && width && height)
    ? Math.round(cornerRadius / Math.min(width, height) * 100) / 100
    : null;

  return {
    // 尺寸
    width, height, aspectRatio,
    cornerRadius,
    cornerRatio,
    rectangleCornerRadii: node.rectangleCornerRadii ?? null,
    // 填充/描边
    hasFill,
    hasStroke,
    hasSolidFill,
    hasGradient,
    fillType,
    dominantColor,  // 主色块
    strokeWeight: node.strokeWeight ?? null,
    // 效果
    hasShadow,
    // 样式关联
    fillStyleId: node.fillStyleId || null,
    strokeStyleId: node.strokeStyleId || null,
    textStyleId: textStyleId || null,
    effectStyleId: node.effectStyleId || null,
    gradients: gradients.length > 0 ? gradients : [],
    // 结构
    layerCount: children.length,
    childSig,          // { text, icon, image, ... }
    childSigStr,       // "T1-I1" 类字符串
    firstText,
    // 布局
    layoutMode: node.layoutMode || null,
    paddingLeft: node.paddingLeft ?? null,
    paddingRight: node.paddingRight ?? null,
    paddingTop: node.paddingTop ?? null,
    paddingBottom: node.paddingBottom ?? null,
    itemSpacing: node.itemSpacing ?? null,
  };
}

function findFirstText(children) {
  for (const child of children) {
    if (child.type === 'TEXT') return child;
    if (child.children) {
      const found = findFirstText(child.children);
      if (found) return found;
    }
  }
  return null;
}

function findStyleId(children, field) {
  for (const child of children) {
    if (child[field]) return child[field];
    if (child.children) {
      const found = findStyleId(child.children, field);
      if (found) return found;
    }
  }
  return null;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const { token, fileKey, outFile } = loadConfig();

  console.log('\n🔬 Figma 组件库样式指纹提取');
  console.log(`   文件 ID: ${fileKey}`);
  console.log(`   输出文件: ${outFile}`);
  console.log('');

  // 1. 样式注册表（含双 key 索引）
  const { registry: styles_registry, rawStyles } = await fetchStylesRegistry(token, fileKey);

  // 2. 补充 FILL 样式实际颜色值
  await enrichFillStyleColors(token, fileKey, styles_registry, rawStyles);

  // 3. 组件列表
  const componentEntries = await fetchComponentList(token, fileKey);

  // 4. 批量节点详情
  const nodeIds = componentEntries.map(e => e.nodeId);
  const nodeMap = await fetchNodeDetails(token, fileKey, nodeIds);

  // 4. 合并组件基础信息 + DNA
  console.log('\n[提取 DNA] 处理节点数据...');
  const components_registry = {};
  let successCount = 0;
  let failCount = 0;

  for (const entry of componentEntries) {
    const node = nodeMap.get(entry.nodeId);
    const dna = node ? extractDNA(node) : null;
    const groupName = entry.componentSetName || entry.name;
    const category = classifyComponent(groupName);

    components_registry[entry.nodeId] = {
      name: entry.name,
      key: entry.key || null,         // 保留全局 key，供插件精确校验
      componentSetName: entry.componentSetName,
      isVariant: entry.isVariant,
      isComponentSet: entry.isComponentSet || false,
      pageName: entry.pageName,
      thumbnailUrl: entry.thumbnailUrl,
      category,
      ...(dna || { extractError: 'node not found in batch response' }),
    };

    if (dna) successCount++;
    else failCount++;
  }

  console.log(`  ✓ 成功: ${successCount}，失败(节点未返回): ${failCount}`);

  // 5. 输出 JSON
  // styles_registry 含双 key（node_id + S:key），统计实际样式数用去重
  const uniqueStyleNames = new Set(Object.values(styles_registry).map(s => s.name));
  const fillStylesWithColor = Object.values(styles_registry).filter(
    s => s.styleType === 'FILL' && s.color
  ).length;

  const output = {
    extractedAt: new Date().toISOString(),
    fileKey,
    summary: {
      stylesCount: uniqueStyleNames.size,
      fillStylesWithColor,
      componentsCount: Object.keys(components_registry).length,
    },
    styles_registry,
    components_registry,
  };

  const outPath = join(__dirname, outFile);
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`\n✅ 完成！指纹文件已保存：${outPath}`);
  console.log(`   样式数: ${output.summary.stylesCount}（含颜色值的 FILL 样式: ${output.summary.fillStylesWithColor}）`);
  console.log(`   组件数: ${output.summary.componentsCount}`);
}

main().catch(err => {
  console.error('❌ 发生错误：', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
