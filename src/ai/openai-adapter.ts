// ============================================================================
// Cy2Play — OpenAI LLM Adapter
// ============================================================================

import OpenAI from 'openai';
import { LLMClient, LLMCompletionOptions, LLMConfig } from '../types';

/**
 * Thin adapter around the `openai` SDK.
 * Implements the `LLMClient` interface — no LangChain involved.
 */
export class OpenAIAdapter implements LLMClient {
  private client: OpenAI;
  private model: string;
  private defaultTemperature: number;
  private defaultMaxTokens: number;

  constructor(config: LLMConfig) {
    if (!config.apiKey) {
      throw new Error(
        'OpenAI API key is required. Set OPENAI_API_KEY in your .env or cy2play.config.json.',
      );
    }

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl, // allows custom endpoints (Azure, proxies)
    });

    this.model = config.model || 'gpt-4o';
    this.defaultTemperature = config.temperature ?? 0.2;
    this.defaultMaxTokens = config.maxTokens ?? 4096;
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    options?: LLMCompletionOptions,
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      stop: options?.stop,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI returned an empty response.');
    }

    return content;
  }
}
