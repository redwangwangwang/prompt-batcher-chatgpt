# Prompt Batcher（发布版说明）

本项目提供一个可以在 ChatGPT 网页端进行批量发送数据的用户脚本，仅用于学习交流与个人效率提升。

请务必遵守目标网站/平台的使用条款，合理控制请求频率与自动化行为。由此产生的一切后果由使用者自行承担。

## 功能概览

- 自定义提示模板：在面板中编辑提示（Prompt），将模板与数据拼接后发送给 ChatGPT。
- 多文件/文件夹导入：支持 JSONL / TXT / CSV / XLSX；也可从文件夹一次选择多个文件。
- 批量自动发送：可配置是否等待回复、发送间隔（节流）、失败重试等。
- 自动保存：可将每条输入/输出以 JSONL 形式保存，支持 resume 与导出。

占位符支持：

- `{{列名}}`：当数据来自 CSV/XLSX 时，用列名替换。
- `{{JSON}}`：插入当前记录的数据 JSON（带缩进）。
- `{{SOURCE}}`：数据来源的文件名。
- `{{INDEX}}`：当前记录序号（从 1 开始）。

## 快速开始

1) 安装浏览器扩展 Tampermonkey（油猴）。
2) 将 `browser/userscripts/prompt-batcher-chatgpt.user.js` 安装为用户脚本。
3) 打开 ChatGPT（chat.openai.com 或 chatgpt.com），右下角会出现控制面板。
4) 在面板中：
   - 编辑 Prompt Template（可使用上述占位符）。
   - 选择文件（JSONL/TXT/CSV/XLSX），或点击“Load Folder”从文件夹读取。
   - 根据需要勾选 Auto send / Wait for response / Interval / Retries 等参数。
   - 点击 Start 开始批量发送。

注意：

- TXT 默认按“非空行”为一条数据；CSV/XLSX 按表头字段解析；JSONL 按行解析为对象（兼容旧版 JSONL 字段 `id`、`report`、`GA`）。
- 若模板未包含任何占位符，系统会在模板后自动追加一段 JSON 文本作为数据体。

## 截图

面板位于页面右下角，可拖拽移动，提供文件导入、模板编辑、自动化参数等控制。

## 免责声明

本项目仅用于学习交流，不构成对任何平台的自动化操作建议。请遵守相关法律法规与网站条款，合理控制使用范围与频率。

## 请我喝咖啡

如果这个项目对你有帮助，欢迎请我喝咖啡：

![请我喝咖啡](coffee-qr.png)

