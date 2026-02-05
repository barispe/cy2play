// ============================================================================
// Cy2Play — LLM Client Factory
// ============================================================================

import { LLMClient, LLMConfig } from '../types';
import { OpenAIAdapter } from './openai-adapter';
import { AnthropicAdapter } from './anthropic-adapter';
import { OllamaAdapter } from './ollama-adapter';

/**
 * Create the appropriate LLM client based on the provider config.
 *
 * @param config - Resolved LLM configuration
 * @returns An LLMClient instance ready for use
 * @throws If the provider is unknown
 */
export function createLLMClient(config: LLMConfig): LLMClient {
  switch (config.provider) {
    case 'openai':
      return new OpenAIAdapter(config);

    case 'anthropic':
      return new AnthropicAdapter(config);

    case 'local':
      return new OllamaAdapter(config);

    default:
      throw new Error(
        `Unknown LLM provider: "${config.provider}". ` +
        `Supported providers: openai, anthropic, local (Ollama/LM Studio).`,
      );
  }
}
