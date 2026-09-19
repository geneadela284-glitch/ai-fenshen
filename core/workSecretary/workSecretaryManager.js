import serverAIClient from '../ai/ServerAIClient.js';
import { eventManager } from '../events/index.js';
import { knowledgeManager } from '../knowledge/knowledgeManager.js';
import { memoryManager } from '../memory/memoryManager.js';
import realUserMemoryClient from '../memory/realUserMemoryClient.js';
import taskRouter from '../orchestrator/TaskRouter.js';
import { promptManager } from '../prompts/index.js';
import { workspaceToolRegistry } from '../workspace/workspaceToolRegistry.js';
import { CAPABILITIES } from '../router/CapabilityMap.js';
import { workSecretaryRepository } from './workSecretaryRepository.js';

function now() {
  return new Date().toISOString();
}

function createTaskId() {
  return `work-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeError(error) {
  return 'AI 服务暂不可用，请稍后重试。';
}

function sanitizeTaskDebug(debug) {
  if (!debug || typeof debug !== 'object') return null;
  return Object.fromEntries([
    'taskType', 'workspaceIntent', 'injectedMemoryCount', 'injectedKnowledgeCount',
    'injectedAttachmentCount', 'latency', 'status', 'errorType'
  ].filter((key) => debug[key] !== undefined).map((key) => [key, debug[key]]));
}

function normalizeAttachment(attachment = {}, taskId = '', includeTransient = false) {
  const tables = Array.isArray(attachment.tables) ? attachment.tables : [];
  return {
    id: String(attachment.id || ''),
    taskId: String(attachment.taskId || taskId || ''),
    name: String(attachment.name || '未命名附件'),
    mimeType: String(attachment.mimeType || attachment.type || 'application/octet-stream'),
    size: Number(attachment.size || 0),
    extension: String(attachment.extension || ''),
    status: String(attachment.status || 'attached'),
    contentType: String(attachment.contentType || 'unknown'),
    parseable: Boolean(attachment.parseable),
    readable: Boolean(attachment.readable || attachment.parseable),
    parseStatus: String(attachment.parseStatus || (attachment.parseable ? 'readable' : 'not_supported')),
    content: String(attachment.content || '').slice(0, 24000),
    tables,
    metadata: attachment.metadata && typeof attachment.metadata === 'object' ? attachment.metadata : {},
    warnings: Array.isArray(attachment.warnings) ? attachment.warnings.map((item) => String(item)).filter(Boolean) : [],
    error: String(attachment.error || ''),
    ...(includeTransient && attachment.imageDataUrl ? { imageDataUrl: String(attachment.imageDataUrl) } : {})
  };
}

function normalizeTask(task = {}) {
  const createdAt = task.createdAt || now();
  const taskId = task.taskId || task.id || createTaskId();
  return {
    id: task.id || taskId,
    taskId,
    userInput: task.userInput || '',
    taskType: task.taskType || 'general',
    status: task.status || 'created',
    createdAt,
    completedAt: task.completedAt || '',
    result: task.result || '',
    error: task.error || '',
    latency: Number(task.latency || 0),
    usage: task.usage || null,
    taskConfirmation: task.taskConfirmation || null,
    workspaceMetadata: task.workspaceMetadata && typeof task.workspaceMetadata === 'object' ? task.workspaceMetadata : {},
    debug: sanitizeTaskDebug(task.debug),
    conversationId: task.conversationId || '',
    conversationContext: task.conversationContext && typeof task.conversationContext === 'object' ? task.conversationContext : null,
    attachments: Array.isArray(task.attachments) ? task.attachments.map((item) => normalizeAttachment(item, taskId)) : [],
    isSaved: Boolean(task.isSaved),
    savedAt: task.savedAt || '',
    updatedAt: task.updatedAt || createdAt
  };
}

function extractBetween(input, startPattern) {
  const match = input.match(startPattern);
  return match?.[1]?.trim() || '';
}

function extractAudience(input) {
  return extractBetween(input, /面向(.+?)(?:，|,|。|$)/);
}

function extractOutputFormat(input, taskType) {
  const wordCount = input.match(/约?\s*\d+\s*字/);
  if (wordCount) return wordCount[0].replace(/\s+/g, '');
  if (taskType === 'presentation') return 'PPT 逐页大纲';
  if (input.includes('大纲')) return '大纲';
  return '';
}

function extractConstraints(input) {
  const constraints = [];
  const style = extractBetween(input, /风格(.+?)(?:，|,|。|$)/);
  const tone = extractBetween(input, /语气(.+?)(?:，|,|。|$)/);
  const highlights = extractBetween(input, /突出(.+?)(?:，|,|。|$)/);
  const banned = extractBetween(input, /不要出现(.+?)(?:，|,|。|$)/);
  if (style) constraints.push(`风格：${style}`);
  if (tone) constraints.push(`语气：${tone}`);
  if (highlights) constraints.push(`必须包含：${highlights}`);
  if (banned) constraints.push(`禁止出现：${banned}`);
  return constraints;
}

function hasProvidedData(input) {
  const text = String(input || '');
  const hasRows = text.includes('\n') && /\d/.test(text);
  const hasTableLikeSeparators = /[,，\t|]/.test(text) && /\d/.test(text);
  return hasRows || hasTableLikeSeparators;
}

function attachmentHasParsedContent(attachment) {
  return Boolean(attachment.parseable && (attachment.content || (Array.isArray(attachment.tables) && attachment.tables.length)));
}

function attachmentHasVisionPayload(attachment) {
  return Boolean(attachment.contentType === 'image' && attachment.imageDataUrl && attachment.metadata?.visionRequired);
}

function hasProvidedAnalysisObject(input, attachments = []) {
  const text = String(input || '').trim();
  if (attachments.some(attachmentHasParsedContent)) return true;
  if (/这份方案|该方案|上述方案|上面的方案/.test(text) && text.length < 40) return false;
  return text.length >= 40 || /[:：\n]/.test(text);
}

function formatAttachmentTable(table = {}, tableIndex = 0) {
  const headers = Array.isArray(table.headers) ? table.headers : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const lines = [
    `表格 ${tableIndex + 1}：${table.title || '未命名表格'}`,
    headers.length ? `字段：${headers.join('、')}` : ''
  ].filter(Boolean);
  rows.slice(0, 20).forEach((row, index) => {
    const values = Object.entries(row || {}).map(([key, value]) => `${key}=${value}`).join('；');
    if (values) lines.push(`${index + 1}. ${values}`);
  });
  return lines.join('\n');
}

function formatAttachmentContext(attachment = {}, index = 0) {
  const warnings = attachment.warnings?.length ? `\n解析提示：${attachment.warnings.join('；')}` : '';
  const metadataParts = [];
  if (attachment.contentType) metadataParts.push(`类型=${attachment.contentType}`);
  if (attachment.metadata?.pageCount) metadataParts.push(`页数=${attachment.metadata.pageCount}`);
  if (attachment.metadata?.sheetNames?.length) metadataParts.push(`工作表=${attachment.metadata.sheetNames.join('、')}`);
  const metadata = metadataParts.length ? `\n元数据：${metadataParts.join('；')}` : '';
  const text = attachment.content ? `\n正文：\n${attachment.content.slice(0, 6000)}` : '';
  const tables = attachment.tables?.length ? `\n表格数据：\n${attachment.tables.map(formatAttachmentTable).join('\n\n')}` : '';
  return `附件 ${index + 1}：${attachment.name}${metadata}${warnings}${text}${tables}`;
}

function isFollowUp(input) {
  return /上面|上述|上一份|刚才|更正式|缩短|扩写|继续修改|改成/.test(String(input || ''));
}

function getPromptId(taskType) {
  const map = {
    writing: 'work-secretary-writing',
    reasoning: 'work-secretary-reasoning',
    data_analysis: 'work-secretary-data-analysis',
    presentation: 'work-secretary-presentation',
    general: 'work-secretary-general'
  };
  return map[taskType] || map.general;
}

function getUserMessage(input) {
  return String(input || '').trim();
}

export class WorkSecretaryManager {
  constructor({
    repository = workSecretaryRepository,
    events = eventManager,
    ai = serverAIClient,
    router = taskRouter,
    prompts = promptManager,
    memory = memoryManager,
    knowledge = knowledgeManager,
    workspaceTools = workspaceToolRegistry,
    memoryIntegration = realUserMemoryClient
  } = {}) {
    this.repository = repository;
    this.events = events;
    this.ai = ai;
    this.router = router;
    this.prompts = prompts;
    this.memory = memory;
    this.knowledge = knowledge;
    this.workspaceTools = workspaceTools;
    this.memoryIntegration = memoryIntegration;
    this.transientAttachmentPayloads = new Map();
  }

  listTasks() {
    return this.repository
      .readAll()
      .map(normalizeTask)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  getTask(taskId) {
    return this.repository.read(taskId);
  }

  createTask(userInput, options = {}) {
    const input = String(userInput || '').trim();
    if (!input) throw new Error('请输入要完成的工作。');

    const route = this.router.route({ input });
    const createdAt = now();
    const id = createTaskId();
    const transientAttachments = Array.isArray(options.attachments)
      ? options.attachments.map((item) => normalizeAttachment(item, id, true))
      : [];
    const task = normalizeTask({
      id,
      userInput: input,
      taskType: route.taskType,
      status: 'processing',
      conversationId: options.conversationId || '',
      conversationContext: options.conversationContext || null,
      attachments: transientAttachments.map((item) => normalizeAttachment(item, id)),
      createdAt,
      updatedAt: createdAt
    });

    const payloads = transientAttachments
      .filter(attachmentHasVisionPayload)
      .map((item) => [item.id, item.imageDataUrl]);
    if (payloads.length) this.transientAttachmentPayloads.set(id, new Map(payloads));

    this.repository.create(task);
    this.recordTaskEvent(task, 'task_created');
    this.recordTaskEvent(task, 'task_processing');
    return task;
  }

  async executeTask(taskId, updates = {}) {
    const task = this.repository.read(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const input = getUserMessage(updates.input || task.userInput);
    let realMemory = { enabled: false, handled: false, memoryContext: { items: [] } };
    try {
      realMemory = await this.memoryIntegration.process({
        input,
        sourceId: task.taskId,
        requestId: task.taskId,
        correlationId: task.conversationId || task.taskId,
        conversationId: task.conversationId || '',
        idempotencyKey: task.taskId,
        locale: 'zh-CN',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
      });
    } catch {
      realMemory = { enabled: true, handled: false, status: 'degraded', memoryContext: { items: [] } };
    }

    if (realMemory?.handled) {
      const memoryMetadata = {
        status: realMemory.status || '',
        confirmationId: realMemory.confirmationId || '',
        safeSummary: realMemory.safeSummary || '',
        memoryType: realMemory.memoryType || '',
        sensitivity: realMemory.sensitivity || '',
        longTerm: Boolean(realMemory.longTerm)
      };
      if (realMemory.status === 'needs_clarification') {
        return this.needsInputTask(taskId, realMemory.safeMessage || '请补充一项必要信息。', {
          workspaceMetadata: { memoryIntegration: memoryMetadata }
        });
      }
      return this.completeTask(taskId, {
        result: realMemory.safeMessage || '记忆操作已完成。',
        workspaceMetadata: { memoryIntegration: memoryMetadata }
      });
    }

    const workspaceAction = await this.workspaceTools.runForInput(input, {
      task: normalizeTask(task),
      updates,
      conversationId: task.conversationId,
      skipMemory: Boolean(realMemory?.enabled)
    });
    if (workspaceAction?.handled) {
      if (workspaceAction.status === 'failed') {
        return this.failTask(taskId, workspaceAction.error || workspaceAction.result || '这笔记录未保存，请稍后重试。', {
          taskType: workspaceAction.intent?.type || workspaceAction.intent?.intent || task.taskType,
          workspaceMetadata: workspaceAction.metadata || {},
          debug: { taskType: workspaceAction.intent?.type || workspaceAction.intent?.intent || task.taskType, status: 'failed' }
        });
      }
      if (workspaceAction.status === 'needs_input') {
        return this.needsInputTask(taskId, workspaceAction.error || workspaceAction.result || '请补充信息。', {
          taskType: workspaceAction.intent?.type || task.taskType,
          taskConfirmation: {
            taskType: workspaceAction.intent?.type || task.taskType,
            userGoal: input,
            requiredInputs: [],
            missingInputs: [workspaceAction.error || workspaceAction.result || '请补充信息。'],
            workspaceIntent: workspaceAction.intent || null,
            sources: workspaceAction.sources || []
          },
          debug: {
            originalInput: input,
            taskType: workspaceAction.intent?.type || task.taskType,
            workspaceIntent: workspaceAction.intent || null,
            sourceCount: workspaceAction.sources?.length || 0,
            status: 'needs_input'
          }
        });
      }

      return this.completeTask(taskId, {
        result: workspaceAction.result || '',
        latency: 0,
        usage: null,
        taskType: workspaceAction.intent?.type || task.taskType,
        taskConfirmation: {
          taskType: workspaceAction.intent?.type || task.taskType,
          userGoal: input,
          requiredInputs: [],
          missingInputs: [],
          workspaceIntent: workspaceAction.intent || null,
          sources: workspaceAction.sources || []
        },
        workspaceMetadata: workspaceAction.metadata || {},
        debug: {
          originalInput: input,
          taskType: workspaceAction.intent?.type || task.taskType,
          workspaceIntent: workspaceAction.intent || null,
          sourceCount: workspaceAction.sources?.length || 0,
          status: 'completed'
        }
      });
    }
    const prepared = this.prepareRequest({
      ...task,
      attachments: this.getExecutionAttachments(taskId, task.attachments)
    }, input, realMemory?.enabled
      ? (realMemory.memoryContext || { items: [] })
      : (workspaceAction?.memoryContext || { items: [] }));

    if (prepared.confirmation.missingInputs.length) {
      return this.needsInputTask(taskId, prepared.confirmation.missingInputs[0], {
        taskType: prepared.confirmation.taskType,
        taskConfirmation: prepared.confirmation,
        debug: prepared.debug
      });
    }

    const startedAt = Date.now();
    try {
      const response = await this.ai.generate({
        input,
        messages: prepared.messages,
        capability: prepared.capability,
        metadata: {
          source: 'work-secretary',
          taskId,
          conversationId: task.conversationId || '',
          currentTime: new Date().toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
          pageContext: 'ai-secretary-home',
          requiresRealAi: true,
          taskType: prepared.confirmation.taskType,
          taskConfirmation: prepared.confirmation,
          promptTemplateName: prepared.promptId,
          injectedMemoryCount: prepared.context.memoryItems.length,
          injectedKnowledgeCount: prepared.context.knowledgeItems.length,
          injectedAttachmentCount: prepared.context.attachmentItems.length,
          debug: prepared.debug
        },
        options: {
          timeoutMs: 30000
        }
      });

      if (response.error) {
        return this.failTask(taskId, sanitizeError(response.error), {
          latency: response.latency || Date.now() - startedAt,
          usage: response.usage || null
        });
      }

      return this.completeTask(taskId, {
        result: response.content || response.result?.content || '',
        latency: response.latency || Date.now() - startedAt,
        usage: response.usage || null,
        taskType: response.taskType || prepared.confirmation.taskType,
        taskConfirmation: prepared.confirmation,
        debug: {
          ...prepared.debug,
          provider: response.selectedProvider || response.provider || '',
          model: response.selectedModel || response.model || '',
          latency: response.latency || Date.now() - startedAt,
          status: response.error ? 'failed' : 'completed',
          errorType: response.error?.code || ''
        }
      });
    } catch (error) {
      return this.failTask(taskId, sanitizeError(error), {
        latency: Date.now() - startedAt
      });
    }
  }

  getExecutionAttachments(taskId, attachments = []) {
    const payloads = this.transientAttachmentPayloads.get(taskId);
    return attachments.map((item) => normalizeAttachment({
      ...item,
      ...(payloads?.get(item.id) ? { imageDataUrl: payloads.get(item.id) } : {})
    }, taskId, true));
  }

  completeTask(taskId, updates = {}) {
    const completedAt = now();
    const updated = this.repository.update(taskId, {
      ...updates,
      status: 'completed',
      error: '',
      completedAt,
      updatedAt: completedAt
    });
    this.recordTaskEvent(updated, 'task_completed');
    return normalizeTask(updated);
  }

  resolveMemoryConfirmation(taskId, result = {}) {
    const task = this.repository.read(taskId);
    if (!task) return null;
    const previous = task.workspaceMetadata?.memoryIntegration || {};
    const stillPending = result.status === 'confirmation_required';
    return this.completeTask(taskId, {
      result: result.safeMessage || (stillPending ? '需要确认，尚未保存。' : '记忆操作已完成。'),
      workspaceMetadata: {
        ...task.workspaceMetadata,
        memoryIntegration: {
          ...previous,
          status: result.status || '',
          confirmationId: stillPending ? (result.confirmationId || '') : '',
          safeSummary: result.safeSummary || previous.safeSummary || '',
          memoryType: result.memoryType || previous.memoryType || '',
          sensitivity: result.sensitivity || previous.sensitivity || '',
          longTerm: stillPending || Boolean(previous.longTerm),
          memoryId: result.memoryId || ''
        }
      }
    });
  }

  needsInputTask(taskId, message, updates = {}) {
    const completedAt = now();
    const updated = this.repository.update(taskId, {
      ...updates,
      status: 'needs_input',
      error: message,
      completedAt,
      updatedAt: completedAt
    });
    this.recordTaskEvent(updated, 'task_failed');
    return normalizeTask(updated);
  }

  failTask(taskId, error, updates = {}) {
    const completedAt = now();
    const updated = this.repository.update(taskId, {
      ...updates,
      status: 'failed',
      error,
      completedAt,
      updatedAt: completedAt
    });
    this.recordTaskEvent(updated, 'task_failed');
    return normalizeTask(updated);
  }

  cancelTask(taskId) {
    const completedAt = now();
    const updated = this.repository.update(taskId, {
      status: 'cancelled',
      error: '',
      completedAt,
      updatedAt: completedAt
    });
    this.recordTaskEvent(updated, 'task_cancelled');
    return normalizeTask(updated);
  }

  saveTaskResult(taskId) {
    const task = this.repository.read(taskId);
    if (!task || task.status !== 'completed') return null;
    const savedAt = now();
    const updated = this.repository.update(taskId, {
      isSaved: true,
      savedAt,
      updatedAt: savedAt
    });
    this.recordTaskEvent(updated, 'result_saved');
    return normalizeTask(updated);
  }

  recordTaskEvent(task, status) {
    if (!task) return null;
    try {
      return this.events.createEvent({
        type: 'ai',
        source: 'work-secretary',
        title: 'work_secretary_task',
        content: '',
        tags: ['work-secretary', task.taskType, status],
        status: status === 'task_completed' ? 'done' : 'open',
        priority: status === 'task_failed' ? 'high' : 'normal',
        metadata: {
          taskId: task.taskId,
          conversationId: task.conversationId || '',
          workSecretaryStatus: status,
          taskType: task.taskType,
          latency: task.latency || 0,
          attachmentCount: Array.isArray(task.attachments) ? task.attachments.length : 0
        }
      });
    } catch {
      return null;
    }
  }

  prepareRequest(task, input, memoryContext = { items: [] }) {
    const route = this.router.route({ input });
    const previousTask = this.findPreviousCompletedTask(task.taskId, task.conversationId);
    const attachments = Array.isArray(task.attachments) ? task.attachments.map((item) => normalizeAttachment(item, task.taskId, true)) : [];
    const taskType = isFollowUp(input) && previousTask?.taskType ? previousTask.taskType : route.taskType;
    const confirmation = this.buildTaskConfirmation({
      input,
      taskType,
      previousTask,
      attachments
    });
    const context = this.buildScopedContext(input, previousTask, confirmation, attachments, task.conversationContext, memoryContext);
    const promptId = getPromptId(confirmation.taskType);
    const prompt = this.prompts.loadPrompt(promptId);
    const templateData = {
      input,
      taskConfirmation: JSON.stringify(confirmation, null, 2),
      context: context.content || '无直接相关上下文。'
    };
    const systemContent = this.prompts.renderPrompt(prompt.system, templateData);
    const userContent = this.prompts.renderPrompt(prompt.user, templateData);

    const visionAttachments = attachments.filter(attachmentHasVisionPayload);
    const userMessageContent = visionAttachments.length
      ? [
          { type: 'text', text: userContent },
          ...visionAttachments.map((attachment) => ({
            type: 'image_url',
            image_url: { url: attachment.imageDataUrl }
          }))
        ]
      : userContent;

    return {
      promptId,
      capability: visionAttachments.length ? CAPABILITIES.VISION : undefined,
      confirmation,
      context,
      messages: [
        {
          role: 'system',
          content: systemContent
        },
        {
          role: 'user',
          content: userMessageContent
        }
      ],
      debug: {
        originalInput: input,
        taskType: confirmation.taskType,
        taskConfirmation: confirmation,
        promptTemplateName: promptId,
        injectedMemoryCount: context.memoryItems.length,
        injectedKnowledgeCount: context.knowledgeItems.length,
        injectedAttachmentCount: context.attachmentItems.length + visionAttachments.length
      }
    };
  }

  buildTaskConfirmation({ input, taskType, previousTask, attachments = [] }) {
    const followUp = isFollowUp(input);
    const requiredInputs = [];
    const missingInputs = [];
    const hasReadableAttachments = attachments.some((attachment) => attachmentHasParsedContent(attachment) || attachmentHasVisionPayload(attachment));

    if (taskType === 'reasoning') {
      requiredInputs.push('需要分析的方案、材料或明确对象');
      if (!followUp && !hasProvidedAnalysisObject(input, attachments)) {
        missingInputs.push('请提供需要分析的方案内容，或粘贴方案的目标、关键措施、预算、时间和约束。');
      }
    }

    if (taskType === 'data_analysis') {
      requiredInputs.push('门店、产品、销售额、订单数、客户数或成交数');
      if (!hasProvidedData(input) && !hasReadableAttachments) {
        missingInputs.push('要统计各门店销售额，请上传销售报表，或粘贴包含门店、产品、销售额、订单数和客户数的数据。');
      }
    }

    return {
      taskType,
      userGoal: input,
      audience: extractAudience(input),
      outputFormat: extractOutputFormat(input, taskType),
      constraints: extractConstraints(input),
      requiredInputs,
      missingInputs,
      isFollowUp: followUp,
      previousTaskId: followUp ? previousTask?.taskId || '' : '',
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        contentType: attachment.contentType,
        parseable: attachment.parseable,
        status: attachment.status,
        parseStatus: attachment.parseStatus,
        warnings: attachment.warnings
      }))
    };
  }

  findPreviousCompletedTask(currentTaskId, conversationId = '') {
    return this.listTasks().find((item) => item.taskId !== currentTaskId
      && item.status === 'completed'
      && (!conversationId || item.conversationId === conversationId)) || null;
  }

  buildScopedContext(input, previousTask, confirmation, attachments = [], conversationContext = null, persistentMemoryContext = { items: [] }) {
    const memoryItems = this.selectRelevantItems(this.memory.list({ includeDisabled: false }), input, 3);
    const knowledgeItems = this.selectRelevantItems(this.knowledge.search({ keyword: '' }), input, 3);
    const attachmentItems = attachments.filter(attachmentHasParsedContent);
    const sections = [];

    if (attachmentItems.length) {
      sections.push(`当前任务附件（只使用真实可读取内容；未解析或不支持的附件不会注入）：\n${attachmentItems.map(formatAttachmentContext).join('\n\n')}`);
    }

    if (memoryItems.length) {
      sections.push(`Memory（仅直接相关）：\n${memoryItems.map((item) => `- ${item.title}: ${item.content}`).join('\n')}`);
    }

    const persistentMemoryItems = Array.isArray(persistentMemoryContext?.items) ? persistentMemoryContext.items.slice(0, 3) : [];
    if (persistentMemoryItems.length) {
      sections.push(`长期记忆（仅直接相关，含来源时间）：\n${persistentMemoryItems.map((item) => `- ${item.summary}（来源：${item.sourceType}，${item.eventDate || String(item.createdAt || '').slice(0, 10)}）`).join('\n')}`);
    }

    if (knowledgeItems.length) {
      sections.push(`Knowledge（仅直接相关）：\n${knowledgeItems.map((item) => `- ${item.title}: ${item.content}`).join('\n')}`);
    }

    if (conversationContext?.summary) {
      sections.push(`当前会话摘要（只用于延续本次工作，不跨会话串线）：\n${String(conversationContext.summary).slice(0, 2400)}`);
    }

    if (Array.isArray(conversationContext?.recentMessages) && conversationContext.recentMessages.length) {
      const lines = conversationContext.recentMessages
        .filter((message) => message?.content)
        .slice(-8)
        .map((message) => `${message.role === 'assistant' ? 'AI' : '用户'}：${String(message.content).slice(0, 1200)}`);
      if (lines.length) sections.push(`当前会话最近对话：\n${lines.join('\n')}`);
    }

    if (confirmation.isFollowUp && previousTask?.result) {
      sections.push(`当前会话上一份结果（只用于本次追问，不改变原主题）：\n${previousTask.result.slice(0, 1600)}\n\n追问要求：基于当前会话上下文继续处理，只修改风格，不改变主题，不要把追问当作独立新任务。`);
    }

    return {
      content: sections.join('\n\n').slice(0, 10000),
      attachmentItems,
      memoryItems: [...memoryItems, ...persistentMemoryItems],
      knowledgeItems
    };
  }

  selectRelevantItems(items = [], input = '', limit = 3) {
    const source = String(input || '').toLowerCase();
    const terms = source
      .split(/[^\p{L}\p{N}]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);

    return items
      .map((item) => {
        const target = `${item.title || ''} ${item.content || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
        const score = terms.reduce((count, term) => count + (target.includes(term) ? 1 : 0), 0);
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item }) => item);
  }
}

export const workSecretaryManager = new WorkSecretaryManager();
