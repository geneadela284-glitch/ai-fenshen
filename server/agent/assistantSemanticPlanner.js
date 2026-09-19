import { CAPABILITIES } from '../../core/router/CapabilityMap.js';
import { ASSISTANT_PROVIDER_PLAN_SCHEMA_ID } from '../../core/router/SchemaRepairContract.js';
import { isAccessControlErrorCode } from '../../core/router/AccessControlErrorCodes.js';
import { localDateKey } from '../finance/time.js';
import {
  parseProviderPlanWithLocalRepair,
  validateFormatOnlyProviderPlanRepair
} from './providerPlanSchemaRepair.js';

const SYSTEM_PROMPT = `你是AI分身唯一的语义规划入口。只输出一个JSON对象，不输出Markdown，不执行工具，不写数据库，不计算金额或日期转换结果。
先理解当前用户目标，再选择domain：memory、finance、tool、ordinary_chat或ambiguous。
输出严格包含domain,intent,action,entity,relation_to_owner,predicate,value,qualifiers,tool,arguments,required_evidence,explicit_fields,inherited_fields,ambiguity_reasons,confidence,requires_confirmation,source_spans,source_message_id。
entity严格包含type,reference,relation_to_owner；source_message_id必须为null；不得输出owner字段。
当前消息明确表达的字段写入explicit_fields，只有可信上下文提供且当前消息省略的字段才写入inherited_fields；当前明确表达优先。
Memory应区分事实新增、查询、补充、修正、否定和删除；完整出生日期使用birth_date，每年生日使用birthday；历法未说明用unknown，不得仅因此要求确认。
Finance只描述create/query/update/delete意图与原始交易候选，不计算合计或时间戳；分类等非关键字段允许为空。相对自然日表达必须在qualifiers.relative_day_offset中输出相对runtime_context.local_date的整数日偏移，当前自然日为0，前一自然日为-1，后一自然日为1。
Tool只选择已注册工具并提供参数与required_evidence，不提供工具结果。
用户明确表达待办、安排或提醒意图时，选择tool tasks.create和action tasks.create；标题保留用户要做的事，日期用arguments.relative_day_offset或arguments.date，明确时间才写arguments.local_time。缺少时间不是歧义；日期无法唯一确定时才选择ambiguous并指出日期歧义。普通聊天、长期事实或偏好、金额收支、生日和日期换算不得写入Tasks。
requires_confirmation、confidence和source_spans只是建议；无歧义时ambiguity_reasons=[]。source_spans允许[]。`;

function withoutOwner(value) {
  if (Array.isArray(value)) return value.map(withoutOwner);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id'].includes(key))
    .map(([key, child]) => [key, withoutOwner(child)]));
}

export function createAssistantSemanticPlanner({ aiService, toolDescriptors = [], timeoutMs = 8000 } = {}) {
  if (!aiService || typeof aiService.run !== 'function') throw new TypeError('Assistant Semantic Planner requires aiService.run().');
  return Object.freeze({
    markBusinessExecution(route, outcome) {
      return aiService.markBusinessExecution?.(route, outcome) || 0;
    },
    async plan({
      message,
      sourceMessageId = null,
      contextPack = {},
      routeDomain = 'semantic_planner',
      requestId = null,
      clientRequestId = null,
      ownerId = null,
      businessExecutionStarted = false,
      businessWriteStarted = false,
      timezone = 'Asia/Shanghai',
      now = new Date(),
      invocation = {}
    } = {}) {
      const text = String(message || '').trim();
      if (!text) return { ok: false, code: 'ASSISTANT_SEMANTIC_INPUT_REQUIRED', attempts: 0 };
      const currentTime = new Date(now);
      const runtimeContext = {
        timezone: String(timezone || 'Asia/Shanghai'),
        current_time: Number.isFinite(currentTime.getTime()) ? currentTime.toISOString() : null,
        local_date: Number.isFinite(currentTime.getTime())
          ? localDateKey(currentTime, String(timezone || 'Asia/Shanghai'))
          : null
      };
      let result;
      try {
        result = await aiService.run({
          input: text,
          capability: CAPABILITIES.CHAT,
          messages: [
            { role: 'system', content: `${SYSTEM_PROMPT}\n正式工具：${JSON.stringify(toolDescriptors)}` },
            {
              role: 'user',
              content: JSON.stringify({
                message: text,
                context: withoutOwner({
                  ...contextPack,
                  runtime_context: runtimeContext
                })
              })
            }
          ],
          metadata: {
            purpose: 'assistant_semantic_ingress_v1',
            memoryPolicy: 'disabled',
            routeDomain,
            requestId,
            clientRequestId,
            ownerId,
            businessExecutionStarted,
            businessWriteStarted
          },
          options: { timeoutMs }
        }, invocation);
      } catch {
        result = { ok: false };
      }
      if (!result?.ok) {
        const code = String(result?.code || '').toUpperCase();
        return {
          ok: false,
          code: isAccessControlErrorCode(code) || code === 'NO_USABLE_RUNTIME_CONNECTION'
            ? code
            : 'ASSISTANT_SEMANTIC_PLANNER_UNAVAILABLE',
          attempts: 1
        };
      }
      const parsed = parseProviderPlanWithLocalRepair(result.content);
      if (parsed.valid) {
        return {
          ok: true,
          plan: Object.freeze({ ...structuredClone(parsed.value), source_message_id: sourceMessageId || null }),
          attempts: 1,
          source: 'model',
          ...(parsed.repair === 'local' ? { repair: 'local' } : {}),
          route: result.route || null
        };
      }
      const route = result.route || {};
      const initialTrace = Array.isArray(route.routeTrace) ? route.routeTrace : [];
      const providerRepairAllowed = parsed.repairEligible === true &&
        !businessExecutionStarted &&
        !businessWriteStarted &&
        route.selectedProvider === 'deepseek' &&
        route.selectedModel === 'deepseek-v4-flash' &&
        initialTrace.length === 1 &&
        initialTrace[0]?.success === true &&
        initialTrace[0]?.attemptNumber === 1 &&
        typeof aiService.repairSchema === 'function';
      if (!providerRepairAllowed) {
        return {
          ok: false,
          code: 'ASSISTANT_SEMANTIC_PLAN_INVALID',
          attempts: 1,
          errors: parsed.errors
        };
      }

      let repaired;
      try {
        repaired = await aiService.repairSchema({
          route,
          domain: routeDomain,
          rawContent: result.content,
          schemaContract: ASSISTANT_PROVIDER_PLAN_SCHEMA_ID,
          errors: parsed.errors,
          options: { timeoutMs },
          businessExecutionStarted: false,
          businessWriteStarted: false
        }, invocation);
      } catch {
        repaired = { ok: false };
      }
      if (!repaired?.ok) {
        return {
          ok: false,
          code: 'ASSISTANT_SEMANTIC_SCHEMA_REPAIR_UNAVAILABLE',
          attempts: 2,
          errors: parsed.errors,
          route: repaired?.route || route
        };
      }
      const checked = validateFormatOnlyProviderPlanRepair({
        originalContent: result.content,
        repairedContent: repaired.content
      });
      if (!checked.valid) {
        return {
          ok: false,
          code: checked.code,
          attempts: 2,
          errors: checked.errors,
          route: repaired.route || route
        };
      }
      return {
        ok: true,
        plan: Object.freeze({ ...structuredClone(checked.value), source_message_id: sourceMessageId || null }),
        attempts: 2,
        source: 'model',
        repair: 'provider_format_only',
        route: repaired.route || route
      };
    }
  });
}
