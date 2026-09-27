import { z } from 'zod'

export interface Analysis {
  summary: string
  probableCause: string
  confidence: number
  evidence: string[]
  recommendations: string[]
  source: 'openrouter'
  model: string
}

const analysisSchema = z.object({
  summary: z.string().min(1).max(4000),
  probableCause: z.string().min(1).max(4000),
  confidence: z.coerce.number().min(0).max(100),
  evidence: z.array(z.string().min(1).max(500)).min(1).max(10),
  recommendations: z.array(z.string().min(1).max(500)).min(1).max(10),
})

const analysisParameters = {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise assessment grounded only in the supplied incident evidence.' },
        probableCause: { type: 'string', description: 'Most likely cause, explicitly stating uncertainty when evidence is insufficient.' },
        confidence: { type: 'number', minimum: 0, maximum: 100, description: 'Confidence percentage based on the strength of supplied evidence.' },
        evidence: {
          type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' },
          description: 'Specific observations present in the supplied timeline, checks, or telemetry.',
        },
        recommendations: {
          type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' },
          description: 'Safe verification and remediation actions appropriate to the supplied evidence.',
        },
      },
      required: ['summary', 'probableCause', 'confidence', 'evidence', 'recommendations'],
      additionalProperties: false,
} as const

type OpenRouterPayload = {
  model?: string
  error?: { message?: string }
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
    }
  }>
}

function parseAnalysis(raw: string) {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('response did not contain a JSON object')
  return analysisSchema.parse(JSON.parse(trimmed.slice(start, end + 1)))
}

export async function analyzeIncident(context: unknown): Promise<Analysis> {
  const apiKey = process.env.OPENROUTER_API_KEY
  const configuredModel = process.env.OPENROUTER_MODEL || 'openrouter/free'
  if (!apiKey) {
    const error = new Error('OpenRouter is not configured') as Error & { status?: number; setup?: string }
    error.status = 503
    error.setup = 'Add OPENROUTER_API_KEY to backend/.env.'
    throw error
  }

  // The general free router may select a model without structured-output support.
  // These zero-cost fallbacks explicitly advertise JSON Schema support.
  const models = Array.from(new Set([
    ...(configuredModel === 'openrouter/free' ? [] : [configuredModel]),
    'qwen/qwen3.8-27b:free',
    'liquid/lfm-2.5-2.6b:free',
  ]))
  const attemptPlan = [...models, ...models.slice().reverse()]
  const evidencePayload = JSON.stringify(context)
  let lastIssue = 'No provider response'

  for (const [attempt, model] of attemptPlan.entries()) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(35_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:5173',
          'X-OpenRouter-Title': 'Incident Command AI',
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 1600,
          provider: { require_parameters: true, allow_fallbacks: true },
          tools: [{
            type: 'function',
            function: {
              name: 'submit_incident_analysis',
              description: 'Submit the final evidence-grounded incident root-cause analysis.',
              parameters: analysisParameters,
            },
          }],
          tool_choice: { type: 'function', function: { name: 'submit_incident_analysis' } },
          messages: [
            {
              role: 'system',
              content: 'You are a senior production SRE. Analyze only the supplied incident, timeline, health checks, and telemetry. Never invent signals. If evidence is insufficient, state that plainly and lower confidence. Recommendations must begin with verification and favor reversible actions.',
            },
            { role: 'user', content: attempt ? `${evidencePayload}\nThis is a retry. Submit the required function call and include every required field.` : evidencePayload },
          ],
        }),
      })

      const payload = await response.json() as OpenRouterPayload
      if (!response.ok) {
        lastIssue = `${model}: ${payload.error?.message || `provider returned ${response.status}`}`
        console.warn(`OpenRouter analysis attempt failed: ${lastIssue}`)
        continue
      }

      const choice = payload.choices?.[0]
      const toolCall = choice?.message?.tool_calls?.find((item) => item.function?.name === 'submit_incident_analysis')
      const raw = toolCall?.function?.arguments || choice?.message?.content || choice?.message?.reasoning
      if (!raw) {
        lastIssue = `${model}: empty content (${choice?.finish_reason || 'unknown finish reason'})`
        console.warn(`OpenRouter analysis attempt failed: ${lastIssue}`)
        continue
      }

      try {
        const parsed = parseAnalysis(raw)
        return { ...parsed, source: 'openrouter', model: payload.model || model }
      } catch (parseError) {
        lastIssue = `${model}: ${parseError instanceof Error ? parseError.message : 'invalid structured response'}`
        console.warn(`OpenRouter analysis attempt failed: ${lastIssue}`)
      }
    } catch (providerError) {
      lastIssue = `${model}: ${providerError instanceof Error ? providerError.message : 'network failure'}`
      console.warn(`OpenRouter analysis attempt failed: ${lastIssue}`)
    }
  }

  const error = new Error('OpenRouter could not produce a structured analysis right now. The free providers may be busy; please retry in a moment.') as Error & { status?: number; detail?: string }
  error.status = 502
  error.detail = lastIssue
  throw error
}
