<script lang="ts">
	import Button from '@smui/button';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Import — EV Charging Log</title>
</svelte:head>

<h1>Historical import</h1>

{#if !form || form.step === 'upload'}
	<p>
		Upload a legacy monthly "Record of Home Charging" spreadsheet. It'll be parsed and shown to you
		for review before anything is saved.
	</p>

	{#if form?.error}
		<p class="error">{form.error}</p>
	{/if}

	<form method="POST" action="?/upload" enctype="multipart/form-data" class="upload-form">
		<label class="file-field">
			<span>Spreadsheet file (.xlsx)</span>
			<input type="file" name="file" accept=".xlsx" required />
		</label>
		<Button type="submit" variant="raised">Parse file</Button>
	</form>
{:else if form.step === 'review'}
	{@const review = form.review}

	<p>
		Review the parsed data below and fix anything that's wrong before committing. Rows flagged below
		are missing a field the parser couldn't confidently read.
	</p>

	{#if review.issues.length > 0}
		<div class="issues">
			<strong>{review.issues.length} item(s) need review:</strong>
			<ul>
				{#each review.issues as issue (issue.message)}
					<li>{issue.message}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<form method="POST" action="?/commit" class="review-form">
		<section class="header-fields">
			<h2>Billing period</h2>
			<label>
				<span>Period label</span>
				<input type="text" name="periodLabel" value={review.periodLabel} required />
			</label>
			<label>
				<span>Start date</span>
				<input type="date" name="startDate" value={review.startDate} required />
			</label>
			<label>
				<span>End date</span>
				<input type="date" name="endDate" value={review.endDate} required />
			</label>
			<label>
				<span>Full name (from sheet, not stored)</span>
				<input type="text" value={review.fullName} disabled />
			</label>
			<label>
				<span>Vehicle (from sheet, not stored)</span>
				<input type="text" value={review.vehicleLabel} disabled />
			</label>
			<label>
				<span>Claiming kWh (from sheet, for reference)</span>
				<input type="text" value={review.claimingKwh} disabled />
			</label>
			<label>
				<span>Rate $/kWh (from sheet, for reference)</span>
				<input type="text" value={review.rateKwh} disabled />
			</label>
		</section>

		<h2>Home charging sessions</h2>
		<input type="hidden" name="homeCount" value={review.homeRows.length} />
		<div class="table-scroll">
			<table>
				<thead>
					<tr>
						<th>Include</th>
						<th>Date</th>
						<th>Time</th>
						<th>Odometer (km)</th>
						<th>kWh used</th>
						<th>Location</th>
					</tr>
				</thead>
				<tbody>
					{#each review.homeRows as row, i (i)}
						<tr>
							<td>
								<input
									type="checkbox"
									name={`home-${i}-excluded`}
									checked={false}
									title="Exclude this row"
								/>
							</td>
							<td><input type="date" name={`home-${i}-date`} value={row.date} /></td>
							<td><input type="time" name={`home-${i}-time`} value={row.time} /></td>
							<td>
								<input
									type="number"
									step="any"
									name={`home-${i}-odometerKm`}
									value={row.odometerKm}
								/>
							</td>
							<td>
								<input type="number" step="any" name={`home-${i}-kwhUsed`} value={row.kwhUsed} />
							</td>
							<td><input type="text" name={`home-${i}-location`} value={row.location} /></td>
						</tr>
					{:else}
						<tr><td colspan="6">No home sessions parsed.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>

		<h2>Public / commercial charging sessions</h2>
		<input type="hidden" name="publicCount" value={review.publicRows.length} />
		<div class="table-scroll">
			<table>
				<thead>
					<tr>
						<th>Include</th>
						<th>Date</th>
						<th>Time</th>
						<th>Odometer (km)</th>
						<th>kWh used</th>
						<th>Location</th>
					</tr>
				</thead>
				<tbody>
					{#each review.publicRows as row, i (i)}
						<tr>
							<td>
								<input
									type="checkbox"
									name={`public-${i}-excluded`}
									checked={false}
									title="Exclude this row"
								/>
							</td>
							<td><input type="date" name={`public-${i}-date`} value={row.date} /></td>
							<td><input type="time" name={`public-${i}-time`} value={row.time} /></td>
							<td>
								<input
									type="number"
									step="any"
									name={`public-${i}-odometerKm`}
									value={row.odometerKm}
								/>
							</td>
							<td>
								<input type="number" step="any" name={`public-${i}-kwhUsed`} value={row.kwhUsed} />
							</td>
							<td><input type="text" name={`public-${i}-location`} value={row.location} /></td>
						</tr>
					{:else}
						<tr><td colspan="6">No public sessions parsed.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>

		<div class="actions">
			<Button type="submit" variant="raised">Commit import</Button>
		</div>
	</form>
{:else if form.step === 'done'}
	<p class="success">
		Imported {form.sessionCount} session(s) into billing period "{form.label}".
	</p>
	<a href="/import">Import another file</a>
{:else if form.step === 'commit-error'}
	<p class="error">{form.error}</p>
	<p>Go back and re-upload the file to try again.</p>
	<a href="/import">Back to upload</a>
{/if}

<style>
	h1 {
		margin-top: 0;
	}

	.error {
		color: #b91c1c;
		font-weight: 600;
	}

	.success {
		color: #0f766e;
		font-weight: 600;
	}

	.issues {
		background: #fffbeb;
		border: 1px solid #fde68a;
		border-radius: 8px;
		padding: 0.75rem 1rem;
		margin-bottom: 1rem;
	}

	.issues ul {
		margin: 0.5rem 0 0;
		padding-left: 1.25rem;
	}

	.upload-form,
	.header-fields {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 480px;
	}

	.file-field,
	.header-fields label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.9rem;
	}

	.header-fields input,
	.file-field input[type='file'] {
		padding: 0.5rem;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		font-size: 1rem;
	}

	.table-scroll {
		overflow-x: auto;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		margin-bottom: 1.5rem;
	}

	table {
		border-collapse: collapse;
		width: 100%;
		min-width: 640px;
	}

	th,
	td {
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid #e2e8f0;
		text-align: left;
		white-space: nowrap;
	}

	th {
		background: #f1f5f9;
		font-size: 0.8rem;
		position: sticky;
		top: 0;
	}

	td input {
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		padding: 0.3rem;
		font-size: 0.9rem;
		width: 100%;
		box-sizing: border-box;
	}

	td input[type='checkbox'] {
		width: auto;
	}

	.actions {
		margin-top: 1rem;
	}

	@media (prefers-color-scheme: dark) {
		.issues {
			background: #422006;
			border-color: #78350f;
		}

		.table-scroll {
			border-color: #334155;
		}

		th {
			background: #1e293b;
		}

		th,
		td {
			border-color: #334155;
		}

		.header-fields input,
		.file-field input[type='file'],
		td input {
			background: #0f172a;
			border-color: #334155;
			color: #e2e8f0;
		}
	}
</style>
