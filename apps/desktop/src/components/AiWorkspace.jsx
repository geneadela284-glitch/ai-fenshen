import { useEffect, useMemo, useRef, useState } from 'react';
import PrimaryButton from './PrimaryButton';
import { copyText, exportMarkdown } from '../lib/workspaceActions';
import { runAiAction } from '../../../../core/actions/runAiAction.js';
import { promptManager } from '../../../../core/prompts/index.js';
import { toolManager } from '../../../../core/tools/toolManager.js';
import { workspaceManager } from '../../../../core/workspace/workspaceManager.js';

function formatWorkspaceError(error) {
  if (error?.message?.includes('Provider not found')) return 'Provider 未配置';
  return error?.message || '网络错误';
}

function getUsageTotal(usage) {
  if (!usage) return 0;
  return (
    usage.total_tokens ||
    usage.totalTokens ||
    (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0)) ||
    (Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0)) ||
    0
  );
}

function AiWorkspace({ config, onBack }) {
  const [workspaces, setWorkspaces] = useState(() => workspaceManager.list(config.id));
  const [activeWorkspace, setActiveWorkspace] = useState(() => workspaceManager.ensure(config.id, config.title));
  const [draft, setDraft] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [debugInfo, setDebugInfo] = useState(null);
  const activeRequestRef = useRef(null);

  const messages = activeWorkspace?.messages || [];
  const lastAssistant = useMemo(() => [...messages].reverse().find((message) => message.role === 'assistant'), [messages]);

  const refreshWorkspaces = (workspace = activeWorkspace) => {
    setWorkspaces(workspaceManager.list(config.id));
    if (workspace) {
      setActiveWorkspace(workspaceManager.load(workspace.id) || workspace);
    }
  };

  useEffect(() => {
    const workspace = workspaceManager.ensure(config.id, config.title);
    setActiveWorkspace(workspace);
    setWorkspaces(workspaceManager.list(config.id));
    setDraft('');
    setIsGenerating(false);
    activeRequestRef.current = null;
  }, [config.id, config.title]);

  const createWorkspace = () => {
    const workspace = workspaceManager.create({ toolId: config.id, title: '新 Workspace' });
    setActiveWorkspace(workspace);
    setWorkspaces(workspaceManager.list(config.id));
    setDraft('');
  };

  const switchWorkspace = (workspaceId) => {
    const workspace = workspaceManager.touchOpen(workspaceId);
    if (!workspace) return;
    workspaceManager.setActiveWorkspaceId(config.id, workspaceId);
    setActiveWorkspace(workspace);
    setWorkspaces(workspaceManager.list(config.id));
    setDraft('');
  };

  const renameWorkspace = (event, workspaceId) => {
    event.stopPropagation();
    const workspace = workspaceManager.load(workspaceId);
    const nextTitle = window.prompt('输入新的 Workspace 名称', workspace?.title || '');
    if (!nextTitle) return;
    const renamed = workspaceManager.rename(workspaceId, nextTitle);
    setActiveWorkspace(renamed);
    setWorkspaces(workspaceManager.list(config.id));
  };

  const duplicateWorkspace = (event, workspaceId) => {
    event.stopPropagation();
    const copied = workspaceManager.duplicate(workspaceId);
    if (!copied) return;
    setActiveWorkspace(copied);
    setWorkspaces(workspaceManager.list(config.id));
  };

  const deleteWorkspace = (event, workspaceId) => {
    event.stopPropagation();
    workspaceManager.delete(workspaceId);
    const workspace = workspaceManager.ensure(config.id, config.title);
    setActiveWorkspace(workspace);
    setWorkspaces(workspaceManager.list(config.id));
  };

  const stopGenerating = () => {
    activeRequestRef.current = null;
    setIsGenerating(false);
  };

  const send = async () => {
    const input = draft.trim();
    if (!input || isGenerating) return;

    setIsGenerating(true);
    setDraft('');
    const requestId = Date.now();
    activeRequestRef.current = requestId;

    const startedAt = performance.now();
    let promptMessagesForDebug = [];
    let memoryContextForDebug = {
      loaded: 0,
      tokens: 0,
      preview: ''
    };
    let toolDebug = {
      loaded: config.id,
      execute: false,
      time: 0,
      result: null
    };
    let requestForDebug = null;

    let workspace = activeWorkspace || workspaceManager.ensure(config.id, config.title);
    workspace = workspaceManager.addMessage(workspace.id, {
      role: 'user',
      content: input,
      toolId: config.id
    });
    refreshWorkspaces(workspace);

    try {
      const promptMessages = promptManager.buildMessages(config.promptId || config.id, {
        category: config.categories?.[0] || config.title,
        input
      });
      memoryContextForDebug = promptManager.getLastMemoryContext();
      promptMessagesForDebug = promptMessages;
      const systemMessage = promptMessages.find((message) => message.role === 'system');
      const userPrompt = promptMessages.find((message) => message.role === 'user')?.content || input;
      const historyMessages = workspace.messages
        .slice(0, -1)
        .map((message) => ({ role: message.role, content: message.content }));
      requestForDebug = {
        action: config.action || 'chat',
        capability: config.capability || 'CHAT',
        messages: [
          ...(systemMessage ? [systemMessage] : []),
          ...historyMessages,
          { role: 'user', content: userPrompt }
        ]
      };

      const response = await runAiAction({
        type: requestForDebug.action,
        capability: requestForDebug.capability,
        messages: requestForDebug.messages
      });

      if (activeRequestRef.current !== requestId) return;

      try {
        const toolExecution = await toolManager.execute(config.id, {
          input,
          response,
          messages: requestForDebug.messages
        });
        toolDebug = {
          loaded: toolExecution.toolName || config.id,
          execute: true,
          time: toolExecution.durationMs,
          result: toolExecution.result
        };
      } catch (toolError) {
        toolDebug = {
          loaded: config.id,
          execute: false,
          time: 0,
          result: toolError.message || 'Tool 执行失败'
        };
      }

      setDebugInfo({
        tool: config.id,
        prompt: promptMessages,
        capability: response.capability || requestForDebug.capability,
        selectedProvider: response.selectedProvider || response.provider || '',
        selectedModel: response.selectedModel || response.model || response.raw?.model || '',
        orchestrator: response.debug || null,
        request: requestForDebug,
        response: {
          content: response.content || '',
          mocked: Boolean(response.mocked),
          usage: response.usage || null,
          taskType: response.taskType,
          selectedProvider: response.selectedProvider,
          selectedModel: response.selectedModel,
          fallbackUsed: response.fallbackUsed,
          error: response.error
        },
        durationMs: Math.round(performance.now() - startedAt),
        tokens: getUsageTotal(response.usage),
        memory: memoryContextForDebug,
        toolDebug,
        error: response.error?.message || ''
      });

      const responseTokens = getUsageTotal(response.usage);
      workspace = workspaceManager.addMessage(workspace.id, {
        role: 'assistant',
        content: response.content || '',
        generatedContent: response.content || '',
        prompt: promptMessages,
        tokens: responseTokens,
        toolId: config.id
      });
    } catch (error) {
      if (activeRequestRef.current !== requestId) return;
      const errorMessage = formatWorkspaceError(error);

      setDebugInfo((current) => ({
        tool: config.id,
        prompt: promptMessagesForDebug,
        capability: requestForDebug?.capability || config.capability || 'CHAT',
        selectedProvider: '',
        selectedModel: '',
        orchestrator: null,
        request: requestForDebug || {
          action: config.action || 'chat',
          capability: config.capability || 'CHAT',
          input
        },
        response: null,
        durationMs: Math.round(performance.now() - startedAt),
        tokens: 0,
        memory: memoryContextForDebug,
        toolDebug,
        error: errorMessage
      }));

      workspace = workspaceManager.addMessage(workspace.id, {
        role: 'assistant',
        content: errorMessage,
        generatedContent: errorMessage,
        prompt: promptMessagesForDebug,
        tokens: 0,
        toolId: config.id
      });
    } finally {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null;
        setIsGenerating(false);
        refreshWorkspaces(workspace);
      }
    }
  };

  return (
    <section className="overflow-hidden rounded-[36px] border border-white/80 bg-white/70 shadow-[0_24px_80px_rgba(60,54,45,0.08)] backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-white/70 px-6 py-5">
        <div className="min-w-0">
          <button className="mb-4 text-sm text-[#8a8378] transition hover:text-[#1f1f1f]" onClick={onBack}>
            返回首页
          </button>
          <div className="flex flex-wrap items-end gap-3">
            <h2 className="text-3xl font-semibold tracking-tight">{config.title}</h2>
            <span className="rounded-full bg-[#f2eee8] px-3 py-1 text-xs text-[#7b7164]">{config.mockBadge}</span>
          </div>
          <p className="mt-2 text-sm text-[#746d64]">{config.subtitle}</p>
        </div>
        <div className="flex shrink-0 gap-2 text-sm text-[#6f695f]">
          <span className="rounded-full bg-white/80 px-4 py-2">AI Router</span>
        </div>
      </div>

      <div className="grid min-h-[620px] grid-cols-[260px_1fr]">
        <aside className="border-r border-white/70 bg-[#f8f5ef]/80 p-4">
          <div className="mb-4 flex items-center justify-between">
            <div className="px-2 text-sm font-semibold text-[#4d473f]">Workspace</div>
            <button
              className="rounded-full bg-white px-3 py-1.5 text-xs text-[#4d473f] shadow-sm transition hover:bg-[#1f1f1f] hover:text-white active:scale-95"
              onClick={createWorkspace}
            >
              新建
            </button>
          </div>
          <div className="space-y-2">
            {workspaces.length === 0 ? (
              <div className="px-2 text-xs leading-5 text-[#8a8378]">开始对话后会自动保存到本地。</div>
            ) : (
              workspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className={`group w-full rounded-2xl px-3 py-3 text-left transition active:scale-[0.98] ${
                    activeWorkspace?.id === workspace.id
                      ? 'bg-[#1f1f1f] text-white shadow-[0_12px_28px_rgba(31,31,31,0.16)]'
                      : 'bg-white/70 text-[#6f695f] hover:bg-white hover:text-[#1f1f1f]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                      onClick={() => switchWorkspace(workspace.id)}
                    >
                      {workspace.title}
                    </button>
                    <div className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100">
                      <button className="rounded-full px-2 py-0.5 text-xs transition hover:bg-[#f2eee8]" onClick={(event) => renameWorkspace(event, workspace.id)}>
                        改名
                      </button>
                      <button className="rounded-full px-2 py-0.5 text-xs transition hover:bg-[#f2eee8]" onClick={(event) => duplicateWorkspace(event, workspace.id)}>
                        复制
                      </button>
                      <button className="rounded-full px-2 py-0.5 text-xs transition hover:bg-[#f2eee8]" onClick={(event) => deleteWorkspace(event, workspace.id)}>
                        删除
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-xs opacity-70">
                    {new Date(workspace.lastEditedAt || workspace.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-col bg-white/40">
          <div className="flex-1 overflow-auto px-7 py-6">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-md text-center">
                  <div className="text-2xl font-semibold text-[#2a2927]">开始一个任务</div>
                  <p className="mt-3 text-sm leading-6 text-[#746d64]">{config.placeholder}</p>
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col gap-4">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[78%] rounded-[26px] px-5 py-4 text-sm leading-7 shadow-[0_12px_32px_rgba(60,54,45,0.06)] ${
                        message.role === 'user'
                          ? 'bg-[#1f1f1f] text-white'
                          : 'border border-[#eee7dc] bg-white text-[#2a2927]'
                      }`}
                    >
                      <div className="whitespace-pre-wrap">{message.content}</div>
                      <div className={`mt-3 text-xs ${message.role === 'user' ? 'text-white/55' : 'text-[#8a8378]'}`}>
                        {new Date(message.time).toLocaleString('zh-CN', { hour12: false })}
                      </div>
                    </div>
                  </div>
                ))}
                {isGenerating ? (
                  <div className="flex justify-start">
                    <div className="rounded-[26px] border border-[#eee7dc] bg-white px-5 py-4 text-sm text-[#8a8378] shadow-[0_12px_32px_rgba(60,54,45,0.06)]">
                      正在生成...
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="border-t border-white/70 bg-white/70 px-7 py-5">
            <div className="mx-auto max-w-4xl">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                className="h-24 w-full resize-none rounded-[24px] border border-[#eee7dc] bg-[#fbfaf7] p-4 text-sm leading-6 text-[#2a2927] outline-none transition focus:border-[#1f1f1f] focus:bg-white"
                placeholder={config.placeholder}
              />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-3">
                  <PrimaryButton onClick={send} disabled={isGenerating || !draft.trim()}>
                    发送
                  </PrimaryButton>
                  <PrimaryButton variant="light" onClick={stopGenerating} disabled={!isGenerating}>
                    停止生成
                  </PrimaryButton>
                </div>
                <div className="flex gap-3">
                  <PrimaryButton variant="light" onClick={() => copyText(lastAssistant?.content || '')} disabled={!lastAssistant}>
                复制
                  </PrimaryButton>
                  <PrimaryButton variant="light" onClick={() => exportMarkdown(config, '会话', lastAssistant?.content || '')} disabled={!lastAssistant}>
                    导出 Markdown
                  </PrimaryButton>
                </div>
              </div>
              {import.meta.env.DEV ? <DebugConsole info={debugInfo} /> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DebugConsole({ info }) {
  if (!info) {
    return (
      <div className="mt-4 rounded-[22px] border border-dashed border-[#ddd4c8] bg-[#fbfaf7] p-4 text-xs text-[#8a8378]">
        Debug Console：发送消息后显示当前 Tool、Prompt、Capability、Request、Response、耗时和错误信息。
      </div>
    );
  }

  return (
    <details className="mt-4 rounded-[22px] border border-[#eee7dc] bg-[#fbfaf7] p-4 text-xs text-[#4d473f]">
      <summary className="cursor-pointer font-semibold">Debug Console</summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <DebugItem label="当前 Tool" value={info.tool} />
        <DebugItem label="Capability" value={info.capability || '无'} />
        <DebugItem label="用户原始目标" value={info.orchestrator?.originalGoal || '无'} />
        <DebugItem label="Task Type" value={info.orchestrator?.taskType || '无'} />
        <DebugItem label="首选 Provider" value={info.orchestrator?.preferredProvider || '无'} />
        <DebugItem label="实际 Provider" value={info.orchestrator?.selectedProvider || info.selectedProvider || '无'} />
        <DebugItem label="实际 Model" value={info.orchestrator?.selectedModel || info.selectedModel || '无'} />
        <DebugItem label="Fallback" value={info.orchestrator?.fallbackUsed ? '是' : '否'} />
        <DebugItem label="耗时" value={`${info.durationMs} ms`} />
        <DebugItem label="Token" value={String(info.tokens || 0)} />
        <DebugItem label="错误信息" value={info.error || '无'} />
        <DebugItem label="Memory Loaded" value={String(info.memory?.loaded || 0)} />
        <DebugItem label="Memory Tokens" value={String(info.memory?.tokens || 0)} />
        <DebugItem label="Tool Loaded" value={info.toolDebug?.loaded || info.tool} />
        <DebugItem label="Tool Execute" value={info.toolDebug?.execute ? '已执行' : '未执行'} />
        <DebugItem label="Tool Time" value={`${info.toolDebug?.time || 0} ms`} />
      </div>
      <DebugBlock label="Memory Preview" value={info.memory?.preview || ''} />
      <DebugBlock label="Tool Result" value={info.toolDebug?.result || null} />
      <DebugBlock label="Prompt" value={info.prompt} />
      <DebugBlock label="Request" value={info.request} />
      <DebugBlock label="AI Orchestrator" value={info.orchestrator || null} />
      <DebugBlock label="Response" value={info.response} />
    </details>
  );
}

function DebugItem({ label, value }) {
  return (
    <div className="rounded-2xl bg-white px-3 py-2">
      <div className="text-[#8a8378]">{label}</div>
      <div className="mt-1 break-words font-medium">{value}</div>
    </div>
  );
}

function DebugBlock({ label, value }) {
  return (
    <div className="mt-3">
      <div className="mb-1 font-semibold">{label}</div>
      <pre className="max-h-44 overflow-auto rounded-2xl bg-white p-3 leading-5 text-[#4d473f]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default AiWorkspace;
