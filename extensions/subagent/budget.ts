/**
 * Budget Tracker
 *
 * Session-scoped cost tracking for sub-agent invocations.
 * Tracks cumulative spend across a session and warns when
 * approaching the configured weekly budget.
 *
 * Budget is NOT enforced — it only provides warnings that
 * appear in tool results. The LLM and user decide what to do.
 *
 * State is persisted via pi.appendEntry() so it survives
 * reloads within the same session.
 */

import { type SubagentConfig, displayModel } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BudgetEntryData {
	sessionCost: number;
	requestCount: number;
	modelCosts: Record<string, number>; // modelId → cumulative cost
}

export interface BudgetCheckResult {
	ok: boolean;
	warning?: string;
	percentUsed: number;
	sessionCost: number;
}

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

export class BudgetTracker {
	private config: SubagentConfig;
	sessionCost: number = 0;
	requestCount: number = 0;
	modelCosts: Record<string, number> = {};

	constructor(config: SubagentConfig) {
		this.config = config;
	}

	/**
	 * Record a cost from a completed sub-agent run.
	 */
	recordCost(cost: number, modelId: string): void {
		this.sessionCost += cost;
		this.requestCount++;
		if (!this.modelCosts[modelId]) {
			this.modelCosts[modelId] = 0;
		}
		this.modelCosts[modelId] += cost;
	}

	/**
	 * Check whether an upcoming operation would approach or exceed
	 * the weekly budget. Returns a warning if thresholds are crossed.
	 *
	 * Thresholds:
	 *   - 80%: mild warning
	 *   - 95%: strong warning
	 *   - 100%+: critical warning
	 */
	check(estimatedCost: number): BudgetCheckResult {
		// We can't know the true weekly total across all sessions,
		// so we use session cost as a lower bound and estimate weekly
		// based on typical usage. For simplicity, we just track session
		// cost and warn based on the configured budget.
		const projectedTotal = this.sessionCost + estimatedCost;
		const percentUsed = (projectedTotal / this.config.weeklyBudget) * 100;

		let warning: string | undefined;

		if (percentUsed >= 100) {
			warning = `Budget exceeded: $${projectedTotal.toFixed(2)} of $${this.config.weeklyBudget}/week (${percentUsed.toFixed(0)}%). This session has used $${this.sessionCost.toFixed(2)} across ${this.requestCount} sub-agent requests.`;
		} else if (percentUsed >= 95) {
			warning = `Budget nearly exhausted: $${projectedTotal.toFixed(2)} of $${this.config.weeklyBudget}/week (${percentUsed.toFixed(0)}%). Consider reducing sub-agent usage.`;
		} else if (percentUsed >= 80) {
			warning = `Budget approaching limit: $${projectedTotal.toFixed(2)} of $${this.config.weeklyBudget}/week (${percentUsed.toFixed(0)}%).`;
		}

		return {
			ok: percentUsed < 100,
			warning,
			percentUsed,
			sessionCost: this.sessionCost,
		};
	}

	/**
	 * Serialize for session persistence.
	 */
	toEntryData(): BudgetEntryData {
		return {
			sessionCost: this.sessionCost,
			requestCount: this.requestCount,
			modelCosts: { ...this.modelCosts },
		};
	}

	/**
	 * Restore from a previously persisted entry.
	 */
	restoreFromEntry(data: any): void {
		if (!data || typeof data !== "object") return;
		this.sessionCost = typeof data.sessionCost === "number" ? data.sessionCost : 0;
		this.requestCount = typeof data.requestCount === "number" ? data.requestCount : 0;
		if (data.modelCosts && typeof data.modelCosts === "object") {
			this.modelCosts = { ...data.modelCosts };
		}
	}

	/**
	 * Format a budget summary for display.
	 */
	formatSummary(): string {
		const lines: string[] = [];
		lines.push(`Session: $${this.sessionCost.toFixed(4)} across ${this.requestCount} requests`);
		if (Object.keys(this.modelCosts).length > 0) {
			lines.push("Per-model:");
			for (const [modelId, cost] of Object.entries(this.modelCosts)) {
				lines.push(`  ${displayModel(modelId)}: $${cost.toFixed(4)}`);
			}
		}
		lines.push(`Budget: $${this.sessionCost.toFixed(2)} / $${this.config.weeklyBudget}/week (${((this.sessionCost / this.config.weeklyBudget) * 100).toFixed(0)}%)`);
		return lines.join("\n");
	}
}
