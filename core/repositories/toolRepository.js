import tools from '../../data/tools.json' with { type: 'json' };
import { JsonCollectionRepository } from './jsonRepository.js';

const TOOLS_KEY = 'tools';

export class ToolRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: TOOLS_KEY, seed: tools, ...options });
  }
}

export const toolRepository = new ToolRepository();
