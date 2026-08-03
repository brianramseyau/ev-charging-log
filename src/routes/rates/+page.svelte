<script lang="ts">
	import { enhance } from '$app/forms';
	import Button, { Label } from '@smui/button';
	import Textfield from '@smui/textfield';
	import Select, { Option } from '@smui/select';
	import IconButton from '@smui/icon-button';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type PlanType = 'flat' | 'peak_offpeak';

	let type = $state<PlanType>('flat');
	let effectiveFrom = $state(new Date().toISOString().slice(0, 10));
	let flatRate = $state('');
	let peakRate = $state('');
	let offpeakRate = $state('');
	let windows = $state<{ start: string; end: string }[]>([{ start: '22:00', end: '07:00' }]);

	function addWindow() {
		windows.push({ start: '', end: '' });
	}

	function removeWindow(index: number) {
		windows.splice(index, 1);
	}

	function formatWindows(list: { start: string; end: string }[] | null) {
		if (!list || list.length === 0) return '—';
		return list.map((w) => `${w.start}–${w.end}`).join(', ');
	}
</script>

<h1>Rate Plans</h1>

{#if form?.error}
	<p class="error">{form.error}</p>
{/if}

<section class="plan-list">
	{#each data.plans as plan (plan.id)}
		<article class="plan-card">
			<div class="plan-card__header">
				<span class="plan-card__type">
					{plan.type === 'flat' ? 'Flat rate' : 'Peak / off-peak'}
				</span>
				<span class="plan-card__date">from {plan.effectiveFrom}</span>
			</div>

			{#if plan.type === 'flat'}
				<p class="plan-card__rate">${plan.flatRate?.toFixed(5)} / kWh</p>
			{:else}
				<p class="plan-card__rate">
					Peak: ${plan.peakRate?.toFixed(5)} / kWh &nbsp;·&nbsp; Off-peak: ${plan.offpeakRate?.toFixed(
						5
					)} / kWh
				</p>
				<p class="plan-card__windows">Off-peak windows: {formatWindows(plan.offpeakWindows)}</p>
			{/if}

			<form method="POST" action="?/delete" use:enhance class="plan-card__delete">
				<input type="hidden" name="id" value={plan.id} />
				<Button type="submit" variant="text" color="secondary">
					<Label>Delete</Label>
				</Button>
			</form>
		</article>
	{:else}
		<p class="empty-state">No rate plans yet. Add one below.</p>
	{/each}
</section>

<h2>Add rate plan</h2>

<form
	method="POST"
	action="?/create"
	use:enhance={() => {
		return async ({ update }) => {
			await update();
		};
	}}
	class="rate-form"
>
	<Select bind:value={type} label="Type" hiddenInput input$name="type" class="rate-form__field">
		<Option value="flat">Flat rate</Option>
		<Option value="peak_offpeak">Peak / off-peak</Option>
	</Select>

	<Textfield
		bind:value={effectiveFrom}
		label="Effective from"
		type="date"
		input$name="effectiveFrom"
		class="rate-form__field"
		required
	/>

	{#if type === 'flat'}
		<Textfield
			bind:value={flatRate}
			label="Flat rate ($/kWh)"
			type="number"
			input$step="0.00001"
			input$min="0"
			input$name="flatRate"
			class="rate-form__field"
			required
		/>
	{:else}
		<Textfield
			bind:value={peakRate}
			label="Peak rate ($/kWh)"
			type="number"
			input$step="0.00001"
			input$min="0"
			input$name="peakRate"
			class="rate-form__field"
			required
		/>
		<Textfield
			bind:value={offpeakRate}
			label="Off-peak rate ($/kWh)"
			type="number"
			input$step="0.00001"
			input$min="0"
			input$name="offpeakRate"
			class="rate-form__field"
			required
		/>

		<div class="windows">
			<div class="windows__header">
				<span>Off-peak windows</span>
				<IconButton type="button" onclick={addWindow} title="Add window">add_circle</IconButton>
			</div>

			{#each windows as window, i (i)}
				<div class="windows__row">
					<Textfield
						bind:value={window.start}
						label="Start"
						type="time"
						input$name="windowStart"
						class="windows__field"
					/>
					<Textfield
						bind:value={window.end}
						label="End"
						type="time"
						input$name="windowEnd"
						class="windows__field"
					/>
					<IconButton
						type="button"
						onclick={() => removeWindow(i)}
						title="Remove window"
						disabled={windows.length <= 1}
					>
						remove_circle
					</IconButton>
				</div>
			{/each}
		</div>
	{/if}

	<Button type="submit" variant="raised" color="primary" class="rate-form__submit">
		<Label>Add rate plan</Label>
	</Button>
</form>

<style>
	h1 {
		font-size: 1.25rem;
		margin-bottom: 1rem;
	}

	h2 {
		font-size: 1.05rem;
		margin: 1.5rem 0 0.75rem;
	}

	.error {
		background: #fee2e2;
		color: #991b1b;
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		margin-bottom: 1rem;
	}

	.plan-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.plan-card {
		border: 1px solid rgba(0, 0, 0, 0.1);
		border-radius: 10px;
		padding: 0.85rem 1rem;
	}

	.plan-card__header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
		font-weight: 600;
	}

	.plan-card__type {
		color: #0f766e;
	}

	.plan-card__date {
		font-size: 0.8rem;
		font-weight: 400;
		color: #64748b;
	}

	.plan-card__rate,
	.plan-card__windows {
		margin: 0.35rem 0 0;
		font-size: 0.9rem;
	}

	.plan-card__delete {
		margin-top: 0.25rem;
		display: flex;
		justify-content: flex-end;
	}

	.empty-state {
		color: #64748b;
		font-size: 0.9rem;
	}

	.rate-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.rate-form :global(.rate-form__field) {
		width: 100%;
	}

	.rate-form :global(.rate-form__submit) {
		align-self: stretch;
		justify-content: center;
	}

	.windows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.windows__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 0.9rem;
		color: #334155;
	}

	.windows__row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.windows :global(.windows__field) {
		flex: 1;
		min-width: 0;
	}

	@media (prefers-color-scheme: dark) {
		.plan-card {
			border-color: rgba(255, 255, 255, 0.12);
		}

		.plan-card__type {
			color: #2dd4bf;
		}

		.plan-card__date {
			color: #94a3b8;
		}

		.empty-state {
			color: #94a3b8;
		}

		.windows__header {
			color: #cbd5e1;
		}

		.error {
			background: #450a0a;
			color: #fecaca;
		}
	}
</style>
