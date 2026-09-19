import { applyResponsePolicy } from '../../router/ResponsePolicy.js';

export class ResponsePolicyRuntime {
  apply(response = {}, context = {}) {
    return {
      ...response,
      content: applyResponsePolicy(response.content || '', {
        programResult: context.programResult || ''
      })
    };
  }

  applyContent(content = '', context = {}) {
    return this.apply({ content }, context).content;
  }
}

export const responsePolicyRuntime = new ResponsePolicyRuntime();
export default responsePolicyRuntime;
