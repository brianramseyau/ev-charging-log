<script lang="ts">
	import { enhance } from '$app/forms';
	import Button, { Label } from '@smui/button';
	import Textfield from '@smui/textfield';
	import Select, { Option } from '@smui/select';
	import IconButton from '@smui/icon-button';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type PlanType = 'flat' | 'peak_offpeak';
	type Plan = PageData['plans'][number];

	let editingId = $state<number | null>(null);

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

	function startEdit(plan: Plan) {
		editingId = plan.id;
		type = plan.type;
		effectiveFrom = plan.effectiveFrom;
		flatRate = plan.flatRate != null ? String(plan.flatRate) : '';
		peakRate = plan.peakRate != null ? String(plan.peakRate) : '';
		offpeakRate = plan.offpeakRate != null ? String(plan.offpeakRate) : '';
		windows =
			plan.offpeakWindows && plan.offpeakWindows.length > 0
				? plan.offpeakWindows.map((w) => ({ ...w }))
				: [{ start: '22:00', end: '07:00' }];
		window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
	}

	function cancelEdit() {
		editingId = null;
		type = 'flat';
		effectiveFrom = new Date().toISOString().slice(0, 10);
		flatRate = '';
		peakRate = '';
		offpeakRate = '';
		windows = [{ start: '22:00', end: '07:00' }];
	}
</script>

<h1>Rate Plans</h1>

{#if form?.error}
	<p class="error">{form.error}</p>
{/if}

{#if form?.success && typeof form.recalculated === 'number'}
	<p class="notice">
		{form.recalculated === 0
			? 'No session costs needed updating.'
			: `Recalculated cost for ${form.recalculated} session${form.recalculated === 1 ? '' : 's'}.`}
	</p>
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

			<div class="plan-card__actions">
				<Button type="button" variant="text" onclick={() => startEdit(plan)}>
					<Label>Edit</Label>
				</Button>
				<form method="POST" action="?/delete" use:enhance>
					<input type="hidden" name="id" value={plan.id} />
					<Button type="submit" variant="text" color="secondary">
						<Label>Delete</Label>
					</Button>
				</form>
			</div>
		</article>
	{:else}
		<p class="empty-state">No rate plans yet. Add one below.</p>
	{/each}
</section>

<h2>{editingId === null ? 'Add rate plan' : 'Edit rate plan'}</h2>

<form
	method="POST"
	action={editingId === null ? '?/create' : '?/update'}
	use:enhance={() => {
		return async ({ update }) => {
			await update();
			if (editingId !== null) cancelEdit();
		};
	}}
	class="rate-form"
>
	{#if editingId !== null}
		<input type="hidden" name="id" value={editingId} />
	{/if}

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

	<div class="rate-form__buttons">
		<Button type="submit" variant="raised" color="primary" class="rate-form__submit">
			<Label>{editingId === null ? 'Add rate plan' : 'Save changes'}</Label>
		</Button>
		{#if editingId !== null}
			<Button type="button" variant="outlined" onclick={cancelEdit}>
				<Label>Cancel</Label>
			</Button>
		{/if}
	</div>
</form>

<style>
	h1 {
		font-size: 1.3rem;
		margin: 0 0 1rem;
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

	.plan-card__actions {
		margin-top: 0.25rem;
		display: flex;
		justify-content: flex-end;
		gap: 0.25rem;
	}

	.rate-form__buttons {
		display: flex;
		gap: 0.5rem;
	}

	.rate-form__buttons :global(.rate-form__submit) {
		flex: 1;
	}

	.notice {
		background: #ecfdf5;
		color: #065f46;
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		margin-bottom: 1rem;
		font-size: 0.9rem;
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

		.notice {
			background: #064e3b;
			color: #a7f3d0;
		}
	}
</style>
