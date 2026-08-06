<script lang="ts">
	// A Textfield with Australia-only address autocomplete (via /api/address/search)
	// and a "use current location" button (via /api/address/reverse). Search results
	// are optionally biased towards the browser's GPS position, requested lazily on
	// first focus. Search is triggered off the input's native `input` event, not off
	// `value` itself, so programmatic value changes (picking a suggestion, locating,
	// or a caller's own prefill logic) never reopen the dropdown or fire a redundant
	// lookup.
	import Textfield from '@smui/textfield';
	import TextfieldIcon from '@smui/textfield/icon';
	import { mdiClose, mdiCrosshairsGps } from '@mdi/js';
	import Icon from '$lib/components/Icon.svelte';

	let {
		value = $bindable(''),
		label,
		name,
		required = false,
		invalid = false
	}: {
		value: string;
		label: string;
		name: string;
		required?: boolean;
		invalid?: boolean;
	} = $props();

	interface Suggestion {
		label: string;
		lat: number;
		lon: number;
	}

	let suggestions = $state<Suggestion[]>([]);
	let open = $state(false);
	let highlighted = $state(-1);
	let locating = $state(false);
	let containerEl: HTMLDivElement | undefined;

	let debounceHandle: ReturnType<typeof setTimeout> | undefined;
	let abortController: AbortController | undefined;
	let biasPosition: { lat: number; lon: number } | null = null;
	let biasRequested = false;

	function requestBiasPosition() {
		if (biasRequested || typeof navigator === 'undefined' || !navigator.geolocation) return;
		biasRequested = true;
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				biasPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
			},
			() => {
				// Permission denied or unavailable — search just proceeds unbiased.
			},
			{ maximumAge: 5 * 60 * 1000, timeout: 8000 }
		);
	}

	async function runSearch(query: string) {
		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;

		const params = new URLSearchParams({ q: query });
		if (biasPosition) {
			params.set('lat', String(biasPosition.lat));
			params.set('lon', String(biasPosition.lon));
		}

		try {
			const res = await fetch(`/api/address/search?${params}`, { signal: controller.signal });
			if (!res.ok) return;
			const data = (await res.json()) as { results: Suggestion[] };
			suggestions = data.results ?? [];
			open = suggestions.length > 0;
			highlighted = -1;
		} catch (err) {
			if ((err as Error).name !== 'AbortError') suggestions = [];
		}
	}

	function handleInput() {
		clearTimeout(debounceHandle);
		const query = value.trim();
		if (query.length < 3) {
			abortController?.abort();
			suggestions = [];
			open = false;
			return;
		}
		debounceHandle = setTimeout(() => runSearch(query), 350);
	}

	function selectSuggestion(suggestion: Suggestion) {
		value = suggestion.label;
		biasPosition = { lat: suggestion.lat, lon: suggestion.lon };
		suggestions = [];
		open = false;
		highlighted = -1;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!open || suggestions.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlighted = (highlighted + 1) % suggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlighted = (highlighted - 1 + suggestions.length) % suggestions.length;
		} else if (e.key === 'Enter') {
			if (highlighted >= 0) {
				e.preventDefault();
				selectSuggestion(suggestions[highlighted]);
			}
		} else if (e.key === 'Escape') {
			open = false;
		}
	}

	function handleWindowMousedown(e: MouseEvent) {
		if (open && containerEl && !containerEl.contains(e.target as Node)) {
			open = false;
		}
	}

	function locate() {
		if (typeof navigator === 'undefined' || !navigator.geolocation || locating) return;
		locating = true;
		navigator.geolocation.getCurrentPosition(
			async (pos) => {
				biasPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
				try {
					const params = new URLSearchParams({
						lat: String(pos.coords.latitude),
						lon: String(pos.coords.longitude)
					});
					const res = await fetch(`/api/address/reverse?${params}`);
					if (res.ok) {
						const data = (await res.json()) as { address: string | null };
						if (data.address) {
							value = data.address;
							suggestions = [];
							open = false;
						}
					}
				} finally {
					locating = false;
				}
			},
			() => {
				locating = false;
			},
			{ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
		);
	}
</script>

<svelte:window onmousedown={handleWindowMousedown} />

<div class="address-field" bind:this={containerEl}>
	<Textfield
		variant="outlined"
		{label}
		bind:value
		input$name={name}
		input$autocomplete="off"
		input$oninput={handleInput}
		input$onkeydown={handleKeydown}
		input$onfocus={requestBiasPosition}
		{required}
		style="width: 100%"
		{invalid}
	>
		{#snippet trailingIcon()}
			<TextfieldIcon
				role="button"
				tabindex={locating ? -1 : 0}
				class="address-field__locate-icon{locating ? ' address-field__locate-icon--busy' : ''}"
				aria-label="Use current location"
				onclick={locate}
			>
				<Icon path={mdiCrosshairsGps} size={18} />
			</TextfieldIcon>
			<TextfieldIcon
				role="button"
				tabindex={value ? 0 : -1}
				class="clear-location-icon"
				style={value ? undefined : 'visibility: hidden'}
				aria-label="Clear"
				onclick={() => (value = '')}
			>
				<Icon path={mdiClose} size={18} />
			</TextfieldIcon>
		{/snippet}
	</Textfield>

	{#if open && suggestions.length > 0}
		<ul class="address-field__suggestions" role="listbox">
			{#each suggestions as suggestion, i (suggestion.label)}
				<li>
					<button
						type="button"
						role="option"
						aria-selected={i === highlighted}
						class:highlighted={i === highlighted}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => selectSuggestion(suggestion)}
					>
						{suggestion.label}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.address-field {
		position: relative;
	}

	:global(.address-field__locate-icon) {
		cursor: pointer;
	}

	:global(.address-field__locate-icon--busy) {
		animation: address-field-pulse 1s ease-in-out infinite;
	}

	:global(.clear-location-icon) {
		cursor: pointer;
	}

	.address-field__suggestions {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 20;
		margin: 0.25rem 0 0;
		padding: 0.25rem;
		list-style: none;
		background: #fff;
		border: 1px solid rgba(0, 0, 0, 0.15);
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
		max-height: 260px;
		overflow-y: auto;
	}

	.address-field__suggestions li {
		margin: 0;
	}

	.address-field__suggestions button {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.5rem 0.6rem;
		background: none;
		border: none;
		border-radius: 6px;
		font: inherit;
		font-size: 0.88rem;
		color: inherit;
		cursor: pointer;
	}

	.address-field__suggestions button:hover,
	.address-field__suggestions button.highlighted {
		background: rgba(0, 0, 0, 0.06);
	}

	@keyframes address-field-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}

	@media (prefers-color-scheme: dark) {
		.address-field__suggestions {
			background: #1e293b;
			border-color: rgba(255, 255, 255, 0.15);
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
		}

		.address-field__suggestions button:hover,
		.address-field__suggestions button.highlighted {
			background: rgba(255, 255, 255, 0.08);
		}
	}
</style>
