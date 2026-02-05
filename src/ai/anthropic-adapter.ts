// ============================================================================
// Cy2Play — Anthropic LLM Adapter
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { LLMClient, LLMCompletionOptions, LLMConfig } from '../types';

/**
 * Thin adapter around the `@anthropic-ai/sdk`.
 * Implements the `LLMClient` interface.
 */
export class AnthropicAdapter implements LLMClient {
  private client: Anthropic;
  private model: string;
  private defaultTemperature: number;
  private defaultMaxTokens: number;

  constructor(config: LLMConfig) {
    if (!config.apiKey) {
      throw new Error(
        'Anthropic API key is required. Set ANTHROPIC_API_KEY in your .env or cy2play.config.json.',
      );
    }

    this.client = new Anthropic({
      apiKey: config.apiKey,
    });

    this.model = config.model || 'claude-sonnet-4-20250514';
    this.defaultTemperature = config.temperature ?? 0.2;
    this.defaultMaxTokens = config.maxTokens ?? 4096;
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    options?: LLMCompletionOptions,
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      temperature: options?.temperature ?? this.defaultTemperature,
      stop_sequences: options?.stop,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Extract text from content blocks
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );

    if (textBlocks.length === 0) {
      throw new Error('Anthropic returned no text content.');
    }

    return textBlocks.map(b => b.text).join('');
  }
}
