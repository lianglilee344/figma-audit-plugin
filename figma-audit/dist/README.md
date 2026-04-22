# 抖音商城设计组件使用周报 — 部署说明

## 交付文件

| 文件 | 说明 |
|------|------|
| `index.html` | 报告页面，纯静态，无需构建 |
| `weekly-report.json` | 当前周数据，每周更新这一个文件 |

## 部署方式

把这两个文件放到同一个静态目录下对外访问即可，无需后端、无需数据库。

```
your-server/
  index.html
  weekly-report.json
```

访问 `index.html`（或配置为 `index.html` 为默认文档）即可看到报告。

## 每周更新流程

每周审计跑完后，设计侧会提供一个新的 `weekly-report.json`，**只需替换这一个文件**，页面无需改动。

## 历史报告

每周还会生成一个带日期的存档文件，如 `report-2026-04-20.json`。
后续如需展示历史数据，接入 API 时只需替换 `index.html` 中 `DataService` 的两个函数体：

```js
const DataService = {
  async fetchWeekList() {
    return fetch('/api/weeks').then(r => r.json());   // ← 替换这里
  },
  async fetchWeek(weekId) {
    return fetch(`/api/report/${weekId}`).then(r => r.json());  // ← 替换这里
  },
};
```

其余页面代码无需改动。

## 技术说明

- 纯 HTML / CSS / JS，无框架依赖
- 字体通过 Google Fonts CDN 加载（需外网）
- URL hash 路由（如 `index.html#2026-04-20`）支持直接分享某一周的链接
