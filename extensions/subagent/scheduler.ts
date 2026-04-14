/**
 * Model-Aware Slot Scheduler
 *
 * CPU-scheduler-inspired concurrency management for sub-agents.
 * Tracks per-model slot availability and routes tasks with soft
 * affinity (prefer requested model) and tier-aware fallback.
 *
 * Analogy: 4 CPUs, each with N cores.
 *   - GLM-4.7-Flash:     dual-core (2 slots per pack, small model)
 *   - MiniMax-M2.5:       single-core (1 slot per pack, standard)
 *   - Kimi-K2.5:          single-core (1 slot per pack, standard)
 *   - GLM-5.1:            single-core (1 slot per pack, standard)
 *
 * Scheduling rules:
 *   1. Prefer requested model (soft affinity)
 *   2. If full, fall back to same-tier model with free slots
 *   3. Never cross tiers (power ↔ fast) silently
 *   4. If no same-tier slots available, queue the task
 */

import { type SubagentConfig, type ModelTier, computeSlots, modelsByTier } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledTask {
	/** Index in the original task list */
	index: number;
	/** The model this task was originally requested to use */
	requestedModel: string;
	/** The model this task will actually run on (may differ if fallback) */
	assignedModel: string;
	/** Whether the assigned model is a fallback from the requested model */
	isFallback: boolean;
	/** Whether this task is queued (waiting for a slot to free up) */
	queued: boolean;
	/** Tier of the assigned model */
	tier: ModelTier;
	/** Cost of this task's assigned model */
	cost: number;
}

export interface ExecutionPlan {
	tasks: ScheduledTask[];
	/** Total estimated request cost across all tasks */
	totalCost: number;
	/** How many tasks got fallback models */
	fallbackCount: number;
	/** How many tasks are queued */
	queuedCount: number;
	/** Slot snapshot at planning time */
	slotSnapshot: Record<string, { used: number; total: number }>;
}

export interface SlotStatus {
	used: number;
	total: number;
	free: number;
}

// ---------------------------------------------------------------------------
// SlotTracker
// ---------------------------------------------------------------------------

export class SlotTracker {
	private slots = new Map<string, { used: number; total: number }>();

	constructor(config: SubagentConfig) {
		for (const [modelId, modelConfig] of Object.entries(config.models)) {
			const total = computeSlots(config.packs, modelConfig);
			this.slots.set(modelId, { used: 0, total });
		}
	}

	/** Check if a model has at least one free slot */
	hasSlot(modelId: string): boolean {
		const s = this.slots.get(modelId);
		if (!s) return false;
		return s.used < s.total;
	}

	/** Claim a slot for a model. Returns true if successful. */
	claim(modelId: string): boolean {
		const s = this.slots.get(modelId);
		if (!s || s.used >= s.total) return false;
		s.used++;
		return true;
	}

	/** Release a slot for a model */
	release(modelId: string): void {
		const s = this.slots.get(modelId);
		if (s && s.used > 0) s.used--;
	}

	/** Get free slot count for a model */
	freeSlots(modelId: string): number {
		const s = this.slots.get(modelId);
		if (!s) return 0;
		return s.total - s.used;
	}

	/** Get full status for a model */
	status(modelId: string): SlotStatus | undefined {
		const s = this.slots.get(modelId);
		if (!s) return undefined;
		return { used: s.used, total: s.total, free: s.total - s.used };
	}

	/** Get snapshot of all model slot usage */
	snapshot(): Record<string, { used: number; total: number }> {
		const result: Record<string, { used: number; total: number }> = {};
		for (const [modelId, s] of this.slots.entries()) {
			result[modelId] = { used: s.used, total: s.total };
		}
		return result;
	}

	/** Check if any model has free slots */
	hasAnyFreeSlot(): boolean {
		for (const s of this.slots.values()) {
			if (s.used < s.total) return true;
		}
		return false;
	}

	/** Check if any model in a given tier has free slots */
	hasTierFreeSlot(tier: ModelTier, config: SubagentConfig): boolean {
		const tierModels = modelsByTier(config);
		for (const modelId of tierModels[tier]) {
			if (this.hasSlot(modelId)) return true;
		}
		return false;
	}
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Schedule a list of tasks across available model slots.
 *
 * @param tasks - Array of { requestedModel } objects
 * @param config - Subagent config with model definitions and pack count
 * @param slotTracker - Mutable slot tracker (claims slots as scheduled)
 * @returns Execution plan with model assignments
 */
export function schedule(
	tasks: Array<{ requestedModel: string }>,
	config: SubagentConfig,
	slotTracker: SlotTracker,
): ExecutionPlan {
	const tiers = modelsByTier(config);
	const scheduled: ScheduledTask[] = [];
	let totalCost = 0;
	let fallbackCount = 0;
	let queuedCount = 0;

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		const requestedModel = task.requestedModel;
		const modelConfig = config.models[requestedModel];

		// If requested model isn't in config, queue it (will fail later with clear error)
		if (!modelConfig) {
			scheduled.push({
				index: i,
				requestedModel,
				assignedModel: requestedModel,
				isFallback: false,
				queued: true,
				tier: "fast",
				cost: 1.0,
			});
			queuedCount++;
			continue;
		}

		// Try requested model first (soft affinity)
		if (slotTracker.hasSlot(requestedModel)) {
			slotTracker.claim(requestedModel);
			scheduled.push({
				index: i,
				requestedModel,
				assignedModel: requestedModel,
				isFallback: false,
				queued: false,
				tier: modelConfig.tier,
				cost: modelConfig.cost,
			});
			totalCost += modelConfig.cost;
			continue;
		}

		// Try same-tier fallback
		const sameTierModels = tiers[modelConfig.tier]
			.filter((m) => m !== requestedModel && slotTracker.hasSlot(m));

		if (sameTierModels.length > 0) {
			// Pick the cheapest model in same tier with free slots
			const fallbackModel = sameTierModels.sort((a, b) => {
				return (config.models[a]?.cost ?? 1) - (config.models[b]?.cost ?? 1);
			})[0];

			const fallbackConfig = config.models[fallbackModel];
			slotTracker.claim(fallbackModel);
			scheduled.push({
				index: i,
				requestedModel,
				assignedModel: fallbackModel,
				isFallback: true,
				queued: false,
				tier: fallbackConfig.tier,
				cost: fallbackConfig.cost,
			});
			totalCost += fallbackConfig.cost;
			fallbackCount++;
			continue;
		}

		// No same-tier slots available → queue
		scheduled.push({
			index: i,
			requestedModel,
			assignedModel: requestedModel,
			isFallback: false,
			queued: true,
			tier: modelConfig.tier,
			cost: modelConfig.cost,
		});
		queuedCount++;
	}

	return {
		tasks: scheduled,
		totalCost,
		fallbackCount,
		queuedCount,
		slotSnapshot: slotTracker.snapshot(),
	};
}

/**
 * Find the best available model for a queued task.
 * Called when a slot is released and we need to pick what to run next.
 */
export function findBestAvailableModel(
	requestedModel: string,
	config: SubagentConfig,
	slotTracker: SlotTracker,
): string | null {
	const modelConfig = config.models[requestedModel];
	if (!modelConfig) return null;

	// Try requested model
	if (slotTracker.hasSlot(requestedModel)) {
		return requestedModel;
	}

	// Try same-tier fallback
	const tiers = modelsByTier(config);
	const sameTierModels = tiers[modelConfig.tier]
		.filter((m) => m !== requestedModel && slotTracker.hasSlot(m));

	if (sameTierModels.length > 0) {
		return sameTierModels.sort((a, b) => {
			return (config.models[a]?.cost ?? 1) - (config.models[b]?.cost ?? 1);
		})[0];
	}

	return null;
}

/**
 * Estimate total cost for a set of tasks (without claiming slots).
 */
export function estimateCost(
	tasks: Array<{ requestedModel: string }>,
	config: SubagentConfig,
): number {
	let total = 0;
	for (const task of tasks) {
		const modelConfig = config.models[task.requestedModel];
		if (modelConfig) {
			total += modelConfig.cost;
		} else {
			total += 1.0; // unknown model, assume 1.0
		}
	}
	return total;
}

/**
 * Format slot snapshot for display.
 */
export function formatSlotSnapshot(
	snapshot: Record<string, { used: number; total: number }>,
	displayModelFn: (id: string) => string,
): string {
	const parts: string[] = [];
	for (const [modelId, s] of Object.entries(snapshot)) {
		const full = s.used >= s.total;
		const color = full ? "✗" : s.used > 0 ? "◐" : "○";
		parts.push(`${displayModelFn(modelId)}:${s.used}/${s.total}${full ? "✗" : ""}`);
	}
	return parts.join(" | ");
}
