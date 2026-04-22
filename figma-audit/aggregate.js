/**
 * aggregate.js
 *
 * Collects per-file auditResult objects produced by audit.js and writes a
 * single reports/weekly-report.json that report-demo.html can fetch at runtime.
 *
 * Usage (called automatically by audit.js after all files finish):
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

  // Figma file URL (deep-link to first page)
  const figmaUrl = `https://www.figma.com/design/${fileId}`;

  // Scanned-at timestamp, formatted as "YYYY-MM-DD HH:mm"
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

  // Style issues ← colorViolations
  const style = colorViolations.map(v => {
    const kindMap = {
      exact_match: 'fill-color',
      near_match:  'fill-color',
      no_style:    'fill-color',
    };
    const confMap = {
      exact_match: 'high',
      near_match:  'mid',
      no_style:    'low',
    };
    const rawC  = v.rawColor;
    const hex   = rawC
      ? '#' + [rawC.r, rawC.g, rawC.b]
          .map(x => Math.round(x).toString(16).padStart(2, '0'))
          .join('')
      : '';
    return {
      name:       v.nodeName,
      path:       Array.isArray(v.breadcrumb) ? v.breadcrumb.join(' / ') : (v.pageName || v.nodeName),
      kind:       kindMap[v.violationType] || 'fill-color',
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

// ── compute ISO week range (Mon–Sun) for a given date ────────────────────────

function weekRange(date) {
  const d    = new Date(date);
  const day  = d.getDay() || 7;               // 1=Mon … 7=Sun
  const mon  = new Date(d);
  mon.setDate(d.getDate() - (day - 1));
  const sun  = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt  = dt => dt.toISOString().slice(0, 10);
  return `${fmt(mon)} ~ ${fmt(sun)}`;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * @param {object[]} auditResults  Array of per-file auditResult objects
 * @param {object}   opts
 * @param {string}   opts.outputDir   Directory to write weekly-report.json into
 * @param {string}   [opts.weekLabel] Override the "week" field (e.g. "2026-04-14 ~ 2026-04-20")
 */
export function aggregateResults(auditResults, { outputDir, weekLabel } = {}) {
  const now = new Date();

  const report = {
    week:        weekLabel || weekRange(now),
    generatedAt: now.toISOString().slice(0, 16).replace('T', ' '),
    files:       auditResults.map(mapFile),
  };

  const outDir = outputDir
    ? path.resolve(outputDir)
    : path.resolve(__dirname, 'reports');

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const json = JSON.stringify(report, null, 2);

  // Overwrite the "current" file (fetched by report-demo.html on load)
  const outPath = path.join(outDir, 'weekly-report.json');
  fs.writeFileSync(outPath, json, 'utf-8');
  console.log(`📊 周报 JSON：${outPath}`);

  // Also write a dated archive so each week is permanently accessible
  // Filename: report-YYYY-MM-DD.json using the Sunday (end) of the week range
  const weekEnd = report.week.split(' ~ ')[1]?.trim() || now.toISOString().slice(0, 10);
  const archivePath = path.join(outDir, `report-${weekEnd}.json`);
  fs.writeFileSync(archivePath, json, 'utf-8');
  console.log(`📁 存档 JSON：${archivePath}`);

  return outPath;
}
