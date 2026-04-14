/**
 * Subagent Configuration
 *
 * Types, defaults, and persistence for the Synthetic subagent extension.
 * Config is stored in ~/.pi/agent/settings.json under the "subagent" key.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelTier = "power" | "fast";

export interface ModelConfig {
	slots: number;       // base slots per pack (1 for standard, 2 for small models)
	cost: number;        // request cost relative to 1.0
	tier: ModelTier;     // quality tier for fallback routing
	isSmall: boolean;    // small models get 2x slots per pack on Synthetic
}

export interface SubagentConfig {
	packs: number;                              // number of Synthetic packs (concurrency multiplier)
	models: Record<string, ModelConfig>;        // model ID → config
	weeklyBudget: number;                       // weekly budget in USD
	defaultModel: string;                       // fallback model when agent doesn't specify one
	provider: string;                           // provider name for CLI model resolution (e.g. "synthetic")
}

// ---------------------------------------------------------------------------
// Default Model Map (Synthetic)
// ---------------------------------------------------------------------------

export const DEFAULT_MODELS: Record<string, ModelConfig> = {
	"hf:zai-org/GLM-4.7-Flash": {
		slots: 2,
		cost: 0.13,
		tier: "fast",
		isSmall: true,
	},
	"hf:MiniMaxAI/MiniMax-M2.5": {
		slots: 1,
		cost: 0.53,
		tier: "power",
		isSmall: false,
	},
	"hf:moonshotai/Kimi-K2.5": {
		slots: 1,
		cost: 0.79,
		tier: "power",
		isSmall: false,
	},
	"hf:zai-org/GLM-5.1": {
		slots: 1,
		cost: 1.0,
		tier: "power",
		isSmall: false,
	},
};

export const DEFAULT_CONFIG: SubagentConfig = {
	packs: 1,
	models: { ...DEFAULT_MODELS },
	weeklyBudget: 24,
	defaultModel: "hf:MiniMaxAI/MiniMax-M2.5",
	provider: "synthetic",
};

// ---------------------------------------------------------------------------
// Slot Calculation
// ---------------------------------------------------------------------------

/**
 * Compute actual slot count for a model given pack count.
 * Small models get 2x concurrency per pack, standard models get 1x.
 */
export function computeSlots(packs: number, modelConfig: ModelConfig): number {
	return packs * modelConfig.slots;
}

/**
 * Compute total concurrent slots across all models.
 */
export function computeTotalSlots(config: SubagentConfig): number {
	let total = 0;
	for (const modelConfig of Object.values(config.models)) {
		total += computeSlots(config.packs, modelConfig);
	}
	return total;
}

/**
 * Get models grouped by tier.
 */
export function modelsByTier(config: SubagentConfig): Record<ModelTier, string[]> {
	const result: Record<ModelTier, string[]> = { power: [], fast: [] };
	for (const [modelId, modelConfig] of Object.entries(config.models)) {
		result[modelConfig.tier].push(modelId);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const SETTINGS_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

function readSettingsJson(): Record<string, any> {
	try {
		const content = fs.readFileSync(SETTINGS_FILE, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function writeSettingsJson(data: Record<string, any>): void {
	fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Load subagent config from settings.json, falling back to defaults.
 */
export function loadConfig(): SubagentConfig {
	const settings = readSettingsJson();
	const raw = settings.subagent;
	if (!raw || typeof raw !== "object") {
		return { ...DEFAULT_CONFIG, models: { ...DEFAULT_MODELS } };
	}

	// Merge with defaults so new fields are always present
	const config: SubagentConfig = {
		packs: typeof raw.packs === "number" ? raw.packs : DEFAULT_CONFIG.packs,
		models: { ...DEFAULT_MODELS },
		weeklyBudget: typeof raw.weeklyBudget === "number" ? raw.weeklyBudget : DEFAULT_CONFIG.weeklyBudget,
		defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : DEFAULT_CONFIG.defaultModel,
		provider: typeof raw.provider === "string" ? raw.provider : DEFAULT_CONFIG.provider,
	};

	// Override models if user has custom config
	if (raw.models && typeof raw.models === "object") {
		config.models = {};
		for (const [modelId, modelRaw] of Object.entries(raw.models as Record<string, any>)) {
			if (modelRaw && typeof modelRaw === "object") {
				config.models[modelId] = {
					slots: typeof modelRaw.slots === "number" ? modelRaw.slots : 1,
					cost: typeof modelRaw.cost === "number" ? modelRaw.cost : 1.0,
					tier: modelRaw.tier === "power" || modelRaw.tier === "fast" ? modelRaw.tier : "fast",
					isSmall: typeof modelRaw.isSmall === "boolean" ? modelRaw.isSmall : false,
				};
			}
		}
	}

	return config;
}

/**
 * Save subagent config to settings.json.
 */
export function saveConfig(config: SubagentConfig): void {
	const settings = readSettingsJson();
	settings.subagent = {
		packs: config.packs,
		models: config.models,
		weeklyBudget: config.weeklyBudget,
		defaultModel: config.defaultModel,
		provider: config.provider,
	};
	writeSettingsJson(settings);
}

/**
 * Check if config has been set up (exists in settings.json).
 */
export function hasConfig(): boolean {
	const settings = readSettingsJson();
	return settings.subagent !== undefined && settings.subagent !== null;
}

/**
 * Format a model ID for display (strip provider prefix).
 */
/**
 * Resolve a model ID to the provider/model format that pi's CLI expects.
 * E.g. "hf:zai-org/GLM-4.7-Flash" → "synthetic/hf:zai-org/GLM-4.7-Flash"
 */
export function resolveModelForCli(modelId: string, provider: string): string {
	if (modelId.includes("/")) {
		// Already has a provider prefix like "synthetic/hf:..."
		const parts = modelId.split("/");
		// If first part looks like a provider name, return as-is
		if (parts[0] && !parts[0].includes(":")) return modelId;
	}
	return `${provider}/${modelId}`;
}

export function displayModel(modelId: string): string {
	// "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4" → "NVIDIA-Nemotron-3-Super"
	const parts = modelId.split("/");
	if (parts.length >= 2) {
		const name = parts[parts.length - 1];
		// Trim common suffixes for readability
		return name
			.replace(/-120b-a12b-nvfp4$/i, "")
			.replace(/-flash$/i, "-Flash");
	}
	return modelId;
}

/**
 * Format slot summary for a config.
 */
export function formatSlotSummary(config: SubagentConfig): string {
	const lines: string[] = [];
	for (const [modelId, modelConfig] of Object.entries(config.models)) {
		const slots = computeSlots(config.packs, modelConfig);
		const smallNote = modelConfig.isSmall ? " × 2 small" : " × 1 std";
		lines.push(
			`  ${displayModel(modelId)}: ${slots} slot${slots !== 1 ? "s" : ""} (${config.packs} pack${config.packs !== 1 ? "s" : ""}${smallNote})  [${modelConfig.tier}]`,
		);
	}
	const total = computeTotalSlots(config);
	lines.push(`  Total: ${total} concurrent sub-agents`);
	return lines.join("\n");
}
