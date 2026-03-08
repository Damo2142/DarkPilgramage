/**
 * Gemini API Client for Dark Pilgrimage Co-DM
 * Handles all communication with Google's Gemini API
 */

class GeminiClient {
  constructor(config) {
    this.apiKey = process.env[config.apiKeyEnv || 'GEMINI_API_KEY'];
    this.model = config.model || 'gemini-2.0-flash';
    this.maxTokens = config.maxTokens || 500;
    this.temperature = config.temperature || 0.8;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

    if (!this.apiKey) {
      console.warn('[GeminiClient] No API key found — AI features disabled');
    }
  }

  get available() {
    return !!this.apiKey;
  }

  /**
   * Send a prompt to Gemini and get a response
   * @param {string} systemPrompt - System instructions
   * @param {string} userPrompt - The actual request
   * @param {object} options - Override defaults
   * @returns {string|null} Response text or null on failure
   */
  async generate(systemPrompt, userPrompt, options = {}) {
    if (!this.available) return null;

    const model = options.model || this.model;
    const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;

    const body = {
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }]
        }
      ],
      generationConfig: {
        maxOutputTokens: options.maxTokens || this.maxTokens,
        temperature: options.temperature ?? this.temperature,
        topP: 0.95
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const err = await response.text();
        console.error(`[GeminiClient] API error ${response.status}: ${err.slice(0, 200)}`);
        return null;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return text || null;

    } catch (err) {
      console.error(`[GeminiClient] Request failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Send a multi-turn conversation to Gemini
   * @param {string} systemPrompt - System instructions
   * @param {Array} messages - Array of { role: 'user'|'model', text: '...' }
   * @param {object} options - Override defaults
   * @returns {string|null}
   */
  async chat(systemPrompt, messages, options = {}) {
    if (!this.available) return null;

    const model = options.model || this.model;
    const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: [{ text: m.text }]
    }));

    const body = {
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents,
      generationConfig: {
        maxOutputTokens: options.maxTokens || this.maxTokens,
        temperature: options.temperature ?? this.temperature,
        topP: 0.95
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const err = await response.text();
        console.error(`[GeminiClient] API error ${response.status}: ${err.slice(0, 200)}`);
        return null;
      }

      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || null;

    } catch (err) {
      console.error(`[GeminiClient] Chat request failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Generate JSON-structured output
   */
  async generateJSON(systemPrompt, userPrompt, options = {}) {
    const jsonPrompt = systemPrompt + '\n\nYou MUST respond with valid JSON only. No markdown, no backticks, no explanation.';
    const text = await this.generate(jsonPrompt, userPrompt, options);
    if (!text) return null;

    try {
      // Strip markdown code fences if present
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned);
    } catch (err) {
      console.error('[GeminiClient] JSON parse failed:', text.slice(0, 200));
      return null;
    }
  }
}

module.exports = GeminiClient;
