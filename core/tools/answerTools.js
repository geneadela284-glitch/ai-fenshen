// Isolated read-only registry. No account, storage, network or business tools.
const invalid = () => Object.assign(new Error('ANSWER_CALCULATION_INVALID'), { code: 'ANSWER_CALCULATION_INVALID' });
const functions = Object.freeze({ min: Math.min, max: Math.max, ceil: Math.ceil, floor: Math.floor, abs: Math.abs, round: Math.round });
function calculate(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 240) throw invalid();
  const tokens = []; let offset = 0;
  while (offset < source.length) {
    const rest = source.slice(offset), space = /^\s+/.exec(rest);
    if (space) { offset += space[0].length; continue; }
    const match = /^(?:\d+(?:\.\d+)?|\.\d+|>=|<=|==|!=|[a-z]+|[()+*/%,<>-])/.exec(rest);
    if (!match || tokens.length >= 120) throw invalid();
    tokens.push(match[0]); offset += match[0].length;
  }
  let index = 0, depth = 0;
  const take = token => tokens[index] === token && (++index, true);
  const number = value => { if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) throw invalid(); return Number(value.toPrecision(14)); };
  function atom() {
    if (++depth > 20) throw invalid();
    let value;
    if (take('-')) value = -number(atom());
    else if (take('+')) value = number(atom());
    else if (take('(')) { value = comparison(); if (!take(')')) throw invalid(); }
    else {
      const token = tokens[index++];
      if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token || '')) value = Number(token);
      else if (Object.hasOwn(functions, token || '') && take('(')) {
        const args = [number(comparison())];
        while (take(',')) { if (args.length >= 12) throw invalid(); args.push(number(comparison())); }
        if (!take(')') || (!['min','max'].includes(token) && args.length !== 1)) throw invalid();
        value = functions[token](...args);
      } else throw invalid();
    }
    depth--; return typeof value === 'boolean' ? value : number(value);
  }
  function product() { let value = atom(); while (['*','/','%'].includes(tokens[index])) { const op = tokens[index++], right = number(atom()); value = number(value); value = number(op === '*' ? value * right : op === '/' ? value / right : value % right); } return value; }
  function sum() { let value = product(); while (['+','-'].includes(tokens[index])) { const op = tokens[index++], right = number(product()); value = number(op === '+' ? number(value) + right : number(value) - right); } return value; }
  function comparison() {
    const left = sum(), op = tokens[index];
    if (!['>','<','>=','<=','==','!='].includes(op)) return left;
    index++; const right = number(sum()); number(left);
    return ({ '>': () => left > right, '<': () => left < right, '>=': () => left >= right, '<=': () => left <= right, '==': () => left === right, '!=': () => left !== right })[op]();
  }
  const result = comparison(); if (index !== tokens.length) throw invalid();
  return typeof result === 'boolean' ? result : Number(result.toPrecision(14));
}
export const PUBLIC_LOOKUP_DEFINITION = Object.freeze({type:'function',name:'lookup_public',description:'仅查询公开信息。陌生专名、实时信息、要求查证或来源时使用；提出精准公开查询，不能携带私人资料。后台会搜索并读取实际资料。',parameters:{type:'object',properties:{query:{type:'string',maxLength:200}},required:['query'],additionalProperties:false}});
export const ANSWER_TOOL_DEFINITIONS = Object.freeze([{
  type: 'function', name: 'calculate', description: '计算数量、金额、比例、分钟排期和比较。必须调用本工具获得算数结果，不口算。一次提交最多12个独立算式，可用+ - * / % () min max ceil floor abs round及大小比较；时间换算成分钟。无任何副作用。',
  parameters: { type: 'object', properties: { expressions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 } }, required: ['expressions'], additionalProperties: false }
}]);
const registry = Object.freeze({ calculate(args) {
  if (!args || !Array.isArray(args.expressions) || !args.expressions.length || args.expressions.length > 12 || Object.keys(args).some(k => k !== 'expressions')) throw invalid();
  return { expressions: args.expressions, values: args.expressions.map(calculate), origin: 'local_calculator' };
} });
export function executeAnswerTool(name, args) {
  if (!Object.hasOwn(registry, name)) throw Object.assign(new Error('VOICE_UNEXPECTED_TOOL'), { code: 'VOICE_UNEXPECTED_TOOL' });
  return registry[name](args);
}
