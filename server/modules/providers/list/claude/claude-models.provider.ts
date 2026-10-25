import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  readClaudeModelSetupFingerprint,
  resolveClaudeModelWithCli,
  type ClaudeModelResolver,
  type ClaudeResolvedModel,
} from '@/modules/providers/list/claude/claude-model-resolution.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  isPlaceholderProviderModel,
  stripAnsiSequences,
} from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderProviderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderProviderModel(messageModel) ? messageModel : null;
};

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsiSequences(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderProviderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderProviderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

const MODEL_RESOLUTION_TTL_MS = 60 * 60 * 1000;
const COLD_RESOLUTION_WAIT_MS = 8_000;
const MODEL_RESOLUTION_CONCURRENCY = 3;

/** Aliases that each name one model family. */
const CLAUDE_FAMILY_ALIASES = ['fable', 'sonnet', 'opus', 'haiku'];
/** Aliases that point at one of the families, chosen by the account and the user's settings. */
const CLAUDE_POINTER_ALIASES = new Set(['default', 'best']);

type ClaudeModelResolutions = Map<string, ClaudeResolvedModel>;

/**
 * Exported for tests. Labels each option with the model it resolves to. A
 * pointer alias takes the effort levels of the family it lands on, so
 * `default` offers xhigh when it means Opus and none when it means Haiku.
 */
export const applyClaudeModelResolutions = (
  definition: ProviderModelsDefinition,
  resolutions: ClaudeModelResolutions,
): ProviderModelsDefinition => {
  const familyByLabel = new Map<string, ProviderModelOption>();
  for (const value of CLAUDE_FAMILY_ALIASES) {
    const option = definition.OPTIONS.find((candidate) => candidate.value === value);
    const label = resolutions.get(value)?.label;
    if (option && label) {
      familyByLabel.set(label, option);
    }
  }

  return {
    ...definition,
    OPTIONS: definition.OPTIONS.map((option) => {
      const resolved = resolutions.get(option.value);
      if (!resolved) {
        return option;
      }

      const family = CLAUDE_POINTER_ALIASES.has(option.value) ? familyByLabel.get(resolved.label) : undefined;
      const { effort: catalogEffort, ...rest } = option;
      const effort = family ? family.effort : catalogEffort;
      return {
        ...rest,
        ...(effort ? { effort } : {}),
        resolvedLabel: resolved.label,
        ...(resolved.effort ? { resolvedEffort: resolved.effort } : {}),
      };
    }),
  };
};

const waitAtMost = async (work: Promise<void>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export class ClaudeProviderModels implements IProviderModels {
  private resolutions: { fingerprint: string; resolvedAt: number; byValue: ClaudeModelResolutions } | null = null;
  private pendingResolution: Promise<void> | null = null;

  /**
   * The catalog's aliases (`default`, `best`, `opus`, ...) only make sense once
   * they are tied to a model, so each one is resolved through the CLI and the
   * answer cached until the settings or the CLI change. Lookups start when the
   * server does. Tests run without a resolver unless they pass one.
   */
  constructor(
    private readonly resolveModel: ClaudeModelResolver | null =
      process.env.NODE_ENV === 'test' ? null : resolveClaudeModelWithCli,
    private readonly readSetupFingerprint: () => Promise<string> = readClaudeModelSetupFingerprint,
  ) {
    if (this.resolveModel) {
      void this.getSupportedModels().catch(() => undefined);
    }
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (!this.resolveModel) {
      return CLAUDE_PREDEFINED_MODELS;
    }

    const fingerprint = await this.readSetupFingerprint();
    const current = this.resolutions;
    const isFresh = current !== null
      && current.fingerprint === fingerprint
      && Date.now() - current.resolvedAt < MODEL_RESOLUTION_TTL_MS;
    if (!isFresh) {
      const refresh = this.refreshResolutions(fingerprint);
      // Stale labels are served while they refresh. Only the very first
      // catalog after a restart waits, and only briefly: this also runs
      // before every send.
      if (current === null) {
        await waitAtMost(refresh, COLD_RESOLUTION_WAIT_MS);
      }
    }

    return this.resolutions
      ? applyClaudeModelResolutions(CLAUDE_PREDEFINED_MODELS, this.resolutions.byValue)
      : CLAUDE_PREDEFINED_MODELS;
  }

  private refreshResolutions(fingerprint: string): Promise<void> {
    this.pendingResolution ??= this.resolveAll(fingerprint).finally(() => {
      this.pendingResolution = null;
    });
    return this.pendingResolution;
  }

  private async resolveAll(fingerprint: string): Promise<void> {
    const resolveModel = this.resolveModel;
    if (!resolveModel) {
      return;
    }

    const values = CLAUDE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value);
    const byValue: ClaudeModelResolutions = new Map();
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;
        try {
          const resolved = await resolveModel(value);
          if (resolved) {
            byValue.set(value, resolved);
          }
        } catch {
          // An alias that cannot be resolved keeps its catalog label.
        }
      }
    };
    await Promise.all(Array.from({ length: MODEL_RESOLUTION_CONCURRENCY }, worker));

    // A failed round is remembered too, so a broken CLI is retried after the
    // TTL rather than on every request. It keeps any earlier answers.
    this.resolutions = {
      fingerprint,
      resolvedAt: Date.now(),
      byValue: byValue.size > 0 ? byValue : this.resolutions?.byValue ?? byValue,
    };
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
