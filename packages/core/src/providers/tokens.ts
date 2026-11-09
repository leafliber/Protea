import { estimateMessagesTokens, estimateTokens } from '../util/tokens.js';
import type { ProviderRequest } from './types.js';

export function estimateRequestTokens(req: ProviderRequest): number {
  const sys = req.system.reduce((n, s) => n + estimateTokens(s.text) + 4, 0);
  const tools = req.tools.filter((t) => !t.deferLoading).reduce((n, t) => n + estimateTokens(JSON.stringify(t)), 0);
  return sys + tools + estimateMessagesTokens(req.messages);
}
