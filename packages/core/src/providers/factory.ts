import type { ProteaConfig } from '../config/types.js';
import type { SecretStore } from '../config/secrets.js';
import { AnthropicProvider } from './anthropic.js';
import { EchoProvider } from './echo.js';
import type { Provider } from './types.js';

export function createProvider(config: ProteaConfig, secrets: SecretStore): Provider {
  switch (config.providers.default) {
    case 'anthropic': {
      const a = config.providers.anthropic;
      return new AnthropicProvider(a, secrets.get(a.apiKeySecret));
    }
    case 'echo':
      return new EchoProvider(config.providers.echo.delayMs);
    default:
      throw new Error(`unknown provider "${config.providers.default}" (expected anthropic or echo)`);
  }
}
