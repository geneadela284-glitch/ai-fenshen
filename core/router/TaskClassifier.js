import { CAPABILITIES, normalizeCapability } from './CapabilityMap.js';

function textOf(task = {}) {
  const messages = Array.isArray(task.messages) ? task.messages : [];
  const lastMessage = [...messages].reverse().find((message) => message?.role !== 'system')?.content;
  return String(task.input || task.prompt || lastMessage || '').trim();
}

export class TaskClassifier {
  classify(task = {}) {
    if (task.capability || task.metadata?.capability) {
      return normalizeCapability(task.capability || task.metadata.capability);
    }

    const intent = String(task.metadata?.intent || task.type || '').toLowerCase();
    const taskType = String(task.metadata?.taskType || '').toLowerCase();
    if (intent === 'summarize') return CAPABILITIES.SUMMARIZATION;
    if (intent === 'extract') return CAPABILITIES.STRUCTURED_EXTRACTION;
    if (intent === 'analyze') return CAPABILITIES.DATA_ANALYSIS;
    if (intent === 'translate') return CAPABILITIES.TRANSLATION;
    if (intent === 'code') return CAPABILITIES.CODE;
    if (taskType === 'writing' || taskType === 'presentation') return CAPABILITIES.WRITING;
    if (taskType === 'reasoning') return CAPABILITIES.REASONING;
    if (taskType === 'data_analysis') return CAPABILITIES.DATA_ANALYSIS;

    const input = textOf(task).toLowerCase();
    if (/ocr|识别文字|扫描件|图片文字/.test(input)) return CAPABILITIES.OCR;
    if (/图片|照片|视觉|看图|图像/.test(input)) return CAPABILITIES.VISION;
    if (/会议.*(?:总结|摘要|纪要)|(?:总结|整理).*(?:会议|会谈)/.test(input)) return CAPABILITIES.MEETING_SUMMARY;
    if (/提取.*(?:json|结构化|字段)|(?:json|结构化).*提取/.test(input)) return CAPABILITIES.STRUCTURED_EXTRACTION;
    if (/分析.*(?:表格|数据|销售|趋势)|(?:表格|数据).*分析/.test(input)) return CAPABILITIES.DATA_ANALYSIS;
    if (/推理|逻辑|分析.*(?:风险|方案|原因)|为什么.*(?:会|是)/.test(input)) return CAPABILITIES.REASONING;
    if (/代码|编程|脚本|函数|bug|接口/.test(input)) return CAPABILITIES.CODE;
    if (/翻译|translate/.test(input)) return CAPABILITIES.TRANSLATION;
    if (/搜索|查询|检索/.test(input)) return CAPABILITIES.SEARCH;
    if (/报告|汇报|ppt|大纲|经营分析/.test(input)) return CAPABILITIES.REPORT;
    if (/总结|摘要|纪要|提炼/.test(input)) return CAPABILITIES.SUMMARIZATION;
    if (/写|文案|文章|介绍|邮件|通知|润色/.test(input)) return CAPABILITIES.WRITING;
    if (/工作流|自动化|流程/.test(input)) return CAPABILITIES.WORKFLOW;
    return CAPABILITIES.CHAT;
  }
}

export const taskClassifier = new TaskClassifier();
export default taskClassifier;
