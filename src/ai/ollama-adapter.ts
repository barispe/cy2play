// ============================================================================
// Cy2Play — Ollama / Local LLM Adapter
// ============================================================================
//
// Talks to any OpenAI-compatible local endpoint (Ollama, LM Studio, vLLM, etc.)
// via raw fetch() — no SDK dependency needed.
// ============================================================================

import { LLMClient, LLMCompletionOptions, LLMConfig } from '../types';

/** Shape of the OpenAI-compatible /v1/chat/completions response */
interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

/**
 * Adapter for local LLMs that expose an OpenAI-compatible API
 * (Ollama, LM Studio, vLLM, LocalAI, etc.).
 */
export class OllamaAdapter implements LLMClient {
  private baseUrl: string;
  private model: string;
  private defaultTemperature: number;
  private defaultMaxTokens: number;

  constructor(config: LLMConfig) {
    this.baseUrl = (config.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    this.model = config.model || 'codellama';
    this.defaultTemperature = config.temperature ?? 0.2;
    this.defaultMaxTokens = config.maxTokens ?? 4096;
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    options?: LLMCompletionOptions,
  ): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;

    const body = {
      model: this.model,
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      stop: options?.stop,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Local LLM request failed (${response.status}): ${errorText}\n` +
        `URL: ${url}\n` +
        `Hint: Make sure your local LLM server is running and the model "${this.model}" is available.`,
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Local LLM returned an empty response.');
    }

    return content;
  }
}
