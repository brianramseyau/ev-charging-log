<script lang="ts">
	// A plain native date/time input, styled to match the app.
	// SMUI's Textfield strips the native calendar/clock picker icon via its
	// `appearance: none` reset, so date/time fields deliberately bypass it and
	// use a native <input> directly instead.
	let {
		type,
		label,
		name,
		value = $bindable(''),
		required = false,
		error = null
	}: {
		type: 'date' | 'time';
		label: string;
		name: string;
		value?: string;
		required?: boolean;
		error?: string | null;
	} = $props();
</script>

<label class="date-time-field">
	<span class="date-time-field__label">{label}</span>
	<input {type} {name} bind:value {required} class:invalid={!!error} />
</label>
{#if error}
	<p class="date-time-field__error">{error}</p>
{/if}

<style>
	.date-time-field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		color: #334155;
	}

	.date-time-field input {
		font-size: 1rem;
		padding: 0.55rem 0.6rem;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		font-family: inherit;
		background: #fff;
		color-scheme: light;
	}

	.date-time-field input.invalid {
		border-color: #b91c1c;
	}

	.date-time-field__error {
		color: #b91c1c;
		font-size: 0.8rem;
		margin: 0.25rem 0 0;
	}

	@media (prefers-color-scheme: dark) {
		.date-time-field {
			color: #94a3b8;
		}

		.date-time-field input {
			background: #1e293b;
			border-color: rgba(255, 255, 255, 0.2);
			color: #e2e8f0;
			color-scheme: dark;
		}
	}
</style>
