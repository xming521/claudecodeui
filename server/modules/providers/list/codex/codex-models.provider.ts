import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { codexAppServer, type CodexModel } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/** Curated Codex catalog, used only while the CLI's own list cannot be read. */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: 'Our most capable model for complex, demanding work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-sol',
      label: 'GPT-6 Sol',
      description: 'Workhorse model for coding and everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      description: 'Fast and affordable model for easier tasks.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
const COLD_LIST_WAIT_MS = 8_000;

export type CodexModelLister = () => Promise<CodexModel[]>;

/** Exported for tests. The CLI's model list as a catalog, or `null` when it is empty. */
export const toCodexModelsDefinition = (models: CodexModel[]): ProviderModelsDefinition | null => {
  const options: ProviderModelOption[] = models.map((model) => {
    const values = model.supportedReasoningEfforts.map(({ reasoningEffort, description }) => ({
      value: reasoningEffort,
      ...(description ? { description } : {}),
    }));
    return {
      value: model.model,
      label: model.displayName,
      ...(model.description ? { description: model.description } : {}),
      ...(values.length > 0
        ? { effort: { ...(model.defaultReasoningEffort ? { default: model.defaultReasoningEffort } : {}), values } }
        : {}),
    };
  });
  if (options.length === 0) {
    return null;
  }

  const defaultModel = models.find((model) => model.isDefault)?.model ?? options[0].value;
  return { OPTIONS: options, DEFAULT: defaultModel };
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

/** Provider registry model adapter for the Codex CLI's model list and active config. */
export class CodexProviderModels implements IProviderModels {
  private listed: { listedAt: number; definition: ProviderModelsDefinition | null } | null = null;
  private pendingList: Promise<void> | null = null;

  /**
   * The list comes from the CLI (`model/list`), because OpenAI adds models
   * faster than a curated copy is updated. Tests run without a lister unless
   * they pass one.
   */
  constructor(
    private readonly listModels: CodexModelLister | null =
      process.env.NODE_ENV === 'test' ? null : () => codexAppServer.listModels(),
  ) {
    if (this.listModels) {
      void this.getSupportedModels().catch(() => undefined);
    }
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (!this.listModels) {
      return CODEX_PREDEFINED_MODELS;
    }

    const current = this.listed;
    if (current === null || Date.now() - current.listedAt >= MODEL_LIST_TTL_MS) {
      const refresh = this.refreshList();
      // A stale list is served while it refreshes. Only the first catalog
      // after a restart waits, and only briefly: this also runs before every
      // send.
      if (current === null) {
        await waitAtMost(refresh, COLD_LIST_WAIT_MS);
      }
    }

    return this.listed?.definition ?? CODEX_PREDEFINED_MODELS;
  }

  private refreshList(): Promise<void> {
    this.pendingList ??= this.readList().finally(() => {
      this.pendingList = null;
    });
    return this.pendingList;
  }

  private async readList(): Promise<void> {
    let definition: ProviderModelsDefinition | null = null;
    try {
      definition = this.listModels ? toCodexModelsDefinition(await this.listModels()) : null;
    } catch (error) {
      console.warn('[Codex] Could not read the model list from the CLI:', error instanceof Error ? error.message : error);
    }

    // A failed read is remembered too, so a broken CLI is retried after the
    // TTL rather than on every request. It keeps the last good list.
    this.listed = {
      listedAt: Date.now(),
      definition: definition ?? this.listed?.definition ?? null,
    };
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }
}
