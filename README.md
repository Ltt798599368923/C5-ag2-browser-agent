# Memory Agent - Enhanced Edition

> 基于 [amlworks/ag2-browser-agent](https://github.com/amlworks/ag2-browser-agent) Fork 的增强版本

A Chrome side-panel companion that turns your **browser history** into a **personal knowledge base** — local, private, free, and exportable to Obsidian.

## 🆕 新增功能 (v2.0)

本版本在原版基础上增加了以下功能：

### 1. 总结 Agent (Multi-Dimensional Analysis)
当您保存页面时，系统会自动调用**总结Agent**进行多维度深度分析：

- **Key Insights** - 关键发现和洞察
- **Actionable Takeaways** - 可执行的行动建议
- **Related Concepts** - 相关概念延伸
- **Why This Matters** - 重要性说明

### 2. 网页搜索能力 (Web Search)
新增 `web_search` 工具，当本地知识库不足以回答您的问题时：

- 自动搜索网络获取最新信息
- 整合外部资源补充回答
- 基于 Tavily API（免费注册）

---

## Features / 功能

- **📚 双Agent协作** - 主Agent + 总结Agent协同工作
- **🔍 智能搜索** - 本地知识库 + 网络搜索双模式
- **💬 对话式交互** - 用自然语言查询你的浏览记录
- **📊 知识图谱** - 可视化你的知识网络
- **📤 Obsidian导出** - 导出为Obsidian笔记格式
- **🔒 隐私优先** - 所有数据存储在本地浏览器

---

## Quickstart / 快速开始

### 1. 配置 API Keys

```bash
cd extension/
cp .env.example .env
# 编辑 .env 填入你的 API keys
```

需要以下 API Key（至少需要一个 LLM Provider）：

| Provider | 获取地址 | 说明 |
|----------|---------|------|
| Groq | https://console.groq.com/keys | **推荐** - 免费额度充足 |
| OpenRouter | https://openrouter.ai/keys | 支持多种模型 |
| Gemini | https://aistudio.google.com/apikey | Google官方 |
| Tavily | https://tavily.com | 网页搜索（可选） |

### 2. 加载扩展

1. 打开 `chrome://extensions`
2. 开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `extension/` 文件夹
5. 从工具栏点击 Memory Agent 图标

### 3. 开始使用

1. 点击 **"📥 Pull in my last 30 days of browser history"** 导入浏览历史
2. 点击 **"What have I been reading lately?"** 查看阅读统计
3. 保存重要页面（点击 + 按钮）获取多维度分析
4. 使用知识图谱可视化你的知识网络
5. 导出到 Obsidian 继续整理

---

## 🔧 技术架构

```
用户操作 → 主Agent (Chat Agent)
              ↓ 调用工具
         ┌────┴────┐
         ↓         ↓
   本地知识库   网页搜索 (Tavily)
         ↓
    总结Agent (Enhanced Analysis)
              ↓
         保存到 IndexedDB
```

### Agent 说明

| Agent | 职责 |
|-------|------|
| **主Agent** | 对话、搜索本地/网络、分析用户意图 |
| **总结Agent** | 保存页面时生成多维度深度分析 |

### 工具列表

| 工具 | 功能 |
|------|------|
| `scan_history` | 搜索浏览器历史 |
| `recent_history` | 最近浏览记录 |
| `search_knowledge` | 搜索已保存页面 |
| `list_knowledge` | 列出所有保存 |
| `compare_history_to_goal` | 目标对比分析 |
| `web_search` | 网络搜索（新增）|

---

## 📝 环境变量配置

```env
# LLM Provider (必须)
PROVIDER=groq
MODEL=llama-3.3-70b-versatile
GROQ_API_KEY=your_key_here

# Web Search (可选)
TAVILY_API_KEY=your_tavily_key_here
```

---

## 🎯 使用场景

1. **学习追踪** - "我这周学了什么？" → AI 总结阅读主题分布
2. **知识整理** - 保存技术文章 → 自动生成要点和行动建议
3. **信息补全** - 问最新资讯 → 自动搜索网络补充
4. **笔记导出** - 一键导出到 Obsidian 继续整理

---

## 📄 License

继承原项目 MIT License

## 🙏 致谢

- 原项目: [amlworks/ag2-browser-agent](https://github.com/amlworks/ag2-browser-agent)
- AG2 (AutoGen 2) 框架
- 所有开源 LLM Provider
