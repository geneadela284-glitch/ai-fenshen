import { buildConversationContextPack } from '../memory/conversationContextPack.js';
import { evaluateFinanceToolPlan } from '../finance/financeToolContract.js';
import { bindAssistantToolEvidence } from './assistantEvidenceBinder.js';
import { createAssistantSemanticIngress } from './assistantSemanticIngress.js';
import { createAssistantContextStateStore } from './assistantContextState.js';
import {
  adaptUnifiedPlanToFinance,
  adaptUnifiedPlanToMemory,
  adaptUnifiedPlanToTool
} from './domainPlanAdapters.js';
import { finalizeGroundedToolResponse } from './groundedToolResponder.js';
import { deterministicIdentityAnswer } from './identityDeterministic.js';
import { isAccessControlErrorCode } from '../../core/router/AccessControlErrorCodes.js';

export function createAssistantAgentOrchestrator({ financePlanner = null, financeService = null, memoryIntegration = null,
  assistantToolPlanner = null, toolRegistry = null, evidenceBinder = bindAssistantToolEvidence,
  semanticPlanner = null, semanticIngress: semanticIngressOverride = null,
  contextStateStore = createAssistantContextStateStore(),
  timezone = 'Asia/Shanghai', clock = () => new Date() } = {}) {
  const toolContinuations = new Map();
  const continuationKey = (ownerId, conversationId) => `${ownerId}::${conversationId}`;
  const semanticIngress = semanticIngressOverride ||
    (semanticPlanner?.plan ? createAssistantSemanticIngress({ planner: semanticPlanner }) : null);

  function trustedSemanticContext(input) {
    const finance = financeService?.trustedContext?.(input.ownerId, input.conversationId) || null;
    const memory = memoryIntegration?.trustedContext?.(input.ownerId, input.conversationId) || null;
    const tool = toolContinuations.get(continuationKey(input.ownerId, input.conversationId)) || null;
    const canonical = contextStateStore.read(input.ownerId, input.conversationId);
    const values = {};
    if (memory?.previous_entity) {
      values['entity.relation_to_owner'] = memory.previous_entity;
      values.relation_to_owner = memory.previous_entity;
    }
    if (memory?.previous_predicate) values.predicate = memory.previous_predicate;
    if (finance?.previous_period_type) values['qualifiers.period_type'] = finance.previous_period_type;
    if (Array.isArray(finance?.previous_metrics)) values['arguments.metrics'] = [...finance.previous_metrics];
    if (tool?.previous_tool) values.tool = tool.previous_tool;
    if (canonical?.active_entity?.relation_to_owner) {
      values['entity.relation_to_owner'] = canonical.active_entity.relation_to_owner;
      values.relation_to_owner = canonical.active_entity.relation_to_owner;
    }
    if (canonical?.active_predicate) values.predicate = canonical.active_predicate;
    if (canonical?.active_tool) values.tool = canonical.active_tool;
    return Object.freeze({
      ...(canonical || {}),
      owner: String(input.ownerId || ''),
      conversation: String(input.conversationId || ''),
      owner_id: String(input.ownerId || ''),
      conversation_id: String(input.conversationId || ''),
      values: Object.freeze(values),
      memory_context: memory ? structuredClone(memory) : null,
      finance_context: finance ? structuredClone(finance) : null,
      tool_context: tool ? structuredClone(tool) : null
    });
  }

  function executionAccepted(result) {
    if (!result || typeof result !== 'object') return false;
    if (['clarification', 'query_error'].includes(result.kind)) return false;
    if (['clarify', 'error'].includes(result.action)) return false;
    const outcome = String(result.outcome || '').toLowerCase();
    return !outcome.includes('fail') && !outcome.includes('error');
  }

  function financeError(code, content = '这笔账暂时没有记录成功，请重试。') {
    return {
      domain: 'finance',
      handled: true,
      action: 'error',
      code,
      content
    };
  }

  function validateFinanceResult(result, { plan, input }) {
    if (!result || result.handled !== true) {
      return financeError('FINANCE_HANDLER_NOT_HANDLED');
    }
    if (result.action === 'error') {
      return {
        ...result,
        handled: true,
        action: 'error',
        code: result.code || 'FINANCE_HANDLER_FAILED',
        content: result.content || '这笔账暂时没有记录成功，请重试。'
      };
    }
    if (plan?.action !== 'create') return result;
    const entry = result.data?.entry;
    if (result.action !== 'create' || !entry?.id ||
        entry.clientRequestId !== input.clientRequestId ||
        entry.sourceMessageId !== input.sourceMessageId) {
      return financeError('FINANCE_PERSISTENCE_UNCONFIRMED');
    }
    return result;
  }

  function validateFinanceBatchResult(result, { plan, input }) {
    if (plan?.action !== 'create_batch') return result;
    if (result?.action === 'error') return result;
    const entries = result.data?.entries;
    const commands = plan.commands;
    if (result.action !== 'create_batch' || !Array.isArray(entries) || !Array.isArray(commands) ||
        entries.length !== commands.length || entries.some((entry, index) => (
          !entry?.id ||
          entry.clientRequestId !== `${input.clientRequestId}:${index + 1}` ||
          entry.sourceMessageId !== input.sourceMessageId
        ))) {
      return financeError('FINANCE_PERSISTENCE_UNCONFIRMED');
    }
    return result;
  }

  function markBusinessExecution(interpreted, outcome = {}) {
    try {
      semanticPlanner?.markBusinessExecution?.(interpreted?.route, outcome);
    } catch {
      // Observability must never change a domain result.
    }
  }

  function commitCanonicalContext(plan, input, toolResult = null) {
    contextStateStore.commit({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      plan,
      toolResult
    });
  }

  async function invokeToolPlan(plan, input, {
    now,
    memoryContext = null,
    canonicalPlan = null
  } = {}) {
    if (plan?.tool === 'tasks.create') {
      if (!toolRegistry?.invoke) {
        return {
          domain: 'tasks', handled: true, action: 'error',
          content: '暂时无法记录事项，请稍后再试。'
        };
      }
      const outcome = await toolRegistry.invoke(plan.tool, {
        plan,
        ownerId: input.ownerId,
        timezone: input.taskTimezone || timezone,
        now,
        clientRequestId: input.clientRequestId,
        sourceMessageId: input.sourceMessageId
      });
      if (outcome?.decision === 'ASK') {
        return {
          domain: 'tasks', handled: true, action: 'clarify',
          content: outcome.question || '请补充事项日期。'
        };
      }
      if (outcome?.decision !== 'ACCEPT') {
        return {
          domain: 'tasks', handled: true, action: 'error',
          content: '暂时无法记录事项，请稍后再试。'
        };
      }
      if (canonicalPlan) commitCanonicalContext(canonicalPlan, input, outcome.result?.data || null);
      return {
        domain: 'tasks',
        handled: true,
        action: 'create',
        content: outcome.result.safe_user_message,
        task: outcome.result.data.task
      };
    }
    const bound = await evidenceBinder(plan, {
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      memoryIntegration
    });
    if (!bound?.ok) {
      return {
        domain: 'tool', handled: true, action: 'not_found',
        content: bound?.code === 'TOOL_EVIDENCE_NOT_FOUND' ? '我目前还不知道。' : '暂时无法读取长期记忆，请稍后再试。'
      };
    }
    if (!toolRegistry?.invoke) {
      return { domain: 'tool', handled: true, action: 'error', content: '暂时无法完成日期换算，请稍后再试。' };
    }
    const outcome = await toolRegistry.invoke(bound.plan.tool, {
      plan: bound.plan,
      evidenceBundle: bound.evidenceBundle,
      ownerId: input.ownerId,
      timezone,
      now,
      semanticContext: memoryContext
    });
    if (outcome?.decision === 'ASK') {
      return { domain: 'tool', handled: true, action: 'clarify', content: outcome.question || '请补充一个最必要的信息。' };
    }
    if (outcome?.decision !== 'ACCEPT') {
      return { domain: 'tool', handled: true, action: 'error', content: '暂时无法完成日期换算，请稍后再试。' };
    }
    const finalized = finalizeGroundedToolResponse({ evidenceBundle: bound.evidenceBundle, toolResult: outcome.result });
    if (!finalized.ok) {
      return { domain: 'tool', handled: true, action: 'error', content: '暂时无法完成日期换算，请稍后再试。' };
    }
    const key = continuationKey(input.ownerId, input.conversationId);
    toolContinuations.delete(key);
    toolContinuations.set(key, Object.freeze({
      previous_entity: bound.plan.required_evidence?.[0]?.entity_relation || null,
      previous_predicate: bound.plan.required_evidence?.[0]?.predicate || null,
      previous_tool: bound.plan.tool
    }));
    if (toolContinuations.size > 1000) toolContinuations.delete(toolContinuations.keys().next().value);
    if (canonicalPlan) commitCanonicalContext(canonicalPlan, input, outcome.result?.data || null);
    return {
      domain: 'tool', handled: true, action: bound.plan.action,
      content: finalized.content, coverage: finalized.coverage
    };
  }

  return Object.freeze({
    isMemoryQuery(message, context) {
      return Boolean(memoryIntegration?.isMemoryQuery?.(message, context));
    },
    async processUserMessage(input) {
      const identity = deterministicIdentityAnswer(input.message);
      if (identity) {
        return {
          domain: 'identity',
          handled: true,
          intent: identity.intent,
          action: identity.action,
          content: identity.content
        };
      }
      const deterministicNow = typeof financeService?.clock === 'function'
        ? financeService.clock()
        : clock();
      const deterministicContext = trustedSemanticContext(input);
      // Amounts in plans, hypotheticals and explicit prohibitions are not completed
      // transactions. Let the existing semantic contract interpret these requests.
      const financeNeedsSemanticUnderstanding = /(?:预算|规划|计划|建议|方案|假如|假设|如果|准备|打算|不(?:要|能|许|会)?(?:买|购买|支付|转账|记账)|别记账)/u.test(input.message);
      const forbidsLedgerWrite = /(?:不(?:要|能|许|会)?记账|别记账)/u.test(input.message);
      const financeSubject = '(?:账本|账单|账目|流水|收支|收入|支出|结余|余额|回款|退款|交易|工资)';
      const explicitLedger = new RegExp('(?:查(?:询|看)?|统计|汇总|核对|对比).{0,12}' + financeSubject, 'u').test(input.message) ||
        new RegExp('(?:我(?:的)?|今天|昨天|本月|上月|这个月|今年).{0,12}' + financeSubject + '.{0,12}(?:多少|几笔|明细|情况)', 'u').test(input.message) ||
        /(?:花了|收入|支出|余额).{0,5}(?:多少|几笔)|记(?:一笔)?账|(?:删除|撤销|更正|修改|记下).{0,10}(?:账|上一笔|这笔|交易)/u.test(input.message);
      const completedTransaction = /(?:花了|付了|支付了|买了|转了|收到了|收到|收入了|支出了)/u.test(input.message) && !/(?:如果|假如|假设|准备|打算|预计)/u.test(input.message);
      const financialPlanningOnly = financeNeedsSemanticUnderstanding && !explicitLedger && !completedTransaction;
      const deterministicBatchPlan = !financeNeedsSemanticUnderstanding && financeService?.deterministicCreateBatchPlan?.(input.message, {
        now: deterministicNow,
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        conversationMessages: input.conversationMessages
      });
      if (deterministicBatchPlan) {
        const acceptedCommands = [];
        for (const [index, command] of deterministicBatchPlan.commands.entries()) {
          const contract = evaluateFinanceToolPlan(command, {
            message: deterministicBatchPlan.source_texts[index],
            timezone,
            now: deterministicNow,
            trustedContext: deterministicContext.finance_context,
            ownerId: input.ownerId
          });
          if (contract.decision !== 'ACCEPT') {
            return financeError('FINANCE_DETERMINISTIC_COMMAND_INVALID', '暂时无法理解这条财务请求，请稍后再试。');
          }
          acceptedCommands.push(contract.plan);
        }
        const acceptedBatchPlan = { ...deterministicBatchPlan, commands: acceptedCommands };
        markBusinessExecution({ route: 'deterministic_finance_batch_fast_path' }, { businessExecutionStarted: true });
        let serviceResult;
        try {
          serviceResult = await financeService.processUserMessage({ ...input, plan: acceptedBatchPlan });
        } catch (error) {
          return financeError(error?.code || 'FINANCE_HANDLER_FAILED');
        }
        const result = {
          domain: 'finance',
          ...validateFinanceResult(serviceResult, { plan: acceptedBatchPlan, input }),
          ...validateFinanceBatchResult(serviceResult, { plan: acceptedBatchPlan, input })
        };
        markBusinessExecution({ route: 'deterministic_finance_batch_fast_path' }, {
          businessExecutionStarted: true,
          businessWriteOccurred: ['create_batch'].includes(result.action) && executionAccepted(result)
        });
        if (executionAccepted(result)) commitCanonicalContext(acceptedBatchPlan, input);
        return result;
      }
      const deterministicPlan = !financeNeedsSemanticUnderstanding && financeService?.deterministicCreatePlan?.(input.message, {
        now: deterministicNow,
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        conversationMessages: input.conversationMessages
      });
      if (deterministicPlan) {
        const contract = evaluateFinanceToolPlan(deterministicPlan, {
          message: input.message,
          timezone,
          now: deterministicNow,
          trustedContext: deterministicContext.finance_context,
          ownerId: input.ownerId
        });
        if (contract.decision === 'ASK') {
          financeService?.rememberPendingPlan?.({
            ownerId: input.ownerId,
            conversationId: input.conversationId,
            plan: deterministicPlan
          });
          return { domain: 'finance', handled: true, action: 'clarify', content: contract.question };
        }
        if (contract.decision !== 'ACCEPT') {
          return financeError('FINANCE_DETERMINISTIC_COMMAND_INVALID', '暂时无法理解这条财务请求，请稍后再试。');
        }
        markBusinessExecution({ route: 'deterministic_finance_fast_path' }, { businessExecutionStarted: true });
        let serviceResult;
        try {
          serviceResult = await financeService.processUserMessage({ ...input, plan: contract.plan });
        } catch (error) {
          return financeError(error?.code || 'FINANCE_HANDLER_FAILED');
        }
        const result = {
          domain: 'finance',
          ...validateFinanceResult(serviceResult, { plan: contract.plan, input })
        };
        markBusinessExecution({ route: 'deterministic_finance_fast_path' }, {
          businessExecutionStarted: true,
          businessWriteOccurred: ['create', 'create_batch', 'update', 'delete', 'classify'].includes(result.action) &&
            executionAccepted(result)
        });
        if (executionAccepted(result)) commitCanonicalContext(deterministicPlan, input);
        return result;
      }

      if (semanticIngress?.interpret) {
        const now = clock();
        const trustedContext = trustedSemanticContext(input);
        const key = continuationKey(input.ownerId, input.conversationId);
        // Topic matches are hints, not authority to force the planner into a ledger action.
        // Only explicit ledger reads/writes or an active finance context pin that domain;
        // every returned finance plan still goes through the existing deterministic contract.
        const financeContinuation = /^(?:那|再查|换成|改为|改成|上一笔|这一笔|这笔|继续查|还是|取消|确认)/u.test(input.message);
        const transactionAmount = /(?:\d|[零一二三四五六七八九十百千万两点])(?:[\d零一二三四五六七八九十百千万两点.,，]*)(?:元|块)/u.test(input.message) &&
          !/(?:预算|建议|计划|方案|如何|怎样|推荐|假如|假设|如果)/u.test(input.message);
        const pinnedFinance = !forbidsLedgerWrite && (explicitLedger || transactionAmount || (financeContinuation && Boolean(trustedContext.finance_context)));
        const routeDomain = memoryIntegration?.isMemoryCandidate?.(input.message, {
          ownerId: input.ownerId,
          conversationId: input.conversationId
        })
          ? 'memory'
          : pinnedFinance && financeService?.isFinanceCandidate?.(input.message)
            ? 'finance'
            : toolContinuations.has(key)
              ? 'calendar'
              : 'semantic_planner';
        const contextPack = {
          ...buildConversationContextPack({ messages: input.conversationMessages }),
          semantic_context: structuredClone(trustedContext),
          finance_authority: { planning_only: financialPlanningOnly, ledger_write_forbidden: forbidsLedgerWrite },
          memory_context: trustedContext.memory_context,
          finance_context: trustedContext.finance_context,
          tool_context: trustedContext.tool_context
        };
        const semanticInput = {
          message: input.message,
          sourceMessageId: input.sourceMessageId,
          ownerId: input.ownerId,
          conversationId: input.conversationId,
          contextPack,
          trustedContext,
          timezone,
          now,
          routeDomain,
          requestId: input.requestId,
          clientRequestId: input.clientRequestId,
          invocation: input.invocation
        };
        let interpreted = await semanticIngress.interpret(semanticInput);
        if (!interpreted?.ok && isAccessControlErrorCode(interpreted?.code)) {
          throw Object.assign(new Error(interpreted.code), { code: interpreted.code });
        }
        if (!interpreted?.ok && ['NO_USABLE_RUNTIME_CONNECTION', 'ASSISTANT_SEMANTIC_PLANNER_UNAVAILABLE'].includes(interpreted?.code)) {
          throw Object.assign(new Error(interpreted.code), { code: interpreted.code });
        }
        if (routeDomain === 'finance' &&
            (!interpreted?.ok || interpreted.plan?.domain !== 'finance')) {
          interpreted = await semanticIngress.interpret({
            ...semanticInput,
            contextPack: {
              ...contextPack,
              domain_contract: {
                required_domain: 'finance',
                allowed_domains: ['finance'],
                forbidden_domains: ['ordinary_chat', 'memory', 'tool', 'ambiguous'],
                attempt: 2,
                reason: 'server_route_domain_finance'
              }
            }
          });
          if (!interpreted?.ok && isAccessControlErrorCode(interpreted?.code)) {
            throw Object.assign(new Error(interpreted.code), { code: interpreted.code });
          }
          if (!interpreted?.ok && interpreted?.code === 'ASSISTANT_SEMANTIC_PLANNER_UNAVAILABLE') {
            throw Object.assign(new Error(interpreted.code), { code: interpreted.code });
          }
          if (!interpreted?.ok || interpreted.plan?.domain !== 'finance') {
            return financeError(
              'FINANCE_PLAN_DOMAIN_MISMATCH',
              '暂时无法理解这条财务请求，请稍后再试。'
            );
          }
        }
        if (!interpreted?.ok) {
          return {
            domain: 'ambiguous', handled: true, action: 'clarify',
            content: '我还不能确定你的意思，请再明确一点。'
          };
        }
        const unifiedPlan = interpreted.plan;
        if (unifiedPlan.domain === 'ordinary_chat') {
          return { domain: 'ordinary_chat', kind: 'none', outcome: 'ignored' };
        }
        if (unifiedPlan.domain === 'ambiguous' || unifiedPlan.intent === 'ambiguous') {
          return {
            domain: 'ambiguous', handled: true, action: 'clarify',
            content: '请补充一个最必要的明确信息。'
          };
        }
        if (unifiedPlan.domain === 'memory') {
          // Device evidence is data for answering only, never authority to run a write.
          if (input.localMemoryEvidence?.ownerId === input.ownerId && input.localMemoryEvidence?.spaceId === 'personal') {
            if (unifiedPlan.intent === 'query_fact') return { domain: 'memory', kind: 'local_query', outcome: 'device_evidence_available' };
            return { domain: 'memory', kind: 'clarification', outcome: 'device_memory_management',
              content: '请在长期记忆中选择要更正或删除的记录。确认后会使用新内容，原始聊天仍保留。' };
          }
          const adapted = adaptUnifiedPlanToMemory(unifiedPlan, { message: input.message });
          if (!adapted.ok || !memoryIntegration?.processSemanticPlan) {
            return { domain: 'memory', kind: 'query_error', outcome: 'semantic_adapter_failed', content: '暂时无法读取长期记忆，请稍后再试。' };
          }
          markBusinessExecution(interpreted, { businessExecutionStarted: true });
          const result = {
            domain: 'memory',
            ...await memoryIntegration.processSemanticPlan(input, adapted.plan)
          };
          markBusinessExecution(interpreted, {
            businessExecutionStarted: true,
            businessWriteOccurred: ['memory_written', 'memory_corrected'].includes(result.outcome)
          });
          if (executionAccepted(result)) commitCanonicalContext(unifiedPlan, input);
          return result;
        }
        if (unifiedPlan.domain === 'finance') {
          if (financialPlanningOnly) return { domain: 'ordinary_chat', kind: 'none', outcome: 'planning_is_not_a_ledger_action' };
          const adapted = adaptUnifiedPlanToFinance(unifiedPlan, { message: input.message });
          if (forbidsLedgerWrite && adapted.plan?.action !== 'query') {
            return financeError('FINANCE_WRITE_NOT_AUTHORIZED', '这条内容未记账，你已要求不要记账。');
          }
          if (!adapted.ok || !financeService?.processUserMessage) {
            return { domain: 'finance', handled: true, action: 'error', content: '暂时无法读取账本，请稍后再试。' };
          }
          const contract = evaluateFinanceToolPlan(adapted.plan, {
            message: input.message,
            timezone,
            now,
            trustedContext: trustedContext.finance_context,
            ownerId: input.ownerId
          });
          if (contract.decision === 'ASK') {
            return { domain: 'finance', handled: true, action: 'clarify', content: contract.question };
          }
          if (contract.decision !== 'ACCEPT') {
            return { domain: 'finance', handled: true, action: 'error', content: '暂时无法理解这条财务请求，请稍后再试。' };
          }
          markBusinessExecution(interpreted, { businessExecutionStarted: true });
          let serviceResult;
          try {
            serviceResult = await financeService.processUserMessage({ ...input, plan: contract.plan });
          } catch (error) {
            return financeError(error?.code || 'FINANCE_HANDLER_FAILED');
          }
          const result = {
            domain: 'finance',
            ...validateFinanceResult(serviceResult, { plan: contract.plan, input }),
            ...(contract.audit ? { audit: contract.audit } : {})
          };
          markBusinessExecution(interpreted, {
            businessExecutionStarted: true,
            businessWriteOccurred: ['create', 'update', 'delete', 'classify'].includes(result.action) &&
              executionAccepted(result)
          });
          if (executionAccepted(result)) commitCanonicalContext(unifiedPlan, input);
          return result;
        }
        if (unifiedPlan.domain === 'tool') {
          const adapted = adaptUnifiedPlanToTool(unifiedPlan, { sourceMessageId: input.sourceMessageId });
          if (!adapted.ok) {
            return { domain: 'tool', handled: true, action: 'error', content: '暂时无法完成日期换算，请稍后再试。' };
          }
          markBusinessExecution(interpreted, { businessExecutionStarted: true });
          return invokeToolPlan(adapted.plan, input, {
            now,
            memoryContext: trustedContext.memory_context,
            canonicalPlan: unifiedPlan
          });
        }
        return { domain: 'ordinary_chat', kind: 'none', outcome: 'ignored' };
      }

      const trustedContext = financeService?.trustedContext?.(input.ownerId, input.conversationId) || null;
      const now = clock();
      if (financePlanner?.plan) {
        const contextPack = {
          ...buildConversationContextPack({ messages: input.conversationMessages }),
          finance_context: trustedContext ? structuredClone(trustedContext) : null
        };
        const planned = await financePlanner.plan({
          message: input.message,
          contextPack,
          timezone,
          now,
          invocation: input.invocation
        });
        if (planned?.ok && planned.plan?.domain === 'finance') {
          if (!financeService?.processUserMessage) {
            return { domain: 'finance', handled: true, action: 'error', content: '暂时无法读取账本，请稍后再试。' };
          }
          const contract = evaluateFinanceToolPlan(planned.plan, {
            message: input.message, timezone, now, trustedContext, ownerId: input.ownerId
          });
          if (contract.decision === 'ASK') return { domain: 'finance', handled: true, action: 'clarify', content: contract.question };
          if (contract.decision !== 'ACCEPT') return { domain: 'finance', handled: true, action: 'error', content: '暂时无法理解这条财务请求，请稍后再试。' };
          const result = await financeService.processUserMessage({ ...input, plan: contract.plan });
          return { domain: 'finance', ...result };
        }
        if (!planned?.ok && financeService?.isFinanceCandidate?.(input.message)) {
          return { domain: 'finance', handled: true, action: 'error', content: '暂时无法理解这条财务请求，请稍后再试。' };
        }
      } else if (financeService?.processUserMessage) {
        const legacy = await financeService.processUserMessage(input);
        if (legacy?.handled) return { domain: 'finance', ...legacy };
      }
      let memoryResult = null;
      if (memoryIntegration?.processUserMessage) {
        memoryResult = await memoryIntegration.processUserMessage(input);
        if (['capture', 'clarification', 'query_error'].includes(memoryResult?.kind)) {
          return { domain: 'memory', ...memoryResult };
        }
      }
      if (assistantToolPlanner?.plan) {
        const key = continuationKey(input.ownerId, input.conversationId);
        const toolContext = toolContinuations.get(key) || null;
        const contextPack = {
          ...buildConversationContextPack({ messages: input.conversationMessages }),
          memory_context: memoryResult?.semanticContext ? structuredClone(memoryResult.semanticContext) : null,
          tool_context: toolContext ? structuredClone(toolContext) : null
        };
        const planned = await assistantToolPlanner.plan({
          message: input.message,
          sourceMessageId: input.sourceMessageId,
          contextPack,
          timezone,
          now,
          invocation: input.invocation
        });
        if (planned?.ok && planned.plan?.domain === 'tool') {
          return invokeToolPlan(planned.plan, input, {
            now,
            memoryContext: memoryResult?.semanticContext || null
          });
        }
      }
      if (memoryResult) return { domain: 'memory', ...memoryResult };
      return { domain: 'ordinary_chat', kind: 'none', outcome: 'ignored' };
    }
  });
}
