#!/usr/bin/env node
/**
 * Figma 组件使用监督工具 - 主入口
 * 零外部依赖，只使用 Node.js 内置模块
 *
 * 用法：
 *   node audit.js                                  # 审核 config.json 中所有 targetFileIds
 *   node audit.js --file <fileId>                  # 审核指定文件
 *   node audit.js --file <fileId> --page "首页"    # 只审核指定页面
 *   node audit.js --dry-run                        # 只扫描节点，不调用 AI（测试用）
 *   node audit.js --md                             # 额外生成 Markdown 报告
 *   node audit.js --json                           # 额外生成 JSON 报告
 *   node audit.js --no-images                      # 跳过截图获取（更快，报告无截图）
 *   node audit.js --no-color                       # 跳过颜色合规扫描
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  fetchLibraryComponents,
  fetchTargetFile,
  extractCandidateNodes,
  extractColorViolationCandidates,
  fetchNodeImages,
} from './figma.js';
import { judgeAllCandidates, enrichSuspiciousNodes } from './ai.js';
import { loadFingerprints, matchComponents, matchColors } from './match.js';
import {
  generateHtmlReport,
  generateMarkdownReport,
  generateJsonReport,
  saveReport,
  printSummary,
} from './report.js';
import { aggregateResults } from './aggregate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));

  if (argv.help || argv.h) {
    printHelp();
    process.exit(0);
  }

  const configPath = argv.config
    ? argv.config
    : join(__dirname, 'config.json');

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    console.error(`❌ 找不到配置文件：${configPath}`);
    console.error('   请复制 config.example.json 为 config.json 并填写相关信息');
    process.exit(1);
  }

  validateConfig(config, argv['dry-run']);

  const { figma: figmaConfig, ai: aiConfig, audit: auditConfig } = config;
  const outputDir = auditConfig?.outputDir || './reports';
  const skipPageNames = auditConfig?.skipPageNames || [];
  const minChildren = auditConfig?.minSuspiciousChildren || 1;

  const targetFileIds = argv.file
    ? [argv.file]
    : figmaConfig.targetFileIds;

  if (!targetFileIds || targetFileIds.length === 0) {
    console.error('❌ 未指定要审核的文件 ID，请在 config.json 中设置 targetFileIds，或用 --file 参数指定');
    process.exit(1);
  }

  const skipImages = argv['no-images'] || false;
  const skipColor = argv['no-color'] || false;
  const targetNodeId = argv.node || null;

  console.log('\n🔍 Figma 组件使用监督工具');
  console.log(`   配置文件：${configPath}`);
  console.log(`   审核文件数：${targetFileIds.length}`);
  console.log(`   模式：${argv['dry-run'] ? 'dry-run（跳过 AI）' : '完整审核'}${skipImages ? ' + 跳过截图' : ''}${skipColor ? ' + 跳过颜色扫描' : ''}`);
  console.log('');

  // 并行加载：组件库 + 指纹文件
  const [componentIndex, fingerprints] = await Promise.all([
    fetchLibraryComponents(figmaConfig.token, figmaConfig.libraryFileId),
    Promise.resolve(loadFingerprints()),
  ]);

  if (componentIndex.length === 0) {
    console.warn('⚠️  组件库中未找到任何组件，请检查 libraryFileId 是否正确');
  }

  const allAuditResults = [];

  for (const fileId of targetFileIds) {
    console.log('\n' + '-'.repeat(60));
    const result = await auditFile({
      fileId,
      figmaToken: figmaConfig.token,
      componentIndex,
      fingerprints,
      aiConfig,
      skipPageNames,
      minChildren,
      filterPage: argv.page || null,
      targetNodeId,
      dryRun: argv['dry-run'] || false,
      outputMd: argv.md || false,
      outputJson: argv.json || false,
      skipImages,
      skipColor,
      outputDir,
    });
    if (result) allAuditResults.push(result);
  }

  console.log('\n✅ 全部审核完成');

  // 生成聚合周报 JSON（供 report-demo.html 动态加载）
  if (allAuditResults.length > 0) {
    aggregateResults(allAuditResults, { outputDir });
  }
}

async function auditFile({
  fileId,
  figmaToken,
  componentIndex,
  fingerprints,
  aiConfig,
  skipPageNames,
  minChildren,
  filterPage,
  targetNodeId,
  dryRun,
  outputMd,
  outputJson,
  skipImages,
  skipColor,
  outputDir,
}) {
  const fileData = await fetchTargetFile(figmaToken, fileId, skipPageNames, targetNodeId);
  const { fileName, pages } = fileData;

  const targetPages = filterPage
    ? pages.filter(p => p.name === filterPage)
    : pages;

  if (filterPage && targetPages.length === 0) {
    console.warn(`⚠️  未找到页面「${filterPage}」，可用页面：${pages.map(p => p.name).join('、')}`);
    return;
  }

  // ── 并行执行：组件候选提取 + 颜色候选提取 ──
  const candidates = extractCandidateNodes(targetPages, minChildren);
  const colorCandidates = skipColor ? [] : extractColorViolationCandidates(targetPages);

  if (candidates.length === 0 && colorCandidates.length === 0) {
    console.log(`[${fileName}] 未找到任何候选节点，跳过`);
    return;
  }

  let suspiciousNodes = [];
  let colorViolations = [];
  let nodeImageMap = new Map();

  if (!dryRun) {
    // ── 组件检测：三层漏斗 ──

    // 第一层：硬规则（已在 extractCandidateNodes 中完成）
    // 第二层：指纹匹配
    const { directHits, hintNodes, scratchNodes } = fingerprints
      ? matchComponents(candidates, fingerprints)
      : { directHits: [], hintNodes: [], scratchNodes: candidates };

    // 第三层：AI（处理 hintNodes + scratchNodes，directHits 直接当可疑节点）
    const aiCandidates = [...hintNodes, ...scratchNodes];
    let aiResults = [];

    if (aiCandidates.length > 0) {
      // 为 HINT 节点在提示词里附加组件提示
      const enrichedCandidates = aiCandidates.map(c =>
        c.matchType === 'HINT'
          ? { ...c, _hint: `疑似 ${c.hintComponent}` }
          : c
      );
      aiResults = await judgeAllCandidates(enrichedCandidates, componentIndex, aiConfig);
    }

    // 将 directHits 转为 AI 结果格式
    const directHitResults = directHits.map(h => ({
      nodeId: h.id,
      nodeName: h.name,
      suspiciousReason: `指纹匹配（评分 ${h.matchScore}）：节点视觉属性与组件库高度相似`,
      suggestedComponent: h.suggestedComponent,
      confidence: Math.min(95, 60 + h.matchScore),
    }));

    const allResults = [...directHitResults, ...aiResults];

    // 获取可疑节点截图
    if (!skipImages && allResults.length > 0) {
      const suspiciousIds = allResults.map(r => r.nodeId).filter(id => !id.includes('_stroke'));
      nodeImageMap = await fetchNodeImages(figmaToken, fileId, suspiciousIds);
    }

    suspiciousNodes = enrichSuspiciousNodes(allResults, candidates, nodeImageMap, componentIndex);

    // ── 颜色合规：纯算法匹配 ──
    if (!skipColor && colorCandidates.length > 0 && fingerprints) {
      colorViolations = matchColors(colorCandidates, fingerprints.styles_registry);
    }
  } else {
    console.log(`[dry-run] 跳过 AI 判断，候选节点列表（前 10 条）：`);
    candidates.slice(0, 10).forEach(n => {
      const cr = n.cornerRadius != null ? ` cr=${n.cornerRadius}` : '';
      const fills = n.fills.length > 0 ? ` fills=${n.fills.length}` : '';
      const texts = n.textChildren.length > 0 ? ` texts="${n.textChildren.map(t => t.text).join('|')}"` : '';
      console.log(`  - [${n.pageName}] ${n.breadcrumb.slice(-3).join(' > ')} (${n.type}${cr}${fills}${texts})`);
    });
    if (candidates.length > 10) console.log(`  ... 共 ${candidates.length} 个候选节点`);

    if (!skipColor) {
      console.log(`[dry-run] 颜色候选节点（前 5 条）：`);
      colorCandidates.slice(0, 5).forEach(c => {
        const color = c.rawColor;
        console.log(`  - [${c.pageName}] ${c.nodeName} (${c.nodeType}/${c.source}) rgba(${color.r},${color.g},${color.b},${color.a})`);
      });
      if (colorCandidates.length > 5) console.log(`  ... 共 ${colorCandidates.length} 个颜色候选节点`);
    }
  }

  const auditResult = {
    fileName,
    fileId,
    auditedAt: new Date().toISOString(),
    componentCount: componentIndex.length,
    totalCandidates: candidates.length,
    totalColorCandidates: colorCandidates.length,
    suspiciousNodes,
    colorViolations,
  };

  printSummary(auditResult);

  // 默认输出 HTML
  const htmlContent = generateHtmlReport(auditResult);
  const htmlPath = saveReport(htmlContent, outputDir, fileName, 'html');
  console.log(`🌐 HTML 报告：${htmlPath}`);

  if (outputMd) {
    const mdContent = generateMarkdownReport(auditResult);
    const mdPath = saveReport(mdContent, outputDir, fileName, 'md');
    console.log(`📄 Markdown 报告：${mdPath}`);
  }

  if (outputJson) {
    const jsonContent = generateJsonReport(auditResult);
    const jsonPath = saveReport(jsonContent, outputDir, fileName, 'json');
    console.log(`📄 JSON 报告：${jsonPath}`);
  }

  return auditResult;
}

function validateConfig(config, dryRun) {
  const errors = [];
  if (!config.figma?.token || config.figma.token.includes('YOUR_')) {
    errors.push('figma.token 未配置');
  }
  if (!config.figma?.libraryFileId || config.figma.libraryFileId.includes('YOUR_')) {
    errors.push('figma.libraryFileId 未配置');
  }
  if (!dryRun && (!config.ai?.apiKey || config.ai.apiKey.includes('YOUR_'))) {
    errors.push('ai.apiKey 未配置（如只想测试可加 --dry-run 参数跳过 AI）');
  }

  if (errors.length > 0) {
    const isFatal = errors.some(e => e.includes('token') || e.includes('libraryFileId'));
    console.warn('⚠️  配置缺失：');
    errors.forEach(e => console.warn(`   - ${e}`));
    if (isFatal) {
      console.error('❌ Figma 配置缺失，无法继续');
      process.exit(1);
    }
  }
}

function printHelp() {
  console.log(`
Figma 组件使用监督工具

用法：
  node audit.js [选项]

选项：
  --file <fileId>        指定要审核的 Figma 文件 ID
  --page <pageName>      只审核指定页面
  --dry-run              只扫描节点，不调用 AI（用于测试 Figma 连接）
  --no-images            跳过截图获取（报告无截图，速度更快）
  --no-color             跳过颜色合规扫描
  --md                   额外生成 Markdown 格式报告
  --json                 额外生成 JSON 格式报告
  --config <path>        指定配置文件路径（默认 ./config.json）
  --help                 显示帮助

示例：
  node audit.js                              # 完整审核（含截图+颜色扫描），生成 HTML 报告
  node audit.js --file AbCdEfGh --dry-run    # 测试 Figma 连接
  node audit.js --no-images --no-color       # 只做组件检测，最快模式
  node audit.js --md --json                  # 同时输出 HTML + MD + JSON
`);
}

main().catch(err => {
  console.error('❌ 发生错误：', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
