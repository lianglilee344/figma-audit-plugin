/**
 * aggregate.js
 *
 * Collects per-file auditResult objects produced by audit.js and writes:
 *   - reports/{weekId}.json        — per-week data (fetched by report-demo.html)
 *   - reports/weeks-index.json     — week list index (week switcher in the UI)
 *
 * Usage:
 *   aggregateResults(results, { outputDir, weekLabel })
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── confidence score → label ─────────────────────────────────────────────────

function confLabel(score) {
  if (score >= 80) return 'high';
  if (score >= 65) return 'mid';
  return 'low';
}

// ── per-file auditResult → REPORT file entry ─────────────────────────────────

function mapFile(auditResult) {
  const { fileId, fileName, auditedAt, suspiciousNodes = [], colorViolations = [] } = auditResult;

  const figmaUrl = `https://www.figma.com/design/${fileId}`;
  const scannedAt = auditedAt
    ? auditedAt.slice(0, 16).replace('T', ' ')
    : new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Component issues ← suspiciousNodes
  const component = suspiciousNodes.map(n => ({
    name:       n.nodeName,
    path:       Array.isArray(n.breadcrumb) ? n.breadcrumb.join(' / ') : n.nodeName,
    suggestion: n.suggestedComponent || '',
    confidence: confLabel(n.confidence ?? 0),
    nodeId:     n.nodeId || null,
    imageUrl:   n.nodeImageUrl || null,
  }));

  // Style issues ← colorViolations（server-side pipeline 目前只检测颜色，text-style 由插件侧检测）
  const kindMap = {
    exact_match:  'fill-color',
    near_match:   'fill-color',
    no_style:     'fill-color',
    text_style:   'text-style',   // 预留：若未来 audit.js 扩展文字样式检测
  };
  const confMap = {
    exact_match: 'high',
    near_match:  'mid',
    no_style:    'low',
    text_style:  'mid',
  };

  const style = colorViolations.map(v => {
    const rawC = v.rawColor;
    const hex  = rawC
      ? '#' + [rawC.r, rawC.g, rawC.b]
          .map(x => Math.round(x).toString(16).padStart(2, '0'))
          .join('')
      : '';
    // 透传 kind 字段（若 audit 结果已带），否则根据 violationType 映射
    const kind = v.kind || kindMap[v.violationType] || 'fill-color';
    return {
      name:       v.nodeName,
      path:       Array.isArray(v.breadcrumb) ? v.breadcrumb.join(' / ') : (v.pageName || v.nodeName),
      kind,
      detail:     hex ? `${hex} 未绑定颜色样式` : (v.reason || ''),
      suggest:    Array.isArray(v.suggestedStyles) && v.suggestedStyles.length > 0
                    ? v.suggestedStyles[0]
                    : '',
      confidence: confMap[v.violationType] || 'low',
      nodeId:     v.nodeId || null,
      imageUrl:   v.nodeImageUrl || null,
    };
  });

  return {
    id:        fileId,
    name:      fileName,
    figmaUrl,
    scannedAt,
    issues:    { component, style, layout: [] },
  };
}

// ── compute ISO week range (Mon–Sun) ─────────────────────────────────────────

function weekRange(date) {
  const d   = new Date(date);
  const day = d.getDay() || 7;
  const mon = new Date(d); mon.setDate(d.getDate() - (day - 1));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const fmt = dt => dt.toISOString().slice(0, 10);
  return `${fmt(mon)} ~ ${fmt(sun)}`;
}

// ── update weeks-index.json ───────────────────────────────────────────────────

function updateWeeksIndex(outDir, weekEntry) {
  const indexPath = path.join(outDir, 'weeks-index.json');
  let index = [];
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch (e) { /* first run, start fresh */ }

  // Mark all existing entries as not current
  index = index.map(w => ({ ...w, isCurrent: false }));

  // Replace if same id exists, otherwise prepend (newest first)
  const existingIdx = index.findIndex(w => w.id === weekEntry.id);
  if (existingIdx >= 0) {
    index[existingIdx] = weekEntry;
  } else {
    index.unshift(weekEntry);
  }

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  console.log(`📋 周索引 JSON：${indexPath}（共 ${index.length} 周）`);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * @param {object[]} auditResults   Array of per-file auditResult objects
 * @param {object}   opts
 * @param {string}   [opts.outputDir]   Directory to write into (default: ./reports)
 * @param {string}   [opts.weekLabel]   Override "week" range string (e.g. "2026-04-14 ~ 2026-04-20")
 * @param {string}   [opts.weekId]      Override weekId filename key (default: Sunday date of the range)
 */
export function aggregateResults(auditResults, { outputDir, weekLabel, weekId } = {}) {
  const now = new Date();

  const weekStr = weekLabel || weekRange(now);
  const report = {
    week:        weekStr,
    generatedAt: now.toISOString().slice(0, 16).replace('T', ' '),
    files:       auditResults.map(mapFile),
  };

  const outDir = outputDir
    ? path.resolve(outputDir)
    : path.resolve(__dirname, 'reports');

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // weekId = Sunday (end) of the week, used as filename key and index id
  const resolvedWeekId = weekId || weekStr.split(' ~ ')[1]?.trim() || now.toISOString().slice(0, 10);

  // ── 1. Write per-week data file: reports/{weekId}.json ────────────────────
  const weekPath = path.join(outDir, `${resolvedWeekId}.json`);
  fs.writeFileSync(weekPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`📊 周报 JSON：${weekPath}`);

  // ── 2. Update weeks-index.json ────────────────────────────────────────────
  const [weekStart, weekEnd2] = weekStr.split(' ~ ').map(s => s.trim());
  const mmdd = s => s.slice(5).replace('-', '.');  // "YYYY-MM-DD" → "MM.DD"
  const label = `${mmdd(weekStart)}–${mmdd(weekEnd2 || weekStart)} 本周设计稿走查`;
  const weekEntry = {
    id:        resolvedWeekId,
    label,
    week:      weekStr,
    isCurrent: true,
  };
  updateWeeksIndex(outDir, weekEntry);

  return weekPath;
}
